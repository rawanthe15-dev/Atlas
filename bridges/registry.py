"""Bridge factory + MCP server discovery across public registries.

Two roles:
  1. `make_bridge(spec)` — instantiate the right Bridge subclass for a kind.
  2. `search_mcp_registry(query)` — search public sources for ready-made
     MCP servers the user can install (npm, GitHub, official registry).
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, asdict
from typing import Optional

import httpx

from .base import Bridge
from .spec import BridgeSpec


def make_bridge(spec: BridgeSpec) -> Bridge:
    kind = spec.kind.lower()
    if kind == "http":
        from .http_bridge import HTTPBridge
        return HTTPBridge(spec)
    if kind == "openapi":
        from .openapi_bridge import OpenAPIBridge
        return OpenAPIBridge(spec)
    if kind == "mcp":
        from .mcp_bridge import MCPBridge
        return MCPBridge(spec)
    if kind == "process":
        from .process_bridge import ProcessBridge
        return ProcessBridge(spec)
    if kind == "shell":
        from .shell_bridge import ShellBridge
        return ShellBridge(spec)
    if kind == "homeassistant":
        from .homeassistant_bridge import HomeAssistantBridge
        return HomeAssistantBridge(spec)
    if kind == "adb":
        from .adb_bridge import ADBBridge
        return ADBBridge(spec)
    if kind == "ble":
        from .ble_bridge import BLEBridge
        return BLEBridge(spec)
    if kind == "serial":
        from .serial_bridge import SerialBridge
        return SerialBridge(spec)
    raise ValueError(
        f"unknown bridge kind '{spec.kind}'. supported: "
        "http, openapi, mcp, process, shell, homeassistant, adb, ble, serial"
    )


def supported_kinds() -> list[str]:
    return [
        "http", "openapi", "mcp", "process", "shell",
        "homeassistant", "adb", "ble", "serial",
    ]


# ─── MCP server search ────────────────────────────────────────────────────

@dataclass
class MCPCandidate:
    """A discovered MCP server the user could install."""
    id: str                    # canonical id (npm package, github repo, registry id)
    source: str                # "npm" | "github" | "official"
    name: str
    description: str
    install_command: str       # ready to feed into installer (e.g. "npx @x/y")
    transport: str = "stdio"   # MCP transport hint
    homepage: str = ""
    score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


async def _search_npm(query: str, limit: int = 10) -> list[MCPCandidate]:
    url = "https://registry.npmjs.org/-/v1/search"
    out: list[MCPCandidate] = []
    try:
        async with httpx.AsyncClient(timeout=15) as cli:
            resp = await cli.get(url, params={"text": f"{query} mcp-server", "size": limit})
            if resp.status_code != 200:
                return out
            data = resp.json()
            for hit in data.get("objects", []):
                pkg = hit.get("package", {})
                name = pkg.get("name", "")
                # MCP server packages are conventionally named.
                if not (name.startswith("@modelcontextprotocol/server-")
                        or "mcp-server" in name
                        or "mcp" in (pkg.get("keywords") or [])):
                    continue
                out.append(MCPCandidate(
                    id=name,
                    source="npm",
                    name=name,
                    description=(pkg.get("description") or "")[:240],
                    install_command=f"npx -y {name}",
                    transport="stdio",
                    homepage=pkg.get("links", {}).get("homepage", ""),
                    score=float(hit.get("score", {}).get("final", 0.0)),
                ))
    except Exception:
        pass
    return out


async def _search_github(query: str, limit: int = 10) -> list[MCPCandidate]:
    """Search GitHub for repos tagged mcp-server. No auth — rate-limited
    to ~10 req/min/IP, fine for interactive use."""
    url = "https://api.github.com/search/repositories"
    out: list[MCPCandidate] = []
    try:
        async with httpx.AsyncClient(timeout=15) as cli:
            resp = await cli.get(
                url,
                params={
                    "q": f"{query} topic:mcp-server",
                    "sort": "stars",
                    "per_page": limit,
                },
                headers={"Accept": "application/vnd.github+json"},
            )
            if resp.status_code != 200:
                return out
            for repo in resp.json().get("items", []):
                full = repo.get("full_name", "")
                lang = repo.get("language", "") or ""
                # Heuristic install: python projects → uvx git+url; node → npx
                if lang.lower() in ("python", "py"):
                    install = f"uvx --from git+https://github.com/{full} mcp-server"
                else:
                    install = f"npx -y github:{full}"
                out.append(MCPCandidate(
                    id=full,
                    source="github",
                    name=repo.get("name", full),
                    description=(repo.get("description") or "")[:240],
                    install_command=install,
                    transport="stdio",
                    homepage=repo.get("html_url", ""),
                    score=float(repo.get("stargazers_count", 0)) / 100.0,
                ))
    except Exception:
        pass
    return out


async def _search_official(query: str, limit: int = 10) -> list[MCPCandidate]:
    """Try the in-development official registry; fail silently if absent."""
    url = "https://registry.modelcontextprotocol.io/v0/servers"
    out: list[MCPCandidate] = []
    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            resp = await cli.get(url, params={"search": query, "limit": limit})
            if resp.status_code != 200:
                return out
            data = resp.json()
            for server in data.get("servers", []):
                pkg = (server.get("packages") or [{}])[0]
                pkg_name = pkg.get("name") or server.get("name", "")
                runtime = (pkg.get("runtime_hint") or pkg.get("registry_name") or "").lower()
                if runtime in ("node", "npm", "npx"):
                    install = f"npx -y {pkg_name}"
                elif runtime in ("python", "pypi", "uvx"):
                    install = f"uvx {pkg_name}"
                else:
                    install = pkg_name
                out.append(MCPCandidate(
                    id=server.get("name", pkg_name),
                    source="official",
                    name=server.get("name", pkg_name),
                    description=(server.get("description") or "")[:240],
                    install_command=install,
                    transport="stdio",
                    homepage=server.get("repository", {}).get("url", ""),
                    score=10.0,  # trust official > scraped
                ))
    except Exception:
        pass
    return out


async def search_mcp_registry(query: str, limit: int = 10) -> list[MCPCandidate]:
    """Federated search across registries. Results merged and de-duped by id."""
    results = await asyncio.gather(
        _search_official(query, limit),
        _search_npm(query, limit),
        _search_github(query, limit),
        return_exceptions=True,
    )
    seen: dict[str, MCPCandidate] = {}
    for batch in results:
        if isinstance(batch, Exception):
            continue
        for cand in batch:
            existing = seen.get(cand.id)
            if existing is None or cand.score > existing.score:
                seen[cand.id] = cand
    out = sorted(seen.values(), key=lambda c: -c.score)
    return out[:limit]
