import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "undici";
import { Bridge } from "./base.js";
import { BridgeError, type ToolSpec } from "./types.js";

// Caps for inlining tool-result content into conversation history.
//
// Text is the agent's main signal — accessibility trees, HTML, search-
// result extracts. Cap higher so the agent can actually reason about the
// content it asked for (Google's a11y tree is ~50-200kB; a 8kB cap
// truncated mid-sidebar and forced the agent to fabricate results).
//
// Images/binary go to disk almost immediately — base64 dumps blow the
// context window and the agent can't read them anyway.
const MAX_INLINE_TEXT_CHARS = 64_000;   // ≈ 16k tokens
const MAX_INLINE_BINARY_CHARS = 8_000;  // base64 / json / non-text
const ATLAS_TMP_DIR = path.join(tmpdir(), "atlas-bridge-output");

async function saveLargeBlob(
  data: string,
  hint: { mime?: string; ext?: string; deviceName: string; toolName: string },
): Promise<string> {
  await mkdir(ATLAS_TMP_DIR, { recursive: true });
  const ext =
    hint.ext ||
    (hint.mime?.startsWith("image/") ? hint.mime.split("/")[1] || "bin" : "txt");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeDevice = hint.deviceName.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeTool = hint.toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(ATLAS_TMP_DIR, `${safeDevice}_${safeTool}_${stamp}.${ext}`);
  // base64 → binary; otherwise write as text
  if (hint.mime && /^image\//.test(hint.mime) && /^[A-Za-z0-9+/=\s]+$/.test(data)) {
    await writeFile(file, Buffer.from(data, "base64"));
  } else {
    await writeFile(file, data, "utf8");
  }
  return file;
}

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

function parseCommand(cmd: string): { argv: string[] } {
  // Minimal shell-style splitter — handles quoted args. Good enough for the
  // command lines registries hand us ("npx -y @x/y --arg 'with space'").
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | "" = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === " " || c === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return { argv: out };
}

class StdioMCP {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (msg: JsonRpcResponse) => void>();
  private buf = "";

