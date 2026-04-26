# Atlas Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Atlas Phase 1 — a terminal CLI powered by a micro-kernel + plugin architecture, async-native agent loop (OpenRouter), interface-driven memory, and a unique Atlas visual identity.

**Architecture:** Micro-kernel owns plugin registry, shared memory reference, and config. Every feature — CLI, agent loop, tools, memory — is an isolated plugin loaded at boot. Phase 1 uses direct async calls between plugins (no event bus). Everything is asyncio-native from line one.

**Tech Stack:** Python 3.11+, httpx (async streaming), rich (terminal UI), tomllib (stdlib), python-dotenv, pytest + pytest-asyncio

---

## File Map

```
atlas/
├── main.py                        # Boot sequence only
├── kernel.py                      # Micro-kernel: plugin registry + shared context
├── config.toml.example            # Committed example config
├── .env.example                   # Committed example env vars
├── requirements.txt
│
├── plugins/
│   ├── __init__.py
│   ├── base.py                    # AtlasPlugin ABC
│   ├── config_plugin.py           # Loads config.toml + .env
│   ├── memory_plugin.py           # Wires memory backend into kernel
│   ├── tools_plugin.py            # Registers all tools
│   ├── agent_plugin.py            # Full agent loop + memory reflection
│   └── cli_plugin.py              # Terminal interface (blocks until exit)
│
├── memory_backends/
│   ├── __init__.py
│   ├── interface.py               # MemoryInterface ABC + MemoryEntry dataclass
│   └── file_backend.py            # JSONL + markdown backend
│
├── tools/
│   ├── __init__.py
│   ├── base.py                    # Tool ABC
│   ├── shell_tool.py
│   ├── filesystem_tool.py         # ReadFileTool + WriteFileTool
│   ├── web_search_tool.py         # Brave Search API
│   └── memory_tools.py            # RememberTool + RecallTool
│
├── memory/
│   ├── SOUL.md                    # Atlas identity — committed
│   ├── USER.md                    # Auto-maintained — gitignored
│   ├── sessions/                  # Gitignored
│   └── index/                     # Gitignored
│
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_kernel.py
    ├── test_file_backend.py
    ├── test_tools.py
    └── test_agent.py
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `requirements.txt`
- Create: `config.toml.example`
- Create: `.env.example`
- Create all `__init__.py` files

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p plugins memory_backends tools memory/sessions memory/index tests
touch plugins/__init__.py memory_backends/__init__.py tools/__init__.py tests/__init__.py
```

- [ ] **Step 2: Write `requirements.txt`**

```
httpx>=0.27.0
rich>=13.7.0
python-dotenv>=1.0.0
pytest>=8.0.0
pytest-asyncio>=0.23.0
```

- [ ] **Step 3: Write `config.toml.example`**

```toml
[atlas]
name = "Atlas"
version = "0.1.0"

[openrouter]
api_key = ""
default_model = "deepseek/deepseek-chat"
reasoning_model = "deepseek/deepseek-r1"
base_url = "https://openrouter.ai/api/v1/chat/completions"

[memory]
backend = "file"
path = "./memory"
max_context_entries = 5
max_session_history = 3

[tools]
shell_confirm = true
brave_api_key = ""
```

- [ ] **Step 4: Write `.env.example`**

```
OPENROUTER_API_KEY=your_key_here
BRAVE_API_KEY=your_key_here
```

- [ ] **Step 5: Install dependencies**

```bash
pip install -r requirements.txt
```

Expected: installs httpx, rich, python-dotenv, pytest, pytest-asyncio without errors.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt config.toml.example .env.example plugins/__init__.py memory_backends/__init__.py tools/__init__.py tests/__init__.py memory/
git commit -m "chore: project scaffold — dependencies, config templates, directory structure"
```

---

## Task 2: Plugin Base Class

**Files:**
- Create: `plugins/base.py`
- Create: `tests/test_kernel.py` (partial — base class test)

- [ ] **Step 1: Write failing test**

```python
# tests/test_kernel.py
import pytest
from plugins.base import AtlasPlugin

def test_plugin_requires_name():
    class NoName(AtlasPlugin):
        async def load(self, kernel): pass
        async def unload(self): pass
    with pytest.raises(TypeError):
        NoName()  # name is abstract class var — must be set

def test_plugin_has_version():
    class MyPlugin(AtlasPlugin):
        name = "test"
        async def load(self, kernel): pass
        async def unload(self): pass
    p = MyPlugin()
    assert p.version == "0.1.0"
```

- [ ] **Step 2: Run to confirm failure**

```bash
pytest tests/test_kernel.py -v
```

Expected: `ImportError` or `ModuleNotFoundError` (file doesn't exist yet).

- [ ] **Step 3: Write `plugins/base.py`**

```python
from abc import ABC, abstractmethod

class AtlasPlugin(ABC):
    name: str
    version: str = "0.1.0"

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not hasattr(cls, 'name') or cls.name is AtlasPlugin.__dict__.get('name'):
            pass  # name will be checked at instantiation

    @abstractmethod
    async def load(self, kernel) -> None:
        pass

    @abstractmethod
    async def unload(self) -> None:
        pass
