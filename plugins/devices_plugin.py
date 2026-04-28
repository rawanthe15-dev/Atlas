"""DevicesPlugin — runtime registry of connected devices.

Each "device" is a `Bridge` instance. Mounting registers its tools into
the global ToolsPlugin namespaced as `<device>__<tool>`. Unmount removes
them and closes the transport. Specs persist under `memory/devices/`,
so mounted devices survive Atlas restarts.

Trust gate (`InstallPolicy`): trusted MCP sources install silently;
arbitrary code-running mounts (mcp/process/shell) prompt once unless
the source is on the trusted list.
"""
from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable, Optional, Union

from bridges import Bridge, BridgeTool, DeviceRecord
from bridges.dynamic_tool import namespaced_tool_name
from bridges.installer import MCPInstaller
from bridges.policy import InstallPolicy, PolicyDenied
from bridges.registry import make_bridge, search_mcp_registry, MCPCandidate
from bridges.spec import BridgeSpec
from bridges.state import DeviceStore

from .base import AtlasPlugin


class DevicesPlugin(AtlasPlugin):
    name = "devices"

    def __init__(self):
        self._kernel = None
        self._records: dict[str, DeviceRecord] = {}
        self._bridges: dict[str, Bridge] = {}
        self._store: Optional[DeviceStore] = None
        self._policy = InstallPolicy()
        self._installer = MCPInstaller(policy=self._policy)

    async def load(self, kernel) -> None:
        self._kernel = kernel
        mem_path = Path(kernel.config.get("memory", {}).get("path", "./memory"))
        self._store = DeviceStore(mem_path / "devices")

        cfg = kernel.config.get("devices", {}) or {}
        self._policy = InstallPolicy(
            mode=cfg.get("install_policy", "auto"),
            trusted_sources=cfg.get("trusted_sources"),
        )
        self._installer.set_policy(self._policy)

        # Register device-management tools directly — no special-casing
        # in ToolsPlugin.
        from tools.device_tools import (
            ListDevicesTool, MountDeviceTool, UnmountDeviceTool,
            InspectDeviceTool, SearchMCPTool, InstallMCPTool, AutoConnectTool,
        )
        tools = kernel.get_plugin("tools")
        for tool in [
            ListDevicesTool(self),
            MountDeviceTool(self),
            UnmountDeviceTool(self),
            InspectDeviceTool(self),
            SearchMCPTool(self),
            InstallMCPTool(self),
            AutoConnectTool(self),
        ]:
            tools.register(tool)

        # Auto-mount declared devices, then restore previously mounted ones.
        for entry in cfg.get("auto_mount", []) or []:
            try:
                spec = BridgeSpec.from_dict(entry)
                await self._mount_internal(spec, persist=False, source="config")
            except Exception as e:
                print(f"[devices] auto_mount '{entry.get('name','?')}' failed: {e}")

        for spec in self._store.load_all():
            if spec.name in self._records:
                continue
            try:
                await self._mount_internal(spec, persist=False, source="restore")
            except Exception as e:
                print(f"[devices] could not restore '{spec.name}': {e}")

    async def unload(self) -> None:
        for name in list(self._records.keys()):
            try:
                await self._unmount_internal(name, persist=False)
            except Exception:
                pass

    # ── confirm wiring (CLI plugin sets this on load) ──────────────────────

    def set_install_confirm(
        self,
        fn: Optional[Callable[[str, str], Union[bool, Awaitable[bool]]]],
    ) -> None:
        self._installer.set_confirm(fn)
        self._mount_confirm = fn

    _mount_confirm = None

    # ── public API used by tools and CLI ───────────────────────────────────

    async def mount(self, spec: BridgeSpec, *, source: str = "user") -> DeviceRecord:
        return await self._mount_internal(spec, persist=True, source=source)

    async def unmount(self, name: str) -> None:
        await self._unmount_internal(name, persist=True)

    def get(self, name: str) -> Optional[DeviceRecord]:
        return self._records.get(name)

    def list(self) -> list[DeviceRecord]:
        return list(self._records.values())

    def policy(self) -> InstallPolicy:
        return self._policy

    async def search_mcp(self, query: str, limit: int = 10) -> list[MCPCandidate]:
        return await search_mcp_registry(query, limit)

    async def install_and_mount_mcp(
        self,
        candidate: MCPCandidate,
        device_name: str,
        env: Optional[dict] = None,
        cwd: Optional[str] = None,
    ) -> DeviceRecord:
        spec, _log = await self._installer.install_and_build_spec(
            candidate, device_name=device_name, env=env, cwd=cwd,
        )
        # Skip the policy gate inside _mount_internal — the installer
        # already cleared it. Mark source so future logging knows.
        return await self._mount_internal(
            spec, persist=True, source=candidate.source, skip_policy=True,
        )

    async def auto_connect(self, name: str, query: str) -> dict:
        """One-shot autonomy: search registries, pick the best trusted
        result, install + mount silently. Returns a structured dict for
        the agent to act on."""
        cands = await self.search_mcp(query, limit=10)
        if not cands:
            return {
                "status": "no_match",
                "message": f"no MCP servers matched '{query}'",
                "candidates": [],
            }
        # Prefer trusted, then by score.
        trusted = [c for c in cands if self._policy.is_trusted(c.source, c.id)]
        if trusted:
            chosen = trusted[0]
            try:
                record = await self.install_and_mount_mcp(chosen, device_name=name)
            except PolicyDenied as e:
                return {"status": "denied", "message": str(e), "candidates": [c.to_dict() for c in cands]}
            except Exception as e:
                return {
                    "status": "install_failed",
                    "message": f"trusted candidate {chosen.id} failed: {e}",
                    "candidates": [c.to_dict() for c in cands],
                }
            return {
                "status": "mounted",
                "device": record.public_summary(),
                "chose": chosen.to_dict(),
            }
        # No trusted match — present options to the agent so the user can
        # confirm via install_mcp explicitly. Don't silent-install random code.
        return {
            "status": "needs_confirmation",
            "message": (
                "found candidates but none are from a trusted source. "
                "call install_mcp(...) on one to confirm and proceed."
            ),
            "candidates": [c.to_dict() for c in cands[:5]],
        }

    # ── internals ──────────────────────────────────────────────────────────

    async def _mount_internal(
        self,
        spec: BridgeSpec,
        *,
        persist: bool,
        source: str = "user",
        skip_policy: bool = False,
    ) -> DeviceRecord:
        if spec.name in self._records:
            raise ValueError(f"device '{spec.name}' is already mounted; unmount first")

        if not skip_policy:
            decision = self._policy.decide_mount(spec.kind, source=source, id_=spec.name)
            if not decision.allow:
                raise PolicyDenied(
                    f"mount '{spec.name}' refused: {decision.reason}"
                )
            if decision.prompt and self._mount_confirm is not None:
                ok = self._mount_confirm(
                    "mount risky bridge",
                    f"name: {spec.name}\nkind: {spec.kind}\nconfig: {spec.config!r}",
                )
                import asyncio as _asyncio
                if _asyncio.iscoroutine(ok):
                    ok = await ok
                if not ok:
                    raise RuntimeError("user declined to mount risky bridge")

        bridge = make_bridge(spec)
        await bridge.connect()
        tool_specs = await bridge.discover()
        if not spec.capabilities:
            ctor = type(bridge)
            if hasattr(ctor, "default_capabilities"):
                spec.capabilities = ctor.default_capabilities()

        tools_plugin = self._kernel.get_plugin("tools")
        registered: list[str] = []
        for ts in tool_specs:
            tool = BridgeTool(bridge, ts)
            tools_plugin.register(tool)
            registered.append(tool.name)

        record = DeviceRecord(spec=spec, tool_names=registered)
        self._records[spec.name] = record
        self._bridges[spec.name] = bridge
        if persist and self._store is not None:
            self._store.save(spec)

        await self._note_in_memory(spec, registered)
        return record

    async def _unmount_internal(self, name: str, *, persist: bool) -> None:
        record = self._records.pop(name, None)
        bridge = self._bridges.pop(name, None)
        if not record:
            raise KeyError(f"device '{name}' is not mounted")

        tools_plugin = self._kernel.get_plugin("tools")
        for tn in record.tool_names:
            tools_plugin.unregister(tn)

        if bridge is not None:
            try:
                await bridge.aclose()
            except Exception:
                pass

        if persist and self._store is not None:
            self._store.delete(name)

    async def _note_in_memory(self, spec: BridgeSpec, tool_names: list[str]) -> None:
        if self._store is None:
            return
        try:
            doc = (
                f"# Device: {spec.name}\n\n"
                f"- kind: `{spec.kind}`\n"
                f"- capabilities: {', '.join(spec.capabilities) or '(none declared)'}\n"
                f"- tools: {', '.join(tool_names) or '(none)'}\n"
                f"- mounted: {spec.created_at}\n\n"
                f"{spec.description}\n"
            )
            md_path = self._store.root / f"{spec.name}.md"
            md_path.write_text(doc, encoding="utf-8")
        except Exception:
            pass
