import fs from "node:fs/promises";
import path from "node:path";
import { ATLAS_ROOT } from "../config/config.js";
import {
  DEFAULT_SOUL,
  DEFAULT_USER,
  type MemoryBackend,
  type MemoryHit,
  type Session,
  type SessionEntry,
} from "./backend.js";

export class FileMemoryBackend implements MemoryBackend {
  readonly kind = "file" as const;
  private readonly memoryDir: string;
  private readonly soulPath: string;
  private readonly userPath: string;
  private readonly sessionsDir: string;

  constructor(opts: { basePath?: string } = {}) {
    const base = opts.basePath ?? path.join(ATLAS_ROOT, "memory");
    this.memoryDir = base;
    this.soulPath = path.join(base, "SOUL.md");
    this.userPath = path.join(base, "USER.md");
    this.sessionsDir = path.join(base, "sessions");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await this.ensureFile(this.soulPath, DEFAULT_SOUL);
    await this.ensureFile(this.userPath, DEFAULT_USER);
  }

  private async ensureFile(p: string, fallback: string): Promise<string> {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, fallback);
      return fallback;
    }
  }

  async getSoul(): Promise<string> {
    return this.ensureFile(this.soulPath, DEFAULT_SOUL);
  }

  async getUserProfile(): Promise<string> {
    return this.ensureFile(this.userPath, DEFAULT_USER);
  }

  async updateUserProfile(content: string): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.writeFile(this.userPath, content);
  }

  async appendSession(sessionId: string, entry: SessionEntry): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    await fs.appendFile(file, JSON.stringify(entry) + "\n");
  }

  async getRecentSessions(limit = 5): Promise<Session[]> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const jsonl = files.filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, limit);
      const sessions: Session[] = [];
      for (const f of jsonl) {
        const s = await this.loadSession(f);
        if (s) sessions.push(s);
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async loadSession(file: string): Promise<Session | null> {
    try {
      const text = await fs.readFile(path.join(this.sessionsDir, file), "utf-8");
      const entries = text
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as SessionEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is SessionEntry => e !== null);
      return { file, entries };
    } catch {
      return null;
    }
  }

  async search(query: string, limit = 5): Promise<MemoryHit[]> {
    const sessions = await this.getRecentSessions(20);
    const queryTerms = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
    if (queryTerms.size === 0) return [];

    const scored: { hit: MemoryHit; score: number }[] = [];
    for (const s of sessions) {
      for (const e of s.entries) {
        const text = `${e.user} ${e.assistant}`.toLowerCase();
        let score = 0;
        for (const t of queryTerms) if (text.includes(t)) score += 1;
        if (score > 0) {
          scored.push({
            hit: {
              content: `User: ${e.user.slice(0, 200)} / Atlas: ${e.assistant.slice(0, 200)}`,
              timestamp: e.timestamp,
              relevance: score / queryTerms.size,
            },
            score,
          });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.hit);
  }
}

// Re-export the types for callers that imported from here historically.
export type { Session, SessionEntry, MemoryHit } from "./backend.js";