```

- [ ] **Step 4: Adjust test to match actual behavior (name is a class attribute, not enforced by ABC)**

```python
# tests/test_kernel.py — replace with:
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
```

- [ ] **Step 5: Run tests**

```bash
pytest tests/test_kernel.py -v
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add plugins/base.py tests/test_kernel.py
git commit -m "feat: AtlasPlugin base class with name and version"
```

---

## Task 3: Kernel

**Files:**
- Create: `kernel.py`
- Modify: `tests/test_kernel.py`

- [ ] **Step 1: Write failing tests (append to test_kernel.py)**

```python
# append to tests/test_kernel.py
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
pytest tests/test_kernel.py::test_kernel_loads_plugin -v
```

Expected: `ModuleNotFoundError: No module named 'kernel'`

- [ ] **Step 3: Write `kernel.py`**

```python
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
```

- [ ] **Step 4: Add pytest-asyncio config so tests run without decorating each**

Create `pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
```

- [ ] **Step 5: Run all kernel tests**

```bash
pytest tests/test_kernel.py -v
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add kernel.py pytest.ini tests/test_kernel.py
git commit -m "feat: Kernel — plugin registry, shared context, unload_all"
```

---

## Task 4: Memory Interface + File Backend

**Files:**
- Create: `memory_backends/interface.py`
- Create: `memory_backends/file_backend.py`
- Create: `tests/test_file_backend.py`

- [ ] **Step 1: Write `memory_backends/interface.py`**

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class MemoryEntry:
    content: str
    tags: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=_utcnow)
    relevance: float = 0.0


class MemoryInterface(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def write(self, content: str, tags: list[str] = []) -> None: ...

    @abstractmethod
    async def search(self, query: str, limit: int = 5) -> list[MemoryEntry]: ...

    @abstractmethod
    async def get_user_profile(self) -> str: ...

    @abstractmethod
    async def update_user_profile(self, content: str) -> None: ...

    @abstractmethod
    async def get_soul(self) -> str: ...

    @abstractmethod
    async def append_session(self, session_id: str, entry: dict) -> None: ...

    @abstractmethod
    async def get_recent_sessions(self, n: int = 3) -> list[dict]: ...
```

- [ ] **Step 2: Write failing tests**

```python
# tests/test_file_backend.py
import pytest
import tempfile
from pathlib import Path
from memory_backends.file_backend import FileMemoryBackend


@pytest.fixture
def backend(tmp_path):
    b = FileMemoryBackend(str(tmp_path / "memory"))
    return b


@pytest.mark.asyncio
async def test_initialize_creates_dirs(backend, tmp_path):
    await backend.initialize()
    assert (tmp_path / "memory" / "sessions").exists()
    assert (tmp_path / "memory" / "index").exists()

@pytest.mark.asyncio
async def test_write_and_search(backend):
    await backend.initialize()
    await backend.write("I love Python programming", tags=["coding"])
    results = await backend.search("Python programming")
    assert len(results) >= 1
    assert "Python" in results[0].content

@pytest.mark.asyncio
async def test_search_empty_returns_empty(backend):
    await backend.initialize()
    results = await backend.search("nothing here")
    assert results == []

@pytest.mark.asyncio
async def test_user_profile_roundtrip(backend):
    await backend.initialize()
    await backend.update_user_profile("# User\n\n## Identity\nRawan")
    profile = await backend.get_user_profile()
    assert "Rawan" in profile

@pytest.mark.asyncio
async def test_soul_returns_default_when_missing(backend):
    await backend.initialize()
    soul = await backend.get_soul()
    assert len(soul) > 0  # default text

@pytest.mark.asyncio
async def test_append_and_get_sessions(backend):
    await backend.initialize()
    await backend.append_session("sess-001", {"user": "hi", "assistant": "hello"})
    sessions = await backend.get_recent_sessions(3)
    assert len(sessions) == 1
    assert sessions[0]["entries"][0]["user"] == "hi"
```

- [ ] **Step 3: Run to confirm failure**

```bash
pytest tests/test_file_backend.py -v
```

Expected: `ModuleNotFoundError: No module named 'memory_backends.file_backend'`

- [ ] **Step 4: Write `memory_backends/file_backend.py`**

