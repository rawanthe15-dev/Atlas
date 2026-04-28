/**
 * Persistent cache of MCP servers that have passed the smoke test.
 *
 * `auto_connect` checks this BEFORE hitting public registries. The first
 * time the user installs (e.g.) `@playwright/mcp@latest --browser chrome`
 * for the query "browser", we record the (query keywords → install_command)
 * pairing. Future "browser" / "chrome" / "playwright" queries reuse it
 * directly — no registry round-trip, no smoke-test cycle, no risk of the
 * registry's top-ranked-but-broken candidate being picked again.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MCPCandidate } from "./registry.js";

export interface VerifiedMCP {
  id: string;
  source: MCPCandidate["source"];
  name: string;
  description: string;
  installCommand: string;
  /** Lowercase tokens taken from the query that led to verification. */
  keywords: string[];
  verifiedAt: string;
  /** How many times this entry served a successful auto_connect. */
  uses: number;
}

const STOPWORDS = new Set([
  "a","an","the","and","or","of","for","to","in","on","with","my","your","atlas",
  "use","using","please","just","find","get","set","up","setup","new",
]);

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class VerifiedStore {
  constructor(private root: string) {}

  private file(): string {
    return path.join(this.root, "verified_mcps.json");
  }

  async load(): Promise<VerifiedMCP[]> {
    try {
      const raw = await readFile(this.file(), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: VerifiedMCP[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.file(), JSON.stringify(list, null, 2), "utf8");
  }

  /** Add or update an entry. Merges keywords with any existing record. */
  async record(candidate: MCPCandidate, query: string): Promise<void> {
    const list = await this.load();
    const tokens = tokenizeQuery(query);
    const existing = list.find((v) => v.id === candidate.id);
    if (existing) {
      const merged = new Set([...existing.keywords, ...tokens]);
      existing.keywords = [...merged];
      existing.uses += 1;
      existing.verifiedAt = new Date().toISOString();
      // Refresh install command in case the candidate changed.
      existing.installCommand = candidate.installCommand;
      existing.description = candidate.description;
    } else {
      list.push({
        id: candidate.id,
        source: candidate.source,
        name: candidate.name,
        description: candidate.description,
        installCommand: candidate.installCommand,
        keywords: tokens,
        verifiedAt: new Date().toISOString(),
        uses: 1,
      });
    }
    await this.writeAll(list);
  }

  /** Remove an entry — used when a previously-verified MCP starts failing. */
  async forget(id: string): Promise<void> {
    const list = await this.load();
    await this.writeAll(list.filter((v) => v.id !== id));
  }

  /**
   * Return verified MCPs whose recorded keywords overlap the new query's
   * tokens. Sorted by overlap count, then by usage. Higher = more likely
   * the right pick.
   */
  async match(query: string): Promise<VerifiedMCP[]> {
    const list = await this.load();
    const qTokens = new Set(tokenizeQuery(query));
    if (qTokens.size === 0) return [];
    const scored: Array<{ mcp: VerifiedMCP; score: number }> = [];
    for (const v of list) {
      let overlap = 0;
      for (const k of v.keywords) if (qTokens.has(k)) overlap += 1;
      if (overlap === 0) continue;
      scored.push({ mcp: v, score: overlap * 10 + v.uses });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.mcp);
  }
}
