import { loadConfig } from "../src/config/config.js";
import { Agent } from "../src/agent/agent.js";
import { buildDefaultRegistry } from "../src/tools/registry.js";

async function main() {
  const cfg = loadConfig();
  const apiKey = cfg.openrouter?.api_key;
  if (!apiKey) {
    console.error("no api_key in config.toml");
    process.exit(1);
  }

  const agent = new Agent({
    apiKey,
    baseUrl: cfg.openrouter?.base_url ?? "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.MODEL ?? cfg.openrouter?.default_model ?? "deepseek/deepseek-chat",
    tools: buildDefaultRegistry(),
  });

  const t0 = Date.now();
  let firstTokenAt: number | null = null;
  let nTokens = 0;

  process.stdout.write(`[${agent.getModel()}] `);
  const final = await agent.process("count from 1 to 5, one per line", {
    onToken: (t) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      nTokens += 1;
      process.stdout.write(t);
    },
    onReasoning: () => undefined,
    onToolCall: (name) => process.stdout.write(`\n[tool:${name}]\n`),
  });

  process.stdout.write("\n");
  const total = Date.now() - t0;
  const ttft = firstTokenAt !== null ? firstTokenAt - t0 : null;
  console.log(`---`);
  console.log(`tokens=${nTokens} ttft=${ttft}ms total=${total}ms final.length=${final.length}`);
}

main().catch((e) => {
  console.error("stream smoke failed:", e);
  process.exit(1);
});
