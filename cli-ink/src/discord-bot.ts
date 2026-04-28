#!/usr/bin/env node
/**
 * Atlas Discord bot — headless kernel host. Boots the same kernel as
 * the CLI but loads the Discord channel plugin instead of the Ink UI.
 *
 * Run: `atlas-bot` (after `install.sh`) or `npx tsx src/discord-bot.ts`.
 */

import { loadConfig } from "./config/config.js";
import { Kernel } from "./kernel/kernel.js";
import { CorePlugin } from "./plugins/core-plugin.js";
import { ConfigPlugin } from "./plugins/config-plugin.js";
import { SessionsPlugin } from "./plugins/sessions-plugin.js";
import { OnboardingPlugin } from "./plugins/onboarding-plugin.js";
import { MemoryPlugin } from "./plugins/memory-plugin.js";
import { ToolsPlugin } from "./plugins/tools-plugin.js";
import { AgentPlugin } from "./plugins/agent-plugin.js";
import { DiscordPlugin } from "./plugins/discord-plugin.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  const token = cfg.discord?.token;
  const allowedUsers = cfg.discord?.allowed_users;
  if (!token) {
    console.error("✗ no Discord bot token in config.toml under [discord].token");
    console.error("  add the bot token to ~/Atlas/config.toml or run /config inside `atlas`.");
    process.exit(1);
  }

  if (!cfg.openrouter?.api_key) {
    console.error("✗ no OpenRouter key — the bot can't reply without one.");
    console.error("  run `atlas` once and complete onboarding, then try `atlas-bot` again.");
    process.exit(1);
  }

  const kernel = new Kernel(cfg);
  // Channel plugins (CLI surface) aren't needed here, but the kernel/agent
  // pipeline + tools + memory all are.
  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin());
  await kernel.load(new AgentPlugin());
  await kernel.load(new DiscordPlugin({ token, allowedUserIds: allowedUsers }));

  console.log("[atlas-bot] kernel ready · plugins:", kernel.loadedPlugins().join(", "));

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[atlas-bot] ${sig} received — shutting down`);
    await kernel.unloadAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((e) => {
  console.error("[atlas-bot] fatal:", e);
  process.exit(1);
});
