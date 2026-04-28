// Render the App for one tick to catch obvious startup crashes (bad
// imports, missing context, render-time exceptions). Doesn't run an
// interactive session — just mounts and unmounts.

import React from "react";
import { render } from "ink";
import { App, type DiscordLogEntry } from "../src/App.js";
import { Kernel } from "../src/kernel/kernel.js";
import { CorePlugin } from "../src/plugins/core-plugin.js";
import { ConfigPlugin } from "../src/plugins/config-plugin.js";
import { SessionsPlugin } from "../src/plugins/sessions-plugin.js";
import { OnboardingPlugin } from "../src/plugins/onboarding-plugin.js";
import { MemoryPlugin } from "../src/plugins/memory-plugin.js";
import { ToolsPlugin } from "../src/plugins/tools-plugin.js";
import { AgentPlugin } from "../src/plugins/agent-plugin.js";
import { loadConfig } from "../src/config/config.js";
import type { ShellConfirmFn } from "../src/tools/shell.js";
import type { DiscordLogFn } from "../src/plugins/discord-plugin.js";

async function main() {
  const cfg = loadConfig();
  const kernel = new Kernel(cfg);
  const shellConfirmRef = { current: (async () => false) as ShellConfirmFn };
  const discordLogQueue: DiscordLogEntry[] = [];
  const discordLogRef: { current: DiscordLogFn } = { current: () => undefined };

  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin({ shellConfirm: shellConfirmRef.current }));
  await kernel.load(new AgentPlugin());

  const { unmount } = render(
    <App
      kernel={kernel}
      shellConfirmRef={shellConfirmRef}
      discordLogRef={discordLogRef}
      discordLogQueue={discordLogQueue}
      discordEnabled={false}
    />,
    {
      stdout: process.stderr,
      debug: true,
    },
  );

  await new Promise((r) => setTimeout(r, 350));
  unmount();

  console.log("BOOT_OK");
}

main().catch((e) => {
  console.error("BOOT_FAIL", e);
  process.exit(1);
});
