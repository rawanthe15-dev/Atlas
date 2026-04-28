import {
  ChannelType,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Role,
} from "discord.js";
import type { Tool } from "./tool.js";
import type { DiscordContext } from "../kernel/kernel.js";

type GetDiscord = () => DiscordContext | undefined;

function resolveGuild(get: GetDiscord, requestedId?: string): Guild | { error: string } {
  const ctx = get();
  if (!ctx) return { error: "Discord channel is not connected. Set discord.token + enabled=true in config." };
  if (requestedId) {
    const g = ctx.client.guilds.cache.get(requestedId);
    if (!g) return { error: `bot is not in guild '${requestedId}'.` };
    return g;
  }
  const g = ctx.getActiveGuild();
  if (!g) return { error: "no active Discord server. Send a message in a server first or pass guild_id." };
  return g;
}

function channelTypeFromString(s: string): ChannelType | null {
  switch (s.toLowerCase()) {
    case "text":
      return ChannelType.GuildText;
    case "voice":
      return ChannelType.GuildVoice;
    case "category":
      return ChannelType.GuildCategory;
    case "announcement":
    case "news":
      return ChannelType.GuildAnnouncement;
    case "stage":
      return ChannelType.GuildStageVoice;
    case "forum":
      return ChannelType.GuildForum;
    default:
      return null;
  }
}

function describeChannel(c: GuildBasedChannel): string {
  const typeLabel: Partial<Record<ChannelType, string>> = {
    [ChannelType.GuildText]: "text",
    [ChannelType.GuildVoice]: "voice",
    [ChannelType.GuildCategory]: "category",
    [ChannelType.GuildAnnouncement]: "announcement",
    [ChannelType.GuildStageVoice]: "stage",
    [ChannelType.GuildForum]: "forum",
  };
  const type = typeLabel[c.type as ChannelType] ?? `type:${c.type}`;
  const parent = "parent" in c && c.parent ? ` (in ${c.parent.name})` : "";
  return `${c.id}  ${type.padEnd(13)} #${c.name}${parent}`;
}

function describeRole(r: Role): string {
  return `${r.id}  ${r.hexColor}  ${r.name}${r.hoist ? "  [hoisted]" : ""}${r.mentionable ? "  [mentionable]" : ""}`;
}

function permsFromStrings(names: string[]): bigint {
  const bits = PermissionsBitField.Flags as unknown as Record<string, bigint>;
  let total = 0n;
  for (const n of names) {
    const key = n.toUpperCase();
    if (key in bits) total |= bits[key];
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────

export function makeDiscordTools(getDiscord: GetDiscord): Tool[] {
  return [
    // discovery
    listGuilds(getDiscord),
    listChannels(getDiscord),
    listRoles(getDiscord),
    listMembers(getDiscord),
    getChannelInfo(getDiscord),
    readChannel(getDiscord),
    getMember(getDiscord),
    // channel CRUD
    createChannel(getDiscord),
    createCategory(getDiscord),
    deleteChannel(getDiscord),
    editChannel(getDiscord),
    setChannelTopic(getDiscord),
    moveChannel(getDiscord),
    setChannelPermissions(getDiscord),
    // messages
    sendMessage(getDiscord),
    sendEmbed(getDiscord),
    editMessage(getDiscord),
    deleteMessage(getDiscord),
    pinMessage(getDiscord),
    unpinMessage(getDiscord),
    purgeMessages(getDiscord),
    // roles
    createRole(getDiscord),
    deleteRole(getDiscord),
    editRole(getDiscord),
    addRoleToMember(getDiscord),
    removeRoleFromMember(getDiscord),
    // members & moderation
    setMemberNickname(getDiscord),
    kickMember(getDiscord),
    banMember(getDiscord),
    timeoutMember(getDiscord),
    sendDM(getDiscord),
    // server-level
    setServerName(getDiscord),
    // the killer one-shot
    setupServer(getDiscord),
  ];
}

function listGuilds(get: GetDiscord): Tool {
  return {
    name: "discord_list_guilds",
    description: "List Discord servers (guilds) the bot is in. Returns id and name per guild.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      const guilds = ctx.client.guilds.cache;
      if (guilds.size === 0) return "(none)";
      return [...guilds.values()].map((g) => `${g.id}  ${g.name}  (${g.memberCount} members)`).join("\n");
    },
  };
}

function listChannels(get: GetDiscord): Tool {
  return {
    name: "discord_list_channels",
    description: "List all channels in a Discord server, grouped by type. Defaults to the active server.",
    parameters: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Optional. Discord guild ID." },
      },
      required: [],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      const channels = [...r.channels.cache.values()].sort((a, b) => {
        const pa = "position" in a ? a.position : 0;
        const pb = "position" in b ? b.position : 0;
        return pa - pb;
      });
      if (channels.length === 0) return "(no channels)";
      return channels.map(describeChannel).join("\n");
    },
  };
}

