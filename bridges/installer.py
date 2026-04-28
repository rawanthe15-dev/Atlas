"""Install MCP servers discovered via the registry, then mount them.

The actual install of npx/uvx packages is "lazy" — those tools fetch on
first invocation. For `pip install` / `npm install -g` style packages we
shell out (with a user-confirmation hook).

Confirmation flow mirrors ShellTool: callback installed by the CLI plugin
asks the user "install X? y/N" before any subprocess runs.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Union

from .policy import InstallPolicy, PolicyDenied
from .registry import MCPCandidate
from .spec import BridgeSpec


ConfirmCallback = Callable[[str, str], Union[bool, Awaitable[bool]]]
"""Signature: (action, detail) -> bool. CLI implementation prompts the user."""


@dataclass
class InstallPlan:
    """The planned operations for one candidate."""
    candidate: MCPCandidate
    pre_install_cmd: Optional[str]   # e.g. "pip install foo" or None for npx/uvx
    runtime_command: str             # exact command the bridge will run
    needs_confirm: bool


def plan_install(candidate: MCPCandidate) -> InstallPlan:
    cmd = candidate.install_command.strip()
    # `npx -y` / `uvx` self-install — no separate step needed.
    if cmd.startswith("npx ") or cmd.startswith("uvx "):
        return InstallPlan(candidate=candidate, pre_install_cmd=None,
                           runtime_command=cmd, needs_confirm=True)
    # `pip install pkg && pkg-cmd` — split into install + run.
    pip_match = re.match(r"^pip install\s+([^\s;]+)\s*(?:&&\s*(.+))?$", cmd)
    if pip_match:
        pkg, rest = pip_match.group(1), pip_match.group(2)
        runtime = rest or pkg.split("==")[0].split(">=")[0]
        return InstallPlan(candidate=candidate,
                           pre_install_cmd=f"pip install {pkg}",
                           runtime_command=runtime, needs_confirm=True)
    # default: run as-is, no separate install step.
    return InstallPlan(candidate=candidate, pre_install_cmd=None,
                       runtime_command=cmd, needs_confirm=True)


class MCPInstaller:
    """Install + mount MCP servers, gated by an InstallPolicy.

    Flow per install:
      1. policy.decide_install(source, id) — auto-allow, prompt, or deny
      2. if prompt → call confirm_callback (CLI prompts the user; non-CLI
         contexts default-allow if no callback was set)
      3. run pre-install (pip/npm) with the same gate, then build a
         BridgeSpec the DevicesPlugin can mount.
    """

    def __init__(
        self,
        policy: Optional[InstallPolicy] = None,
        confirm: Optional[ConfirmCallback] = None,
    ):
        self._policy = policy or InstallPolicy()
        self._confirm = confirm

    def set_confirm(self, fn: Optional[ConfirmCallback]) -> None:
        self._confirm = fn

    def set_policy(self, policy: InstallPolicy) -> None:
        self._policy = policy

    async def _ask(self, action: str, detail: str) -> bool:
        if self._confirm is None:
            # Non-interactive: defer to whatever the policy already allowed.
            return True
        result = self._confirm(action, detail)
        if asyncio.iscoroutine(result):
            return bool(await result)
        return bool(result)

    async def _run(self, cmd: str, timeout: int = 600) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode(errors="replace")

    async def install_and_build_spec(
        self,
        candidate: MCPCandidate,
        device_name: str,
        env: dict | None = None,
        cwd: str | None = None,
    ) -> tuple[BridgeSpec, str]:
        """Returns (spec, log). Raises PolicyDenied if blocked, or RuntimeError
        if the user declines a prompt or install fails."""
        plan = plan_install(candidate)

        decision = self._policy.decide_install(candidate.source, candidate.id)
        if not decision.allow:
            raise PolicyDenied(
                f"install of '{candidate.id}' refused: {decision.reason}"
            )

        # Only prompt when policy says to. Trusted sources skip this entirely.
        if decision.prompt:
            ok = await self._ask(
                "mount mcp server",
                f"name: {device_name}\nsource: {candidate.source}\nid: {candidate.id}\n"
                f"runtime command: {plan.runtime_command}",
            )
            if not ok:
                raise RuntimeError("user declined to mount MCP server")

        log_parts: list[str] = []

        # Pre-install: prompt when policy demands; auto-run when trusted.
        if plan.pre_install_cmd:
            if decision.prompt:
                ok2 = await self._ask("install package", plan.pre_install_cmd)
                if not ok2:
                    raise RuntimeError("user declined pre-install step")
            rc, out = await self._run(plan.pre_install_cmd, timeout=900)
            log_parts.append(f"$ {plan.pre_install_cmd}\n{out}")
            if rc != 0:
                raise RuntimeError(f"pre-install failed (exit {rc})\n{out[-1000:]}")

        spec = BridgeSpec(
            name=device_name,
            kind="mcp",
            config={
                "transport": "stdio",
                "command":   plan.runtime_command,
                "env":       env or None,
                "cwd":       cwd,
            },
            capabilities=["control", "telemetry"],
            description=f"MCP server: {candidate.description}"[:300],
        )
        return spec, "\n\n".join(log_parts) if log_parts else "ok"