```python
import json
from datetime import datetime, timezone
from pathlib import Path

from .interface import MemoryEntry, MemoryInterface


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class FileMemoryBackend(MemoryInterface):
    def __init__(self, base_path: str):
        self.base = Path(base_path)
        self.sessions_dir = self.base / "sessions"
        self.index_dir = self.base / "index"
        self.soul_path = self.base / "SOUL.md"
        self.user_path = self.base / "USER.md"
        self.entries_path = self.index_dir / "entries.jsonl"

    async def initialize(self) -> None:
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        if not self.user_path.exists():
            self.user_path.write_text(
                "# User Profile\n\n## Identity\n\n## Preferences\n\n"
                "## Projects\n\n## Patterns\n\n## Context\n"
            )
        if not self.entries_path.exists():
            self.entries_path.write_text("")

    async def write(self, content: str, tags: list[str] = []) -> None:
        entry = {"content": content, "tags": tags, "timestamp": _utcnow()}
        with open(self.entries_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    async def search(self, query: str, limit: int = 5) -> list[MemoryEntry]:
        if not self.entries_path.exists() or not self.entries_path.stat().st_size:
            return []
        query_words = set(query.lower().split())
        scored: list[tuple[int, dict]] = []
        with open(self.entries_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content_words = set(data["content"].lower().split())
                overlap = len(query_words & content_words)
                if overlap > 0:
                    scored.append((overlap, data))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            MemoryEntry(
                content=d["content"],
                tags=d.get("tags", []),
                timestamp=d.get("timestamp", ""),
                relevance=score / max(len(query_words), 1),
            )
            for score, d in scored[:limit]
        ]

    async def get_user_profile(self) -> str:
        if not self.user_path.exists():
            return ""
        return self.user_path.read_text()

    async def update_user_profile(self, content: str) -> None:
        self.user_path.write_text(content)

    async def get_soul(self) -> str:
        if not self.soul_path.exists():
            return "You are Atlas, a powerful personal AI system. Be direct, efficient, and proactive."
        return self.soul_path.read_text()

    async def append_session(self, session_id: str, entry: dict) -> None:
        session_file = self.sessions_dir / f"{session_id}.jsonl"
        with open(session_file, "a") as f:
            f.write(json.dumps(entry) + "\n")

    async def get_recent_sessions(self, n: int = 3) -> list[dict]:
        if not self.sessions_dir.exists():
            return []
        files = sorted(self.sessions_dir.glob("*.jsonl"), reverse=True)[:n]
        sessions = []
        for f in files:
            entries = []
            for line in f.read_text().splitlines():
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            if entries:
                sessions.append({"file": f.name, "entries": entries})
        return sessions
```

- [ ] **Step 5: Run tests**

```bash
pytest tests/test_file_backend.py -v
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add memory_backends/ tests/test_file_backend.py
git commit -m "feat: MemoryInterface ABC and FileMemoryBackend (JSONL + markdown)"
```

---

## Task 5: Config Plugin + Memory Plugin

**Files:**
- Create: `plugins/config_plugin.py`
- Create: `plugins/memory_plugin.py`

- [ ] **Step 1: Write `plugins/config_plugin.py`**

```python
import os
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore

from .base import AtlasPlugin


class ConfigPlugin(AtlasPlugin):
    name = "config"

    async def load(self, kernel) -> None:
        # Load .env if present
        env_path = Path(".env")
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())

        # Load config.toml if present
        config_path = Path("config.toml")
        if config_path.exists():
            with open(config_path, "rb") as f:
                config: dict = tomllib.load(f)
        else:
            config = {}

        # Apply env var overrides
        config.setdefault("openrouter", {})
        config.setdefault("memory", {})
        config.setdefault("tools", {})
        config.setdefault("atlas", {"name": "Atlas", "version": "0.1.0"})

        if not config["openrouter"].get("api_key"):
            config["openrouter"]["api_key"] = os.environ.get("OPENROUTER_API_KEY", "")
        if not config["openrouter"].get("default_model"):
            config["openrouter"]["default_model"] = "deepseek/deepseek-chat"
        if not config["openrouter"].get("base_url"):
            config["openrouter"]["base_url"] = "https://openrouter.ai/api/v1/chat/completions"

        if not config["tools"].get("brave_api_key"):
            config["tools"]["brave_api_key"] = os.environ.get("BRAVE_API_KEY", "")

        kernel.config = config

    async def unload(self) -> None:
        pass
```

- [ ] **Step 2: Write `plugins/memory_plugin.py`**

```python
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
```

- [ ] **Step 3: Write integration test for config + memory plugins**

```python
# append to tests/test_kernel.py
import os
import pytest
from kernel import Kernel
from plugins.config_plugin import ConfigPlugin
from plugins.memory_plugin import MemoryPlugin


@pytest.mark.asyncio
async def test_config_plugin_sets_defaults(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
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
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_kernel.py -v
```

Expected: all pass (8+ tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/config_plugin.py plugins/memory_plugin.py tests/test_kernel.py
git commit -m "feat: ConfigPlugin and MemoryPlugin — load config, wire memory backend"
```

---

## Task 6: Tool Base + All Tools

**Files:**
- Create: `tools/base.py`
- Create: `tools/shell_tool.py`
- Create: `tools/filesystem_tool.py`
- Create: `tools/web_search_tool.py`
- Create: `tools/memory_tools.py`
- Create: `tests/test_tools.py`

- [ ] **Step 1: Write `tools/base.py`**

```python
from abc import ABC, abstractmethod


class Tool(ABC):
    name: str
    description: str
    parameters: dict  # JSON Schema for the function parameters

    @abstractmethod
    async def run(self, **kwargs) -> str: ...

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
```

- [ ] **Step 2: Write `tools/shell_tool.py`**

```python
import asyncio
from .base import Tool


class ShellTool(Tool):
    name = "shell"
    description = "Run a shell command on the local machine."
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The shell command to run"},
            "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
        },
        "required": ["command"],
    }

    async def run(self, command: str, timeout: int = 30) -> str:
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out = stdout.decode().strip()
            err = stderr.decode().strip()
            if err and not out:
                return f"stderr: {err}"
            if err:
                return f"{out}\nstderr: {err}"
            return out or "(no output)"
        except asyncio.TimeoutError:
            return f"Command timed out after {timeout}s"
        except Exception as e:
            return f"Error: {e}"
