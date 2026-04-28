"""Wraps any local CLI binary as a single tool (`run`).

Distinct from ShellBridge: that one defines named, type-checked commands;
this one is a one-shot exec for tools that take args at the agent's
discretion (rclone, ffmpeg, kubectl, …).
"""
from __future__ import annotations

import asyncio
import shlex
from typing import List

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


class ProcessBridge(Bridge):
    """`config`:
        binary:   str   — path or command name (e.g. "rclone")
        cwd:      str   (optional)
        env:      dict  (optional)
        timeout:  int   (default 60)
    """

    kind = "process"

    async def connect(self) -> None:
        return None  # nothing to open

    async def discover(self) -> List[ToolSpec]:
        binary = self.spec.config.get("binary", "")
        if not binary:
            raise BridgeError("process bridge: 'binary' is required")
        return [
            ToolSpec(
                name="run",
                description=f"Run `{binary}` with the given argv. Returns stdout/stderr.",
                parameters={
                    "type": "object",
                    "properties": {
                        "args":   {"type": "array", "items": {"type": "string"}, "description": "argv passed after the binary"},
                        "stdin":  {"type": "string", "description": "Optional stdin"},
                        "timeout": {"type": "integer", "description": "Timeout seconds"},
                    },
                    "required": ["args"],
                },
                handler={"op": "run"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        cfg = self.spec.config
        binary = cfg.get("binary", "")
        if not binary:
            raise BridgeError("process bridge: 'binary' is required")
        argv = [binary, *list(arguments.get("args", []))]
        timeout = int(arguments.get("timeout", cfg.get("timeout", 60)))
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cfg.get("cwd"),
                env=cfg.get("env"),
            )
            stdin_bytes = (arguments.get("stdin") or "").encode() or None
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin_bytes), timeout=timeout
            )
        except asyncio.TimeoutError:
            return f"timed out after {timeout}s"
        except Exception as e:
            raise BridgeError(f"process exec failed: {e}") from e
        out = stdout.decode(errors="replace").strip()
        err = stderr.decode(errors="replace").strip()
        body = out if not err else (f"{out}\nstderr: {err}" if out else f"stderr: {err}")
        return f"exit {proc.returncode}: {body or '(no output)'}"

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value]
