from typing import Optional, List

from .base import AtlasPlugin
from tools.shell_tool import ShellTool
from tools.filesystem_tool import ReadFileTool, WriteFileTool
from tools.web_search_tool import WebSearchTool
from tools.memory_tools import RememberTool, RecallTool, UpdateProfileTool, GetProfileTool
from tools.device_tools import IntrospectURLTool
from tools.base import Tool


class ToolsPlugin(AtlasPlugin):
    """Flat tool registry. Other plugins (currently just DevicesPlugin) push
    additional tools in via `register()` / `unregister()`."""

    name = "tools"

    def __init__(self):
        self._registry: dict = {}

    async def load(self, kernel) -> None:
        cfg = kernel.config.get("tools", {})
        builtins: List[Tool] = [
            ShellTool(),
            ReadFileTool(),
            WriteFileTool(),
            WebSearchTool(api_key=cfg.get("brave_api_key", "")),
            RememberTool(kernel.memory),
            RecallTool(kernel.memory),
            GetProfileTool(kernel.memory),
            UpdateProfileTool(kernel.memory),
            IntrospectURLTool(),
        ]
        for tool in builtins:
            self._registry[tool.name] = tool

    async def unload(self) -> None:
        self._registry.clear()

    # ── runtime registration ───────────────────────────────────────────────

    def register(self, tool: Tool) -> None:
        if tool.name in self._registry:
            raise ValueError(f"tool '{tool.name}' is already registered")
        self._registry[tool.name] = tool

    def unregister(self, name: str) -> None:
        self._registry.pop(name, None)

    # ── agent-facing accessors ─────────────────────────────────────────────

    def get(self, name: str) -> Optional[Tool]:
        return self._registry.get(name)

    def all(self) -> List[Tool]:
        return list(self._registry.values())

    def schemas(self) -> List[dict]:
        return [t.to_openai_schema() for t in self._registry.values()]
