/**
 * Direct probe: install + smoke-test the real broken playwright MCP package
 * so we can see whether DevicesPlugin's smoke test now correctly rejects it
 * (without depending on the LLM's behavior).
 */
import { Kernel } from "../src/kernel/kernel.js";
import { CorePlugin } from "../src/plugins/core-plugin.js";
import { ConfigPlugin } from "../src/plugins/config-plugin.js";
import { SessionsPlugin } from "../src/plugins/sessions-plugin.js";
import { OnboardingPlugin } from "../src/plugins/onboarding-plugin.js";
import { MemoryPlugin } from "../src/plugins/memory-plugin.js";
import { ToolsPlugin } from "../src/plugins/tools-plugin.js";
import { DevicesPlugin } from "../src/plugins/devices-plugin.js";
import { loadConfig } from "../src/config/config.js";
import type { MCPCandidate } from "../src/bridges/registry.js";

async function main() {
  const config = loadConfig();
  (config as any).devices = { install_policy: "auto" };
  const kernel = new Kernel(config);
  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin({ shellConfirm: async () => true }));
  const devices = new DevicesPlugin();
  await kernel.load(devices);

  // Force the candidate as "trusted" so the install runs without confirm.
  (devices as any).installPolicy.trustedSources.push("npm:@executeautomation/*");

  const cand: MCPCandidate = {
    id: "@executeautomation/playwright-mcp-server",
    source: "npm",
    name: "playwright-mcp-server",
    description: "Playwright MCP server",
    installCommand: "npx -y @executeautomation/playwright-mcp-server",
    transport: "stdio",
    homepage: "",
    score: 1,
  };

  console.log("Installing and mounting (with smoke test)...");
  try {
    const record = await devices.installAndMountMcp(cand, "brave");
    console.log("✗ FAILED — installAndMountMcp returned success!");
    console.log("  Got tools:", record.toolNames.slice(0, 6).join(", "), "...");
    console.log("  Smoke test failed to catch the broken runtime.");
    process.exit(1);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.log(`Caught error: ${msg.slice(0, 300)}`);
    if (msg.includes("runtime is missing") || msg.includes("Executable doesn") || msg.includes("smoke test")) {
      console.log("✓ PASS — smoke test correctly rejected the broken MCP.");
      process.exit(0);
    } else {
      console.log("? unclear — error was caught but not the expected pattern");
      process.exit(2);
    }
  } finally {
    await kernel.unloadAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
