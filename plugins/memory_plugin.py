from .base import AtlasPlugin
from memory_backends.file_backend import FileMemoryBackend


class MemoryPlugin(AtlasPlugin):
    name = "memory"

    async def load(self, kernel) -> None:
        cfg = kernel.config.get("memory", {})
        backend_type = cfg.get("backend", "file")
        path = cfg.get("path", "./memory")

        if backend_type == "file":
            backend = FileMemoryBackend(path)
        else:
            raise ValueError(f"Unknown memory backend: '{backend_type}'. Supported: 'file'")

        await backend.initialize()
        kernel.memory = backend

    async def unload(self) -> None:
        pass
