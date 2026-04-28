"""Bridge to any MCP (Model Context Protocol) server.

Supports two transports:
  - stdio: launch a local command and speak JSON-RPC over its stdin/stdout
  - http:  POST JSON-RPC to a URL

We implement just enough of MCP to call `initialize`, `tools/list`, and
`tools/call`. No external `mcp` SDK dependency — keeps Atlas slim.
"""
from __future__ import annotations

import asyncio
import json
import shlex
from typing import List

import httpx

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


PROTOCOL_VERSION = "2024-11-05"


class _StdioMCP:
    """JSON-RPC over a child process's stdio. One outstanding request map."""

    def __init__(self, command: str, env: dict | None = None, cwd: str | None = None):
        self._command = command
        self._env = env
        self._cwd = cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if self._proc is not None:
            return
        argv = shlex.split(self._command)
        self._proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env,
            cwd=self._cwd,
        )
        self._reader_task = asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode().strip())
                except Exception:
                    continue
                if "id" in msg and msg["id"] in self._pending:
                    fut = self._pending.pop(msg["id"])
                    if not fut.done():
                        fut.set_result(msg)
        except asyncio.CancelledError:
            pass

    async def call(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        if self._proc is None or self._proc.stdin is None:
            raise BridgeError("mcp stdio: process not started")
        async with self._lock:
            req_id = self._next_id
            self._next_id += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode())
        await self._proc.stdin.drain()
        try:
            msg = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise BridgeError(f"mcp call '{method}' timed out after {timeout}s")
        if "error" in msg:
            err = msg["error"]
            raise BridgeError(f"mcp error {err.get('code')}: {err.get('message')}")
        return msg.get("result", {})

    async def notify(self, method: str, params: dict | None = None) -> None:
        if self._proc is None or self._proc.stdin is None:
            return
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode())
        await self._proc.stdin.drain()

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._proc:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass


class _HTTPMCP:
    def __init__(self, url: str, headers: dict | None = None):
        self._url = url
        self._headers = headers or {}
        self._client: httpx.AsyncClient | None = None
        self._next_id = 1

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(headers=self._headers, timeout=60)

    async def call(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        if self._client is None:
            await self.start()
        assert self._client is not None
        req_id = self._next_id
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        resp = await self._client.post(self._url, json=payload, timeout=timeout)
        resp.raise_for_status()
        msg = resp.json()
        if "error" in msg:
            err = msg["error"]
            raise BridgeError(f"mcp error {err.get('code')}: {err.get('message')}")
        return msg.get("result", {})

    async def notify(self, method: str, params: dict | None = None) -> None:
        if self._client is None:
            return
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        await self._client.post(self._url, json=payload)

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()


class MCPBridge(Bridge):
    """`config`:
        transport: "stdio" | "http"        (required)
        # stdio
        command:   str                     — full command line (e.g. "uvx mcp-server-fetch")
        env:       dict[str,str]
        cwd:       str
        # http
        url:       str
        headers:   dict[str,str]
    """

    kind = "mcp"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._client: _StdioMCP | _HTTPMCP | None = None
        self._tools_cache: list[ToolSpec] = []

    async def connect(self) -> None:
        if self._client is not None:
            return
        cfg = self.spec.config
        transport = cfg.get("transport", "stdio")
        if transport == "stdio":
            cmd = cfg.get("command")
            if not cmd:
                raise BridgeError("mcp stdio: 'command' is required")
            self._client = _StdioMCP(cmd, env=cfg.get("env"), cwd=cfg.get("cwd"))
        elif transport == "http":
            url = cfg.get("url")
            if not url:
                raise BridgeError("mcp http: 'url' is required")
            self._client = _HTTPMCP(url, headers=cfg.get("headers", {}))
        else:
            raise BridgeError(f"mcp: unsupported transport '{transport}'")
        await self._client.start()

        # Initialize handshake
        try:
            await self._client.call("initialize", {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Atlas", "version": "0.1"},
            }, timeout=15)
            await self._client.notify("notifications/initialized")
        except Exception as e:
            raise BridgeError(f"mcp initialize failed: {e}") from e

    async def discover(self) -> List[ToolSpec]:
        await self.connect()
        assert self._client is not None
        try:
            result = await self._client.call("tools/list")
        except Exception as e:
            raise BridgeError(f"mcp tools/list failed: {e}") from e
        tools_raw = result.get("tools", [])
        out: list[ToolSpec] = []
        for t in tools_raw:
            name = t.get("name")
            if not name:
                continue
            out.append(ToolSpec(
                name=name,
                description=(t.get("description") or "")[:300],
                parameters=t.get("inputSchema") or {"type": "object", "properties": {}, "required": []},
                handler={"op": "call_tool", "tool_name": name},
            ))
        self._tools_cache = out
        return out

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        if self._client is None:
            await self.connect()
        assert self._client is not None
        if tool.handler.get("op") != "call_tool":
            raise BridgeError(f"mcp: unknown op {tool.handler!r}")
        upstream_name = tool.handler["tool_name"]
        try:
            result = await self._client.call("tools/call", {
                "name": upstream_name,
                "arguments": arguments,
            })
        except Exception as e:
            raise BridgeError(f"mcp call '{upstream_name}' failed: {e}") from e
        # MCP tool results are a list of content parts.
        parts = result.get("content") or []
        chunks: list[str] = []
        for p in parts:
            if p.get("type") == "text" and isinstance(p.get("text"), str):
                chunks.append(p["text"])
            else:
                chunks.append(json.dumps(p))
        if result.get("isError"):
            return "[mcp tool returned error]\n" + "\n".join(chunks)
        return "\n".join(chunks) if chunks else "(empty)"

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
