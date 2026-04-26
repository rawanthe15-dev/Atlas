import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .interface import MemoryEntry, MemoryInterface


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class FileMemoryBackend(MemoryInterface):
    def __init__(self, base_path: str):
        self.base = Path(base_path)
        self.sessions_dir = self.base / "sessions"
        self.index_dir = self.base / "index"
        self.soul_path = self.base / "SOUL.md"
        self.user_path = self.base / "USER.md"
        self.entries_path = self.index_dir / "entries.jsonl"

    async def initialize(self) -> None:
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        if not self.user_path.exists():
            self.user_path.write_text(
                "# User Profile\n\n## Identity\n\n## Preferences\n\n"
                "## Projects\n\n## Patterns\n\n## Context\n",
                encoding="utf-8",
            )
        if not self.entries_path.exists():
            self.entries_path.write_text("", encoding="utf-8")

    async def write(self, content: str, tags: Optional[list[str]] = None) -> None:
        tags = tags or []
        entry = {"content": content, "tags": tags, "timestamp": _utcnow()}
        with open(self.entries_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    async def search(self, query: str, limit: int = 5) -> list[MemoryEntry]:
        if not self.entries_path.exists() or not self.entries_path.stat().st_size:
            return []
        query_words = set(query.lower().split())
        scored: list[tuple[int, str, dict]] = []  # (overlap, timestamp, data)
        with open(self.entries_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = data.get("content", "")
                if not content:
                    continue
                content_words = set(content.lower().split())
                overlap = len(query_words & content_words)
                if overlap > 0:
                    scored.append((overlap, data.get("timestamp", ""), data))
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return [
            MemoryEntry(
                content=d["content"],
                tags=d.get("tags", []),
                timestamp=d.get("timestamp", ""),
                relevance=score / max(len(query_words), 1),
            )
            for score, _ts, d in scored[:limit]
        ]

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

    async def get_recent_sessions(self, n: int = 3) -> list[dict]:
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
