from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class MemoryEntry:
    content: str
    tags: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=_utcnow)
    relevance: float = 0.0


class MemoryInterface(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def write(self, content: str, tags: Optional[list[str]] = None) -> None: ...

    @abstractmethod
    async def search(self, query: str, limit: int = 5) -> list[MemoryEntry]: ...

    @abstractmethod
    async def get_user_profile(self) -> str: ...

    @abstractmethod
    async def update_user_profile(self, content: str) -> None: ...

    @abstractmethod
    async def get_soul(self) -> str: ...

    @abstractmethod
    async def append_session(self, session_id: str, entry: dict) -> None: ...

    @abstractmethod
    async def get_recent_sessions(self, n: int = 3) -> list[dict]: ...
