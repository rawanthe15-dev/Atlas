import { fetch } from "undici";
import type { Tool } from "./tool.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

export function makeBraveSearchTool(apiKey: string): Tool {
  return {
    name: "web_search",
    description:
      "Search the web via Brave Search. Returns the top results as a numbered list with title, URL, and snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        count: { type: "number", description: "How many results to return (default 5, max 10)." },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Tool error: missing 'query'.";
      const count = Math.max(1, Math.min(10, Number(args.count ?? 5)));

      const url = new URL(BRAVE_API_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });
        if (!res.ok) {
          const text = await res.text();
          return `Tool error: brave returned ${res.status} — ${text.slice(0, 200)}`;
        }
        const data = (await res.json()) as BraveResponse;
        const results = data.web?.results ?? [];
        if (results.length === 0) return "(no results)";
        return results
          .slice(0, count)
          .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${r.description ?? ""}`)
          .join("\n\n");
      } catch (e: any) {
        return `Tool error: ${e.message ?? e}`;
      }
    },
  };
}
