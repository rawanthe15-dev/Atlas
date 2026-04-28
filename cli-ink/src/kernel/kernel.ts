import { ToolRegistry } from "../tools/registry.js";
import type { MemoryBackend } from "../memory/backend.js";
import type { Agent } from "../agent/agent.js";
import type { AtlasConfig } from "../config/config.js";
import type { AtlasPlugin } from "./plugin.js";
import type { SlashCommand } from "./types.js";
import type { Client, Guild } from "discord.js";
import type { TodoStore } from "../memory/todos.js";

/**
 * Channel-specific runtime context plugins expose so tools can drive
 * external services. Set by DiscordPlugin once the gateway is ready.
 */
export interface DiscordContext {
  client: Client;
  /** Guild the bot most recently saw a message in, or the only guild it's in. */
  getActiveGuild: () => Guild | undefined;
}

/**
 * Atlas's central runtime. Everything user-facing — channels (CLI, future
 * Telegram, voice) — talks to this instead of constructing tools / agents
 * inline. Plugins register tools, commands, and the memory backend during
 * `load()`. The kernel does NOT own UI state; it only owns the headless
 * runtime that any frontend can drive.
 */
export class Kernel {
  config: AtlasConfig;
  tools: ToolRegistry = new ToolRegistry();
  commands: Map<string, SlashCommand> = new Map();
  /** Set by memory-plugin during load. */
  memory!: MemoryBackend;
  /** Set by agent-plugin during load. */
  agent!: Agent;
  /** Persistent todo store — set by tools-plugin during load. */
  todos!: TodoStore;
  /** Brave API key snapshot — tools-plugin re-reads on reload. */
  braveApiKey?: string;
  /** Set by DiscordPlugin once the gateway is ready, so tools can act on the live client. */
  discord?: DiscordContext;

  private plugins: AtlasPlugin[] = [];

  constructor(config: AtlasConfig) {
    this.config = config;
  }

  registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  unregisterCommand(name: string): void {
    this.commands.delete(name);
  }

  /** Returns `{ "/help": "...", "/clear": "..." }` for the autocomplete dropdown. */
  getCommandsAsRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, cmd] of this.commands) out[name] = cmd.description;
    return out;
  }

  async load(plugin: AtlasPlugin): Promise<void> {
    await plugin.load(this);
    this.plugins.push(plugin);
  }

  async unloadAll(): Promise<void> {
    for (const p of [...this.plugins].reverse()) {
      try {
        await p.unload?.();
      } catch {
        // best-effort
      }
    }
    this.plugins = [];
  }

  /** Snapshot the loaded plugin names — useful for /version output. */
  loadedPlugins(): string[] {
    return this.plugins.map((p) => p.name);
  }

  /** Update the in-memory config snapshot (e.g. after the user edits via /config). */
  setConfig(next: AtlasConfig): void {
    this.config = next;
  }
}
