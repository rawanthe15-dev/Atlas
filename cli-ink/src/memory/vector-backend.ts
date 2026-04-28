import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import { ATLAS_ROOT } from "../config/config.js";
import { FileMemoryBackend } from "./file-backend.js";
import type {
  MemoryBackend,
  MemoryHit,
  Session,
  SessionEntry,
} from "./backend.js";

export interface EmbeddingsConfig {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint root (we POST to `${baseUrl}/embeddings`). */
  baseUrl: string;
}

interface IndexEntry {
  id: string;
  text: string;
  vector: number[];
  timestamp: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embedding-based memory backend. Stores SOUL.md, USER.md, and session
 * JSONLs identically to FileMemoryBackend (delegated). On every appended
 * session entry we also embed the text and persist `{id, text, vector}`
 * to `memory/index/embeddings.jsonl`. `search()` embeds the query and
 * returns the top-N by cosine similarity.
 *
 * If the embeddings endpoint is misconfigured or fails, search falls
 * back to file-backend word-overlap so we never break on a bad config.
 */
export class VectorMemoryBackend implements MemoryBackend {
  readonly kind = "vector" as const;
  private readonly file: FileMemoryBackend;
  private readonly indexPath: string;
  private readonly embeddings: EmbeddingsConfig;
  private cache: IndexEntry[] | null = null;

  constructor(opts: { embeddings: EmbeddingsConfig; basePath?: string }) {
    const base = opts.basePath ?? path.join(ATLAS_ROOT, "memory");
    this.file = new FileMemoryBackend({ basePath: base });
    this.embeddings = opts.embeddings;
    this.indexPath = path.join(base, "index", "embeddings.jsonl");
  }

  async init(): Promise<void> {
    await this.file.init();
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
  }

  getSoul(): Promise<string> {
    return this.file.getSoul();
  }
  getUserProfile(): Promise<string> {
    return this.file.getUserProfile();
  }
  updateUserProfile(content: string): Promise<void> {
    return this.file.updateUserProfile(content);
  }
  getRecentSessions(limit?: number): Promise<Session[]> {
    return this.file.getRecentSessions(limit);
  }
  loadSession(file: string): Promise<Session | null> {
    return this.file.loadSession(file);
  }

  async appendSession(sessionId: string, entry: SessionEntry): Promise<void> {
    await this.file.appendSession(sessionId, entry);
    const text = `User: ${entry.user}\nAtlas: ${entry.assistant}`;
    // Best-effort embed — never block the write path on it.
    this.embed(text)
      .then(async (vec) => {
        if (!vec) return;
        const id = `${sessionId}-${entry.timestamp}`;
        await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
        await fs.appendFile(
          this.indexPath,
          JSON.stringify({ id, text, vector: vec, timestamp: entry.timestamp }) + "\n",
        );
        this.cache = null;
      })
      .catch(() => undefined);
  }

  async search(query: string, limit = 5): Promise<MemoryHit[]> {
    const qvec = await this.embed(query);
    if (!qvec) return this.file.search(query, limit);
    const index = await this.loadIndex();
    if (index.length === 0) return [];
    const scored = index.map((e) => ({
      content: `${e.text.slice(0, 400)}`,
      timestamp: e.timestamp,
      relevance: cosine(qvec, e.vector),
    }));
    scored.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return scored.slice(0, limit);
  }

  private async embed(text: string): Promise<number[] | null> {
    try {
      const url = `${this.embeddings.baseUrl.replace(/\/$/, "")}/embeddings`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.embeddings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.embeddings.model,
          input: text,
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const vec = data?.data?.[0]?.embedding;
      return Array.isArray(vec) ? vec : null;
    } catch {
      return null;
    }
  }

  private async loadIndex(): Promise<IndexEntry[]> {
    if (this.cache) return this.cache;
    try {
      const text = await fs.readFile(this.indexPath, "utf-8");
      this.cache = text
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as IndexEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is IndexEntry => e !== null);
    } catch {
      this.cache = [];
    }
    return this.cache;
  }
}
