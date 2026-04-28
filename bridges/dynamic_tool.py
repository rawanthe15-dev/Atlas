from __future__ import annotations

import re
from typing import TYPE_CHECKING

from tools.base import Tool

if TYPE_CHECKING:
    from .base import Bridge
    from .spec import ToolSpec


# OpenAI tool names must match ^[a-zA-Z0-9_-]{1,64}$. We namespace
# device-contributed tools as "<device>__<tool>" to avoid collisions
# with built-in tools and across devices.
_VALID_NAME = re.compile(r"^[a-zA-Z0-9_-]+$")


def namespaced_tool_name(device: str, tool: str) -> str:
    safe = lambda s: re.sub(r"[^A-Za-z0-9_-]", "_", s)
    full = f"{safe(device)}__{safe(tool)}"
    return full[:64]


class BridgeTool(Tool):
    """Adapter — turns a (Bridge, ToolSpec) pair into the in-tree Tool
    interface. The agent sees this exactly like any built-in tool."""

    def __init__(self, bridge: "Bridge", spec: "ToolSpec"):
        self._bridge = bridge
        self._spec = spec
        self.name = namespaced_tool_name(bridge.name, spec.name)
        # Keep the description short but identifiable so the model can
        # tell two devices' "send" tools apart.
        self.description = f"[{bridge.name}] {spec.description}".strip()
        self.parameters = spec.parameters or {
            "type": "object", "properties": {}, "required": []
        }

    async def run(self, **kwargs) -> str:
        try:
            return await self._bridge.invoke(self._spec, kwargs)
        except Exception as e:
            return f"Bridge '{self._bridge.name}' error: {e}"

    @property
    def device_name(self) -> str:
        return self._bridge.name

    @property
    def underlying(self) -> str:
        return self._spec.name