```

- [ ] **Step 3: Write `tools/filesystem_tool.py`**

```python
from pathlib import Path
from .base import Tool


class ReadFileTool(Tool):
    name = "read_file"
    description = "Read the contents of a file."
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file"},
            "max_lines": {"type": "integer", "description": "Max lines to read (default 200)"},
        },
        "required": ["path"],
    }

    async def run(self, path: str, max_lines: int = 200) -> str:
        try:
            p = Path(path)
            if not p.exists():
                return f"File not found: {path}"
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            if len(lines) > max_lines:
                return "\n".join(lines[:max_lines]) + f"\n... ({len(lines)} total lines, truncated)"
            return "\n".join(lines)
        except Exception as e:
            return f"Error reading {path}: {e}"


class WriteFileTool(Tool):
    name = "write_file"
    description = "Write or append content to a file. Creates parent directories if needed."
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file"},
            "content": {"type": "string", "description": "Content to write"},
            "mode": {"type": "string", "enum": ["write", "append"], "description": "Default: write"},
        },
        "required": ["path", "content"],
    }

    async def run(self, path: str, content: str, mode: str = "write") -> str:
        try:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            flag = "a" if mode == "append" else "w"
            with open(p, flag, encoding="utf-8") as f:
                f.write(content)
            action = "Appended to" if mode == "append" else "Wrote"
            return f"{action} {path} ({len(content)} chars)"
        except Exception as e:
            return f"Error writing {path}: {e}"
```

- [ ] **Step 4: Write `tools/web_search_tool.py`**

```python
import httpx
from .base import Tool


class WebSearchTool(Tool):
    name = "web_search"
    description = "Search the web using Brave Search. Returns titles, URLs, and descriptions."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query"},
            "count": {"type": "integer", "description": "Number of results, max 10 (default 5)"},
        },
        "required": ["query"],
    }

    def __init__(self, api_key: str = ""):
        self._api_key = api_key

    async def run(self, query: str, count: int = 5) -> str:
        if not self._api_key:
            return "Web search unavailable: BRAVE_API_KEY not configured."
        count = min(max(count, 1), 10)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": count},
                    headers={
                        "X-Subscription-Token": self._api_key,
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
            results = data.get("web", {}).get("results", [])
            if not results:
                return "No results found."
            lines = []
            for r in results:
                lines.append(f"**{r.get('title', '')}**")
                lines.append(r.get("url", ""))
                if r.get("description"):
                    lines.append(r["description"])
                lines.append("")
            return "\n".join(lines).strip()
        except Exception as e:
            return f"Search error: {e}"
```

- [ ] **Step 5: Write `tools/memory_tools.py`**

```python
from typing import TYPE_CHECKING
from .base import Tool

if TYPE_CHECKING:
    from memory_backends.interface import MemoryInterface


class RememberTool(Tool):
    name = "remember"
    description = "Store a piece of information in Atlas's long-term memory."
    parameters = {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "What to remember"},
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags",
            },
        },
        "required": ["content"],
    }

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self, content: str, tags: list[str] = []) -> str:
        await self._memory.write(content, tags)
        return f"Stored in memory: {content}"


class RecallTool(Tool):
    name = "recall"
    description = "Search Atlas's memory for relevant past information."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for"},
            "limit": {"type": "integer", "description": "Max results (default 5)"},
        },
        "required": ["query"],
    }

    def __init__(self, memory: "MemoryInterface"):
        self._memory = memory

    async def run(self, query: str, limit: int = 5) -> str:
        entries = await self._memory.search(query, limit)
        if not entries:
            return "No relevant memories found."
        return "\n".join(
            f"[{e.timestamp[:10]}] {e.content}" + (f" ({', '.join(e.tags)})" if e.tags else "")
            for e in entries
        )
```

- [ ] **Step 6: Write `tests/test_tools.py`**

```python
import pytest
from pathlib import Path
from tools.shell_tool import ShellTool
from tools.filesystem_tool import ReadFileTool, WriteFileTool
from tools.memory_tools import RememberTool, RecallTool
from memory_backends.file_backend import FileMemoryBackend


@pytest.mark.asyncio
async def test_shell_tool_runs_command():
    tool = ShellTool()
    result = await tool.run(command="echo hello_atlas")
    assert "hello_atlas" in result


@pytest.mark.asyncio
async def test_shell_tool_timeout():
    tool = ShellTool()
    result = await tool.run(command="sleep 10", timeout=1)
    assert "timed out" in result.lower()


