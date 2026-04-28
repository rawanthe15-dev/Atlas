/**
 * Live end-to-end harness for cli-ink: real Atlas agent against fake
 * targets at increasing difficulty. Mirrors tests/live/run_agent_tests.py
 * but for the TypeScript Atlas the user actually runs.
 *
 * Usage:  npx tsx scripts/live-agent-tests.ts
 *
 * Levels:
 *   1  full OpenAPI camera        — agent should mount kind="openapi"
 *   2  partial OpenAPI camera     — agent should fall back to `request`
 *   3  no docs camera             — agent should mount kind="http"
 *   4  blind MCP stdio server     — agent should mount kind="mcp"
 *   5  compose camera + MCP       — agent must use BOTH
 *   6  brave browser (real MCP)   — auto_connect should find playwright/puppeteer
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config/config.js";
import { Kernel } from "../src/kernel/kernel.js";
import { CorePlugin } from "../src/plugins/core-plugin.js";
import { ConfigPlugin } from "../src/plugins/config-plugin.js";
import { SessionsPlugin } from "../src/plugins/sessions-plugin.js";
import { OnboardingPlugin } from "../src/plugins/onboarding-plugin.js";
import { MemoryPlugin } from "../src/plugins/memory-plugin.js";
import { ToolsPlugin } from "../src/plugins/tools-plugin.js";
import { DevicesPlugin } from "../src/plugins/devices-plugin.js";
import { AgentPlugin } from "../src/plugins/agent-plugin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_ROOT = resolve(__dirname, "..", "..");
const FAKE_MCP_PATH = resolve(ATLAS_ROOT, "tests", "_fixtures", "fake_mcp_server.py");

// ─── colour helpers ──────────────────────────────────────────────────────

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const banner = (s: string) => console.log(`\n${C.bold}${C.magenta}━━━ ${s} ━━━${C.reset}\n`);
const okmark = (s: string) => console.log(`${C.green}✓${C.reset} ${s}`);
const fail = (s: string) => console.log(`${C.red}✗${C.reset} ${s}`);

// ─── Fake camera (Node http) ─────────────────────────────────────────────

interface CameraOpts {
  /** 1 = full spec, 2 = spec missing /api/snapshot, 3 = no spec at all */
  difficulty: 1 | 2 | 3;
}

