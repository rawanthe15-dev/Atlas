from .base import AtlasPlugin


class MemoryPlugin(AtlasPlugin):
    name = "memory"

    async def load(self, kernel) -> None:
        cfg = kernel.config.get("memory", {})
        backend_type = cfg.get("backend", "file")
        path = cfg.get("path", "./memory")

        if backend_type == "file":
            from memory_backends.file_backend import FileMemoryBackend
            backend = FileMemoryBackend(path)
        elif backend_type == "chroma":
            try:
                from memory_backends.chroma_backend import ChromaMemoryBackend
            except ImportError as e:
                raise RuntimeError(
                    "Chroma backend requested but chromadb is not installed.\n"
                    "Run: pip install chromadb"
                ) from e
            backend = ChromaMemoryBackend(path)
        else:
            raise ValueError(
                f"Unknown memory backend: '{backend_type}'. Supported: 'file', 'chroma'"
            )

        await backend.initialize()
        kernel.memory = backend

    async def unload(self) -> None:
        pass
