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
