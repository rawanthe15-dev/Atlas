import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request } from "undici";
import { Bridge } from "./base.js";
import { BridgeError, type ToolSpec } from "./types.js";

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
      if (p?.type === "text" && typeof p.text === "string") chunks.push(p.text);
      else chunks.push(JSON.stringify(p));
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
