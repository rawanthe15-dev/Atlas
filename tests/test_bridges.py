"""Tests for the device-connectivity layer.

Covers spec round-trip, dynamic tool naming, OpenAPI schema squashing,
shell-bridge templating, MCP installer planning, and the DevicesPlugin
mount/unmount lifecycle (with a fake bridge so no network/process is hit).
"""
from __future__ import annotations

import pytest

from bridges.spec import BridgeSpec, ToolSpec, Capability
from bridges.dynamic_tool import namespaced_tool_name, BridgeTool
from bridges.base import Bridge
from bridges.shell_bridge import ShellBridge
from bridges.openapi_bridge import _params_to_schema, _safe_op_name
from bridges.installer import plan_install, MCPInstaller
from bridges.policy import InstallPolicy, PolicyDenied
from bridges.registry import MCPCandidate, make_bridge, supported_kinds
from bridges.state import DeviceStore


# ─── spec / state ────────────────────────────────────────────────────────

def test_bridgespec_round_trip():
    s = BridgeSpec(name="x", kind="http", config={"base_url": "http://h"},
                   capabilities=["control"], description="d")
    rev = BridgeSpec.from_dict(s.to_dict())
    assert rev.name == s.name and rev.kind == s.kind
    assert rev.config == s.config and rev.capabilities == s.capabilities


def test_device_store_save_load_delete(tmp_path):
    store = DeviceStore(tmp_path)
    spec = BridgeSpec(name="hub", kind="http", config={"base_url": "http://x"})
    store.save(spec)
    loaded = store.load_all()
    assert len(loaded) == 1 and loaded[0].name == "hub"
    store.delete("hub")
    assert store.load_all() == []


# ─── tool naming ─────────────────────────────────────────────────────────

def test_namespaced_tool_name_strips_unsafe_chars():
    assert namespaced_tool_name("home/asst", "list states") == "home_asst__list_states"


def test_namespaced_tool_name_truncates_to_64():
    long = "a" * 80
    name = namespaced_tool_name("dev", long)
    assert len(name) <= 64


# ─── OpenAPI helpers ─────────────────────────────────────────────────────

def test_safe_op_name_uses_operation_id():
    assert _safe_op_name("createPet", "post", "/pet") == "createPet"


def test_safe_op_name_falls_back_to_path():
    assert _safe_op_name(None, "GET", "/pets/{id}/owner") == "get_pets_owner"


def test_params_to_schema_carries_required_and_body():
    params = [
        {"name": "id", "schema": {"type": "string"}, "required": True},
        {"name": "verbose", "schema": {"type": "boolean"}},
    ]
    body = {"required": True, "content": {"application/json": {"schema": {"type": "object"}}}}
    schema = _params_to_schema(params, body)
    assert "id" in schema["properties"] and "verbose" in schema["properties"]
    assert "body" in schema["properties"]
    assert "id" in schema["required"] and "body" in schema["required"]
    assert "verbose" not in schema["required"]


# ─── shell bridge ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_shell_bridge_discover_extracts_placeholders():
    spec = BridgeSpec(name="tv", kind="shell", config={
        "commands": [
            {"name": "vol", "description": "set volume", "template": "echo vol={level}"},
        ],
    })
    bridge = ShellBridge(spec)
    tools = await bridge.discover()
    assert len(tools) == 1
    t = tools[0]
    assert t.name == "vol"
    assert "level" in t.parameters["properties"]
    assert "level" in t.parameters["required"]


@pytest.mark.asyncio
async def test_shell_bridge_invokes_template(monkeypatch):
    spec = BridgeSpec(name="tv", kind="shell", config={
        "commands": [
            {"name": "echo_it", "description": "x", "template": "echo hello-{who}"},
        ],
    })
    bridge = ShellBridge(spec)
    tools = await bridge.discover()
    out = await bridge.invoke(tools[0], {"who": "world"})
    assert "hello-world" in out
    assert "exit 0" in out


# ─── MCP install planning ───────────────────────────────────────────────

def test_plan_install_npx_no_pre_install():
    cand = MCPCandidate(id="@x/y", source="npm", name="y",
                        description="", install_command="npx -y @x/y")
    plan = plan_install(cand)
    assert plan.pre_install_cmd is None
    assert plan.runtime_command == "npx -y @x/y"


def test_plan_install_uvx_no_pre_install():
    cand = MCPCandidate(id="mcp-server-fetch", source="official", name="fetch",
                        description="", install_command="uvx mcp-server-fetch")
    plan = plan_install(cand)
    assert plan.pre_install_cmd is None
    assert plan.runtime_command == "uvx mcp-server-fetch"


def test_plan_install_pip_split():
    cand = MCPCandidate(id="some-pkg", source="custom", name="pkg",
                        description="", install_command="pip install some-pkg && some-pkg --serve")
    plan = plan_install(cand)
    assert plan.pre_install_cmd == "pip install some-pkg"
    assert plan.runtime_command == "some-pkg --serve"


# ─── registry dispatch ──────────────────────────────────────────────────

