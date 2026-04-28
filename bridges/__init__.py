"""Atlas device-connectivity layer.

A `Bridge` is anything that can be plugged into Atlas: a REST API, an MCP
server, a serial port, a BLE peripheral, a phone over ADB, a Home Assistant
instance, a shell wrapper, or a process. Each bridge exposes a list of
`ToolSpec`s that the kernel surfaces to the agent at runtime.
"""

from .spec import ToolSpec, BridgeSpec, DeviceRecord, Capability
from .base import Bridge, BridgeError
from .dynamic_tool import BridgeTool

__all__ = [
    "ToolSpec",
    "BridgeSpec",
    "DeviceRecord",
    "Capability",
    "Bridge",
    "BridgeError",
    "BridgeTool",
]
