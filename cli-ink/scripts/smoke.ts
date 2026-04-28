// Smoke test: boot the kernel through the same plugin sequence as the
// real CLI launcher, then exercise the bits that don't need an LLM call:
// memory backend init, slash command resolution, onboarding-empty check,
// and (when configured) Discord tool registration.

import { ATLAS_ROOT, loadConfig } from "../src/config/config.js";
import { Kernel } from "../src/kernel/kernel.js";
import { CorePlugin } from "../src/plugins/core-plugin.js";
import { ConfigPlugin } from "../src/plugins/config-plugin.js";
import { SessionsPlugin } from "../src/plugins/sessions-plugin.js";
import { OnboardingPlugin } from "../src/plugins/onboarding-plugin.js";
import { MemoryPlugin } from "../src/plugins/memory-plugin.js";
import { ToolsPlugin } from "../src/plugins/tools-plugin.js";
import { AgentPlugin } from "../src/plugins/agent-plugin.js";
import { DiscordPlugin } from "../src/plugins/discord-plugin.js";
import { userProfileIsEmpty } from "../src/memory/backend.js";
import { completeSlash } from "../src/ui/SlashAutocomplete.js";

async function main() {
  console.log("ATLAS_ROOT:", ATLAS_ROOT);
  const cfg = loadConfig();
  console.log("has api_key:", Boolean(cfg.openrouter?.api_key));
  console.log("default_model:", cfg.openrouter?.default_model ?? "(default)");
  console.log("memory backend (config):", cfg.memory?.backend ?? "file");
  console.log("onboarded:", cfg.atlas?.onboarded === true);

  const kernel = new Kernel(cfg);
  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin());
  await kernel.load(new AgentPlugin());

  if (cfg.discord?.token && cfg.discord?.enabled !== false) {
    await kernel.load(
      new DiscordPlugin({
        token: cfg.discord.token,
        allowedUserIds: cfg.discord.allowed_users,
        // Silent during smoke test.
        onLog: () => undefined,
      }),
    );
  }

  console.log("\nplugins:", kernel.loadedPlugins().join(", "));
  console.log("memory backend (live):", kernel.memory.kind);
  console.log("tools:", kernel.tools.all().map((t) => t.name).join(", "));
  console.log("commands:", [...kernel.commands.keys()].sort().join(", "));

  const soul = await kernel.memory.getSoul();
  const profile = await kernel.memory.getUserProfile();
  console.log("\nsoul (first 80):", soul.slice(0, 80).replace(/\n/g, "\\n"));
  console.log("profile (first 80):", profile.slice(0, 80).replace(/\n/g, "\\n"));
  console.log("profile is empty (skeleton):", userProfileIsEmpty(profile));

  const cmds = kernel.getCommandsAsRecord();
  for (const probe of ["/h", "/me", "/o", "/d"]) {
    console.log(`completeSlash(${probe.padEnd(4)}) ->`, completeSlash(probe, cmds));
  }

  const help = kernel.commands.get("/help");
  if (help) {
    const r = await help.handler({ raw: "/help", arg: "" });
    if (r.kind === "text") console.log("\n/help (head):\n" + r.text.split("\n").slice(0, 4).join("\n"));
  }

  const sessions = await kernel.memory.getRecentSessions(3);
  console.log("\nrecent sessions:", sessions.length);

  console.log("\nALL_GOOD");
  // Discord plugin starts a background WS connection; force-exit so the
  // smoke script doesn't hang waiting for it.
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