def test_supported_kinds_complete():
    kinds = supported_kinds()
    for required in ("http", "openapi", "mcp", "process", "shell",
                     "homeassistant", "adb", "ble", "serial"):
        assert required in kinds


def test_make_bridge_unknown_kind():
    with pytest.raises(ValueError):
        make_bridge(BridgeSpec(name="x", kind="quantum-flux", config={}))


def test_make_bridge_dispatches():
    spec = BridgeSpec(name="x", kind="shell", config={"commands": []})
    bridge = make_bridge(spec)
    assert bridge.kind == "shell"


# ─── DevicesPlugin lifecycle (with a fake bridge) ───────────────────────

class _FakeBridge(Bridge):
    """Stand-in for a real bridge — no network or processes."""
    kind = "fake"

    def __init__(self, spec):
        super().__init__(spec)
        self.connected = False
        self.closed = False

    async def connect(self) -> None:
        self.connected = True

    async def discover(self):
        return [
            ToolSpec(name="ping", description="ping", parameters={
                "type": "object", "properties": {}, "required": [],
            }, handler={"op": "ping"}),
            ToolSpec(name="echo", description="echo", parameters={
                "type": "object",
                "properties": {"msg": {"type": "string"}},
                "required": ["msg"],
            }, handler={"op": "echo"}),
        ]

    async def invoke(self, tool, arguments):
        if tool.handler["op"] == "ping":
            return "pong"
        if tool.handler["op"] == "echo":
            return f"echo: {arguments.get('msg','')}"
        return "?"

    async def aclose(self):
        self.closed = True

    @staticmethod
    def default_capabilities():
        return [Capability.CONTROL.value]


