"""Android Debug Bridge bridge — drives any USB- or Wi-Fi-connected
Android device through `adb`. The user "plugs Atlas into their phone"
once, and Atlas can read screen, send taps/keys, query device info.

Requires `adb` on PATH (Android platform-tools).
"""
from __future__ import annotations

import asyncio
import shlex
from typing import List

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


async def _run(cmd: list[str], timeout: int = 30, stdin: bytes | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


class ADBBridge(Bridge):
    """`config`:
        device_id:  str  (optional — passed as `-s`)
        adb_path:   str  (default "adb")
    """

    kind = "adb"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._adb = spec.config.get("adb_path", "adb")
        self._dev = spec.config.get("device_id")

    def _argv(self, *args: str) -> list[str]:
        base = [self._adb]
        if self._dev:
            base += ["-s", self._dev]
        return base + list(args)

    async def connect(self) -> None:
        try:
            rc, out, err = await _run([self._adb, "devices"], timeout=10)
        except FileNotFoundError:
            raise BridgeError("adb not found — install Android platform-tools")
        if rc != 0:
            raise BridgeError(f"adb error: {err.strip()}")

    async def discover(self) -> List[ToolSpec]:
        return [
            ToolSpec(
                name="shell",
                description="Run an adb shell command on the connected Android device.",
                parameters={
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                },
                handler={"op": "shell"},
            ),
            ToolSpec(
                name="install_apk",
                description="Install an APK from a local path (`adb install`).",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "replace": {"type": "boolean"}},
                    "required": ["path"],
                },
                handler={"op": "install"},
            ),
            ToolSpec(
                name="screenshot",
                description="Capture a screenshot to a path on the host (PNG).",
                parameters={
                    "type": "object",
                    "properties": {"out_path": {"type": "string"}},
                    "required": ["out_path"],
                },
                handler={"op": "screenshot"},
            ),
            ToolSpec(
                name="tap",
                description="Tap at screen coordinates (x, y).",
                parameters={
                    "type": "object",
                    "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
                    "required": ["x", "y"],
                },
                handler={"op": "tap"},
            ),
            ToolSpec(
                name="key",
                description="Send an Android keycode (e.g. 'KEYCODE_HOME', 'KEYCODE_VOLUME_UP').",
                parameters={
                    "type": "object",
                    "properties": {"keycode": {"type": "string"}},
                    "required": ["keycode"],
                },
                handler={"op": "key"},
            ),
            ToolSpec(
                name="open_url",
                description="Open a URL on the device's default browser.",
                parameters={
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
                handler={"op": "open_url"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        op = tool.handler["op"]
        try:
            if op == "shell":
                rc, out, err = await _run(self._argv("shell", arguments["command"]), timeout=60)
                return f"exit {rc}: {out.strip() or err.strip() or '(no output)'}"
            if op == "install":
                args = ["install"]
                if arguments.get("replace"):
                    args.append("-r")
                args.append(arguments["path"])
                rc, out, err = await _run(self._argv(*args), timeout=180)
                return f"exit {rc}: {out.strip() or err.strip()}"
            if op == "screenshot":
                out_path = arguments["out_path"]
                # adb exec-out streams binary stdout — capture and write.
                proc = await asyncio.create_subprocess_exec(
                    *self._argv("exec-out", "screencap", "-p"),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
                if proc.returncode != 0:
                    return f"screenshot failed: {stderr.decode(errors='replace').strip()}"
                with open(out_path, "wb") as f:
                    f.write(stdout)
                return f"saved {len(stdout)} bytes to {out_path}"
            if op == "tap":
                rc, out, err = await _run(
                    self._argv("shell", "input", "tap", str(arguments["x"]), str(arguments["y"])),
                    timeout=10,
                )
                return f"exit {rc}: {out.strip() or err.strip() or '(ok)'}"
            if op == "key":
                rc, out, err = await _run(
                    self._argv("shell", "input", "keyevent", arguments["keycode"]),
                    timeout=10,
                )
                return f"exit {rc}: {out.strip() or err.strip() or '(ok)'}"
            if op == "open_url":
                rc, out, err = await _run(
                    self._argv("shell", "am", "start", "-a", "android.intent.action.VIEW",
                               "-d", shlex.quote(arguments["url"])),
                    timeout=15,
                )
                return f"exit {rc}: {out.strip() or err.strip() or '(ok)'}"
        except FileNotFoundError:
            raise BridgeError("adb not found — install Android platform-tools")
        return f"unknown op {op}"

    @staticmethod
    def default_capabilities() -> list[str]:
        return [
            Capability.CONTROL.value,
            Capability.TELEMETRY.value,
            Capability.VISION.value,  # screenshots
        ]