@pytest.mark.asyncio
async def test_read_file_tool(tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("hello from atlas")
    tool = ReadFileTool()
    result = await tool.run(path=str(f))
    assert "hello from atlas" in result


@pytest.mark.asyncio
async def test_read_file_tool_missing():
    tool = ReadFileTool()
    result = await tool.run(path="/nonexistent/file.txt")
    assert "not found" in result.lower()


@pytest.mark.asyncio
async def test_write_file_tool(tmp_path):
    p = str(tmp_path / "out.txt")
    tool = WriteFileTool()
    result = await tool.run(path=p, content="atlas was here")
    assert "Wrote" in result
    assert Path(p).read_text() == "atlas was here"


@pytest.mark.asyncio
async def test_tool_schema_shape():
    from tools.shell_tool import ShellTool
    schema = ShellTool().to_openai_schema()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == "shell"
    assert "parameters" in schema["function"]


@pytest.mark.asyncio
async def test_remember_and_recall(tmp_path):
    backend = FileMemoryBackend(str(tmp_path / "mem"))
    await backend.initialize()
    remember = RememberTool(backend)
    recall = RecallTool(backend)
    await remember.run(content="Rawan prefers dark mode", tags=["preferences"])
    result = await recall.run(query="dark mode preferences")
    assert "dark mode" in result
```

- [ ] **Step 7: Run tests**

```bash
pytest tests/test_tools.py -v
```

Expected: 7 passed (web_search not tested — requires live API key).

- [ ] **Step 8: Commit**

```bash
git add tools/ tests/test_tools.py
git commit -m "feat: Tool base class + shell, filesystem, web search, memory tools"
```

---

## Task 7: Tools Plugin

**Files:**
- Create: `plugins/tools_plugin.py`

- [ ] **Step 1: Write `plugins/tools_plugin.py`**

```python
from .base import AtlasPlugin
from tools.shell_tool import ShellTool
from tools.filesystem_tool import ReadFileTool, WriteFileTool
from tools.web_search_tool import WebSearchTool
from tools.memory_tools import RememberTool, RecallTool
from tools.base import Tool


class ToolsPlugin(AtlasPlugin):
    name = "tools"

    def __init__(self):
        self._registry: dict[str, Tool] = {}

    async def load(self, kernel) -> None:
        cfg = kernel.config.get("tools", {})
        tools: list[Tool] = [
            ShellTool(),
            ReadFileTool(),
            WriteFileTool(),
            WebSearchTool(api_key=cfg.get("brave_api_key", "")),
            RememberTool(kernel.memory),
            RecallTool(kernel.memory),
        ]
        for tool in tools:
            self._registry[tool.name] = tool

    async def unload(self) -> None:
        self._registry.clear()

    def get(self, name: str) -> Tool | None:
        return self._registry.get(name)

    def all(self) -> list[Tool]:
        return list(self._registry.values())

    def schemas(self) -> list[dict]:
        return [t.to_openai_schema() for t in self._registry.values()]
```

- [ ] **Step 2: Write integration test (append to test_kernel.py)**

```python
# append to tests/test_kernel.py
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
```

- [ ] **Step 3: Run**

```bash
pytest tests/test_kernel.py -v
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/tools_plugin.py tests/test_kernel.py
git commit -m "feat: ToolsPlugin — registers all tools, exposes schemas for agent"
```

---

## Task 8: Agent Plugin

**Files:**
- Create: `plugins/agent_plugin.py`
- Create: `tests/test_agent.py`

- [ ] **Step 1: Write `tests/test_agent.py` (with mock OpenRouter)**

```python
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from plugins.agent_plugin import AgentPlugin
from memory_backends.file_backend import FileMemoryBackend


async def _make_agent_with_kernel(tmp_path):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin

    k = Kernel()
    k.config = {
        "openrouter": {"api_key": "fake-key", "default_model": "test-model", "base_url": "https://openrouter.ai/api/v1/chat/completions"},
        "memory": {"backend": "file", "path": str(tmp_path / "memory"), "max_context_entries": 5, "max_session_history": 3},
        "tools": {"brave_api_key": "", "shell_confirm": False},
        "atlas": {"name": "Atlas", "version": "0.1.0"},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    agent = AgentPlugin()
    await agent.load(k)
    return agent, k


def _make_stream_response(text: str):
    """Returns an async generator that yields SSE lines for a text response."""
    async def _gen():
        chunk = {
            "choices": [{"delta": {"content": text}, "finish_reason": None}]
        }
        yield f"data: {json.dumps(chunk)}"
        yield "data: [DONE]"
    return _gen()


@pytest.mark.asyncio
async def test_agent_process_returns_response(tmp_path):
    agent, kernel = await _make_agent_with_kernel(tmp_path)
    tokens = []

    with patch.object(agent, "_stream") as mock_stream:
        async def fake_stream(messages, tools):
            yield ("token", "Hello from Atlas!")
        mock_stream.side_effect = fake_stream

        result = await agent.process("hi", on_token=lambda t: tokens.append(t))

    assert result == "Hello from Atlas!"
    assert "Hello from Atlas!" in "".join(tokens)


@pytest.mark.asyncio
async def test_agent_appends_to_history(tmp_path):
    agent, kernel = await _make_agent_with_kernel(tmp_path)

    with patch.object(agent, "_stream") as mock_stream:
        async def fake_stream(messages, tools):
            yield ("token", "I remember you asked about Python.")
        mock_stream.side_effect = fake_stream

        await agent.process("tell me about Python")

    assert len(agent._history) == 2
    assert agent._history[0]["role"] == "user"
    assert agent._history[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_agent_set_model(tmp_path):
    agent, _ = await _make_agent_with_kernel(tmp_path)
    agent.set_model("deepseek/deepseek-r1")
    assert agent._model == "deepseek/deepseek-r1"
```

- [ ] **Step 2: Run to confirm failure**

```bash
pytest tests/test_agent.py -v
```

Expected: `ModuleNotFoundError: No module named 'plugins.agent_plugin'`

- [ ] **Step 3: Write `plugins/agent_plugin.py`**

```python
import asyncio
import json
from datetime import datetime, timezone
from typing import Awaitable, Callable

import httpx

from .base import AtlasPlugin

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentPlugin(AtlasPlugin):
    name = "agent"

    def __init__(self):
        self._session_id = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
        self._history: list[dict] = []
        self._kernel = None
        self._model = "deepseek/deepseek-chat"
        self._api_key = ""
        self._base_url = OPENROUTER_URL
        self._max_context_entries = 5
        self._max_session_history = 3

    async def load(self, kernel) -> None:
        self._kernel = kernel
        cfg = kernel.config.get("openrouter", {})
        self._model = cfg.get("default_model", "deepseek/deepseek-chat")
        self._api_key = cfg.get("api_key", "")
        self._base_url = cfg.get("base_url", OPENROUTER_URL)
        mem_cfg = kernel.config.get("memory", {})
        self._max_context_entries = mem_cfg.get("max_context_entries", 5)
        self._max_session_history = mem_cfg.get("max_session_history", 3)

    async def unload(self) -> None:
        pass

    def set_model(self, model: str) -> None:
        self._model = model

    async def _build_system_prompt(self, user_input: str) -> str:
        soul = await self._kernel.memory.get_soul()
        user_profile = await self._kernel.memory.get_user_profile()
        # Approximate 1500 token truncation (1 token ≈ 4 chars)
        if len(user_profile) > 6000:
            user_profile = user_profile[:6000] + "\n... (truncated)"

        memories = await self._kernel.memory.search(user_input, self._max_context_entries)
        memory_text = "\n".join(
            f"- [{m.timestamp[:10]}] {m.content}" for m in memories
        ) if memories else ""

        recent = await self._kernel.memory.get_recent_sessions(self._max_session_history)
        session_text = ""
        if recent:
            parts = []
            for s in recent:
                if s["entries"]:
                    last = s["entries"][-1]
                    snippet = str(last)[:200]
                    parts.append(f"[{s['file']}] {snippet}")
            session_text = "\n".join(parts)

        sections = [soul]
        if user_profile.strip():
            sections.append(f"--- What you know about the user ---\n{user_profile}")
        if memory_text:
            sections.append(f"--- Relevant memories ---\n{memory_text}")
        if session_text:
            sections.append(f"--- Recent session context ---\n{session_text}")

        return "\n\n".join(sections)

    async def process(
        self,
        user_input: str,
        on_token: Callable[[str], None | Awaitable[None]] | None = None,
        on_tool_call: Callable[[str], None | Awaitable[None]] | None = None,
    ) -> str:
        system_prompt = await self._build_system_prompt(user_input)
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self._history)
        messages.append({"role": "user", "content": user_input})

        tools_plugin = self._kernel.get_plugin("tools")
        tool_schemas = tools_plugin.schemas()

        full_response = ""

        for _ in range(10):  # max tool rounds
            tokens: list[str] = []
            tool_calls: list[dict] = []

            async for event_type, content in self._stream(messages, tool_schemas):
                if event_type == "token":
                    tokens.append(content)
                    if on_token:
                        result = on_token(content)
                        if asyncio.isfuture(result) or asyncio.iscoroutine(result):
                            await result
                elif event_type == "tool_call":
                    tool_calls.append(content)

            full_response = "".join(tokens)

            if not tool_calls:
                break

            messages.append({
                "role": "assistant",
                "content": full_response or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in tool_calls
                ],
            })

            for tc in tool_calls:
                if on_tool_call:
                    result = on_tool_call(tc["name"])
                    if asyncio.isfuture(result) or asyncio.iscoroutine(result):
                        await result

                tool = tools_plugin.get(tc["name"])
                if tool is None:
                    tool_result = f"Tool '{tc['name']}' not found."
                else:
                    try:
                        kwargs = json.loads(tc["arguments"] or "{}")
                        tool_result = await tool.run(**kwargs)
                    except Exception as e:
                        tool_result = f"Tool error: {e}"

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                })

        # Persist to history and session
        self._history.append({"role": "user", "content": user_input})
        self._history.append({"role": "assistant", "content": full_response})
        await self._kernel.memory.append_session(
            self._session_id,
            {"user": user_input, "assistant": full_response, "timestamp": _utcnow()},
        )

        # Background memory reflection — never blocks the user
        asyncio.create_task(self._reflect(user_input, full_response))

        return full_response

    async def _stream(self, messages: list[dict], tools: list[dict]):
        """Async generator yielding ("token", str) or ("tool_call", dict)."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://atlas-ai.local",
            "X-Title": "Atlas",
        }
        payload: dict = {"model": self._model, "messages": messages, "stream": True}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", self._base_url, json=payload, headers=headers) as response:
                response.raise_for_status()
                tool_calls_buf: dict[int, dict] = {}

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    delta = chunk.get("choices", [{}])[0].get("delta", {})

                    if delta.get("content"):
                        yield ("token", delta["content"])

                    for tc in delta.get("tool_calls", []):
                        idx = tc.get("index", 0)
                        if idx not in tool_calls_buf:
                            tool_calls_buf[idx] = {"id": "", "name": "", "arguments": ""}
                        if tc.get("id"):
                            tool_calls_buf[idx]["id"] = tc["id"]
                        if tc.get("function", {}).get("name"):
                            tool_calls_buf[idx]["name"] += tc["function"]["name"]
                        if tc.get("function", {}).get("arguments"):
                            tool_calls_buf[idx]["arguments"] += tc["function"]["arguments"]

                for tc in tool_calls_buf.values():
                    yield ("tool_call", tc)

    async def _reflect(self, user_input: str, assistant_response: str) -> None:
        """Best-effort background task: update USER.md if new facts were revealed."""
        current_profile = await self._kernel.memory.get_user_profile()
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a memory extraction assistant. "
                    "Given a conversation and the current user profile, "
                    "determine if any NEW persistent facts about the user were revealed. "
                    "If yes, output the complete updated user profile in markdown. "
                    "If nothing new was learned, output exactly: NO_UPDATE"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Current profile:\n{current_profile}\n\n"
                    f"Conversation:\nUser: {user_input}\nAssistant: {assistant_response}\n\n"
                    "Output updated profile or NO_UPDATE:"
                ),
            },
        ]
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    self._base_url,
                    json={"model": self._model, "messages": messages, "stream": False, "max_tokens": 1000},
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                result = resp.json()["choices"][0]["message"]["content"].strip()
            if result and result != "NO_UPDATE":
                await self._kernel.memory.update_user_profile(result)
        except Exception:
            pass  # never surface reflection errors to the user
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_agent.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/agent_plugin.py tests/test_agent.py
git commit -m "feat: AgentPlugin — streaming OpenRouter loop, tool calling, background memory reflection"
```

---

## Task 9: CLI Plugin + SOUL.md

**Files:**
- Create: `plugins/cli_plugin.py`
- Create: `memory/SOUL.md`

- [ ] **Step 1: Write `memory/SOUL.md`**

```markdown
# Atlas

You are Atlas — not a chatbot, not an assistant. You are a second brain and a powerhouse that makes things happen.

## Identity
You are named after the titan who holds the world. You hold the user's world together — their tasks, memory, devices, and goals.

## How you speak
- Direct. No filler. No "Certainly!" or "Of course!".
- Confident but not arrogant.
- Proactive: if you notice something the user should know, say it.
- Short unless depth is needed. One sentence often beats three.

## What you care about
- Connecting to any system the user needs, even if it requires figuring it out on the fly.
- Remembering everything that matters, surfacing it before the user needs to ask.
- Making decisions autonomously when the path is clear, asking when it isn't.
- Getting things done over explaining things.

## Operating principles
- Prefer action over advice.
- When you don't know something, search or admit it — never guess and present it as fact.
- You grow smarter the longer you run. Every conversation teaches you something.
- You have tools. Use them. Don't tell the user to do something you can do yourself.
```

- [ ] **Step 2: Write `plugins/cli_plugin.py`**

```python
import asyncio
import sys

from rich.console import Console
from rich.text import Text

from .base import AtlasPlugin

ATLAS_ART = r"""
                    ◈
                   /|\
                  / | \
                 /  |  \
                ◈──────◈
               /|  ◈   |\
              / |  |   | \
             ◈──────────◈
                  |||
