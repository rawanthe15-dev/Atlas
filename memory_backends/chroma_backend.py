"""ChromaDB-backed memory — drop-in replacement for FileMemoryBackend.

Same interface, but `search()` uses semantic vector similarity instead of
word overlap. Switch via `[memory].backend = "chroma"` in config.toml.

USER.md and SOUL.md and session JSONLs still live as files (human-readable);
only the entries.jsonl-equivalent is replaced with a Chroma collection.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from .interface import MemoryEntry, MemoryInterface


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChromaMemoryBackend(MemoryInterface):
    def __init__(self, base_path: str, collection_name: str = "atlas_memory"):
        self.base = Path(base_path)
        self.sessions_dir = self.base / "sessions"
        self.chroma_dir = self.base / "chroma"
        self.soul_path = self.base / "SOUL.md"
        self.user_path = self.base / "USER.md"
        self._collection_name = collection_name
        self._client = None
        self._collection = None

    async def initialize(self) -> None:
        # Lazy import — don't pay the chromadb startup cost unless this backend is selected
        import chromadb

        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.chroma_dir.mkdir(parents=True, exist_ok=True)

        if not self.user_path.exists():
            self.user_path.write_text(
                "# User Profile\n\n## Identity\n\n## Preferences\n\n"
                "## Projects\n\n## Patterns\n\n## Context\n",
                encoding="utf-8",
            )

        # Persistent embedded client — no separate process
        self._client = chromadb.PersistentClient(path=str(self.chroma_dir))
        self._collection = self._client.get_or_create_collection(
            name=self._collection_name,
            metadata={"hnsw:space": "cosine"},
        )

    async def write(self, content: str, tags: Optional[List[str]] = None) -> None:
        tags = tags or []
        ts = _utcnow()
        # Chroma needs a unique id; timestamp is monotonic-ish + we hash content
        entry_id = f"{ts}-{abs(hash(content)) % 10_000_000}"
        self._collection.add(
            documents=[content],
            metadatas=[{"tags": ",".join(tags), "timestamp": ts}],
            ids=[entry_id],
        )

    async def search(self, query: str, limit: int = 5) -> List[MemoryEntry]:
        if self._collection is None or self._collection.count() == 0:
            return []
        try:
            results = self._collection.query(
                query_texts=[query],
                n_results=min(limit, self._collection.count()),
            )
        except Exception:
            return []

        docs = (results.get("documents") or [[]])[0]
        metas = (results.get("metadatas") or [[]])[0]
        dists = (results.get("distances") or [[]])[0]

        entries: List[MemoryEntry] = []
        for doc, meta, dist in zip(docs, metas, dists):
            tags_str = (meta or {}).get("tags", "")
            tags = [t for t in tags_str.split(",") if t] if tags_str else []
            # Cosine distance → relevance: smaller distance = higher relevance
            relevance = max(0.0, 1.0 - float(dist)) if dist is not None else 0.0
            entries.append(
                MemoryEntry(
                    content=doc,
                    tags=tags,
                    timestamp=(meta or {}).get("timestamp", ""),
                    relevance=relevance,
                )
            )
        return entries

    async def get_user_profile(self) -> str:
        if not self.user_path.exists():
            return ""
        return self.user_path.read_text(encoding="utf-8")

    async def update_user_profile(self, content: str) -> None:
        self.user_path.write_text(content, encoding="utf-8")

    async def get_soul(self) -> str:
        if not self.soul_path.exists():
            return "You are Atlas, a powerful personal AI system. Be direct, efficient, and proactive."
        return self.soul_path.read_text(encoding="utf-8")

    async def append_session(self, session_id: str, entry: dict) -> None:
        session_file = self.sessions_dir / f"{session_id}.jsonl"
        with open(session_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    async def get_recent_sessions(self, n: int = 3) -> List[dict]:
        if not self.sessions_dir.exists():
            return []
        files = sorted(self.sessions_dir.glob("*.jsonl"), reverse=True)[:n]
        sessions = []
        for f in files:
            entries = []
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            if entries:
                sessions.append({"file": f.name, "entries": entries})
        return sessions
