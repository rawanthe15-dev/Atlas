import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Guild,
  type Message,
  type OmitPartialGroupDMChannel,
  type SendableChannels,
} from "discord.js";
import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";
import { makeDiscordTools } from "../tools/discord-tools.js";

export type DiscordLogLevel = "info" | "warn" | "error";
export type DiscordLogFn = (level: DiscordLogLevel, message: string) => void;

export interface DiscordPluginOpts {
  token: string;
  /** Discord user IDs allowed to chat with the bot. Empty/missing = anyone. */
  allowedUserIds?: string[];
  /**
   * Where to send status messages. Set this when running inside the Ink
   * CLI so logs route to system lines instead of stdout (which would
   * corrupt the rendered UI). Defaults to `console.{level}`.
   */
  onLog?: DiscordLogFn;
}

const ACK_PLACEHOLDER = "⏺ thinking…";
const EDIT_THROTTLE_MS = 1500;
const MAX_DISCORD_LEN = 1980; // 2000 limit minus a small buffer

/**
 * Discord channel for Atlas. Listens for DMs (always) and guild messages
 * (only when @mentioned), runs them through `kernel.agent.process()`, and
 * stream-edits the reply back as the model produces tokens. Multi-message
 * responses split on `MAX_DISCORD_LEN`.
 *
 * Requires the Discord application to have the MESSAGE CONTENT intent
 * enabled (Developer Portal → Bot → Privileged Gateway Intents).
 */
export class DiscordPlugin implements AtlasPlugin {
  name = "discord";
  version = "0.3.0";

  private client?: Client;
  private kernel?: Kernel;
  private connected = false;
  private botTag = "(connecting…)";
  private activeGuildId?: string;

  constructor(private opts: DiscordPluginOpts) {}

  load(kernel: Kernel): void {
    this.kernel = kernel;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (c) => {
      this.connected = true;
      this.botTag = c.user.tag;
      this.log("info", `connected as ${c.user.tag}`);

      // Expose to the rest of the kernel so tools can drive the live client.
      if (this.client) {
        kernel.discord = {
          client: this.client,
          getActiveGuild: () => this.getActiveGuild(),
        };
      }

      const guilds = c.guilds.cache;
      if (guilds.size === 0) {
        this.log(
          "warn",
          "bot is in 0 servers — Discord will NOT deliver DMs from anyone you don't share a server with. Invite via Developer Portal → OAuth2 → URL Generator → scope=bot.",
        );
      } else {
        const names = guilds.map((g) => g.name).slice(0, 3).join(", ");
        this.log(
          "info",
          `in ${guilds.size} server(s): ${names}${guilds.size > 3 ? ` (+${guilds.size - 3} more)` : ""}`,
        );
        // Default the active guild to the only one if it's unique.
        if (guilds.size === 1) this.activeGuildId = guilds.first()!.id;
      }

      const allowList = this.opts.allowedUserIds ?? [];
      if (allowList.length === 0) {
        this.log(
          "warn",
          "no allowed_users — bot will respond to anyone who can DM/@mention it. set discord.allowed_users in config.toml.",
        );
      } else {
        this.log("info", `restricted to ${allowList.length} user(s)`);
      }
    });

    this.client.on(Events.Error, (e) => {
      this.log("error", `gateway error: ${e.message}`);
    });

    this.client.on(Events.MessageCreate, (msg) => {
      // Wrap in try/catch so a bad event never silently kills future ones.
      try {
        const isPartial = (msg as any).partial === true;
        const channelType = (msg.channel as any)?.type;
        const len = msg.content?.length ?? 0;
        if (!msg.author?.bot) {
          const where = msg.guild
            ? `guild=${msg.guild.name}`
            : `DM channelType=${channelType}`;
          this.log(
            "info",
            `← ${msg.author?.tag ?? "(?)"} (${where}) · ${len} chars${
              isPartial ? " PARTIAL" : ""
            }${len === 0 && !isPartial ? " ⚠ empty (MESSAGE_CONTENT intent missing?)" : ""}`,
          );
        }
        void this.handleMessage(msg, isPartial);
      } catch (e: any) {
        this.log("error", `MessageCreate crashed: ${e?.message ?? e}`);
      }
    });

