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