  constructor(
    private command: string,
    private env?: Record<string, string>,
    private cwd?: string,
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;
    const { argv } = parseCommand(this.command);
    if (argv.length === 0) throw new BridgeError("mcp stdio: empty command");
    const [cmd, ...rest] = argv;
    this.proc = spawn(cmd!, rest, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env ? { ...process.env, ...this.env } : process.env,
      cwd: this.cwd,
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.on("error", (err) => {
      // Reject any pending calls; future calls will fail at write-time.
      for (const [, resolve] of this.pending) {
        resolve({ jsonrpc: "2.0", error: { code: -32000, message: String(err.message) } });
      }
      this.pending.clear();
    });
    this.proc.on("exit", (code) => {
      for (const [, resolve] of this.pending) {
        resolve({
          jsonrpc: "2.0",
          error: { code: -32001, message: `mcp server exited (code ${code})` },
        });
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;  // ignore malformed lines (some servers print debug to stdout)
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  async call(method: string, params?: any, timeoutMs = 60_000): Promise<any> {
    if (!this.proc?.stdin) throw new BridgeError("mcp stdio: process not started");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    const result: JsonRpcResponse = await new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`mcp call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(t);
          this.pending.delete(id);
          reject(new BridgeError(`mcp stdin write failed: ${err.message}`));
        }
      });
      // Resolve also clears the timer once it fires.
      const wrapped = this.pending.get(id)!;
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        wrapped(msg);
      });
    });
    if (result.error) throw new BridgeError(`mcp error ${result.error.code}: ${result.error.message}`);
    return result.result;
  }

  notify(method: string, params?: any): void {
    if (!this.proc?.stdin) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n";
    this.proc.stdin.write(payload);
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = undefined;
  }
}

class HttpMCP {
  private nextId = 1;
  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    /* nothing — request-per-call */
  }

  async call(method: string, params?: any, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await request(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        signal: controller.signal,
      });
      const text = await res.body.text();
      const msg = JSON.parse(text) as JsonRpcResponse;
      if (msg.error) throw new BridgeError(`mcp error ${msg.error.code}: ${msg.error.message}`);
      return msg.result;
    } finally {
      clearTimeout(t);
    }
  }

  notify(_method: string, _params?: any): void {
    // No-op for HTTP MCP — initialization notifications don't need a response.
  }

  async close(): Promise<void> {
    /* nothing */
  }
}

export class MCPBridge extends Bridge {
  static override kind = "mcp";
  private client?: StdioMCP | HttpMCP;

  override async connect(): Promise<void> {
    if (this.client) return;
    const cfg = this.spec.config;
    const transport = String(cfg.transport ?? "stdio");
    if (transport === "stdio") {
      if (!cfg.command) throw new BridgeError("mcp stdio: 'command' is required");
      this.client = new StdioMCP(cfg.command, cfg.env, cfg.cwd);
    } else if (transport === "http") {
      if (!cfg.url) throw new BridgeError("mcp http: 'url' is required");
      this.client = new HttpMCP(cfg.url, cfg.headers ?? {});
    } else {
      throw new BridgeError(`mcp: unsupported transport '${transport}'`);
    }
    await this.client.start();
    try {
      await this.client.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Atlas", version: "0.1" },
      }, 15_000);
      this.client.notify("notifications/initialized");
    } catch (e: any) {
      throw new BridgeError(`mcp initialize failed: ${e?.message ?? e}`);
    }
  }

  override async discover(): Promise<ToolSpec[]> {
    await this.connect();
    const result = await this.client!.call("tools/list");
    const upstream = (result?.tools ?? []) as Array<{
      name?: string;
      description?: string;
      inputSchema?: any;
    }>;
    const out: ToolSpec[] = [];
    for (const t of upstream) {
      if (!t.name) continue;
      out.push({
        name: t.name,
        description: (t.description ?? "").slice(0, 300),
        parameters: t.inputSchema ?? { type: "object", properties: {}, required: [] },
        handler: { op: "call_tool", tool_name: t.name },
      });
    }
    return out;
  }

  override async invoke(tool: ToolSpec, args: Record<string, any>): Promise<string> {
    if (!this.client) await this.connect();
    if (tool.handler?.op !== "call_tool") {
      throw new BridgeError(`mcp: unknown op ${JSON.stringify(tool.handler)}`);
    }
    const upstreamName = String(tool.handler.tool_name);
    const result = await this.client!.call("tools/call", { name: upstreamName, arguments: args ?? {} });
    const parts = (result?.content ?? []) as any[];
    const chunks: string[] = [];
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") {
        // Text is the primary signal — keep generous inline budget so the
        // agent can actually reason about the content. Only offload truly
        // large dumps, and even then preserve a substantial head + tell
        // the agent to read_file for the full document if needed.
        if (p.text.length > MAX_INLINE_TEXT_CHARS) {
          const file = await saveLargeBlob(p.text, {
            deviceName: this.spec.name, toolName: upstreamName, ext: "txt",
          });
          const head = p.text.slice(0, MAX_INLINE_TEXT_CHARS - 400);
          chunks.push(
            `[full text (${p.text.length} chars) saved to ${file}; ` +
            `first ${head.length} chars below — call read_file with that path ` +
            `to read the rest before answering]\n\n` +
            `${head}\n\n... (${p.text.length - head.length} more chars in file)`,
          );
        } else {
          chunks.push(p.text);
        }
      } else if (p?.type === "image" && typeof p.data === "string") {
        // Screenshots etc. — never inline base64. The agent CANNOT read
        // images, so the prompt rules tell it to use a text tool instead
        // of describing the file.
        const file = await saveLargeBlob(p.data, {
          deviceName: this.spec.name, toolName: upstreamName,
          mime: p.mimeType ?? "image/png",
        });
        chunks.push(
          `[image saved to ${file} — you CANNOT read it. ` +
          `If the user wanted information from a page, use a text-extraction ` +
          `tool (browser_snapshot, browser_evaluate, get_page_content, etc.) ` +
          `instead of describing this image. Tell the user the file path is saved.]`,
        );
      } else {
        const j = JSON.stringify(p);
        if (j.length > MAX_INLINE_BINARY_CHARS) {
          const file = await saveLargeBlob(j, {
            deviceName: this.spec.name, toolName: upstreamName, ext: "json",
          });
          chunks.push(`[large ${p?.type ?? "non-text"} part (${j.length} chars) saved to ${file}]`);
        } else {
          chunks.push(j);
        }
      }
    }
    if (result?.isError) return "[mcp tool returned error]\n" + chunks.join("\n");
    return chunks.length ? chunks.join("\n") : "(empty)";
  }

  override async aclose(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }

  static defaultCapabilities(): string[] {
    return ["control", "telemetry"];
  }
}
