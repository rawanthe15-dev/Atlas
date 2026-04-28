import pytest
from plugins.base import AtlasPlugin


def test_plugin_subclass_sets_name():
    class MyPlugin(AtlasPlugin):
        name = "my_plugin"
        async def load(self, kernel): pass
        async def unload(self): pass
    p = MyPlugin()
    assert p.name == "my_plugin"


def test_plugin_has_default_version():
    class MyPlugin(AtlasPlugin):
        name = "test"
        async def load(self, kernel): pass
        async def unload(self): pass
    assert MyPlugin().version == "0.1.0"


def test_plugin_can_override_version():
    class MyPlugin(AtlasPlugin):
        name = "test"
        version = "1.2.3"
        async def load(self, kernel): pass
        async def unload(self): pass
    assert MyPlugin().version == "1.2.3"


# --- Kernel tests ---
import asyncio
import pytest
from kernel import Kernel


@pytest.mark.asyncio
async def test_kernel_loads_plugin():
    from plugins.base import AtlasPlugin
    class FakePlugin(AtlasPlugin):
        name = "fake"
        loaded = False
        async def load(self, kernel): self.loaded = True
        async def unload(self): pass

    k = Kernel()
    await k.load_plugin(FakePlugin)
    plugin = k.get_plugin("fake")
    assert plugin.loaded is True


@pytest.mark.asyncio
async def test_kernel_get_unknown_plugin_raises():
    k = Kernel()
    with pytest.raises(KeyError):
        k.get_plugin("nonexistent")


@pytest.mark.asyncio
async def test_kernel_unload_all():
    from plugins.base import AtlasPlugin
    unloaded = []
    class FakePlugin(AtlasPlugin):
        name = "fake"
        async def load(self, kernel): pass
        async def unload(self): unloaded.append(self.name)

    k = Kernel()
    await k.load_plugin(FakePlugin)
    await k.unload_all()
    assert "fake" in unloaded
    assert k._plugins == {}


# --- Plugin integration tests ---
from plugins.config_plugin import ConfigPlugin
from plugins.memory_plugin import MemoryPlugin


@pytest.mark.asyncio
async def test_config_plugin_sets_defaults(tmp_path, monkeypatch):
    # ConfigPlugin now uses absolute paths anchored to ATLAS_ROOT — point them
    # at this test's tmp_path so we don't pick up the developer's real config.
    monkeypatch.setattr("plugins.config_plugin.CONFIG_PATH", tmp_path / "config.toml")
    monkeypatch.setattr("plugins.config_plugin.ENV_PATH", tmp_path / ".env")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-123")
    k = Kernel()
    await k.load_plugin(ConfigPlugin)
    assert k.config["openrouter"]["api_key"] == "test-key-123"
    assert k.config["openrouter"]["default_model"] == "deepseek/deepseek-chat"


@pytest.mark.asyncio
async def test_memory_plugin_wires_backend(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {"memory": {"backend": "file", "path": str(tmp_path / "memory")}}
    await k.load_plugin(MemoryPlugin)
    assert k.memory is not None
    await k.memory.write("test fact", tags=["test"])
    results = await k.memory.search("test fact")
    assert len(results) >= 1


# --- Tools plugin integration test ---
from plugins.tools_plugin import ToolsPlugin


@pytest.mark.asyncio
async def test_tools_plugin_loads_all_tools(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    k = Kernel()
    k.config = {
        "memory": {"backend": "file", "path": str(tmp_path / "memory")},
        "tools": {"brave_api_key": "", "shell_confirm": False},
        "openrouter": {"api_key": "", "default_model": "deepseek/deepseek-chat"},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    tools_plugin = k.get_plugin("tools")
    names = [t.name for t in tools_plugin.all()]
    assert "shell" in names
    assert "read_file" in names
    assert "write_file" in names
    assert "remember" in names
    assert "recall" in names
    assert "get_user_profile" in names
    assert "update_user_profile" in names
    assert "introspect_url" in names
    # Verify schemas are exposed
    schemas = tools_plugin.schemas()
    assert len(schemas) == 9
    assert all("function" in s for s in schemas)