    // Background login — don't block the host on the gateway handshake.
    this.client.login(this.opts.token).catch((e: any) => {
      this.connected = false;
      this.log("error", `login failed: ${e?.message ?? e}`);
    });

    kernel.registerCommand({
      name: "/discord",
      description: "Show the Discord bot's connection status",
      handler: () => {
        if (!this.connected) {
          return { kind: "text", text: `discord: connecting as ${this.botTag}…`, dim: true };
        }
        const allow = this.opts.allowedUserIds ?? [];
        const where = allow.length > 0 ? `${allow.length} allowed user(s)` : "anyone (unrestricted)";
        const guild = this.getActiveGuild();
        const guildText = guild ? ` · active guild: ${guild.name}` : "";
        return {
          kind: "text",
          text: `discord: ✓ connected as ${this.botTag} · ${where}${guildText}`,
          color: "cyan",
        };
      },
    });

    // Register the server-management tools so the model can call them.
    const tools = makeDiscordTools(() => kernel.discord);
    for (const t of tools) kernel.tools.register(t);
  }

  async unload(): Promise<void> {
    this.connected = false;
    if (this.kernel) this.kernel.discord = undefined;
    await this.client?.destroy();
    this.client = undefined;
  }

  private log(level: DiscordLogLevel, message: string): void {
    if (this.opts.onLog) {
      this.opts.onLog(level, message);
      return;
    }
    if (level === "error") console.error(`[discord] ${message}`);
    else if (level === "warn") console.warn(`[discord] ${message}`);
    else console.log(`[discord] ${message}`);
  }

  private getActiveGuild(): Guild | undefined {
    if (!this.client) return undefined;
    if (this.activeGuildId) {
      const g = this.client.guilds.cache.get(this.activeGuildId);
      if (g) return g;
    }
    if (this.client.guilds.cache.size === 1) {
      return this.client.guilds.cache.first();
    }
    return undefined;
  }

  private async handleMessage(
    rawMsg: OmitPartialGroupDMChannel<Message<boolean>>,
    isPartial: boolean,
  ): Promise<void> {
    let msg = rawMsg as Message;

    // If the message arrived partial (channel uncached, etc.) fetch the full
    // payload before we do anything that touches msg.content / msg.channel.
    if (isPartial) {
      try {
        msg = (await msg.fetch()) as Message;
      } catch (e: any) {
        this.log("error", `partial message fetch failed: ${e?.message ?? e}`);
        return;
      }
    }

    if (msg.author.bot) return;
    if (!this.kernel || !this.client?.user) return;

    // Track the active guild for tool invocations.
    if (msg.guild) this.activeGuildId = msg.guild.id;

    // In guilds we only respond when explicitly @mentioned — DMs always respond.
    if (msg.guild && !msg.mentions.users.has(this.client.user.id)) return;

    const allow = this.opts.allowedUserIds;
    if (allow && allow.length > 0 && !allow.includes(msg.author.id)) {
      try {
        await msg.reply("hi — I'm Atlas, but I'm only set up to chat with my owner.");
      } catch {
        // best-effort
      }
      return;
    }

    // Strip the bot's @mention from guild messages so the model sees a clean prompt.
    let content = msg.content?.trim() ?? "";
    if (msg.guild) {
      const me = this.client.user.id;
      content = content.replace(new RegExp(`<@!?${me}>`, "g"), "").trim();
    }
    if (!content) {
      try {
        const hint = msg.guild
          ? "you @mentioned me but didn't say anything — what would you like to ask?"
          : "I can see your message but its content is empty — please enable **MESSAGE CONTENT INTENT** for this bot in the Discord Developer Portal.";
        await msg.reply(hint);
      } catch {}
      return;
    }

    // For DMs we may need to fetch the channel as well so .send() works.
    let channel: SendableChannels;
    try {
      const ch = msg.channel.partial ? await msg.channel.fetch() : msg.channel;
      channel = ch as SendableChannels;
    } catch (e: any) {
      this.log("error", `channel fetch failed: ${e?.message ?? e}`);
      return;
    }

    // Fetch the last ~15 messages so Atlas can see what was already said
    // in this channel/DM and continue work it committed to earlier. Best-
    // effort: if the fetch fails (rate-limit, intent issue, etc.) we just
    // proceed without history.
    let chatHistoryBlock = "";
    try {
      const fetchable = channel as any;
      if (typeof fetchable.messages?.fetch === "function") {
        const recent = await fetchable.messages.fetch({ limit: 15, before: msg.id });
        const lines: string[] = [];
        for (const m of [...recent.values()].reverse()) {
          const author = m.author?.bot ? "Atlas" : m.author?.username ?? "user";
          const text = (m.content ?? "").replace(/\n/g, " ").slice(0, 500);
          if (text) lines.push(`${author}: ${text}`);
        }
        if (lines.length > 0) {
          const surface = msg.guild ? `#${(channel as any).name ?? "channel"} in ${msg.guild.name}` : "DM";
          chatHistoryBlock =
            `--- Recent ${surface} messages (oldest first) ---\n` +
            lines.join("\n") +
            `\n--- end of recent messages ---\n\n`;
        }
      }
    } catch (e: any) {
      this.log("warn", `failed to fetch channel history: ${e?.message ?? e}`);
    }

    const augmentedContent = chatHistoryBlock
      ? `${chatHistoryBlock}New message from ${msg.author.username}: ${content}`
      : content;

    let ack: Message;
    try {
      ack = await channel.send(ACK_PLACEHOLDER);
    } catch (e: any) {
      this.log("error", `failed to send ack: ${e?.message ?? e}`);
      return;
    }

    let buf = "";
    let lastEdit = 0;
    let pendingEdit = Promise.resolve();
    const ctrl = new AbortController();

    const flush = async (final: boolean): Promise<void> => {
      await pendingEdit.catch(() => undefined);
      const text = buf.length === 0 ? (final ? "(empty response)" : ACK_PLACEHOLDER) : buf;
      const visible = text.length > MAX_DISCORD_LEN ? text.slice(0, MAX_DISCORD_LEN) + " ⋯" : text;
      lastEdit = Date.now();
      pendingEdit = ack
        .edit(visible)
        .then(() => undefined)
        .catch((e) => {
          this.log("error", `edit failed: ${e?.message ?? e}`);
        });
      await pendingEdit;
    };

    try {
      await this.kernel.agent.process(
        augmentedContent,
        {
          onToken: (t) => {
            buf += t;
            if (Date.now() - lastEdit >= EDIT_THROTTLE_MS) {
              void flush(false);
            }
          },
          onToolCall: (name) => {
            const hint = buf ? buf : `${ACK_PLACEHOLDER}\n\n_calling ${name}…_`;
            if (!buf) {
              ack.edit(hint).catch(() => undefined);
            }
          },
        },
        ctrl.signal,
      );
    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      buf = `✗ ${errMsg}`;
      await flush(true);
      return;
    }

    if (buf.length <= MAX_DISCORD_LEN) {
      buf = buf || "(empty response)";
      await flush(true);
      return;
    }
    const head = buf.slice(0, MAX_DISCORD_LEN);
    await pendingEdit.catch(() => undefined);
    await ack.edit(head).catch(() => undefined);
    let pos = MAX_DISCORD_LEN;
    while (pos < buf.length) {
      const chunk = buf.slice(pos, pos + MAX_DISCORD_LEN);
      try {
        await channel.send(chunk);
      } catch (e: any) {
        this.log("error", `follow-up send failed: ${e?.message ?? e}`);
        break;
      }
      pos += MAX_DISCORD_LEN;
    }
  }
}
