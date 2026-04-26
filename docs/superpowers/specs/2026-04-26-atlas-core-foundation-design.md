# Atlas Core Foundation — Design Spec
**Date:** 2026-04-26  
**Phase:** 1 — Core Foundation  
**Status:** Approved for implementation

---

## 1. Overview

Atlas Core Foundation is the minimal, production-grade base that every future Atlas capability is built on. It is not a chatbot — it is a kernel + plugin system that happens to start with a CLI interface, and is architected to grow into a full autonomous multi-device AI system without ever rewriting the core.

**What this phase delivers:**
- A unique terminal CLI (Atlas identity, ASCII art, streaming responses)
- A micro-kernel that routes events and loads plugins
- An async-native agent loop connected to OpenRouter
- A memory layer (persistent, human-readable, interface-driven for future backend swaps)
- Plugin architecture ready for Telegram, voice, device bridges in future phases

---

## 2. Architecture

### 2.1 Layers

```
┌─────────────────────────────────────────────────┐
│                INTERFACE LAYER                  │
│         CLI Plugin (phase 1)                    │
│         Telegram Plugin (phase 2)               │
│         Voice Plugin (phase 2)                  │
└───────────────────┬─────────────────────────────┘
                    │ async calls
┌───────────────────▼─────────────────────────────┐
│                KERNEL                           │
│  Plugin registry · Config · Shared memory ref  │
│  Async coordinator (asyncio)                    │
└───────────────────┬─────────────────────────────┘
                    │
        ┌───────────┼────────────┐
        │           │            │
┌───────▼──┐ ┌──────▼───┐ ┌─────▼──────┐
│  AGENT   │ │  MEMORY  │ │   TOOLS    │
│  Plugin  │ │  Plugin  │ │  Plugins   │
│          │ │          │ │            │
│ OpenRouter│ │JSONL+MD  │ │web/files/  │
│ streaming │ │+ vector  │ │calendar/   │
│ tool call │ │ backend  │ │ shell etc  │
└──────────┘ └──────────┘ └────────────┘
```

### 2.2 Kernel Responsibilities (and nothing else)

The kernel (`kernel.py`, target ≤400 lines) owns:

1. **Plugin registry** — `load_plugin(path)`, `unload_plugin(name)`, `get_plugin(name)`
2. **Shared context** — exposes `kernel.memory`, `kernel.config` to all plugins
3. **Async coordination** — owns the main asyncio event loop; plugins get a reference to schedule coroutines

The kernel does NOT: call any LLM, render any UI, read/write memory directly, or contain any business logic.

### 2.3 Plugin Interface

Every plugin is a Python class that implements:

```python
class AtlasPlugin:
    name: str                              # unique identifier
    version: str                           # semver

    async def load(self, kernel) -> None   # startup: register handlers, init state
    async def unload(self) -> None         # shutdown: cleanup resources
```

Plugins communicate by calling each other directly through the kernel's plugin registry (`kernel.get_plugin("agent").run(input)`). No custom event bus in phase 1 — direct async calls are simpler, faster, and easier to debug. An event bus gets introduced in phase 2 when multiple interfaces need to run concurrently.

### 2.4 Plugin Dependency Order

Boot sequence:
1. `config` — loads `config.toml`, validates required keys
2. `memory` — initializes memory layer, loads SOUL.md + USER.md
3. `tools` — registers available tools
4. `agent` — loads agent loop, connects to OpenRouter
5. `cli` — starts the terminal interface (last, blocks until exit)

---

## 3. Kernel Implementation Detail

### 3.1 File: `kernel.py`

```python
# Kernel exposes this to every plugin:
class Kernel:
    config: Config               # parsed config.toml
    memory: MemoryInterface      # memory read/write (backend-agnostic)
    plugins: dict[str, Plugin]   # loaded plugins by name

    async def load_plugin(self, plugin_class) -> None
    async def unload_all(self) -> None
    def get_plugin(self, name: str) -> Plugin
```

### 3.2 File: `main.py`

```python
async def main():
    kernel = Kernel()
    await kernel.load_plugin(ConfigPlugin)
    await kernel.load_plugin(MemoryPlugin)
    await kernel.load_plugin(ToolsPlugin)
    await kernel.load_plugin(AgentPlugin)
    await kernel.load_plugin(CLIPlugin)    # blocks until user exits
    await kernel.unload_all()
```

---

## 4. Memory Layer

### 4.1 Design Philosophy

Memory is Atlas's most important asset. It must be:
- **Human-readable** — you can open any file and read what Atlas knows
- **Interface-driven** — swap the backend without touching any plugin
- **Persistent across restarts** — nothing is lost between sessions
- **Incrementally upgradeable** — start simple, add vector search without breaking changes

### 4.2 Memory Interface

```python
class MemoryInterface:
    async def write(self, content: str, tags: list[str] = []) -> None
    async def search(self, query: str, limit: int = 5) -> list[MemoryEntry]
    async def get_user_profile(self) -> str          # contents of USER.md
    async def update_user_profile(self, patch: str) -> None
    async def get_soul(self) -> str                  # contents of SOUL.md
    async def append_session(self, session_id: str, entry: dict) -> None
    async def get_recent_sessions(self, n: int = 3) -> list[dict]
```

