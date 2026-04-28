from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from .spec import BridgeSpec, ToolSpec


class BridgeError(Exception):
    """Raised when a bridge can't connect, discover, or invoke."""


class Bridge(ABC):
    """The universal connection contract.

    Subclasses know how to talk to one *kind* of system (REST API, MCP
    server, BLE peripheral, etc.). Atlas only ever sees this interface.

    Lifecycle: construct → `connect()` → `discover()` → `tools()` for
    every agent turn → `invoke()` per call → `aclose()` on unmount.
    """

    kind: str = "abstract"

    def __init__(self, spec: BridgeSpec):
        self.spec = spec

    @abstractmethod
    async def connect(self) -> None:
        """Open the underlying transport (HTTP session, stdio process,
        BLE GATT, serial port, …). Must be idempotent."""

    @abstractmethod
    async def discover(self) -> List[ToolSpec]:
        """Read whatever the device exposes (OpenAPI, MCP tools/list,
        GATT services, USB descriptors, README) and return a list of
        invokable ToolSpecs."""

    @abstractmethod
    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        """Run a single tool and return a string result for the agent."""

    async def aclose(self) -> None:
        """Release transport resources. Default: no-op."""
        return None

    @property
    def name(self) -> str:
        return self.spec.name