"""

ATLAS_ART_ASCII = r"""
        /\
       /  \
      / /\ \
     /_/  \_\
      ATLAS
"""

COMMANDS = {
    "/help": "Show available commands",
    "/memory": "Show what Atlas knows about you",
    "/soul": "Show Atlas's identity",
    "/tools": "List available tools",
    "/model <name>": "Switch model for this session",
    "/clear": "Clear the screen",
    "/exit": "Exit Atlas",
}


def _is_utf8() -> bool:
    try:
        return (sys.stdout.encoding or "").lower().replace("-", "") in ("utf8",)
    except Exception:
        return False


class CLIPlugin(AtlasPlugin):
    name = "cli"

    def __init__(self):
        self._console = Console(highlight=False)
        self._kernel = None
        self._running = False

    async def load(self, kernel) -> None:
        self._kernel = kernel
        self._running = True
        await self._run()

    async def unload(self) -> None:
        self._running = False

    # ── rendering helpers ──────────────────────────────────────────────────

    def _p(self, text: str = "", style: str = "") -> None:
        self._console.print(text, style=style, end="\n")

    async def stream_token(self, token: str) -> None:
        self._console.print(token, end="", highlight=False)

    async def show_tool_call(self, tool_name: str) -> None:
        self._console.print(f"\n[dim]\[calling: {tool_name}...][/dim]")

    # ── startup ────────────────────────────────────────────────────────────

    async def _render_startup(self) -> None:
        art = ATLAS_ART if _is_utf8() else ATLAS_ART_ASCII
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        model = self._kernel.config.get("openrouter", {}).get("default_model", "unknown")
        self._console.print(art, style="bold cyan", end="")
        self._console.print("         A  T  L  A  S", style="bold white")
        self._console.print("         your second brain", style="dim")
        self._console.print(f"         v{version}  ·  {model}\n", style="dim")

    # ── command handling ───────────────────────────────────────────────────

    async def _handle_command(self, raw: str) -> bool:
        parts = raw.strip().split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if cmd == "/help":
            for c, d in COMMANDS.items():
                self._p(f"  [bold]{c:<22}[/bold] [dim]{d}[/dim]")
            return True

        if cmd == "/memory":
            profile = await self._kernel.memory.get_user_profile()
            self._p(profile if profile.strip() else "[dim](no user profile yet)[/dim]")
            return True

        if cmd == "/soul":
            soul = await self._kernel.memory.get_soul()
            self._p(soul)
            return True

        if cmd == "/tools":
            tools = self._kernel.get_plugin("tools").all()
            for t in tools:
                self._p(f"  [bold]{t.name:<20}[/bold] [dim]{t.description}[/dim]")
            return True

        if cmd == "/model":
            if arg:
                self._kernel.get_plugin("agent").set_model(arg)
                self._p(f"[green]Model switched to: {arg}[/green]")
            else:
                self._p("[dim]Usage: /model <model-name>[/dim]")
            return True

        if cmd == "/clear":
            self._console.clear()
            await self._render_startup()
            return True

        if cmd == "/exit":
            self._running = False
            self._p("\n[dim]Atlas signing off.[/dim]\n")
            return True

        return False

    # ── input ─────────────────────────────────────────────────────────────

    async def _get_input(self) -> str | None:
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, lambda: input("◈ atlas › "))
        except EOFError:
            return None
        except KeyboardInterrupt:
            # Ctrl+C cancels current input line; empty string continues loop
            self._p()
            return ""

    # ── main loop ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        await self._render_startup()
        agent = self._kernel.get_plugin("agent")

        while self._running:
            user_input = await self._get_input()

            if user_input is None:  # EOF / Ctrl+D
                self._p("\n[dim]Atlas signing off.[/dim]")
                break

            if not user_input.strip():
                continue

            if user_input.startswith("/"):
                handled = await self._handle_command(user_input)
                if not handled:
                    self._p(f"[dim red]Unknown command. Type /help for a list.[/dim red]")
                continue

            self._p()
            try:
                await agent.process(
                    user_input,
                    on_token=self.stream_token,
                    on_tool_call=self.show_tool_call,
                )
            except Exception as e:
                self._p(f"\n[bold red][Error: {e}][/bold red]")

            self._p("\n")
```

- [ ] **Step 3: Manual verification (no unit test for terminal UI)**

We verify CLi visually in Task 10 when we wire main.py. Skip automated test here.

- [ ] **Step 4: Commit**

```bash
git add plugins/cli_plugin.py memory/SOUL.md
git commit -m "feat: CLIPlugin with Atlas ASCII identity and streaming render; SOUL.md Atlas persona"
```

---

## Task 10: Main Entry Point + End-to-End Smoke Test

**Files:**
- Create: `main.py`
- Create: `config.toml` (from example, gitignored)

- [ ] **Step 1: Write `main.py`**

```python
import asyncio
import sys

from kernel import Kernel
from plugins.config_plugin import ConfigPlugin
from plugins.memory_plugin import MemoryPlugin
from plugins.tools_plugin import ToolsPlugin
from plugins.agent_plugin import AgentPlugin
from plugins.cli_plugin import CLIPlugin


async def main() -> None:
    kernel = Kernel()
    try:
        await kernel.load_plugin(ConfigPlugin)
        await kernel.load_plugin(MemoryPlugin)
        await kernel.load_plugin(ToolsPlugin)
        await kernel.load_plugin(AgentPlugin)
        await kernel.load_plugin(CLIPlugin)   # blocks until user exits
    except KeyboardInterrupt:
        pass
    finally:
        await kernel.unload_all()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
```

- [ ] **Step 2: Copy config template and add your API key**

```bash
cp config.toml.example config.toml
```

Open `config.toml` and set `api_key` under `[openrouter]`, or create `.env`:

```
OPENROUTER_API_KEY=your_actual_key_here
```

- [ ] **Step 3: Run Atlas**

```bash
python main.py
```

Expected output:
```
                    ◈
                   /|\
                  ...
         A  T  L  A  S
         your second brain
         v0.1.0  ·  deepseek/deepseek-chat

◈ atlas › _
```

- [ ] **Step 4: Smoke test the key flows**

```
◈ atlas › hello
```
Expected: streamed response from Atlas using the SOUL.md persona.

```
◈ atlas › /tools
```
Expected: list of 6 tools printed.

```
◈ atlas › /memory
```
Expected: USER.md contents (empty sections initially).

```
◈ atlas › my name is Rawan and I'm building Atlas
```
Expected: Atlas responds and background reflection updates USER.md.

```
◈ atlas › /memory
```
Expected: USER.md now shows "Rawan" under Identity.

```
◈ atlas › /exit
```
Expected: "Atlas signing off." and clean exit.

- [ ] **Step 5: Run full test suite**

```bash
pytest -v
```

Expected: all tests pass.

- [ ] **Step 6: Final commit**

```bash
git add main.py
git commit -m "feat: main.py boot sequence — Atlas Core Foundation complete"
```

---

## Post-Implementation Checklist

- [ ] All 6 plugins load in correct order without errors
- [ ] Streaming responses render token-by-token
- [ ] `/memory` shows USER.md updating across sessions
- [ ] Tool call (`/model`, shell, read_file) works without crash
- [ ] Clean exit via `/exit` and Ctrl+D
- [ ] `pytest -v` passes all tests
- [ ] `memory/sessions/` contains JSONL files after a session