### 4.3 Phase 1 Backend: FileMemory

Storage layout:
```
memory/
├── SOUL.md                    # Atlas's identity, personality, operating principles
├── USER.md                    # Living user profile — auto-updated each session
├── sessions/
│   └── 2026-04-26-001.jsonl   # One JSONL file per session
└── index/
    └── entries.jsonl           # Flat log of all memory entries with tags + timestamps
```

**Search in phase 1:** keyword match + recency scoring over `entries.jsonl`. Fast enough for hundreds of entries. No dependencies beyond stdlib.

**Phase 2 upgrade path:** Implement `VectorMemory` that wraps the same interface but uses ChromaDB (embedded, no server). Drop-in swap, zero plugin changes.

### 4.4 SOUL.md

Written once by the developer, defines Atlas's character:
- Who Atlas is
- How it speaks (tone, style)
- What it cares about
- Its operating principles (proactive, honest, efficient)

### 4.5 USER.md

Auto-maintained by the agent plugin. After each session, the agent reflects: "did I learn anything new about the user?" If yes, it appends or updates relevant sections. Structured as free-form markdown with consistent headings:
- `## Identity` — name, profession, location
- `## Preferences` — how they like things done
- `## Projects` — what they're working on
- `## Patterns` — routines and behaviors Atlas has observed
- `## Context` — current priorities and active concerns

---

## 5. Agent Plugin

### 5.1 Conversation Loop

```
receive input (str)
    → build context: SOUL.md + USER.md excerpt + recent sessions + relevant memories
    → build messages: system prompt + history + user message
    → call OpenRouter (streaming, httpx async)
    → stream tokens → CLI plugin renders live
    → if tool_call in response → execute tool → append result → continue loop
    → when response complete:
        → append full exchange to session JSONL
        → run memory reflection (async, non-blocking)
```

### 5.2 System Prompt Construction

```
{SOUL.md contents}

--- What you know about the user ---
{USER.md contents, truncated to 1500 tokens via char-count approximation (1 token ≈ 4 chars)}

--- Recent memory ---
{top 5 relevant memory entries for this query}

--- Recent conversation context ---
{last 3 session summaries}
```

### 5.3 Tool Calling

Tools are registered by the tools plugin. The agent receives the tool manifest at startup. When the model returns a tool call:
1. Agent finds the tool by name in the registry
2. Executes it (async)
3. Appends result to messages
4. Continues the loop (up to 10 tool rounds before forcing a response)

### 5.4 Memory Reflection

After each response, a lightweight async task runs in the background:
1. Feed the conversation turn to the model with a short prompt: "Did you learn anything new and persistent about the user? If yes, output a patch for USER.md. If no, output nothing."
2. If output is non-empty, apply patch to USER.md
3. Also extract any standalone facts to `entries.jsonl` with tags

This runs after the response is delivered so it never adds latency.

### 5.5 OpenRouter Integration

```python
# httpx async streaming
async with httpx.AsyncClient() as client:
    async with client.stream("POST", OPENROUTER_URL, json=payload, headers=headers) as r:
        async for chunk in r.aiter_lines():
            # parse SSE, yield tokens
```

Model configured in `config.toml`. Default: `deepseek/deepseek-chat` (free tier) or `deepseek/deepseek-r1` for reasoning tasks. Agent can suggest model switches based on task complexity (phase 2 feature: auto-switching).

---

## 6. CLI Plugin

### 6.1 Atlas Terminal Identity

The CLI is not a generic REPL. It has a visual identity. Unicode art is used by default; if the terminal reports non-UTF-8 encoding, falls back to ASCII-safe variant automatically.

**Startup screen:**
```
                    ◈
                   /|\
                  / | \
                 /  |  \
                ◈──────◈
               /|  ◈   |\
              / |  |   | \
             ◈──────────◈
                  |||
         A  T  L  A  S
         ─────────────────
         your second brain
         v0.1.0 · core foundation
```

**Session prompt:**
```
◈ atlas › _
```

**Response rendering:**
- Streaming tokens rendered live via `rich`
- Code blocks syntax-highlighted
- Tool calls shown as `[calling: tool_name...]` in dim style
- Memory reflection shown as `[remembering...]` in subtle color

### 6.2 Built-in Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/memory` | Show USER.md — what Atlas knows about you |
| `/soul` | Show SOUL.md — Atlas's identity |
| `/tools` | List available tools |
| `/model <name>` | Switch model for this session |
| `/clear` | Clear screen, keep memory |
| `/exit` | Exit gracefully |

### 6.3 Input Handling

- Multi-line input: press `Enter` on empty line to submit
- Arrow key history (readline)
- Ctrl+C cancels current generation (not the whole session)
- Ctrl+D exits gracefully

---

## 7. Tools Plugin (Phase 1 Baseline)

Phase 1 ships with a minimal set of tools. Each is async, self-contained, and registered with a JSON schema the model can call.

