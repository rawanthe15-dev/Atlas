from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from memory_backends.interface import MemoryInterface
    from plugins.base import AtlasPlugin


class Kernel:
    def __init__(self):
        self._plugins: dict[str, "AtlasPlugin"] = {}
        self.memory: "MemoryInterface | None" = None
        self.config: dict = {}

    async def load_plugin(self, plugin_class: type) -> None:
        plugin = plugin_class()
        await plugin.load(self)
        self._plugins[plugin.name] = plugin

    async def unload_all(self) -> None:
        for plugin in reversed(list(self._plugins.values())):
            await plugin.unload()
        self._plugins.clear()

    def get_plugin(self, name: str) -> "AtlasPlugin":
        if name not in self._plugins:
            raise KeyError(f"Plugin '{name}' not loaded. Loaded: {list(self._plugins)}")
        return self._plugins[name]
