"""Live end-to-end harness: real Atlas agent (real LLM via OpenRouter)
against fake targets at increasing difficulty.

Usage:  python3 -m tests.live.run_agent_tests

Each level prints:
  → user prompt sent to the agent
  · tool calls the agent made (in order)
  ✓/✗ pass/fail criterion (did the agent autonomously connect + use the device?)
  – the agent's final reply

This is meant to surface real prompt / tool-selection bugs that unit
tests can't see — including the "I can't open a browser" reflex we
just hardened the system prompt against.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Make the Atlas root importable.
ATLAS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ATLAS_ROOT))

from kernel import Kernel  # noqa: E402
from plugins.config_plugin import ConfigPlugin  # noqa: E402
from plugins.memory_plugin import MemoryPlugin  # noqa: E402
from plugins.tools_plugin import ToolsPlugin  # noqa: E402
from plugins.devices_plugin import DevicesPlugin  # noqa: E402
from plugins.agent_plugin import AgentPlugin  # noqa: E402

from tests.live.fixtures import FakeCamera, FAKE_MCP_PATH  # noqa: E402


# ────────────────────────────────────────────────────────────────────────
# pretty printing
# ────────────────────────────────────────────────────────────────────────

class C:
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"
    GREEN = "\033[32m"
    RED = "\033[31m"
    YELLOW = "\033[33m"
    CYAN = "\033[36m"
    MAGENTA = "\033[35m"


def banner(text: str) -> None:
    print(f"\n{C.BOLD}{C.MAGENTA}━━━ {text} ━━━{C.RESET}\n")


def ok(text: str) -> None:
    print(f"{C.GREEN}✓{C.RESET} {text}")


def fail(text: str) -> None:
    print(f"{C.RED}✗{C.RESET} {text}")


# ────────────────────────────────────────────────────────────────────────
# Atlas runner
# ────────────────────────────────────────────────────────────────────────

class AgentRun:
    """Captures everything the agent does on one turn so we can grade it."""

    def __init__(self):
        self.tool_calls: list[str] = []
        self.tool_results: list[tuple[str, str]] = []
        self.tokens: list[str] = []

    async def on_token(self, token: str) -> None:
        self.tokens.append(token)
        sys.stdout.write(C.DIM + token + C.RESET)
        sys.stdout.flush()

    async def on_tool_call(self, name: str) -> None:
        self.tool_calls.append(name)
        sys.stdout.write(f"\n{C.CYAN}· tool: {name}{C.RESET}\n")
        sys.stdout.flush()

    async def on_tool_result(self, name: str, result: str) -> None:
        self.tool_results.append((name, result))
        # Show the first 120 chars so a human can sanity-check.
        snippet = result.replace("\n", " ")[:120]
        sys.stdout.write(f"{C.DIM}  ↳ {snippet}{'...' if len(result) > 120 else ''}{C.RESET}\n")
        sys.stdout.flush()

    async def on_reasoning(self, token: str) -> None:
        return

    @property
    def reply(self) -> str:
        return "".join(self.tokens)

    def saw_tool_result_containing(self, fragment: str) -> bool:
        return any(fragment in r for _, r in self.tool_results)


async def boot_atlas(workdir: Path) -> Kernel:
    """Boot Atlas with everything except the CLI plugin."""
    # Point Atlas at a clean workdir so the live test doesn't pollute the
    # user's real memory directory. We keep their api_key + default_model
    # by reading the real config first then redirecting paths.
    import shutil

    real_config = ATLAS_ROOT / "config.toml"
    if not real_config.exists():
        raise SystemExit(
            "no config.toml — set up an OpenRouter key first (run /config in atlas)"
        )

    # Copy config but redirect memory + devices into the temp workdir.
    config_dst = workdir / "config.toml"
    shutil.copy2(real_config, config_dst)

    try:
        import tomllib
    except ImportError:
        import tomli as tomllib  # type: ignore
    import tomli_w

    with open(config_dst, "rb") as f:
        cfg = tomllib.load(f)
    cfg.setdefault("memory", {})["path"] = str(workdir / "memory")
    cfg.setdefault("devices", {})["install_policy"] = "auto"
    # No auto-mounted devices for the harness — each scenario mounts fresh.
    cfg["devices"]["auto_mount"] = []
    cfg["tools"] = cfg.get("tools", {})
    cfg["tools"]["shell_confirm"] = False
    with open(config_dst, "wb") as f:
        tomli_w.dump(cfg, f)

    # Make ConfigPlugin pick up the redirected file by patching its globals.
    import plugins.config_plugin as cp
    cp.CONFIG_PATH = config_dst
    cp.ENV_PATH = workdir / ".env"

    kernel = Kernel()
    await kernel.load_plugin(ConfigPlugin)
    await kernel.load_plugin(MemoryPlugin)
    await kernel.load_plugin(ToolsPlugin)
    await kernel.load_plugin(DevicesPlugin)
    await kernel.load_plugin(AgentPlugin)
    return kernel


# ────────────────────────────────────────────────────────────────────────
# scenarios
# ────────────────────────────────────────────────────────────────────────

async def scenario_level1_camera_full_openapi(kernel: Kernel) -> bool:
    """Camera with full OpenAPI spec. Easy mode — `auto_connect` won't
    help (no MCP for our fake device), so the agent must fall back to
    `mount_device(kind="openapi")` and then call the snapshot tool."""
    cam = FakeCamera(difficulty=1)
    cam.start()
    try:
        prompt = (
            f"I have a new IP camera running at {cam.base_url}. "
            f"Its OpenAPI spec is at {cam.spec_url}. "
            f"Connect to it and grab a snapshot — I want to see the response bytes."
        )
        print(f"{C.BOLD}→{C.RESET} {prompt}")

        agent = kernel.get_plugin("agent")
        run = AgentRun()
        await agent.process(
            prompt,
            on_token=run.on_token,
            on_tool_call=run.on_tool_call,
            on_reasoning=run.on_reasoning,
            on_tool_result=run.on_tool_result,
        )
        print()  # newline after streaming

        mounted = any(t in run.tool_calls for t in ("auto_connect", "mount_device"))
        called_camera = any("snapshot" in t.lower() or "request" in t.lower() or "getinfo" in t.lower()
                            for t in run.tool_calls)
        passed = mounted and called_camera
        if passed:
            ok(f"agent mounted the camera and called it ({run.tool_calls})")
        else:
            fail(f"agent did not connect/use the camera. Tool calls: {run.tool_calls}")
        return passed
    finally:
        cam.stop()
        # Unmount anything the agent created so the next scenario starts clean.
        await _reset_devices(kernel)


async def scenario_level2_camera_partial_openapi(kernel: Kernel) -> bool:
    """OpenAPI exists but is incomplete — snapshot endpoint is missing.
    Agent should still find /api/snapshot via the http `request` escape
    hatch."""
    cam = FakeCamera(difficulty=2)
    cam.start()
    try:
        prompt = (
            f"My camera is at {cam.base_url}. There's an OpenAPI doc at "
            f"{cam.spec_url} but it might be incomplete. Connect, then "
            f"capture a snapshot from /api/snapshot — even if the spec "
            f"doesn't list it."
        )
        print(f"{C.BOLD}→{C.RESET} {prompt}")
        agent = kernel.get_plugin("agent")
        run = AgentRun()
        await agent.process(
            prompt, on_token=run.on_token, on_tool_call=run.on_tool_call,
            on_reasoning=run.on_reasoning, on_tool_result=run.on_tool_result,
        )
        print()

        mounted = any(t in run.tool_calls for t in ("auto_connect", "mount_device"))
        # The bridge actually fetched the snapshot if the marker shows up in
        # any tool result — independent of whether the model relayed it well.
        bridge_got_snapshot = run.saw_tool_result_containing("atlas-test-snapshot")
        passed = mounted and bridge_got_snapshot
        if passed:
            ok(f"bridge worked around the broken spec and fetched the snapshot")
        else:
            fail(
                f"bridge didn't reach /api/snapshot. Tool calls: {run.tool_calls}; "
                f"bridge snapshot result: {bridge_got_snapshot}"
            )
        return passed
    finally:
        cam.stop()
        await _reset_devices(kernel)


async def scenario_level3_camera_no_docs(kernel: Kernel) -> bool:
    """No spec at all. Agent gets only the base URL and is told the
    camera has /api/info and /api/snapshot. Must mount kind="http"."""
    cam = FakeCamera(difficulty=3)
    cam.start()
    try:
        prompt = (
            f"There's a device on my network at {cam.base_url}. No docs, "
            f"no OpenAPI. I know it has GET /api/info and GET /api/snapshot. "
            f"Wire it up to Atlas and fetch the info JSON."
        )
        print(f"{C.BOLD}→{C.RESET} {prompt}")
        agent = kernel.get_plugin("agent")
        run = AgentRun()
        await agent.process(
            prompt, on_token=run.on_token, on_tool_call=run.on_tool_call,
            on_reasoning=run.on_reasoning, on_tool_result=run.on_tool_result,
        )
        print()
        mounted = "mount_device" in run.tool_calls or "auto_connect" in run.tool_calls
        info_hit = "AtlasTestCam" in run.reply
        passed = mounted and info_hit
        if passed:
            ok(f"agent mounted via raw http and got the camera info")
        else:
            fail(
                f"agent didn't get the camera info. Tool calls: {run.tool_calls}; "
                f"saw 'AtlasTestCam' in reply: {info_hit}"
            )
        return passed
    finally:
        cam.stop()
        await _reset_devices(kernel)


async def scenario_level4_real_mcp_blind(kernel: Kernel) -> bool:
    """A real MCP stdio server on disk. Agent must use mount_device
    (kind='mcp') with stdio transport, then call the upstream `add` tool."""
    prompt = (
        f"There's an MCP server I want to connect: it's a Python script "
        f"at {FAKE_MCP_PATH}. It speaks the standard MCP stdio protocol. "
        f"Mount it as 'calc' and use its `add` tool to compute 17 + 25."
    )
    print(f"{C.BOLD}→{C.RESET} {prompt}")
    agent = kernel.get_plugin("agent")
    run = AgentRun()
    await agent.process(
        prompt, on_token=run.on_token, on_tool_call=run.on_tool_call,
        on_reasoning=run.on_reasoning, on_tool_result=run.on_tool_result,
    )
    print()

    mounted = "mount_device" in run.tool_calls
    used_namespaced = any(t.startswith("calc__") for t in run.tool_calls)
    answer_in_reply = "42" in run.reply
    passed = mounted and used_namespaced and answer_in_reply
    if passed:
        ok(f"agent mounted the MCP server and computed 17+25=42")
    else:
        fail(
            f"agent failed. mounted={mounted} used_namespaced={used_namespaced} "
            f"answer_in_reply={answer_in_reply} tool_calls={run.tool_calls}"
        )
    await _reset_devices(kernel)
    return passed


async def scenario_level5_compose_two_devices(kernel: Kernel) -> bool:
    """Both running. Agent must mount BOTH (camera + MCP), then call
    each. Tests cross-device tool composition."""
    cam = FakeCamera(difficulty=1)
    cam.start()
    try:
        prompt = (
            f"Two devices to wire up:\n"
            f"  1) IP camera at {cam.base_url} (OpenAPI at {cam.spec_url}). "
            f"     Mount it as 'cam'.\n"
            f"  2) MCP server at {FAKE_MCP_PATH} (stdio Python). "
            f"     Mount it as 'mcp'.\n"
            f"Then: get the camera info AND ask the MCP server to add 100 + 23. "
            f"Report both answers."
        )
        print(f"{C.BOLD}→{C.RESET} {prompt}")
        agent = kernel.get_plugin("agent")
        run = AgentRun()
        await agent.process(
            prompt, on_token=run.on_token, on_tool_call=run.on_tool_call,
            on_reasoning=run.on_reasoning, on_tool_result=run.on_tool_result,
        )
        print()
        mounts = sum(1 for t in run.tool_calls if t == "mount_device")
        cam_hit = "AtlasTestCam" in run.reply
        mcp_hit = "123" in run.reply
        passed = mounts >= 2 and cam_hit and mcp_hit
        if passed:
            ok(f"agent mounted both devices and used both")
        else:
            fail(
                f"composition failed. mount_device count={mounts}; "
                f"cam info in reply={cam_hit}; '123' in reply={mcp_hit}; "
                f"tool_calls={run.tool_calls}"
            )
        return passed
    finally:
        cam.stop()
        await _reset_devices(kernel)


# ────────────────────────────────────────────────────────────────────────
# helpers
# ────────────────────────────────────────────────────────────────────────

async def _reset_devices(kernel: Kernel) -> None:
    """Unmount everything so the next scenario gets a clean slate."""
    devices = kernel.get_plugin("devices")
    for record in list(devices.list()):
        try:
            await devices.unmount(record.spec.name)
        except Exception:
            pass
    # Reset the agent's history too so prior conversation doesn't bias
    # the next scenario's reasoning.
    agent = kernel.get_plugin("agent")
    agent._history.clear()


# ────────────────────────────────────────────────────────────────────────
# entry point
# ────────────────────────────────────────────────────────────────────────

SCENARIOS = [
    ("Level 1 — Camera with FULL OpenAPI",      scenario_level1_camera_full_openapi),
    ("Level 2 — Camera with PARTIAL OpenAPI",   scenario_level2_camera_partial_openapi),
    ("Level 3 — Camera with NO docs",           scenario_level3_camera_no_docs),
    ("Level 4 — Blind MCP stdio server",        scenario_level4_real_mcp_blind),
    ("Level 5 — Compose camera + MCP",          scenario_level5_compose_two_devices),
]


async def main():
    workdir = ATLAS_ROOT / ".atlas-live-test"
    workdir.mkdir(exist_ok=True)
    kernel = await boot_atlas(workdir)

    results: list[tuple[str, bool, float, str]] = []
    try:
        for name, fn in SCENARIOS:
            banner(name)
            t0 = time.time()
            error = ""
            try:
                passed = await fn(kernel)
            except Exception as e:
                passed = False
                error = f"{e.__class__.__name__}: {e}"
                traceback.print_exc()
            elapsed = time.time() - t0
            results.append((name, passed, elapsed, error))
    finally:
        await kernel.unload_all()

    banner("RESULTS")
    for name, passed, elapsed, error in results:
        marker = f"{C.GREEN}PASS{C.RESET}" if passed else f"{C.RED}FAIL{C.RESET}"
        print(f"  {marker}  {name}  ({elapsed:.1f}s)" + (f"  — {error}" if error else ""))
    n_pass = sum(1 for _, p, _, _ in results if p)
    print(f"\n{C.BOLD}{n_pass}/{len(results)} scenarios passed{C.RESET}\n")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