function makeFakeCamera(opts: CameraOpts): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolveOuter) => {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const port = (server.address() as any)?.port;
      if (url === "/api/info") {
        const body = JSON.stringify({
          model: "AtlasTestCam",
          resolution: "1280x720",
          firmware: "1.0.3",
        });
        res.writeHead(200, { "content-type": "application/json" }).end(body);
        return;
      }
      if (url === "/api/snapshot") {
        const body = Buffer.from("\xff\xd8\xff\xe0\x00\x10JFIFatlas-test-snapshot", "binary");
        res.writeHead(200, { "content-type": "image/jpeg" }).end(body);
        return;
      }
      if (url === "/openapi.json") {
        if (opts.difficulty === 3) {
          res.writeHead(404).end("not found");
          return;
        }
        const paths: any = {
          "/api/info": { get: { operationId: "getInfo", summary: "Camera info" } },
        };
        if (opts.difficulty === 1) {
          paths["/api/snapshot"] = { get: { operationId: "snapshot", summary: "Capture a frame" } };
        }
        const spec = {
          openapi: "3.0.0",
          info: { title: "AtlasTestCam", version: "1.0" },
          servers: [{ url: `http://127.0.0.1:${port}` }],
          paths,
        };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(spec));
        return;
      }
      res.writeHead(404).end("not found");
    };
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolveOuter({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// ─── per-run capture ─────────────────────────────────────────────────────

class Run {
  toolCalls: string[] = [];
  toolResults: Array<[string, string]> = [];
  tokens: string[] = [];

  callbacks() {
    return {
      onToken: (t: string) => {
        this.tokens.push(t);
        process.stdout.write(C.dim + t + C.reset);
      },
      onToolCall: (name: string) => {
        this.toolCalls.push(name);
        process.stdout.write(`\n${C.cyan}· tool: ${name}${C.reset}\n`);
      },
      onToolResult: (name: string, result: string) => {
        this.toolResults.push([name, result]);
        const snippet = result.replace(/\n/g, " ").slice(0, 120);
        process.stdout.write(`${C.dim}  ↳ ${snippet}${result.length > 120 ? "..." : ""}${C.reset}\n`);
      },
    };
  }

  reply(): string {
    return this.tokens.join("");
  }

  bridgeSawText(fragment: string): boolean {
    return this.toolResults.some(([, r]) => r.includes(fragment));
  }
}

// ─── boot Atlas ──────────────────────────────────────────────────────────

async function bootAtlas(): Promise<{ kernel: Kernel; devices: DevicesPlugin }> {
  const config = loadConfig();
  // Ensure devices section exists; default install_policy=auto.
  (config as any).devices = (config as any).devices ?? { install_policy: "auto" };
  const kernel = new Kernel(config);
  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin({ shellConfirm: async () => true }));
  const devicesPlugin = new DevicesPlugin();
  await kernel.load(devicesPlugin);
  await kernel.load(new AgentPlugin());
  if (kernel.agent) {
    (kernel.agent as any).opts.devicesProbe = () =>
      devicesPlugin.list().map((r) => ({
        name: r.spec.name,
        kind: r.spec.kind,
        capabilities: r.spec.capabilities,
        tools: r.toolNames,
      }));
  }
  return { kernel, devices: devicesPlugin };
}

async function resetDevices(kernel: Kernel, devices: DevicesPlugin) {
  for (const r of devices.list()) {
    try {
      await devices.unmount(r.spec.name);
    } catch {
      /* ignore */
    }
  }
  kernel.agent?.resetHistory();
}

// ─── scenarios ───────────────────────────────────────────────────────────

interface Scenario {
  title: string;
  run: (kernel: Kernel, devices: DevicesPlugin) => Promise<boolean>;
}

const scenarios: Scenario[] = [
  {
    title: "Level 1 — Camera with FULL OpenAPI",
    async run(kernel) {
      const cam = await makeFakeCamera({ difficulty: 1 });
      try {
        const prompt = `I have a new IP camera running at http://127.0.0.1:${cam.port}. Its OpenAPI spec is at http://127.0.0.1:${cam.port}/openapi.json. Connect to it and grab a snapshot — I want to see the response bytes.`;
        console.log(`${C.bold}→${C.reset} ${prompt}`);
        const run = new Run();
        await kernel.agent!.process(prompt, run.callbacks());
        console.log();
        const mounted = run.toolCalls.some((t) => t === "auto_connect" || t === "mount_device");
        const calledCamera = run.toolCalls.some(
          (t) => t.includes("snapshot") || t.includes("request") || t.includes("getInfo"),
        );
        const passed = mounted && calledCamera;
        passed ? okmark(`agent mounted + called the camera (${run.toolCalls.join(", ")})`)
               : fail(`tool calls: ${run.toolCalls.join(", ")}`);
        return passed;
      } finally {
        await cam.close();
      }
    },
  },
  {
    title: "Level 2 — Camera with PARTIAL OpenAPI",
    async run(kernel) {
      const cam = await makeFakeCamera({ difficulty: 2 });
      try {
        const prompt = `My camera is at http://127.0.0.1:${cam.port}. There's an OpenAPI doc at http://127.0.0.1:${cam.port}/openapi.json but it might be incomplete. Connect, then capture a snapshot from /api/snapshot — even if the spec doesn't list it.`;
        console.log(`${C.bold}→${C.reset} ${prompt}`);
        const run = new Run();
        await kernel.agent!.process(prompt, run.callbacks());
        console.log();
        const mounted = run.toolCalls.some((t) => t === "auto_connect" || t === "mount_device");
        const got = run.bridgeSawText("atlas-test-snapshot");
        const passed = mounted && got;
        passed ? okmark(`bridge worked around the broken spec`)
               : fail(`mounted=${mounted} bridgeSawSnapshot=${got} tools=${run.toolCalls.join(", ")}`);
        return passed;
      } finally {
        await cam.close();
      }
    },
  },
  {
    title: "Level 3 — Camera with NO docs",
    async run(kernel) {
      const cam = await makeFakeCamera({ difficulty: 3 });
      try {
        const prompt = `There's a device on my network at http://127.0.0.1:${cam.port}. No docs, no OpenAPI. I know it has GET /api/info and GET /api/snapshot. Wire it up to Atlas and fetch the info JSON.`;
        console.log(`${C.bold}→${C.reset} ${prompt}`);
        const run = new Run();
        await kernel.agent!.process(prompt, run.callbacks());
        console.log();
        const mounted = run.toolCalls.some((t) => t === "auto_connect" || t === "mount_device");
        const got = run.bridgeSawText("AtlasTestCam");
        const passed = mounted && got;
        passed ? okmark(`agent mounted via raw http and got the camera info`)
               : fail(`mounted=${mounted} infoSeen=${got} tools=${run.toolCalls.join(", ")}`);
        return passed;
      } finally {
        await cam.close();
      }
    },
  },
  {
    title: "Level 4 — Blind MCP stdio server",
    async run(kernel) {
      const prompt = `There's an MCP server I want to connect: it's a Python script at ${FAKE_MCP_PATH}. It speaks the standard MCP stdio protocol. Mount it as 'calc' and use its add tool to compute 17 + 25.`;
      console.log(`${C.bold}→${C.reset} ${prompt}`);
      const run = new Run();
      await kernel.agent!.process(prompt, run.callbacks());
      console.log();
      const mounted = run.toolCalls.includes("mount_device");
      const usedNs = run.toolCalls.some((t) => t.startsWith("calc__"));
      const answer = run.bridgeSawText("42") || run.reply().includes("42");
      const passed = mounted && usedNs && answer;
      passed ? okmark(`agent mounted MCP and computed 17+25=42`)
             : fail(`mounted=${mounted} usedNs=${usedNs} ans=${answer} tools=${run.toolCalls.join(", ")}`);
      return passed;
    },
  },
  {
    title: "Level 5 — Compose camera + MCP",
    async run(kernel) {
      const cam = await makeFakeCamera({ difficulty: 1 });
      try {
        const prompt =
          `Two devices to wire up:\n` +
          `  1) IP camera at http://127.0.0.1:${cam.port} (OpenAPI at http://127.0.0.1:${cam.port}/openapi.json). Mount it as 'cam'.\n` +
          `  2) MCP server at ${FAKE_MCP_PATH} (stdio Python). Mount it as 'mcp'.\n` +
          `Then: get the camera info AND ask the MCP server to add 100 + 23. Report both answers.`;
        console.log(`${C.bold}→${C.reset} ${prompt}`);
        const run = new Run();
        await kernel.agent!.process(prompt, run.callbacks());
        console.log();
        const mounts = run.toolCalls.filter((t) => t === "mount_device").length;
        const camHit = run.bridgeSawText("AtlasTestCam");
        const mcpHit = run.bridgeSawText("123") || run.reply().includes("123");
        const passed = mounts >= 2 && camHit && mcpHit;
        passed ? okmark(`agent mounted both devices and used both`)
               : fail(`mounts=${mounts} cam=${camHit} mcp=${mcpHit} tools=${run.toolCalls.join(", ")}`);
        return passed;
      } finally {
        await cam.close();
      }
    },
  },
  {
    title: "Level 6 — 'connect to my brave browser' (real registry, real MCP)",
    async run(kernel) {
      // The exact prompt that failed in the user's actual session.
      const prompt = "connect to my brave browser so that you can control it";
      console.log(`${C.bold}→${C.reset} ${prompt}`);
      const run = new Run();
      await kernel.agent!.process(prompt, run.callbacks());
      console.log();
      // Hard pass: agent didn't refuse + tried auto_connect/search_mcp first.
      const triedDiscovery =
        run.toolCalls.includes("auto_connect") ||
        run.toolCalls.includes("search_mcp") ||
        run.toolCalls.includes("install_mcp") ||
        run.toolCalls.includes("mount_device");
      // Soft pass: did it actually mount or surface usable candidates?
      const mountedSomething = run.toolCalls.some((t) => t === "install_mcp" || t === "mount_device");
      const surfacedCandidates = run.toolResults.some(
        ([, r]) => r.includes('"candidates"') || r.includes('"status":'),
      );
      const reflexFail =
        run.reply().toLowerCase().includes("i can't") ||
        run.reply().toLowerCase().includes("i cannot") ||
        run.reply().toLowerCase().includes("don't have access");
      const passed = triedDiscovery && !reflexFail;
      passed
        ? okmark(`agent reached for tools (mounted=${mountedSomething} surfaced=${surfacedCandidates})`)
        : fail(`triedDiscovery=${triedDiscovery} reflexRefusal=${reflexFail} tools=${run.toolCalls.join(", ")}`);
      return passed;
    },
  },
];

// ─── entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const { kernel, devices } = await bootAtlas();
  const results: Array<{ title: string; passed: boolean; ms: number; error?: string }> = [];
  try {
    for (const s of scenarios) {
      banner(s.title);
      const t0 = Date.now();
      let passed = false;
      let error: string | undefined;
      try {
        passed = await s.run(kernel, devices);
      } catch (e: any) {
        error = `${e?.name}: ${e?.message}`;
        console.error(error);
      }
      results.push({ title: s.title, passed, ms: Date.now() - t0, error });
      await resetDevices(kernel, devices);
    }
  } finally {
    await kernel.unloadAll();
  }
  banner("RESULTS");
  for (const r of results) {
    const mark = r.passed ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`  ${mark}  ${r.title}  (${(r.ms / 1000).toFixed(1)}s)${r.error ? "  — " + r.error : ""}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${C.bold}${passed}/${results.length} scenarios passed${C.reset}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