@pytest.mark.asyncio
async def test_devices_plugin_mount_unmount(tmp_path, monkeypatch):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    # Patch make_bridge so DevicesPlugin builds our fake instead of dispatching
    # by kind. This keeps the test hermetic (no network, no subprocess).
    monkeypatch.setattr("plugins.devices_plugin.make_bridge", lambda spec: _FakeBridge(spec))

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {
        "memory": {"backend": "file", "path": str(tmp_path / "memory")},
        "tools":  {"brave_api_key": "", "shell_confirm": False},
        "devices": {},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    devices = k.get_plugin("devices")
    tools = k.get_plugin("tools")

    spec = BridgeSpec(name="drone", kind="fake", config={})
    record = await devices.mount(spec)

    # Tools were registered with the namespaced names.
    assert "drone__ping" in [t.name for t in tools.all()]
    assert "drone__echo" in [t.name for t in tools.all()]
    # Tool can actually be invoked through the registry surface.
    ping = tools.get("drone__ping")
    assert (await ping.run()) == "pong"
    echo = tools.get("drone__echo")
    assert (await echo.run(msg="hi")) == "echo: hi"
    # Capabilities were filled from the bridge default.
    assert "control" in record.spec.capabilities
    # Persisted to disk.
    persisted = (tmp_path / "memory" / "devices" / "drone.json")
    assert persisted.exists()

    # Unmount removes tools and the persisted record.
    await devices.unmount("drone")
    assert tools.get("drone__ping") is None
    assert not persisted.exists()


@pytest.mark.asyncio
async def test_devices_plugin_restores_from_disk(tmp_path, monkeypatch):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    monkeypatch.setattr("plugins.devices_plugin.make_bridge", lambda spec: _FakeBridge(spec))

    monkeypatch.chdir(tmp_path)
    # Pre-seed a saved spec on disk.
    devices_dir = tmp_path / "memory" / "devices"
    devices_dir.mkdir(parents=True)
    DeviceStore(devices_dir).save(BridgeSpec(name="prev", kind="fake", config={}))

    k = Kernel()
    k.config = {
        "memory": {"backend": "file", "path": str(tmp_path / "memory")},
        "tools":  {"brave_api_key": "", "shell_confirm": False},
        "devices": {},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    tools = k.get_plugin("tools")
    assert "prev__ping" in [t.name for t in tools.all()]


# ─── policy ──────────────────────────────────────────────────────────────

def test_policy_auto_trusts_official():
    pol = InstallPolicy(mode="auto")
    d = pol.decide_install("official", "anything")
    assert d.allow and not d.prompt


def test_policy_auto_trusts_modelcontextprotocol_npm():
    pol = InstallPolicy(mode="auto")
    d = pol.decide_install("npm", "@modelcontextprotocol/server-fetch")
    assert d.allow and not d.prompt


def test_policy_auto_prompts_unknown_npm():
    pol = InstallPolicy(mode="auto")
    d = pol.decide_install("npm", "@randomuser/something")
    assert d.allow and d.prompt


def test_policy_auto_prompts_arbitrary_github():
    pol = InstallPolicy(mode="auto")
    d = pol.decide_install("github", "weirdperson/random-mcp")
    assert d.allow and d.prompt


def test_policy_off_blocks_everything():
    pol = InstallPolicy(mode="off")
    assert not pol.decide_install("official", "x").allow
    assert not pol.decide_mount("mcp").allow


def test_policy_prompt_always_prompts():
    pol = InstallPolicy(mode="prompt")
    assert pol.decide_install("official", "x").prompt is True


def test_policy_mount_skips_safe_kinds():
    pol = InstallPolicy(mode="auto")
    assert pol.decide_mount("http").prompt is False
    assert pol.decide_mount("homeassistant").prompt is False
    assert pol.decide_mount("ble").prompt is False
    assert pol.decide_mount("serial").prompt is False


def test_policy_mount_prompts_risky_kinds_unknown_source():
    pol = InstallPolicy(mode="auto")
    assert pol.decide_mount("mcp").prompt is True
    assert pol.decide_mount("shell").prompt is True
    assert pol.decide_mount("process").prompt is True


def test_policy_custom_trusted_glob():
    pol = InstallPolicy(mode="auto", trusted_sources=["github:myorg/*"])
    assert pol.decide_install("github", "myorg/cool").prompt is False
    assert pol.decide_install("github", "other/cool").prompt is True


# ─── installer with policy ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_installer_skips_prompt_for_trusted(monkeypatch):
    pol = InstallPolicy(mode="auto")
    inst = MCPInstaller(policy=pol)
    asked = []
    inst.set_confirm(lambda a, d: asked.append((a, d)) or True)

    cand = MCPCandidate(id="@modelcontextprotocol/server-fetch", source="npm",
                        name="fetch", description="d",
                        install_command="npx -y @modelcontextprotocol/server-fetch")
    spec, _ = await inst.install_and_build_spec(cand, device_name="fetch")
    assert spec.kind == "mcp" and spec.config["command"].startswith("npx -y")
    assert asked == []  # trusted → no prompt


@pytest.mark.asyncio
async def test_installer_prompts_for_unknown(monkeypatch):
    pol = InstallPolicy(mode="auto")
    inst = MCPInstaller(policy=pol)
    asked = []
    inst.set_confirm(lambda a, d: asked.append(a) or True)

    cand = MCPCandidate(id="weirdperson/random", source="github", name="x",
                        description="", install_command="npx -y github:weirdperson/random")
    await inst.install_and_build_spec(cand, device_name="x")
    assert asked == ["mount mcp server"]


@pytest.mark.asyncio
async def test_installer_off_mode_denies():
    pol = InstallPolicy(mode="off")
    inst = MCPInstaller(policy=pol)
    cand = MCPCandidate(id="anything", source="official", name="x",
                        description="", install_command="uvx anything")
    with pytest.raises(PolicyDenied):
        await inst.install_and_build_spec(cand, device_name="x")


# ─── device-management tools registered with ToolsPlugin ─────────────────

@pytest.mark.asyncio
async def test_devices_plugin_registers_management_tools(tmp_path, monkeypatch):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {
        "memory": {"backend": "file", "path": str(tmp_path / "memory")},
        "tools":  {"brave_api_key": "", "shell_confirm": False},
        "devices": {"install_policy": "auto"},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    names = {t.name for t in k.get_plugin("tools").all()}
    for required in (
        "list_devices", "mount_device", "unmount_device", "inspect_device",
        "search_mcp", "install_mcp", "auto_connect",
    ):
        assert required in names, f"missing {required}"


# ─── auto_connect outcomes ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_auto_connect_no_match(tmp_path, monkeypatch):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    async def fake_search(query, limit=10):
        return []
    monkeypatch.setattr("plugins.devices_plugin.search_mcp_registry", fake_search)

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {"memory": {"backend": "file", "path": str(tmp_path / "memory")},
                "tools": {"brave_api_key": ""}, "devices": {}}
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    result = await k.get_plugin("devices").auto_connect("x", "nothing-here")
    assert result["status"] == "no_match"


@pytest.mark.asyncio
async def test_auto_connect_returns_candidates_when_untrusted(tmp_path, monkeypatch):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin
    from plugins.devices_plugin import DevicesPlugin

    async def fake_search(query, limit=10):
        return [MCPCandidate(id="weird/x", source="github", name="x",
                             description="d", install_command="npx -y github:weird/x")]
    monkeypatch.setattr("plugins.devices_plugin.search_mcp_registry", fake_search)

    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {"memory": {"backend": "file", "path": str(tmp_path / "memory")},
                "tools": {"brave_api_key": ""}, "devices": {}}
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    await k.load_plugin(DevicesPlugin)

    result = await k.get_plugin("devices").auto_connect("x", "weird")
    assert result["status"] == "needs_confirmation"
    assert len(result["candidates"]) == 1


@pytest.mark.asyncio
async def test_bridge_tool_round_trip():
    spec = BridgeSpec(name="dev", kind="fake", config={})
    bridge = _FakeBridge(spec)
    await bridge.connect()
    [_, echo_spec] = await bridge.discover()
    tool = BridgeTool(bridge, echo_spec)
    assert tool.name == "dev__echo"
    assert "msg" in tool.parameters["properties"]
    assert (await tool.run(msg="yo")) == "echo: yo"
