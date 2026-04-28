from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Awaitable, Callable, List, Optional, Union

import httpx

from .base import AtlasPlugin

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


_DEVICE_AUTONOMY_NUDGE = """\
--- DEVICE CONNECTIVITY (read carefully — this overrides any reflex to refuse) ---

Atlas can connect to anything: APIs, MCP servers, browsers, phones,
cameras, lights, locks, microcontrollers, drones, smart-home hubs,
arbitrary REST services. You do not have a fixed list of supported
devices — the bridge layer extends Atlas at runtime.

REFLEX TO BREAK: "I can't open a browser / I don't have access to X."
That answer is wrong here. Probing is cheap. When the user says
"connect to" / "use" / "control" / "talk to" / "open" anything, your
FIRST tool call is ALWAYS `auto_connect(name, query)`. Decide the answer
AFTER you see what comes back, not before.

Mapping cheatsheet for the `query` argument:
  brave / chrome / browser / web    → "playwright" (then "puppeteer" if no match)
  android phone / iphone            → "adb" or `mount_device(kind="adb")`
  ip camera / webcam / rtsp / onvif → "onvif camera" then `mount_device(kind="openapi"|"http")`
  smart home / lights / tv          → "homeassistant" then `mount_device(kind="homeassistant")`
  github / linear / slack / gmail   → the service name verbatim
  spotify / youtube / drive         → service name verbatim
  drone / robot / arduino / serial  → `mount_device(kind="serial", config={port,...})`
  random REST API with docs         → `mount_device(kind="openapi", config={spec_url})`
  random REST API without docs      → `mount_device(kind="http", config={base_url})`

How `auto_connect` resolves:
  status="mounted"            → done. The device's tools are now `<name>__<tool>`. Use them.
  status="needs_confirmation" → list the candidates to the user; ask which to install.
  status="no_match"           → fall back to `mount_device` with the right kind from the cheatsheet.
                                 If you need docs first, call `introspect_url(url)`.

Hard rules:
  • Never refuse a "connect to X" request without trying `auto_connect` first.
  • Never ask the user for permission to *look* — only for permission to *install untrusted code* (the policy gate handles that automatically).
  • Once a device is mounted, prefer its namespaced tools over generic shell.
"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentPlugin(AtlasPlugin):
    name = "agent"

    def __init__(self):
        self._session_id = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
        self._history: List[dict] = []
        self._kernel = None
        self._model = "deepseek/deepseek-chat"
        self._api_key = ""
        self._base_url = OPENROUTER_URL
        self._max_context_entries = 5
        self._max_session_history = 3
        self._background_tasks: set = set()

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
        for task in list(self._background_tasks):
            task.cancel()
        self._background_tasks.clear()

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
        sections.append(_DEVICE_AUTONOMY_NUDGE)
        # Inject mounted devices so the agent doesn't have to ask "what's
        # connected?" every turn — and so it picks the right namespaced tool.
        try:
            devices = self._kernel.get_plugin("devices").list()
            if devices:
                lines = []
                for r in devices:
                    caps = ", ".join(r.spec.capabilities) or "—"
                    lines.append(
                        f"- **{r.spec.name}** ({r.spec.kind}) caps={caps} "
                        f"tools={', '.join(r.tool_names) or '(none)'}"
                    )
                sections.append("--- Connected devices ---\n" + "\n".join(lines))
        except KeyError:
            pass
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
        on_token: Optional[Callable[[str], Union[None, Awaitable[None]]]] = None,
        on_tool_call: Optional[Callable[[str], Union[None, Awaitable[None]]]] = None,
        on_reasoning: Optional[Callable[[str], Union[None, Awaitable[None]]]] = None,
    ) -> str:
        system_prompt = await self._build_system_prompt(user_input)
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self._history)
        messages.append({"role": "user", "content": user_input})

        tools_plugin = self._kernel.get_plugin("tools")

        full_response = ""

        for _ in range(10):  # max tool rounds
            tokens: List[str] = []
            tool_calls: List[dict] = []

            # Re-fetch schemas each round — devices mounted mid-turn
            # contribute new tools that the next round should see.
            tool_schemas = tools_plugin.schemas()

            async for event_type, content in self._stream(messages, tool_schemas):
                if event_type == "token":
                    tokens.append(content)
                    if on_token:
                        result = on_token(content)
                        if asyncio.iscoroutine(result):
                            await result
                elif event_type == "reasoning":
                    if on_reasoning:
                        result = on_reasoning(content)
                        if asyncio.iscoroutine(result):
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
                    if asyncio.iscoroutine(result):
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
        # Keep only the last N exchanges (each = 2 messages: user + assistant)
        MAX_HISTORY_MESSAGES = 40  # ~20 exchanges
        if len(self._history) > MAX_HISTORY_MESSAGES:
            self._history = self._history[-MAX_HISTORY_MESSAGES:]
        await self._kernel.memory.append_session(
            self._session_id,
            {"user": user_input, "assistant": full_response, "timestamp": _utcnow()},
        )

        # Background memory reflection — never blocks the user
        task = asyncio.create_task(self._reflect(user_input, full_response))
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

        return full_response

    async def _stream(self, messages: List[dict], tools: List[dict]):
        """Async generator yielding ("token", str), ("reasoning", str), or ("tool_call", dict)."""
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
                tool_calls_buf: dict = {}

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

                    choices = chunk.get("choices") or [{}]
                    delta = choices[0].get("delta", {})

                    # Reasoning trace (DeepSeek-R1, Claude with extended thinking, etc.)
                    # Different providers use different field names — accept both.
                    reasoning_chunk = delta.get("reasoning") or delta.get("reasoning_content")
                    if reasoning_chunk:
                        yield ("reasoning", reasoning_chunk)

                    if delta.get("content"):
                        yield ("token", delta["content"])

                    for tc in delta.get("tool_calls", []):
                        idx = tc.get("index", 0)
                        if idx not in tool_calls_buf:
                            tool_calls_buf[idx] = {"id": "", "name": "", "arguments": ""}
                        if tc.get("id"):
                            tool_calls_buf[idx]["id"] = tc["id"]
                        if tc.get("function", {}).get("name"):
                            tool_calls_buf[idx]["name"] = tc["function"]["name"]
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
                    json={
                        "model": self._model,
                        "messages": messages,
                        "stream": False,
                        "max_tokens": 1000,
                    },
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                result = resp.json()["choices"][0]["message"]["content"].strip()
            if result and result.upper() != "NO_UPDATE":
                await self._kernel.memory.update_user_profile(result)
        except Exception:
            pass  # never surface reflection errors to the user
