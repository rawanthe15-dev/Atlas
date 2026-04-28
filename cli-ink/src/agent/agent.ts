import { streamChat, type ChatMessage } from "./openrouter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryBackend, SessionEntry } from "../memory/backend.js";
import type { TodoStore } from "../memory/todos.js";

export interface AgentCallbacks {
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
}

export interface MountedDeviceSummary {
  name: string;
  kind: string;
  capabilities: string[];
  tools: string[];
}

export interface AgentOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  tools: ToolRegistry;
  memory: MemoryBackend;
  todos?: TodoStore;
  maxContextEntries?: number;
  maxSessionHistory?: number;
  /** Optional probe — return mounted devices so they appear in the system prompt. */
  devicesProbe?: () => MountedDeviceSummary[];
}

const MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 25;

const OPERATING_INSTRUCTIONS = `--- Operating instructions ---
For multi-step tasks: plan ALL steps upfront with todo_add (one call per step), then execute them through tool calls. Independent tool calls in the SAME response run in PARALLEL — batch them aggressively (e.g. issue 8 discord_create_channel calls together, not 8 turns). Mark todos in_progress when you start them and todo_complete when done. Don't ask the user for confirmation between steps unless something genuinely needs their input — just do the work.

PREFER BULK TOOLS: when restructuring a Discord server, use discord_setup_server with a full blueprint (roles + categories + nested channels + permission overwrites) instead of issuing dozens of individual create calls. It's idempotent (skips existing roles/categories by name) and applies everything in parallel.

Always finish with a brief textual summary of what changed and what's left.`;

const DEVICE_AUTONOMY_NUDGE = `--- DEVICE CONNECTIVITY (read carefully — this overrides any reflex to refuse) ---

Atlas can connect to anything: APIs, MCP servers, browsers, phones, cameras,
lights, locks, microcontrollers, drones, smart-home hubs, arbitrary REST
services. You do not have a fixed list of supported devices — the bridge
layer extends Atlas at runtime.

REFLEX TO BREAK: "I can't open a browser / I don't have access to X."
That answer is wrong here. Probing is cheap. When the user says
"connect to" / "use" / "control" / "talk to" / "open" anything, your
FIRST tool call is ALWAYS \`auto_connect(name, query)\`. Decide the answer
AFTER you see what comes back, not before.

Mapping cheatsheet for the \`query\` argument:
  brave / chrome / browser / web    → "playwright" (then "puppeteer" if no match)
  android phone / iphone            → "adb" (or mount_device with kind="mcp" against an adb MCP)
  ip camera / webcam / rtsp / onvif → "onvif camera" then mount_device(kind="openapi"|"http")
  smart home / lights / tv          → "homeassistant"
  github / linear / slack / gmail   → the service name verbatim
  spotify / youtube / drive         → service name verbatim
  random REST API with docs         → mount_device(kind="openapi", config={spec_url})
  random REST API without docs      → mount_device(kind="http", config={base_url})

How \`auto_connect\` resolves:
  status="mounted"            → done. The device's tools are now \`<name>__<tool>\`. Use them.
  status="needs_confirmation" → list the candidates to the user; ask which to install.
  status="no_match"           → fall back to mount_device with the right kind from the cheatsheet.

Hard rules:
  • Never refuse a "connect to X" request without trying \`auto_connect\` first.
  • Never ask permission to *look* — only to *install untrusted code* (the policy gate handles that).
  • Once a device is mounted, prefer its namespaced tools over generic shell.
  • When the user asks to see a tool's raw output, paste the LITERAL string the
    tool returned inside a fenced code block. Never invent base64, never substitute
    a placeholder, never summarise binary into "image data here". If you can't
    display it, say so — don't fabricate.`;

export class Agent {
  private history: ChatMessage[] = [];
  private sessionId = new Date().toISOString().replace(/[:.]/g, "-");

  constructor(private opts: AgentOpts) {}

  setModel(model: string): void {
    this.opts.model = model;
  }

