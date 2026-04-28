"""Agent-callable tools for the device-connectivity layer.

Mounted devices contribute their *own* tools via DevicesPlugin (namespaced
`device__tool`). The tools in this file let the agent manage the device
layer itself: search, install, mount, unmount, inspect.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .base import Tool

if TYPE_CHECKING:
    from plugins.devices_plugin import DevicesPlugin


class ListDevicesTool(Tool):
    name = "list_devices"
    description = "List every device currently mounted in Atlas, including each device's tools and declared capabilities."
    parameters = {"type": "object", "properties": {}, "required": []}

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self) -> str:
        records = self._devices.list()
        if not records:
            return "(no devices mounted)"
        return "\n\n".join(json.dumps(r.public_summary(), indent=2) for r in records)


class MountDeviceTool(Tool):
    name = "mount_device"
    description = (
        "Connect a new device to Atlas. Picks a Bridge implementation from "
        "the supplied 'kind' and registers all of the device's tools with "
        "names like '<device>__<tool>'. Persists across restarts.\n\n"
        "Supported kinds (and required config keys):\n"
        "  • http          — base_url, [headers], [timeout]\n"
        "  • openapi       — spec_url, [base_url], [headers]\n"
        "  • mcp           — transport ('stdio'|'http'), command|url, [env], [cwd], [headers]\n"
        "  • homeassistant — url, token\n"
        "  • adb           — [device_id]\n"
        "  • ble           — address\n"
        "  • serial        — port, [baudrate], [timeout], [eol]\n"
        "  • process       — binary, [cwd], [env]\n"
        "  • shell         — commands: [{name, description, template, params, timeout}]\n"
    )
    parameters = {
        "type": "object",
        "properties": {
            "name":         {"type": "string", "description": "Unique device name (alphanumeric/_/-)"},
            "kind":         {"type": "string"},
            "config":       {"type": "object", "additionalProperties": True},
            "description":  {"type": "string"},
            "capabilities": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["name", "kind", "config"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self, name: str, kind: str, config: dict,
                  description: str = "", capabilities: list | None = None) -> str:
        from bridges.spec import BridgeSpec
        spec = BridgeSpec(
            name=name, kind=kind, config=config or {},
            description=description, capabilities=capabilities or [],
        )
        try:
            record = await self._devices.mount(spec)
        except Exception as e:
            return f"mount failed: {e}"
        return (
            f"mounted '{record.spec.name}' ({record.spec.kind}) with "
            f"{len(record.tool_names)} tools: {', '.join(record.tool_names) or '(none)'}"
        )


class UnmountDeviceTool(Tool):
    name = "unmount_device"
    description = "Disconnect a mounted device and remove its tools."
    parameters = {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self, name: str) -> str:
        try:
            await self._devices.unmount(name)
        except KeyError:
            return f"no device named '{name}' is mounted"
        except Exception as e:
            return f"unmount failed: {e}"
        return f"unmounted '{name}'"


class InspectDeviceTool(Tool):
    name = "inspect_device"
    description = "Return full details (capabilities + tool list) for one mounted device."
    parameters = {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self, name: str) -> str:
        rec = self._devices.get(name)
        if rec is None:
            return f"no device named '{name}' is mounted"
        return json.dumps(rec.public_summary(), indent=2)


class SearchMCPTool(Tool):
    name = "search_mcp"
    description = (
        "Search public MCP server registries (official, npm, GitHub) for "
        "ready-made connectors that match a query. Use this BEFORE building "
        "a custom bridge — many devices and services already have an MCP "
        "server you can install directly. Returns candidates with install "
        "commands; pair with `install_mcp` to actually mount one."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Keywords (e.g. 'github', 'spotify', 'filesystem')"},
            "limit": {"type": "integer", "description": "Max results (default 10)"},
        },
        "required": ["query"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self, query: str, limit: int = 10) -> str:
        cands = await self._devices.search_mcp(query, limit=limit)
        if not cands:
            return "(no MCP servers found for that query)"
        return json.dumps([c.to_dict() for c in cands], indent=2)


class InstallMCPTool(Tool):
    name = "install_mcp"
    description = (
        "Install and mount an MCP server discovered via `search_mcp`. The "
        "user is prompted to confirm BOTH the mount and any package install "
        "step before anything runs. Pass either the candidate id directly "
        "or a custom install_command. After this returns, the MCP server's "
        "tools are exposed as `<device_name>__<tool>` and can be called."
    )
    parameters = {
        "type": "object",
        "properties": {
            "device_name":     {"type": "string", "description": "Local mount name to give this MCP server"},
            "candidate_id":    {"type": "string", "description": "id from a search_mcp result"},
            "source":          {"type": "string", "enum": ["npm", "github", "official", "custom"]},
            "install_command": {"type": "string", "description": "Override / custom command (e.g. 'npx -y @x/y')"},
            "description":     {"type": "string"},
            "env":             {"type": "object", "additionalProperties": {"type": "string"}},
            "cwd":             {"type": "string"},
        },
        "required": ["device_name"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(
        self,
        device_name: str,
        candidate_id: str = "",
        source: str = "custom",
        install_command: str = "",
        description: str = "",
        env: dict | None = None,
        cwd: str | None = None,
    ) -> str:
        from bridges.registry import MCPCandidate
        if not candidate_id and not install_command:
            return "either candidate_id or install_command is required"
        # If only an id is given, the agent should already have a search
        # result in context; fall back to assuming it's an npm package.
        if not install_command and candidate_id:
            install_command = f"npx -y {candidate_id}" if source != "official" else f"uvx {candidate_id}"
        cand = MCPCandidate(
            id=candidate_id or device_name,
            source=source or "custom",
            name=device_name,
            description=description,
            install_command=install_command,
            transport="stdio",
        )
        try:
            record = await self._devices.install_and_mount_mcp(
                cand, device_name=device_name, env=env, cwd=cwd,
            )
        except Exception as e:
            return f"install/mount declined or failed: {e}"
        return (
            f"installed + mounted '{record.spec.name}' with "
            f"{len(record.tool_names)} tools: {', '.join(record.tool_names) or '(none)'}"
        )


class AutoConnectTool(Tool):
    name = "auto_connect"
    description = (
        "Autonomously connect Atlas to a service or device. Searches public "
        "MCP registries for an existing connector, picks the best result "
        "from a TRUSTED source, installs it, and mounts it — all in one "
        "call. No user prompts when the match is trusted. If no trusted "
        "match is found, returns the candidate list so you can decide "
        "whether to install a non-trusted one with `install_mcp`. If "
        "nothing matches at all, fall back to `mount_device` with a "
        "kind like 'openapi', 'http', or 'shell'.\n\n"
        "Use this FIRST whenever the user introduces a new device, app, "
        "or service. It is the highest-leverage way to extend Atlas."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name":  {"type": "string", "description": "Local name to mount the device under"},
            "query": {"type": "string", "description": "Keywords describing the target (e.g. 'spotify', 'github issues', 'filesystem')"},
        },
        "required": ["name", "query"],
    }

    def __init__(self, devices: "DevicesPlugin"):
        self._devices = devices

    async def run(self, name: str, query: str) -> str:
        result = await self._devices.auto_connect(name=name, query=query)
        return json.dumps(result, indent=2)


class IntrospectURLTool(Tool):
    name = "introspect_url"
    description = (
        "Fetch the contents of a URL (an OpenAPI spec, a README, or any web "
        "page) and return the raw text — handy when sizing up a device or "
        "service before building a bridge."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url":        {"type": "string"},
            "max_chars":  {"type": "integer", "description": "Cap on returned chars (default 8000)"},
        },
        "required": ["url"],
    }

    async def run(self, url: str, max_chars: int = 8000) -> str:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cli:
                resp = await cli.get(url)
                text = resp.text
        except Exception as e:
            return f"fetch failed: {e}"
        if len(text) > max_chars:
            text = text[:max_chars] + f"\n... ({len(text) - max_chars} chars truncated)"
        return f"HTTP {resp.status_code} {url}\n\n{text}"
