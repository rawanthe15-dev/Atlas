"""Bluetooth Low Energy bridge — talks to any GATT peripheral via `bleak`.

`bleak` is a soft-dep — only required when this bridge is actually used.
"""
from __future__ import annotations

from typing import List

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


def _require_bleak():
    try:
        import bleak  # noqa: F401
    except ImportError as e:
        raise BridgeError(
            "ble bridge requires `bleak` — install it with `pip install bleak`"
        ) from e
    return __import__("bleak")


class BLEBridge(Bridge):
    """`config`:
        address: str   — peripheral MAC / UUID
        timeout: float (default 10)
    """

    kind = "ble"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._client = None

    async def connect(self) -> None:
        bleak = _require_bleak()
        if self._client is not None:
            return
        addr = self.spec.config.get("address")
        if not addr:
            raise BridgeError("ble bridge: 'address' is required")
        timeout = float(self.spec.config.get("timeout", 10))
        client = bleak.BleakClient(addr, timeout=timeout)
        await client.connect()
        self._client = client

    async def discover(self) -> List[ToolSpec]:
        return [
            ToolSpec(
                name="scan",
                description="Scan for nearby BLE peripherals (returns address + name).",
                parameters={
                    "type": "object",
                    "properties": {"timeout": {"type": "number"}},
                    "required": [],
                },
                handler={"op": "scan"},
            ),
            ToolSpec(
                name="services",
                description="List GATT services and characteristics on the connected peripheral.",
                parameters={"type": "object", "properties": {}, "required": []},
                handler={"op": "services"},
            ),
            ToolSpec(
                name="read_char",
                description="Read a GATT characteristic by UUID, returns hex.",
                parameters={
                    "type": "object",
                    "properties": {"uuid": {"type": "string"}},
                    "required": ["uuid"],
                },
                handler={"op": "read"},
            ),
            ToolSpec(
                name="write_char",
                description="Write hex bytes to a GATT characteristic by UUID.",
                parameters={
                    "type": "object",
                    "properties": {
                        "uuid":  {"type": "string"},
                        "hex":   {"type": "string", "description": "hex-encoded bytes"},
                        "with_response": {"type": "boolean"},
                    },
                    "required": ["uuid", "hex"],
                },
                handler={"op": "write"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        bleak = _require_bleak()
        op = tool.handler["op"]
        if op == "scan":
            timeout = float(arguments.get("timeout", 5))
            devices = await bleak.BleakScanner.discover(timeout=timeout)
            return "\n".join(f"{d.address}  {d.name or '?'}" for d in devices) or "(none)"
        await self.connect()
        client = self._client
        if op == "services":
            lines: list[str] = []
            for svc in client.services:
                lines.append(f"service {svc.uuid}")
                for ch in svc.characteristics:
                    lines.append(f"  char {ch.uuid}  props={','.join(ch.properties)}")
            return "\n".join(lines) or "(no services)"
        if op == "read":
            data = await client.read_gatt_char(arguments["uuid"])
            return data.hex()
        if op == "write":
            payload = bytes.fromhex(arguments["hex"])
            await client.write_gatt_char(
                arguments["uuid"], payload,
                response=bool(arguments.get("with_response", False)),
            )
            return f"wrote {len(payload)} bytes"
        return f"unknown op {op}"

    async def aclose(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