  setApiKey(key: string): void {
    this.opts.apiKey = key;
  }

  setMemory(memory: MemoryBackend): void {
    this.opts.memory = memory;
  }

  setTodos(todos: TodoStore): void {
    this.opts.todos = todos;
  }

  getModel(): string {
    return this.opts.model;
  }

  exchangeCount(): number {
    return Math.floor(this.history.length / 2);
  }

  resetHistory(): void {
    this.history = [];
  }

  /** Seed history with prior session entries (for /sessions resume). */
  seedHistory(entries: SessionEntry[], maxPairs = 10): void {
    const recent = entries.slice(-maxPairs);
    for (const e of recent) {
      this.history.push({ role: "user", content: e.user });
      this.history.push({ role: "assistant", content: e.assistant });
    }
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  /** Make the Agent's tools accessible to the App (used by `/tools` listing). */
  getTools(): ToolRegistry {
    return this.opts.tools;
  }

  private async buildSystemPrompt(userInput: string): Promise<string> {
    const mem = this.opts.memory;
    const soul = await mem.getSoul();
    let userProfile = await mem.getUserProfile();
    if (userProfile.length > 6000) userProfile = userProfile.slice(0, 6000) + "\n... (truncated)";

    const memoryHits = await mem.search(userInput, this.opts.maxContextEntries ?? 5);
    const memoryText = memoryHits
      .map((m) => `- [${(m.timestamp ?? "").slice(0, 10)}] ${m.content}`)
      .join("\n");

    const sessions = await mem.getRecentSessions(this.opts.maxSessionHistory ?? 3);
    const sessionText = sessions
      .filter((s) => s.entries.length > 0)
      .map((s) => {
        const last = s.entries[s.entries.length - 1];
        return `[${s.file}] ${JSON.stringify(last).slice(0, 200)}`;
      })
      .join("\n");

    let todoText = "";
    if (this.opts.todos) {
      try {
        const active = await this.opts.todos.getActive();
        if (active.length > 0) {
          todoText = active
            .map((t) => `[${t.id}] [${t.status}] ${t.title}${t.notes ? ` — ${t.notes}` : ""}`)
            .join("\n");
        }
      } catch {
        // ignore — todos are best-effort context
      }
    }

    const sections = [soul];
    sections.push(DEVICE_AUTONOMY_NUDGE);
    // Inject mounted devices so the agent doesn't have to ask "what's
    // connected?" every turn. The kernel ToolRegistry doesn't expose a
    // "is this from devices" flag, so we read names through the agent's
    // optional devicesProbe (set by the App, no-op when absent).
    if (this.opts.devicesProbe) {
      try {
        const devices = this.opts.devicesProbe();
        if (devices.length > 0) {
          const lines = devices.map(
            (d) =>
              `- **${d.name}** (${d.kind}) caps=${d.capabilities.join(", ") || "—"} ` +
              `tools=${d.tools.join(", ") || "(none)"}`,
          );
          sections.push("--- Connected devices ---\n" + lines.join("\n"));
        }
      } catch {
        // best-effort
      }
    }
    if (userProfile.trim()) sections.push(`--- What you know about the user ---\n${userProfile}`);
    if (todoText) {
      sections.push(
        `--- Active todos (resume work, mark items complete as you go) ---\n${todoText}`,
      );
    }
    if (memoryText) sections.push(`--- Relevant memories ---\n${memoryText}`);
    if (sessionText) sections.push(`--- Recent session context ---\n${sessionText}`);
    sections.push(OPERATING_INSTRUCTIONS);
    return sections.join("\n\n");
  }

  /** Run one user turn end-to-end. Streams events via callbacks; returns the final assistant text. */
  async process(userInput: string, cb: AgentCallbacks = {}, signal?: AbortSignal): Promise<string> {
    const systemPrompt = await this.buildSystemPrompt(userInput);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
      { role: "user", content: userInput },
    ];

    const toolSchemas = this.opts.tools.schemas();
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const tokens: string[] = [];
      const toolCalls: { id: string; name: string; arguments: string }[] = [];

      for await (const ev of streamChat({
        apiKey: this.opts.apiKey,
        baseUrl: this.opts.baseUrl,
        model: this.opts.model,
        messages,
        tools: toolSchemas,
        signal,
      })) {
        if (ev.type === "token") {
          tokens.push(ev.content);
          cb.onToken?.(ev.content);
        } else if (ev.type === "reasoning") {
          cb.onReasoning?.(ev.content);
        } else if (ev.type === "tool_call") {
          toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
        }
      }

      finalText = tokens.join("");

      if (toolCalls.length === 0) {
        // Empty text + no tools after a round of tool use means the model
        // ran out of things to say but didn't summarize. Re-prompt once for
        // a brief textual closing — this is what fixes "(empty response)".
        const ranTools = messages.some((m) => m.role === "tool");
        if (!finalText.trim() && ranTools) {
          messages.push({
            role: "user",
            content:
              "Briefly summarize what you just did and any remaining steps in 1-3 sentences.",
          });
          const summaryTokens: string[] = [];
          for await (const ev of streamChat({
            apiKey: this.opts.apiKey,
            baseUrl: this.opts.baseUrl,
            model: this.opts.model,
            messages,
            signal,
          })) {
            if (ev.type === "token") {
              summaryTokens.push(ev.content);
              cb.onToken?.(ev.content);
            }
          }
          finalText = summaryTokens.join("").trim() || "(done — no summary returned)";
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: finalText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Fire status callbacks up-front so the UI shows "calling X, Y, Z…"
      // for the whole batch at once, then run the tools in parallel. The
      // model issues independent calls in a single round; running them
      // sequentially turned a 30-call server-rebuild into 30 round-trips.
      for (const tc of toolCalls) cb.onToolCall?.(tc.name, tc.arguments);

      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          const tool = this.opts.tools.get(tc.name);
          if (!tool) return { tc, result: `Tool '${tc.name}' not found.` };
          try {
            const args = tc.arguments ? JSON.parse(tc.arguments) : {};
            const result = await tool.run(args);
            return { tc, result };
          } catch (e: any) {
            return { tc, result: `Tool error: ${e?.message ?? e}` };
          }
        }),
      );

