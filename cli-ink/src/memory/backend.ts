// Pluggable memory backend interface. SOUL.md, USER.md, and session
// JSONL files are common across implementations; only `search()` swaps
// between word-overlap (file) and embedding similarity (vector).

export interface SessionEntry {
  user: string;
  assistant: string;
  timestamp: string;
}

export interface Session {
  file: string;
  entries: SessionEntry[];
}

export interface MemoryHit {
  content: string;
  timestamp: string;
  relevance?: number;
}

export interface MemoryBackend {
  /** Backend name shown in /config and the toolbar. */
  readonly kind: "file" | "vector";

  init(): Promise<void>;

  getSoul(): Promise<string>;
  getUserProfile(): Promise<string>;
  updateUserProfile(content: string): Promise<void>;

  appendSession(sessionId: string, entry: SessionEntry): Promise<void>;
  getRecentSessions(limit?: number): Promise<Session[]>;
  loadSession(file: string): Promise<Session | null>;

  search(query: string, limit?: number): Promise<MemoryHit[]>;
}

export const DEFAULT_SOUL =
  "# Atlas\n\nYou are Atlas — a personal second brain. You speak directly, think clearly, and never sycophant.\n";

export const DEFAULT_USER =
  "# User Profile\n\n## Identity\n\n## Preferences\n\n## Projects\n\n## Patterns\n\n## Context\n";

/** Returns true when USER.md is just the default skeleton (no real content yet). */
export function userProfileIsEmpty(profile: string): boolean {
  const stripped = profile.replace(/^#.*$/gm, "").replace(/\s+/g, "");
  return stripped.length === 0;
}
