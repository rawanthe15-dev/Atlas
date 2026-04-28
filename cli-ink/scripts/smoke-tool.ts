import { loadConfig } from "../src/config/config.js";
import { Agent } from "../src/agent/agent.js";
import { buildDefaultRegistry } from "../src/tools/registry.js";

const cfg = loadConfig();
const agent = new Agent({
  apiKey: cfg.openrouter!.api_key!,
  baseUrl: cfg.openrouter?.base_url ?? "https://openrouter.ai/api/v1/chat/completions",
  model: "deepseek/deepseek-chat",
  tools: buildDefaultRegistry(),
});

const final = await agent.process(
  "list the files in /Users/rawan/Downloads/Atlas — show the entries",
  {
    onToken: (t) => process.stdout.write(t),
    onToolCall: (n, a) => process.stdout.write(`\n[tool:${n} args=${a.slice(0,80)}]\n`),
    onToolResult: (n, r) => process.stdout.write(`\n[result of ${n}: ${r.slice(0,200).replace(/\n/g, " | ")}]\n`),
  },
);
console.log("\n---\nfinal length:", final.length);