| Tool | Description |
|---|---|
| `shell` | Run a shell command (with user confirmation prompt) |
| `read_file` | Read a file from the filesystem |
| `write_file` | Write or append to a file |
| `web_search` | Web search via Brave Search API (free tier, 2000 req/month, key in config) |
| `remember` | Explicitly store a fact in memory (user-triggered) |
| `recall` | Search memory and return results |

Tools are defined as classes implementing:
```python
class Tool:
    name: str
    description: str
    parameters: dict       # JSON Schema

    async def run(self, **kwargs) -> str
```

---

## 8. Configuration

`config.toml` at project root:

```toml
[atlas]
name = "Atlas"
version = "0.1.0"

[openrouter]
api_key = ""               # leave blank and set OPENROUTER_API_KEY env var instead (recommended)
default_model = "deepseek/deepseek-chat"
reasoning_model = "deepseek/deepseek-r1"
base_url = "https://openrouter.ai/api/v1/chat/completions"

[memory]
backend = "file"           # "file" | "chroma" (phase 2)
path = "./memory"
max_context_entries = 5
max_session_history = 3

[tools]
shell_confirm = true       # always ask before running shell commands
```

---

## 9. Project Structure

```
atlas/
├── main.py                    # Entry point
├── kernel.py                  # Micro-kernel
├── config.toml                # Configuration (gitignored for api_key)
├── ATLAS.md                   # Vision document
│
├── plugins/
│   ├── __init__.py
│   ├── base.py                # AtlasPlugin base class
│   ├── config_plugin.py       # Config loading
│   ├── memory_plugin.py       # Memory layer
│   ├── tools_plugin.py        # Tool registry
│   ├── agent_plugin.py        # Agent loop
│   └── cli_plugin.py          # Terminal interface
│
├── memory_backends/
│   ├── __init__.py
│   ├── interface.py           # MemoryInterface ABC
│   └── file_backend.py        # JSONL + markdown backend (phase 1)
│
├── tools/
│   ├── __init__.py
│   ├── base.py                # Tool base class
│   ├── shell.py
│   ├── filesystem.py
│   ├── web_search.py
│   └── memory_tools.py        # remember + recall
│
├── memory/
│   ├── SOUL.md                # Written by developer
│   ├── USER.md                # Auto-maintained by Atlas
│   ├── sessions/
│   └── index/
│
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-26-atlas-core-foundation-design.md
│
└── .gitignore
```

---

## 10. Data Flow — Full Trace

```
1. main.py boots kernel, loads plugins in order

2. CLIPlugin renders startup ASCII + "◈ atlas › " prompt

3. User types: "what should i focus on today?"

4. CLIPlugin calls: await kernel.get_plugin("agent").process(user_input)

5. AgentPlugin:
   a. memory.search("focus today priorities") → top 5 entries
   b. memory.get_user_profile() → USER.md (truncated)
   c. memory.get_recent_sessions(3) → last 3 session summaries
   d. builds system prompt: SOUL + USER excerpt + memory hits
   e. calls OpenRouter stream (deepseek/deepseek-chat)
   f. for each token: kernel.get_plugin("cli").stream_token(token)
   g. if tool_call: execute tool, append result, loop
   h. when done: memory.append_session(...) + fire background memory_reflection()

6. CLIPlugin renders tokens live as they arrive

7. After response: memory_reflection() runs async in background:
   a. asks model: "what did you learn about the user?"
   b. if non-empty: patches USER.md
   c. extracts facts to entries.jsonl

8. Prompt returns: "◈ atlas › "
```

---

## 11. Non-Goals for Phase 1

These are explicitly out of scope and will not be built:
- Telegram, voice, or desktop interface
- Vector memory backend (ChromaDB)
- Auto model switching based on task
- Device bridging or MCP servers
- Multi-agent spawning
- Perceptual capture (screen/audio)
- Any web UI

---

## 12. Error Handling

- OpenRouter failures: retry once with exponential backoff, then surface clean error to user (not a stack trace)
- Tool failures: caught, formatted as tool error, model continues
- Memory write failures: logged, session continues (memory is non-blocking)
- Plugin load failures: fail fast at startup with a clear message identifying which plugin failed

---

## 13. Testing Strategy

Each component is independently testable:
- `MemoryInterface`: test with in-memory mock backend
- Tools: unit tested with mocked inputs/outputs
- Agent loop: tested with a mock OpenRouter that returns fixture responses
- CLI: not unit tested (terminal UI) — verified manually
- Kernel: integration tested with real plugins loaded

---

## 14. Future Architecture Hooks

Decisions made now that enable future phases:
- `MemoryInterface` is an ABC — swap to ChromaDB with no plugin changes
- `AtlasPlugin.load()` receives the full kernel — plugins can call any other plugin
- Config has `backend` key in `[memory]` — controlled at config level
- Tool registry is open — new tools are just new classes in `tools/`
- Event bus not built yet but `Kernel` has a reserved `bus` attribute for phase 2
- `CLIPlugin` is one plugin — Telegram/voice are peers, not forks of CLI code
