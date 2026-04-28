"""Serial / USB-CDC bridge for microcontrollers, drones, IoT modules.

Uses `pyserial` (soft-dep). The bridge is line-oriented by default —
suitable for AT command sets and most hobby drone protocols.
"""
from __future__ import annotations

import asyncio
from typing import List

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


def _require_pyserial():
    try:
        import serial  # noqa: F401
    except ImportError as e:
        raise BridgeError(
            "serial bridge requires `pyserial` — install with `pip install pyserial`"
        ) from e
    return __import__("serial")


class SerialBridge(Bridge):
    """`config`:
        port:      str   (e.g. "/dev/tty.usbserial-XYZ" or "COM3")
        baudrate:  int   (default 115200)
        timeout:   float (default 1.0)
        eol:       str   ("\\n" default; bytes appended to writes)
    """

    kind = "serial"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._port = None

    async def connect(self) -> None:
        if self._port is not None:
            return
        serial = _require_pyserial()
        cfg = self.spec.config
        port = cfg.get("port")
        if not port:
            raise BridgeError("serial bridge: 'port' is required")
        loop = asyncio.get_event_loop()
        self._port = await loop.run_in_executor(
            None,
            lambda: serial.Serial(
                port=port,
                baudrate=int(cfg.get("baudrate", 115200)),
                timeout=float(cfg.get("timeout", 1.0)),
            ),
        )

    async def discover(self) -> List[ToolSpec]:
        return [
            ToolSpec(
                name="write_line",
                description="Write a line (EOL appended) to the serial port and read until quiet.",
                parameters={
                    "type": "object",
                    "properties": {
                        "line":      {"type": "string"},
                        "read_for":  {"type": "number", "description": "Seconds to read response"},
                    },
                    "required": ["line"],
                },
                handler={"op": "write_line"},
            ),
            ToolSpec(
                name="read",
                description="Read up to N bytes from the serial port.",
                parameters={
                    "type": "object",
                    "properties": {"max_bytes": {"type": "integer"}},
                    "required": [],
                },
                handler={"op": "read"},
            ),
            ToolSpec(
                name="write_hex",
                description="Write raw hex bytes to the serial port (no EOL).",
                parameters={
                    "type": "object",
                    "properties": {"hex": {"type": "string"}},
                    "required": ["hex"],
                },
                handler={"op": "write_hex"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        await self.connect()
        port = self._port
        op = tool.handler["op"]
        eol = self.spec.config.get("eol", "\n").encode()
        loop = asyncio.get_event_loop()

        def _do(fn):
            return loop.run_in_executor(None, fn)

        if op == "write_line":
            line = arguments["line"]
            await _do(lambda: port.write(line.encode() + eol))
            await _do(lambda: port.flush())
            read_for = float(arguments.get("read_for", 0.5))
            await asyncio.sleep(read_for)
            data = await _do(lambda: port.read(port.in_waiting or 0))
            return data.decode(errors="replace") if data else "(no response)"
        if op == "read":
            n = int(arguments.get("max_bytes", 1024))
            data = await _do(lambda: port.read(n))
            return data.decode(errors="replace") if data else "(empty)"
        if op == "write_hex":
            payload = bytes.fromhex(arguments["hex"])
            await _do(lambda: port.write(payload))
            await _do(lambda: port.flush())
            return f"wrote {len(payload)} bytes"
        return f"unknown op {op}"

    async def aclose(self) -> None:
        if self._port is not None:
            try:
                self._port.close()
            except Exception:
                pass
            self._port = None

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
