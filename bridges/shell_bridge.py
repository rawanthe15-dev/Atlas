"""Declarative shell-command bridge — give it a list of named commands and
each becomes its own tool. Templating uses simple {param} substitution.

Example config (in `config.toml` or via `mount_device`):

    [[devices]]
    name = "tv"
    kind = "shell"
    [devices.config]
    commands = [
      { name = "on",     description = "Turn the TV on",  template = "irsend SEND_ONCE livingroom KEY_POWER" },
      { name = "volume", description = "Set volume {level}", template = "irsend SEND_ONCE livingroom KEY_VOL{level}",
        params = { level = { type = "string", enum = ["UP","DOWN"] } } },
    ]
"""
from __future__ import annotations

import asyncio
import re
import shlex
from typing import List

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


_TEMPLATE_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")


def _format_template(template: str, args: dict) -> str:
    def repl(m):
        key = m.group(1)
        if key not in args:
            raise BridgeError(f"shell bridge: missing required argument '{key}'")
        return shlex.quote(str(args[key]))
    return _TEMPLATE_RE.sub(repl, template)


class ShellBridge(Bridge):
    """`config`:
        commands: list of {
            name:        str,
            description: str,
            template:    str   (use {param} placeholders),
            params:      dict  (JSON-Schema-ish: {param: {type, description, enum}})
            timeout:     int   (default 30)
        }
        confirm:  bool — if true, kernel-level shell-confirm hook is invoked
    """

    kind = "shell"

    async def connect(self) -> None:
        return None

    async def discover(self) -> List[ToolSpec]:
        commands = self.spec.config.get("commands", []) or []
        out: list[ToolSpec] = []
        for cmd in commands:
            if not cmd.get("name") or not cmd.get("template"):
                continue
            params = cmd.get("params", {}) or {}
            placeholders = set(_TEMPLATE_RE.findall(cmd["template"]))
            properties = {}
            required: list[str] = []
            for ph in placeholders:
                meta = params.get(ph, {"type": "string"})
                properties[ph] = meta
                required.append(ph)
            out.append(ToolSpec(
                name=cmd["name"],
                description=cmd.get("description", cmd["template"])[:300],
                parameters={
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": False,
                },
                handler={
                    "op": "shell_template",
                    "template": cmd["template"],
                    "timeout": int(cmd.get("timeout", 30)),
                },
            ))
        return out

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        op = tool.handler.get("op")
        if op != "shell_template":
            raise BridgeError(f"shell bridge: unknown op {op!r}")
        cmd_str = _format_template(tool.handler["template"], arguments)
        timeout = int(tool.handler.get("timeout", 30))
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd_str,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            return f"timed out after {timeout}s"
        out = stdout.decode(errors="replace").strip()
        err = stderr.decode(errors="replace").strip()
        body = out if not err else (f"{out}\nstderr: {err}" if out else f"stderr: {err}")
        return f"exit {proc.returncode}: {body or '(ok)'}"

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value]