function listRoles(get: GetDiscord): Tool {
  return {
    name: "discord_list_roles",
    description: "List all roles in a Discord server with id, color, and flags.",
    parameters: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Optional. Discord guild ID." },
      },
      required: [],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      const roles = [...r.roles.cache.values()].sort((a, b) => b.position - a.position);
      return roles.map(describeRole).join("\n");
    },
  };
}

function listMembers(get: GetDiscord): Tool {
  return {
    name: "discord_list_members",
    description:
      "List members of a Discord server (max 50). Useful to inspect who's in the server before assigning roles.",
    parameters: {
      type: "object",
      properties: {
        guild_id: { type: "string", description: "Optional. Discord guild ID." },
      },
      required: [],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const members = await r.members.fetch({ limit: 50 });
        return [...members.values()]
          .map((m) => `${m.id}  ${m.user.tag}${m.user.bot ? "  [bot]" : ""}`)
          .join("\n");
      } catch (e: any) {
        return `error: ${e?.message ?? e} — fetching members may require GUILD_MEMBERS intent (privileged).`;
      }
    },
  };
}

function getChannelInfo(get: GetDiscord): Tool {
  return {
    name: "discord_get_channel_info",
    description:
      "Get full details of a Discord channel by id: name, type, topic, parent category, position, NSFW flag, slowmode. Use this to read a channel's pinned topic/description.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel ID to inspect." },
      },
      required: ["channel_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch) return "channel not found.";
        const lines: string[] = [`id: ${ch.id}`, `type: ${ch.type}`];
        const a = ch as any;
        if (a.name) lines.push(`name: ${a.name}`);
        if (a.topic != null) lines.push(`topic: ${a.topic || "(empty)"}`);
        if (a.parent?.name) lines.push(`parent: ${a.parent.name}`);
        if (a.parentId) lines.push(`parent_id: ${a.parentId}`);
        if (typeof a.position === "number") lines.push(`position: ${a.position}`);
        if (typeof a.nsfw === "boolean") lines.push(`nsfw: ${a.nsfw}`);
        if (typeof a.rateLimitPerUser === "number") lines.push(`slowmode_seconds: ${a.rateLimitPerUser}`);
        return lines.join("\n");
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function readChannel(get: GetDiscord): Tool {
  return {
    name: "discord_read_channel",
    description:
      "Read recent messages from ANY Discord channel by id (text, announcement, or DM). Returns timestamp, author, content, and any attachment/embed URLs. Use this to inspect what's in another channel before acting — e.g. find a Google Sheet link posted in #litbuy.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The channel ID to read from." },
        limit: { type: "number", description: "How many messages to fetch. Default 20, max 50." },
      },
      required: ["channel_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch) return "channel not found.";
        const fetchable = ch as any;
        if (typeof fetchable.messages?.fetch !== "function") {
          return "this channel type doesn't store messages (maybe a category or voice channel).";
        }
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
        const messages = await fetchable.messages.fetch({ limit });
        const list = [...messages.values()].sort(
          (a: any, b: any) => a.createdTimestamp - b.createdTimestamp,
        );
        const lines: string[] = [];
        for (const m of list as any[]) {
          const author = m.author?.bot ? `[bot]${m.author.username}` : (m.author?.username ?? "?");
          const time = new Date(m.createdTimestamp).toISOString().slice(0, 16).replace("T", " ");
          const text = (m.content ?? "").slice(0, 800);
          const attUrls: string[] = m.attachments?.size
            ? [...m.attachments.values()].map((a: any) => a.url)
            : [];
          const embedUrls: string[] = m.embeds?.length
            ? m.embeds.map((e: any) => e.url || e.title).filter(Boolean)
            : [];
          let entry = `[${time}] ${author}: ${text}`;
          if (attUrls.length) entry += `\n   attachments: ${attUrls.join("  ")}`;
          if (embedUrls.length) entry += `\n   embeds: ${embedUrls.join("  ")}`;
          lines.push(entry);
        }
        if (lines.length === 0) return "(no messages)";
        return lines.join("\n");
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function createChannel(get: GetDiscord): Tool {
  return {
    name: "discord_create_channel",
    description:
      "Create a Discord channel. Types: text, voice, category, announcement, stage, forum. Optional parent_id places it under a category.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Channel name (no leading #)." },
        type: {
          type: "string",
          description: "One of: text, voice, category, announcement, stage, forum",
        },
        parent_id: { type: "string", description: "Optional. Category ID to nest under." },
        topic: { type: "string", description: "Optional channel topic (text channels only)." },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["name", "type"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      const t = channelTypeFromString(String(args.type ?? ""));
      if (t === null) return `Tool error: unknown channel type '${args.type}'.`;
      try {
        const channel = await r.channels.create({
          name: String(args.name),
          type: t as any,
          parent: args.parent_id ? String(args.parent_id) : undefined,
          topic: args.topic ? String(args.topic) : undefined,
        });
        return `created: ${describeChannel(channel as any)}`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function createCategory(get: GetDiscord): Tool {
  return {
    name: "discord_create_category",
    description: "Create a category (a channel container). Equivalent to discord_create_channel with type='category'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Category name." },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["name"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const c = await r.channels.create({
          name: String(args.name),
          type: ChannelType.GuildCategory,
        });
        return `created category: ${c.id}  ${c.name}`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function deleteChannel(get: GetDiscord): Tool {
  return {
    name: "discord_delete_channel",
    description: "Delete a Discord channel by id. Categories can only be deleted when empty.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel ID to delete." },
      },
      required: ["channel_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch) return "channel not found.";
        if (!("delete" in ch)) return "this channel type is not deletable.";
        await ch.delete();
        return `deleted ${args.channel_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function setChannelTopic(get: GetDiscord): Tool {
  return {
    name: "discord_set_channel_topic",
    description: "Set the topic (description) of a text or announcement channel.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        topic: { type: "string", description: "New topic. Empty string clears it." },
      },
      required: ["channel_id", "topic"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("setTopic" in ch)) return "channel doesn't support topics.";
        await (ch as any).setTopic(String(args.topic));
        return "topic updated.";
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function moveChannel(get: GetDiscord): Tool {
  return {
    name: "discord_move_channel",
    description: "Move a channel into a category (or remove it from one) by setting its parent.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        parent_id: {
          type: "string",
          description: "Category id, or empty string to remove from any category.",
        },
      },
      required: ["channel_id", "parent_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("setParent" in ch)) return "channel doesn't support categories.";
        const parent = String(args.parent_id) || null;
        await (ch as any).setParent(parent, { lockPermissions: false });
        return parent ? `moved to ${parent}.` : "removed from category.";
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function sendMessage(get: GetDiscord): Tool {
  return {
    name: "discord_send_message",
    description: "Post a message in a Discord text channel by channel id. Use for posting rules, announcements, etc.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        content: { type: "string", description: "Message content (markdown supported)." },
      },
      required: ["channel_id", "content"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("send" in ch)) return "channel is not sendable.";
        const sent = await (ch as any).send(String(args.content));
        return `sent message ${sent.id} in #${(ch as any).name ?? args.channel_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function createRole(get: GetDiscord): Tool {
  return {
    name: "discord_create_role",
    description:
      "Create a server role. Permissions are an array of permission names (e.g. ADMINISTRATOR, KICK_MEMBERS, MANAGE_MESSAGES, VIEW_CHANNEL, SEND_MESSAGES, CONNECT, SPEAK).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        color: { type: "string", description: "Hex color like '#5865F2' (optional)." },
        hoist: { type: "boolean", description: "Display members of this role separately in the sidebar." },
        mentionable: { type: "boolean", description: "Allow @role mentions." },
        permissions: {
          type: "array",
          description: "Permission names to grant (default: none).",
          items: { type: "string" },
        },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["name"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const perms = Array.isArray(args.permissions) ? permsFromStrings(args.permissions as string[]) : 0n;
        const role = await r.roles.create({
          name: String(args.name),
          color: args.color ? (String(args.color) as any) : undefined,
          hoist: Boolean(args.hoist),
          mentionable: Boolean(args.mentionable),
          permissions: perms,
        });
        return `created role: ${describeRole(role)}`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function deleteRole(get: GetDiscord): Tool {
  return {
    name: "discord_delete_role",
    description: "Delete a role by id.",
    parameters: {
      type: "object",
      properties: {
        role_id: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["role_id"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const role = await r.roles.fetch(String(args.role_id));
        if (!role) return "role not found.";
        await role.delete();
        return `deleted role ${args.role_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function setServerName(get: GetDiscord): Tool {
  return {
    name: "discord_set_server_name",
    description: "Rename the Discord server.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["name"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        await r.setName(String(args.name));
        return `server renamed to '${args.name}'.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Permission-overwrite helpers (used by setChannelPermissions + setup_server)
// ─────────────────────────────────────────────────────────────────────

interface PermOverwriteSpec {
  /** Role name (e.g. "@everyone", "Mod", "Seller") or a raw user/role snowflake id. */
  target: string;
  allow?: string[];
  deny?: string[];
}

function resolveOverwriteTarget(guild: Guild, target: string): string | null {
  // Accept @everyone as the guild id, raw snowflakes, or role names.
  if (target === "@everyone" || target === "everyone") return guild.id;
  if (/^\d{15,}$/.test(target)) return target; // already an id
  const role = guild.roles.cache.find((r) => r.name === target);
  return role ? role.id : null;
}

function buildOverwrites(
  guild: Guild,
  specs: PermOverwriteSpec[] | undefined,
): { id: string; allow: bigint; deny: bigint }[] {
  if (!specs) return [];
  const out: { id: string; allow: bigint; deny: bigint }[] = [];
  for (const s of specs) {
    const id = resolveOverwriteTarget(guild, s.target);
    if (!id) continue;
    out.push({
      id,
      allow: permsFromStrings(s.allow ?? []),
      deny: permsFromStrings(s.deny ?? []),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Channel: edit + permission overwrites
// ─────────────────────────────────────────────────────────────────────

function editChannel(get: GetDiscord): Tool {
  return {
    name: "discord_edit_channel",
    description:
      "Edit a channel's name, topic, slowmode, NSFW flag, or position in one call. Pass only the fields you want to change.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        name: { type: "string" },
        topic: { type: "string" },
        slowmode_seconds: { type: "number", description: "0 disables slowmode." },
        nsfw: { type: "boolean" },
        position: { type: "number" },
      },
      required: ["channel_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("edit" in ch)) return "channel not editable.";
        const patch: any = {};
        if (typeof args.name === "string") patch.name = args.name;
        if (typeof args.topic === "string") patch.topic = args.topic;
        if (typeof args.slowmode_seconds === "number") patch.rateLimitPerUser = args.slowmode_seconds;
        if (typeof args.nsfw === "boolean") patch.nsfw = args.nsfw;
        if (typeof args.position === "number") patch.position = args.position;
        await (ch as any).edit(patch);
        return `edited ${args.channel_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function setChannelPermissions(get: GetDiscord): Tool {
  return {
    name: "discord_set_channel_permissions",
    description:
      "Set permission overwrites on a channel for one or more roles/users. Each overwrite has a target (role name like '@everyone' or 'Mod', or a user id) plus allow/deny arrays of permission names. Use to make channels read-only, restrict sending to certain roles, etc.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        overwrites: {
          type: "array",
          description: "List of permission overwrites to apply.",
          items: {
            type: "object",
            properties: {
              target: { type: "string", description: "Role name, '@everyone', or user/role id." },
              allow: { type: "array", items: { type: "string" } },
              deny: { type: "array", items: { type: "string" } },
            },
            required: ["target"],
          },
        },
      },
      required: ["channel_id", "overwrites"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("permissionOverwrites" in ch) || !ch.guild) {
          return "channel doesn't support permission overwrites.";
        }
        const overwrites = buildOverwrites(ch.guild, args.overwrites as PermOverwriteSpec[]);
        for (const o of overwrites) {
          await (ch as any).permissionOverwrites.edit(o.id, {
            ...permsBitsToObject(o.allow, true),
            ...permsBitsToObject(o.deny, false),
          });
        }
        return `applied ${overwrites.length} overwrite(s) to ${args.channel_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

/** Convert an allow/deny bitfield back into discord.js's PermissionOverwriteOptions object form. */
function permsBitsToObject(bits: bigint, allow: boolean): Record<string, boolean> {
  const flags = PermissionsBitField.Flags as unknown as Record<string, bigint>;
  const out: Record<string, boolean> = {};
  for (const [name, bit] of Object.entries(flags)) {
    if ((bits & bit) === bit) out[name] = allow;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Messages: embed, edit, delete, pin/unpin, purge
// ─────────────────────────────────────────────────────────────────────

function sendEmbed(get: GetDiscord): Tool {
  return {
    name: "discord_send_embed",
    description:
      "Post a rich embed message in a channel. Use for announcements, rules, structured content. Color is hex.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Body — markdown supported." },
        color: { type: "string", description: "Hex color like '#5865F2' (optional)." },
        url: { type: "string", description: "Optional link the title points to." },
        footer: { type: "string", description: "Optional footer text." },
        image_url: { type: "string", description: "Optional image at the bottom." },
        thumbnail_url: { type: "string", description: "Optional thumbnail in the corner." },
        fields: {
          type: "array",
          description: "Up to 25 inline-able key/value sections.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              inline: { type: "boolean" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["channel_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("send" in ch)) return "channel not sendable.";
        const embed: any = {};
        if (args.title) embed.title = String(args.title);
        if (args.description) embed.description = String(args.description);
        if (args.url) embed.url = String(args.url);
        if (args.color) embed.color = parseInt(String(args.color).replace(/^#/, ""), 16);
        if (args.footer) embed.footer = { text: String(args.footer) };
        if (args.image_url) embed.image = { url: String(args.image_url) };
        if (args.thumbnail_url) embed.thumbnail = { url: String(args.thumbnail_url) };
        if (Array.isArray(args.fields))
          embed.fields = (args.fields as any[]).slice(0, 25).map((f) => ({
            name: String(f.name),
            value: String(f.value),
            inline: Boolean(f.inline),
          }));
        const sent = await (ch as any).send({ embeds: [embed] });
        return `sent embed ${sent.id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function editMessage(get: GetDiscord): Tool {
  return {
    name: "discord_edit_message",
    description: "Edit a message the bot previously sent. Bots can only edit their own messages.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        message_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["channel_id", "message_id", "content"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("messages" in ch)) return "channel doesn't store messages.";
        const m = await (ch as any).messages.fetch(String(args.message_id));
        await m.edit(String(args.content));
        return `edited message ${args.message_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function deleteMessage(get: GetDiscord): Tool {
  return {
    name: "discord_delete_message",
    description: "Delete a single message by id. Requires MANAGE_MESSAGES for messages from other authors.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["channel_id", "message_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("messages" in ch)) return "channel doesn't store messages.";
        const m = await (ch as any).messages.fetch(String(args.message_id));
        await m.delete();
        return `deleted ${args.message_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function pinMessage(get: GetDiscord): Tool {
  return {
    name: "discord_pin_message",
    description: "Pin a message to the channel.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["channel_id", "message_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("messages" in ch)) return "channel doesn't store messages.";
        const m = await (ch as any).messages.fetch(String(args.message_id));
        await m.pin();
        return `pinned ${args.message_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function unpinMessage(get: GetDiscord): Tool {
  return {
    name: "discord_unpin_message",
    description: "Unpin a previously pinned message.",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["channel_id", "message_id"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("messages" in ch)) return "channel doesn't store messages.";
        const m = await (ch as any).messages.fetch(String(args.message_id));
        await m.unpin();
        return `unpinned ${args.message_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function purgeMessages(get: GetDiscord): Tool {
  return {
    name: "discord_purge_messages",
    description:
      "Bulk-delete the most recent N messages from a channel (max 100, must be under 14 days old per Discord API).",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        count: { type: "number", description: "How many messages to delete (1-100)." },
      },
      required: ["channel_id", "count"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const ch = await ctx.client.channels.fetch(String(args.channel_id));
        if (!ch || !("bulkDelete" in ch)) return "channel doesn't support bulk delete.";
        const n = Math.min(100, Math.max(1, Number(args.count)));
        const deleted = await (ch as any).bulkDelete(n, true);
        return `deleted ${deleted.size} message(s).`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Roles: edit + assign/remove on members
// ─────────────────────────────────────────────────────────────────────

function editRole(get: GetDiscord): Tool {
  return {
    name: "discord_edit_role",
    description: "Edit a role's name, color, permissions, hoist, mentionable, or position.",
    parameters: {
      type: "object",
      properties: {
        role_id: { type: "string" },
        name: { type: "string" },
        color: { type: "string", description: "Hex like '#5865F2'." },
        hoist: { type: "boolean" },
        mentionable: { type: "boolean" },
        position: { type: "number" },
        permissions: { type: "array", items: { type: "string" } },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["role_id"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const role = await r.roles.fetch(String(args.role_id));
        if (!role) return "role not found.";
        const patch: any = {};
        if (typeof args.name === "string") patch.name = args.name;
        if (args.color) patch.color = String(args.color);
        if (typeof args.hoist === "boolean") patch.hoist = args.hoist;
        if (typeof args.mentionable === "boolean") patch.mentionable = args.mentionable;
        if (typeof args.position === "number") patch.position = args.position;
        if (Array.isArray(args.permissions)) patch.permissions = permsFromStrings(args.permissions as string[]);
        await role.edit(patch);
        return `edited role ${role.id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function addRoleToMember(get: GetDiscord): Tool {
  return {
    name: "discord_add_role_to_member",
    description: "Grant a role to a member by user id. Use role names or ids — names are resolved against the active guild.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        role: { type: "string", description: "Role name or id." },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id", "role"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const member = await r.members.fetch(String(args.user_id));
        const roleId = resolveOverwriteTarget(r, String(args.role));
        if (!roleId) return `role '${args.role}' not found.`;
        await member.roles.add(roleId);
        return `granted ${args.role} to ${member.user.tag}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function removeRoleFromMember(get: GetDiscord): Tool {
  return {
    name: "discord_remove_role_from_member",
    description: "Remove a role from a member.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        role: { type: "string", description: "Role name or id." },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id", "role"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const member = await r.members.fetch(String(args.user_id));
        const roleId = resolveOverwriteTarget(r, String(args.role));
        if (!roleId) return `role '${args.role}' not found.`;
        await member.roles.remove(roleId);
        return `removed ${args.role} from ${member.user.tag}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Members: get, nickname, kick, ban, timeout, send_dm
// ─────────────────────────────────────────────────────────────────────

function getMember(get: GetDiscord): Tool {
  return {
    name: "discord_get_member",
    description:
      "Get full info about a server member: user tag, nickname, roles, joined date, premium-since.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const m = await r.members.fetch(String(args.user_id));
        const lines = [
          `id: ${m.id}`,
          `tag: ${m.user.tag}`,
          `nickname: ${m.nickname ?? "(none)"}`,
          `joined: ${m.joinedAt?.toISOString() ?? "(unknown)"}`,
          `roles: ${[...m.roles.cache.values()].filter((r) => r.name !== "@everyone").map((r) => r.name).join(", ") || "(none)"}`,
          `bot: ${m.user.bot}`,
        ];
        return lines.join("\n");
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function setMemberNickname(get: GetDiscord): Tool {
  return {
    name: "discord_set_member_nickname",
    description: "Set a member's server nickname. Empty string clears it.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        nickname: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id", "nickname"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const m = await r.members.fetch(String(args.user_id));
        await m.setNickname(String(args.nickname) || null);
        return `nickname set for ${m.user.tag}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function kickMember(get: GetDiscord): Tool {
  return {
    name: "discord_kick_member",
    description: "Kick a member from the server. They can rejoin with an invite.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        reason: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const m = await r.members.fetch(String(args.user_id));
        await m.kick(args.reason ? String(args.reason) : undefined);
        return `kicked ${m.user.tag}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function banMember(get: GetDiscord): Tool {
  return {
    name: "discord_ban_member",
    description:
      "Ban a member from the server. delete_message_seconds optionally purges their recent messages (max 604800 = 7 days).",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        reason: { type: "string" },
        delete_message_seconds: {
          type: "number",
          description: "Seconds of recent messages to delete (max 604800).",
        },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        await r.members.ban(String(args.user_id), {
          reason: args.reason ? String(args.reason) : undefined,
          deleteMessageSeconds: typeof args.delete_message_seconds === "number"
            ? Math.min(604800, Math.max(0, args.delete_message_seconds))
            : undefined,
        });
        return `banned ${args.user_id}.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function timeoutMember(get: GetDiscord): Tool {
  return {
    name: "discord_timeout_member",
    description:
      "Time out (mute) a member for a given number of seconds. Pass 0 to clear an active timeout.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        duration_seconds: { type: "number", description: "0 to clear, max 28 days = 2419200." },
        reason: { type: "string" },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: ["user_id", "duration_seconds"],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      try {
        const m = await r.members.fetch(String(args.user_id));
        const dur = Number(args.duration_seconds);
        const ms = dur > 0 ? Math.min(2419200, dur) * 1000 : null;
        await m.timeout(ms, args.reason ? String(args.reason) : undefined);
        return ms === null ? `cleared timeout for ${m.user.tag}.` : `timed out ${m.user.tag} for ${dur}s.`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

function sendDM(get: GetDiscord): Tool {
  return {
    name: "discord_send_dm",
    description:
      "Send a direct message to a Discord user by user id. The bot must share a server with the user.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["user_id", "content"],
    },
    async run(args) {
      const ctx = get();
      if (!ctx) return "Discord not connected.";
      try {
        const user = await ctx.client.users.fetch(String(args.user_id));
        const dm = await user.createDM();
        const sent = await dm.send(String(args.content));
        return `DM'd ${user.tag} (message ${sent.id}).`;
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// The blueprint: setup_server — one-shot server transformation
// ─────────────────────────────────────────────────────────────────────

interface BlueprintRole {
  name: string;
  color?: string;
  permissions?: string[];
  hoist?: boolean;
  mentionable?: boolean;
}

interface BlueprintChannel {
  name: string;
  type: string; // text | voice | category | announcement | stage | forum
  topic?: string;
  slowmode_seconds?: number;
  nsfw?: boolean;
  permission_overwrites?: PermOverwriteSpec[];
}

interface BlueprintCategory {
  name: string;
  permission_overwrites?: PermOverwriteSpec[];
  channels?: BlueprintChannel[];
}

function setupServer(get: GetDiscord): Tool {
  return {
    name: "discord_setup_server",
    description:
      "ONE-SHOT server builder: create roles, categories, channels, and apply permission overwrites in a single call. IDEMPOTENT — roles/categories/channels with names that already exist are skipped (won't duplicate). Use this instead of issuing dozens of individual create_channel/create_role calls when restructuring a server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Optional new server name." },
        roles: {
          type: "array",
          description:
            "Roles to create. Each: { name, color?, permissions?: string[], hoist?, mentionable? }. Skipped if a role with the same name already exists.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              color: { type: "string" },
              permissions: { type: "array", items: { type: "string" } },
              hoist: { type: "boolean" },
              mentionable: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        categories: {
          type: "array",
          description:
            "Categories with their channels. Each: { name, permission_overwrites?, channels?: [{ name, type, topic?, slowmode_seconds?, nsfw?, permission_overwrites? }] }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              permission_overwrites: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string" },
                    allow: { type: "array", items: { type: "string" } },
                    deny: { type: "array", items: { type: "string" } },
                  },
                  required: ["target"],
                },
              },
              channels: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", description: "text | voice | announcement | stage | forum" },
                    topic: { type: "string" },
                    slowmode_seconds: { type: "number" },
                    nsfw: { type: "boolean" },
                    permission_overwrites: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          target: { type: "string" },
                          allow: { type: "array", items: { type: "string" } },
                          deny: { type: "array", items: { type: "string" } },
                        },
                        required: ["target"],
                      },
                    },
                  },
                  required: ["name", "type"],
                },
              },
            },
            required: ["name"],
          },
        },
        guild_id: { type: "string", description: "Optional. Defaults to active guild." },
      },
      required: [],
    },
    async run(args) {
      const r = resolveGuild(get, args.guild_id ? String(args.guild_id) : undefined);
      if ("error" in r) return r.error;
      const guild = r;
      const summary: string[] = [];
      const start = Date.now();

      // 1. Server-level rename
      if (typeof args.server_name === "string" && args.server_name && args.server_name !== guild.name) {
        try {
          await guild.setName(args.server_name);
          summary.push(`✓ renamed server to '${args.server_name}'`);
        } catch (e: any) {
          summary.push(`✗ rename failed: ${e?.message ?? e}`);
        }
      }

      // 2. Roles — create missing ones in parallel.
      const roleSpecs = (args.roles ?? []) as BlueprintRole[];
      if (roleSpecs.length > 0) {
        const existingByName = new Set(guild.roles.cache.map((r) => r.name));
        const toCreate = roleSpecs.filter((r) => !existingByName.has(r.name));
        const skipped = roleSpecs.length - toCreate.length;
        const created = await Promise.allSettled(
          toCreate.map((spec) =>
            guild.roles.create({
              name: spec.name,
              color: spec.color as any,
              hoist: spec.hoist,
              mentionable: spec.mentionable,
              permissions: spec.permissions ? permsFromStrings(spec.permissions) : 0n,
            }),
          ),
        );
        const okNames = created
          .map((res, i) => (res.status === "fulfilled" ? toCreate[i].name : null))
          .filter(Boolean);
        const errs = created.filter((r) => r.status === "rejected").length;
        if (okNames.length > 0) summary.push(`✓ created ${okNames.length} role(s): ${okNames.join(", ")}`);
        if (skipped > 0) summary.push(`↺ skipped ${skipped} existing role(s)`);
        if (errs > 0) summary.push(`✗ ${errs} role(s) failed`);
      }

      // 3. Categories — refresh cache so role lookups work for overwrites.
      const categorySpecs = (args.categories ?? []) as BlueprintCategory[];
      if (categorySpecs.length > 0) {
        // Refresh role cache to pick up newly created roles for overwrite resolution.
        await guild.roles.fetch();

        for (const cat of categorySpecs) {
          const existingCat = guild.channels.cache.find(
            (c) => c.type === ChannelType.GuildCategory && c.name === cat.name,
          );
          let parentId: string;
          if (existingCat) {
            summary.push(`↺ category '${cat.name}' already exists`);
            parentId = existingCat.id;
          } else {
            try {
              const newCat = await guild.channels.create({
                name: cat.name,
                type: ChannelType.GuildCategory,
                permissionOverwrites: buildOverwrites(guild, cat.permission_overwrites) as any,
              });
              parentId = newCat.id;
              summary.push(`✓ created category '${cat.name}'`);
            } catch (e: any) {
              summary.push(`✗ category '${cat.name}' failed: ${e?.message ?? e}`);
              continue;
            }
          }

          // Channels under this category, in parallel.
          const channels = cat.channels ?? [];
          if (channels.length > 0) {
            const existingNamesUnderParent = new Set(
              guild.channels.cache
                .filter((c) => "parentId" in c && (c as any).parentId === parentId)
                .map((c) => c.name),
            );
            const toCreate = channels.filter((c) => !existingNamesUnderParent.has(c.name));
            const skipped = channels.length - toCreate.length;
            const created = await Promise.allSettled(
              toCreate.map((spec) => {
                const t = channelTypeFromString(spec.type);
                if (t === null) return Promise.reject(new Error(`bad type '${spec.type}'`));
                return guild.channels.create({
                  name: spec.name,
                  type: t as any,
                  parent: parentId,
                  topic: spec.topic,
                  rateLimitPerUser: spec.slowmode_seconds,
                  nsfw: spec.nsfw,
                  permissionOverwrites: buildOverwrites(guild, spec.permission_overwrites) as any,
                });
              }),
            );
            const okCount = created.filter((r) => r.status === "fulfilled").length;
            const failCount = created.filter((r) => r.status === "rejected").length;
            if (okCount > 0) summary.push(`  ✓ ${okCount} channel(s) under '${cat.name}'`);
            if (skipped > 0) summary.push(`  ↺ ${skipped} existing channel(s) under '${cat.name}'`);
            if (failCount > 0) summary.push(`  ✗ ${failCount} channel(s) under '${cat.name}' failed`);
          }
        }
      }

      const ms = Date.now() - start;
      summary.push(`done in ${ms}ms.`);
      return summary.join("\n");
    },
  };
}
