import { fetch } from "undici";
import type { ToolSchema } from "../tools/tool.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: string };

export interface StreamOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

interface DeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Stream OpenAI-compatible chat completions over SSE.
 *
 * Yields one event per delta in the stream — token text, reasoning text
 * (DeepSeek-R1 / extended-thinking), or accumulated tool calls. The
 * caller is responsible for re-running the loop after a tool round.
 */
export async function* streamChat(opts: StreamOpts): AsyncGenerator<StreamEvent> {
  const body: any = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(opts.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://atlas-ai.local",
      "X-Title": "Atlas",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("OpenRouter response had no body");

  const decoder = new TextDecoder();
  const toolBuf = new Map<number, { id: string; name: string; arguments: string }>();
  let pending = "";

  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });

    // SSE events are separated by \n\n. Process any complete events and keep the tail.
    let sep: number;
    while ((sep = pending.indexOf("\n\n")) !== -1) {
      const event = pending.slice(0, sep);
      pending = pending.slice(sep + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") {
          for (const tc of toolBuf.values()) {
            yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
          }
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta ?? {};
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (reasoning) yield { type: "reasoning", content: String(reasoning) };
        if (delta.content) yield { type: "token", content: String(delta.content) };
        const tcalls: DeltaToolCall[] = delta.tool_calls ?? [];
        for (const tc of tcalls) {
          const idx = tc.index ?? 0;
          let entry = toolBuf.get(idx);
          if (!entry) {
            entry = { id: "", name: "", arguments: "" };
            toolBuf.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }
  }

  // Flush any tool calls if [DONE] never arrived (server hung up cleanly).
  for (const tc of toolBuf.values()) {
    yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
  }
}
