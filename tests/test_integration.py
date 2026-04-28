"""End-to-end integration tests for the device-connectivity layer.

No mocks. Real ports, real subprocesses. We spin up:

  - A fake IP camera (stdlib `http.server` on 127.0.0.1:0) that exposes
    `/api/info`, `/api/snapshot`, and `/openapi.json`. Atlas mounts it
    through the real OpenAPIBridge (and HTTPBridge fallback) and calls
    the discovered tools.

  - A real MCP server subprocess (tests/_fixtures/fake_mcp_server.py)
    speaking the actual MCP stdio JSON-RPC protocol. Atlas mounts it
    through the real MCPBridge and exercises tools/list + tools/call,
    including error paths.

  - The InstallPolicy gate — verified against a trusted source (silent
    install via the subprocess) AND an untrusted source (must prompt or
    return needs_confirmation).
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from bridges.spec import BridgeSpec
from bridges.registry import make_bridge, MCPCandidate
from bridges.installer import MCPInstaller
from bridges.policy import InstallPolicy, PolicyDenied


FIXTURES = Path(__file__).parent / "_fixtures"
FAKE_MCP = FIXTURES / "fake_mcp_server.py"


# ─── Fake IP camera ──────────────────────────────────────────────────────

def _make_camera_handler(port_holder: dict, *, broken_spec: bool = False):
    """Closure factory so the OpenAPI spec can include the actual port
    once the server has bound. `broken_spec=True` returns a half-broken
    spec that omits `/api/snapshot`, so we can verify the http fallback
    (`request`) still lets the agent reach the missing endpoint."""

    class CamHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/info":
                body = json.dumps({
                    "model": "AtlasTestCam",
                    "resolution": "1280x720",
                    "firmware": "1.0.3",
                }).encode()
                self._send(200, "application/json", body)
            elif self.path == "/api/snapshot":
                # Real-ish JPEG SOI marker so anyone parsing it sees bytes.
                body = b"\xff\xd8\xff\xe0\x00\x10JFIFatlas-test-snapshot"
                self._send(200, "image/jpeg", body)
            elif self.path == "/openapi.json":
                paths = {
                    "/api/info": {
                        "get": {
                            "operationId": "getInfo",
                            "summary": "Camera info",
                        },
                    },
                }
                if not broken_spec:
                    paths["/api/snapshot"] = {
                        "get": {
                            "operationId": "snapshot",
                            "summary": "Capture a frame",
                        },
                    }
                spec = {
                    "openapi": "3.0.0",
                    "info": {"title": "AtlasTestCam", "version": "1.0"},
                    "servers": [{"url": f"http://127.0.0.1:{port_holder['port']}"}],
                    "paths": paths,
                }
                self._send(200, "application/json", json.dumps(spec).encode())
            else:
                self._send(404, "text/plain", b"not found")

        def _send(self, status: int, ctype: str, body: bytes):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args, **kwargs):  # silence stderr noise
            return

    return CamHandler


@pytest.fixture
def fake_camera():
    port_holder: dict = {"port": 0}
    handler = _make_camera_handler(port_holder)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port_holder["port"] = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield port_holder["port"]
    server.shutdown()
    server.server_close()


@pytest.fixture
def fake_camera_broken_spec():
    port_holder: dict = {"port": 0}
    handler = _make_camera_handler(port_holder, broken_spec=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port_holder["port"] = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield port_holder["port"]
    server.shutdown()
    server.server_close()


# ─── OpenAPI bridge end-to-end against the fake camera ───────────────────

@pytest.mark.asyncio
async def test_openapi_bridge_mounts_real_camera_and_calls_endpoints(fake_camera):
    spec = BridgeSpec(
        name="cam",
        kind="openapi",
        config={"spec_url": f"http://127.0.0.1:{fake_camera}/openapi.json"},
    )
    bridge = make_bridge(spec)
    try:
        await bridge.connect()
        tools = await bridge.discover()

        names = {t.name for t in tools}
        # Both operations and the request escape-hatch should be present.
        assert "getInfo" in names
        assert "snapshot" in names
        assert "request" in names

        info_tool = next(t for t in tools if t.name == "getInfo")
        info_out = await bridge.invoke(info_tool, {})
        assert "AtlasTestCam" in info_out
        assert "1280x720" in info_out

        snap_tool = next(t for t in tools if t.name == "snapshot")
        snap_out = await bridge.invoke(snap_tool, {})
        # The bytes survive httpx's text decoding well enough to find the marker.
        assert "atlas-test-snapshot" in snap_out
    finally:
        await bridge.aclose()


@pytest.mark.asyncio
async def test_openapi_bridge_falls_back_to_request_when_spec_misses_endpoint(
    fake_camera_broken_spec,
):
    """Half-broken spec: only /api/info documented. Atlas should still
    reach /api/snapshot via the generic `request` tool."""
    port = fake_camera_broken_spec
    spec = BridgeSpec(
        name="cam",
        kind="openapi",
        config={"spec_url": f"http://127.0.0.1:{port}/openapi.json"},
    )
    bridge = make_bridge(spec)
    try:
        await bridge.connect()
        tools = await bridge.discover()
        names = {t.name for t in tools}
        assert "snapshot" not in names  # spec genuinely missing it
        assert "getInfo" in names
        assert "request" in names

        req_tool = next(t for t in tools if t.name == "request")
        out = await bridge.invoke(req_tool, {"method": "GET", "path": "/api/snapshot"})
        assert "200" in out
        assert "atlas-test-snapshot" in out
    finally:
        await bridge.aclose()


@pytest.mark.asyncio
async def test_http_bridge_mounts_minimally_and_probes_camera(fake_camera):
    """No spec at all — purely the http kind. Verifies Atlas can talk to
    a device given only its base URL, which is the worst-case discovery."""
    spec = BridgeSpec(
        name="cam-raw",
        kind="http",
        config={"base_url": f"http://127.0.0.1:{fake_camera}"},
    )
    bridge = make_bridge(spec)
    try:
        await bridge.connect()
        tools = await bridge.discover()
        assert [t.name for t in tools] == ["request"]

        out = await bridge.invoke(tools[0], {"method": "GET", "path": "/api/info"})
        assert "AtlasTestCam" in out and "200" in out
    finally:
        await bridge.aclose()


# ─── MCP bridge end-to-end against a real subprocess ────────────────────

@pytest.mark.asyncio
async def test_mcp_bridge_real_subprocess_lists_and_calls_tools():
    spec = BridgeSpec(
        name="fake",
        kind="mcp",
        config={"transport": "stdio", "command": f"{sys.executable} {FAKE_MCP}"},
    )
    bridge = make_bridge(spec)
    try:
        await bridge.connect()
        tools = await bridge.discover()
        names = {t.name for t in tools}
        assert names == {"echo", "add", "boom"}

        echo = next(t for t in tools if t.name == "echo")
        out = await bridge.invoke(echo, {"text": "hello atlas"})
        assert out == "hello atlas"

        add = next(t for t in tools if t.name == "add")
        out = await bridge.invoke(add, {"a": 7, "b": 5})
        assert out.strip() == "12"
    finally:
        await bridge.aclose()


@pytest.mark.asyncio
async def test_mcp_bridge_surfaces_tool_errors():
    spec = BridgeSpec(
        name="fake",
        kind="mcp",
        config={"transport": "stdio", "command": f"{sys.executable} {FAKE_MCP}"},
    )
    bridge = make_bridge(spec)
    try:
        await bridge.connect()
        tools = await bridge.discover()
        boom = next(t for t in tools if t.name == "boom")
        out = await bridge.invoke(boom, {})
        # MCPBridge prefixes tool-side errors so the agent can recognise them.
        assert "[mcp tool returned error]" in out
    finally:
        await bridge.aclose()


# ─── DevicesPlugin: full mount/call/unmount through a real MCP server ───

@pytest.mark.asyncio
async def test_devices_plugin_mounts_real_mcp_through_namespaced_tool(
    tmp_path, monkeypatch,
):
    """Whole stack: ToolsPlugin + DevicesPlugin + real MCPBridge to a
    real subprocess. Exercises the same code path the agent hits."""
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {
        "memory":  {"backend": "file", "path": str(tmp_path / "memory")},
        "tools":   {"brave_api_key": "", "shell_confirm": False},
        "devices": {"install_policy": "auto"},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    devices = k.get_plugin("devices")
    tools = k.get_plugin("tools")

    spec = BridgeSpec(
        name="testmcp",
        kind="mcp",
        config={"transport": "stdio", "command": f"{sys.executable} {FAKE_MCP}"},
    )
    # Risky kind on auto policy → would normally prompt, but we pass
    # no confirm callback so it auto-allows for non-interactive contexts
    # (this is what tests / Telegram / cron see).
    record = await devices.mount(spec, source="test")
    try:
        assert "testmcp__echo" in [t.name for t in tools.all()]
        assert "testmcp__add" in [t.name for t in tools.all()]

        echo_tool = tools.get("testmcp__echo")
        result = await echo_tool.run(text="end-to-end")
        assert result == "end-to-end"

        add_tool = tools.get("testmcp__add")
        result = await add_tool.run(a=2, b=40)
        assert result.strip() == "42"
    finally:
        await devices.unmount("testmcp")

    # After unmount, namespaced tools are gone.
    assert tools.get("testmcp__echo") is None


# ─── Policy: real install path with subprocess ──────────────────────────

@pytest.mark.asyncio
async def test_installer_trusted_source_silently_builds_spec(tmp_path):
    """`auto` policy + trusted source → spec built without invoking the
    confirm callback, even though one is wired."""
    pol = InstallPolicy(mode="auto", trusted_sources=["test:fake-*"])
    inst = MCPInstaller(policy=pol)

    asked = []
    inst.set_confirm(lambda action, detail: asked.append(action) or False)

    cand = MCPCandidate(
        id="fake-mcp",
        source="test",
        name="fake-mcp",
        description="trusted test fixture",
        install_command=f"{sys.executable} {FAKE_MCP}",
    )
    spec, _log = await inst.install_and_build_spec(cand, device_name="t1")
    assert spec.kind == "mcp"
    assert spec.config["transport"] == "stdio"
    assert sys.executable in spec.config["command"]
    assert asked == []  # critical: trusted should not prompt


@pytest.mark.asyncio
async def test_installer_untrusted_source_calls_confirm():
    """Same source NOT in trust list → confirm callback IS called."""
    pol = InstallPolicy(mode="auto", trusted_sources=[])  # nothing trusted
    inst = MCPInstaller(policy=pol)

    asked = []
    inst.set_confirm(lambda action, detail: asked.append(action) or True)

    cand = MCPCandidate(
        id="random/repo",
        source="github",
        name="random",
        description="untrusted",
        install_command=f"{sys.executable} {FAKE_MCP}",
    )
    await inst.install_and_build_spec(cand, device_name="t2")
    assert asked and "mount mcp server" in asked[0]


@pytest.mark.asyncio
async def test_installer_off_mode_blocks_even_real_subprocess():
    pol = InstallPolicy(mode="off")
    inst = MCPInstaller(policy=pol)
    cand = MCPCandidate(
        id="anything",
        source="official",
        name="x",
        description="",
        install_command=f"{sys.executable} {FAKE_MCP}",
    )
    with pytest.raises(PolicyDenied):
        await inst.install_and_build_spec(cand, device_name="x")


@pytest.mark.asyncio
async def test_full_pipeline_install_then_mount_then_call(tmp_path, monkeypatch):
    """The full hard test: trust the fake-mcp source, run the installer
    (which constructs a BridgeSpec), feed it to DevicesPlugin.mount, and
    verify the MCP tools really work via the namespaced surface."""
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {
        "memory":  {"backend": "file", "path": str(tmp_path / "memory")},
        "tools":   {"brave_api_key": ""},
        "devices": {
            "install_policy": "auto",
            "trusted_sources": ["test:fake-*"],
        },
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    devices = k.get_plugin("devices")
    tools = k.get_plugin("tools")

    cand = MCPCandidate(
        id="fake-mcp",
        source="test",
        name="fake-mcp",
        description="real subprocess MCP",
        install_command=f"{sys.executable} {FAKE_MCP}",
    )
    record = await devices.install_and_mount_mcp(cand, device_name="real")
    try:
        assert "real__echo" in record.tool_names
        echo = tools.get("real__echo")
        out = await echo.run(text="autonomous-pipeline")
        assert out == "autonomous-pipeline"
    finally:
        await devices.unmount("real")