      for (const { tc, result } of results) {
        cb.onToolResult?.(tc.name, result);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    // Persist to history + session, capped to MAX_HISTORY_MESSAGES.
    this.history.push({ role: "user", content: userInput });
    this.history.push({ role: "assistant", content: finalText });
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
    }
    await this.opts.memory.appendSession(this.sessionId, {
      user: userInput,
      assistant: finalText,
      timestamp: new Date().toISOString(),
    });

    // Background reflection — never blocks the user.
    this.reflect(userInput, finalText).catch(() => undefined);

    return finalText;
  }

  /** Best-effort: ask the LLM whether new persistent facts about the user appeared, and update USER.md. */
  private async reflect(userInput: string, assistantResponse: string): Promise<void> {
    const current = await this.opts.memory.getUserProfile();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a memory extraction assistant. Given a conversation and the current user profile, determine if any NEW persistent facts about the user were revealed. If yes, output the complete updated user profile in markdown. If nothing new was learned, output exactly: NO_UPDATE",
      },
      {
        role: "user",
        content: `Current profile:\n${current}\n\nConversation:\nUser: ${userInput}\nAssistant: ${assistantResponse}\n\nOutput updated profile or NO_UPDATE:`,
      },
    ];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      let result = "";
      for await (const ev of streamChat({
        apiKey: this.opts.apiKey,
        baseUrl: this.opts.baseUrl,
        model: this.opts.model,
        messages,
        signal: ctrl.signal,
      })) {
        if (ev.type === "token") result += ev.content;
      }
      result = result.trim();
      if (result && result.toUpperCase() !== "NO_UPDATE") {
        await this.opts.memory.updateUserProfile(result);
      }
    } catch {
      // best-effort; never surface
    } finally {
      clearTimeout(timer);
    }
  }
}
