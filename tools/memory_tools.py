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


class UpdateProfileTool(Tool):
    name = "update_user_profile"
    description = (
        "Replace the entire USER.md file with new markdown content. "
        "USER.md is your living model of the user — their identity, preferences, "
        "projects, patterns, and context. Use this when the user asks you to "
        "edit, update, or change what you know about them. Always preserve "
        "existing information unless explicitly told to remove it — read the "
        "current profile first via the system prompt context, then write the "
        "complete updated version."
    )
    parameters = {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The complete new markdown content for USER.md",
            },
        },
        "required": ["content"],
    }

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self, content: str) -> str:
        await self._memory.update_user_profile(content)
        return f"USER.md updated ({len(content)} chars)"


class GetProfileTool(Tool):
    name = "get_user_profile"
    description = (
        "Read the current contents of USER.md (the living user profile). "
        "Use this before update_user_profile if you need to confirm what's "
        "currently stored. The profile is also injected into your system "
        "prompt automatically each turn."
    )
    parameters = {"type": "object", "properties": {}, "required": []}

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self) -> str:
        profile = await self._memory.get_user_profile()
        return profile or "(USER.md is empty)"
