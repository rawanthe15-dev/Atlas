#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App, type DiscordLogEntry } from "./App.js";
import { loadConfig } from "./config/config.js";
import { Kernel } from "./kernel/kernel.js";
import { MemoryPlugin } from "./plugins/memory-plugin.js";
import { ToolsPlugin } from "./plugins/tools-plugin.js";
import { AgentPlugin } from "./plugins/agent-plugin.js";
import { CorePlugin } from "./plugins/core-plugin.js";
import { ConfigPlugin } from "./plugins/config-plugin.js";
import { SessionsPlugin } from "./plugins/sessions-plugin.js";
import { OnboardingPlugin } from "./plugins/onboarding-plugin.js";
import { DiscordPlugin, type DiscordLogFn } from "./plugins/discord-plugin.js";
import type { ShellConfirmFn } from "./tools/shell.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const kernel = new Kernel(config);

  // ToolsPlugin needs a shell-confirm callback that opens a UI modal —
  // we install a placeholder here and the App overrides it on mount.
  const shellConfirmRef: { current: ShellConfirmFn } = {
    current: async () => false,
  };
  const shellConfirm: ShellConfirmFn = (cmd) => shellConfirmRef.current(cmd);

  // Discord status messages may fire BEFORE the App mounts (gateway login
  // is async). Buffer them in a queue; the App drains on mount and then
  // overrides the ref so subsequent logs go straight to the system line.
  const discordLogQueue: DiscordLogEntry[] = [];
  const discordLogRef: { current: DiscordLogFn } = {
    current: (level, message) => {
      discordLogQueue.push({ level, message, ts: Date.now() });
    },
  };

  await kernel.load(new CorePlugin());
  await kernel.load(new ConfigPlugin());
  await kernel.load(new SessionsPlugin());
  await kernel.load(new OnboardingPlugin());
  await kernel.load(new MemoryPlugin());
  await kernel.load(new ToolsPlugin({ shellConfirm }));
  await kernel.load(new AgentPlugin());

  // Discord auto-loads when a token is present and not explicitly disabled.
  // It's lightweight (one websocket connection + event handlers) and shares
  // the same agent/memory as the CLI.
  const discordEnabled =
    Boolean(config.discord?.token) && config.discord?.enabled !== false;
  if (discordEnabled) {
    await kernel.load(
      new DiscordPlugin({
        token: config.discord!.token!,
        allowedUserIds: config.discord?.allowed_users,
        onLog: (level, message) => discordLogRef.current(level, message),
      }),
    );
  }

  const { waitUntilExit } = render(
    <App
      kernel={kernel}
      shellConfirmRef={shellConfirmRef}
      discordLogRef={discordLogRef}
      discordLogQueue={discordLogQueue}
      discordEnabled={discordEnabled}
    />,
  );
  await waitUntilExit();
  await kernel.unloadAll();
  process.exit(0);
}

void main();
