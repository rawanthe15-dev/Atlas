from typing import TYPE_CHECKING, Optional, List
from .base import Tool

if TYPE_CHECKING:
    from memory_backends.interface import MemoryInterface


class RememberTool(Tool):
    name = "remember"
    description = "Store a piece of information in Atlas's long-term memory."
    parameters = {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "What to remember"},
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags",
            },
        },
        "required": ["content"],
    }

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self, content: str, tags: Optional[List[str]] = None) -> str:
        tags = tags or []
        await self._memory.write(content, tags)
        return f"Stored in memory: {content}"


class RecallTool(Tool):
    name = "recall"
    description = "Search Atlas's memory for relevant past information."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for"},
            "limit": {"type": "integer", "description": "Max results (default 5)"},
        },
        "required": ["query"],
    }

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self, query: str, limit: int = 5) -> str:
        entries = await self._memory.search(query, limit)
        if not entries:
            return "No relevant memories found."
        return "\n".join(
            f"[{e.timestamp[:10]}] {e.content}" + (f" ({', '.join(e.tags)})" if e.tags else "")
            for e in entries
        )
