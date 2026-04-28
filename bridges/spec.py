from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class Capability(str, Enum):
    """Coarse capability tags used for agent gap-filling.

    A bridge declares what it CAN do; the agent loop matches missing
    capabilities against the agent registry to pick a helper agent.
    """
    CONTROL = "control"            # actuate something (turn on, send, move)
    TELEMETRY = "telemetry"        # read sensors / state
    VISION = "vision"              # capture / process images
    AUDIO = "audio"                # capture / play sound
    STREAM = "stream"              # continuous real-time stream
    LOCATION = "location"          # geolocation / positioning
    NAVIGATION = "navigation"      # directional movement
    STORAGE = "storage"            # persistent storage
    COMMUNICATION = "communication"  # send messages / notifications


@dataclass
class ToolSpec:
    """A single callable surface on a bridge.

    `parameters` is a JSON Schema object suitable for OpenAI function
    calling. `handler` is an opaque payload the bridge interprets when
    `invoke()` is called.
    """
    name: str
    description: str
    parameters: dict
    handler: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BridgeSpec:
    """A serialisable description of a mounted device's connection bridge.

    Persisted to disk so devices survive Atlas restarts.
    """
    name: str
    kind: str                       # "openapi" | "mcp" | "http" | "shell" | ...
    config: dict
    capabilities: list[str] = field(default_factory=list)
    description: str = ""
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "BridgeSpec":
        return cls(
            name=data["name"],
            kind=data["kind"],
            config=data.get("config", {}),
            capabilities=list(data.get("capabilities", [])),
            description=data.get("description", ""),
            created_at=data.get("created_at", datetime.now(timezone.utc).isoformat()),
        )


@dataclass
class DeviceRecord:
    """Live record of a mounted device — spec + runtime tools."""
    spec: BridgeSpec
    tool_names: list[str] = field(default_factory=list)
    notes: str = ""

    def public_summary(self) -> dict[str, Any]:
        return {
            "name": self.spec.name,
            "kind": self.spec.kind,
            "capabilities": self.spec.capabilities,
            "tools": list(self.tool_names),
            "description": self.spec.description,
        }
