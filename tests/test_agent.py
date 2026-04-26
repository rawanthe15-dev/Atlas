import asyncio
import json
import pytest
from unittest.mock import patch
from plugins.agent_plugin import AgentPlugin


async def _make_agent_with_kernel(tmp_path):
    from kernel import Kernel
    from plugins.memory_plugin import MemoryPlugin
    from plugins.tools_plugin import ToolsPlugin

    k = Kernel()
    k.config = {
        "openrouter": {
            "api_key": "fake-key",
            "default_model": "test-model",
            "base_url": "https://openrouter.ai/api/v1/chat/completions",
        },
        "memory": {
            "backend": "file",
            "path": str(tmp_path / "memory"),
            "max_context_entries": 5,
            "max_session_history": 3,
        },
        "tools": {"brave_api_key": "", "shell_confirm": False},
        "atlas": {"name": "Atlas", "version": "0.1.0"},
    }
    await k.load_plugin(MemoryPlugin)
    await k.load_plugin(ToolsPlugin)
    agent = AgentPlugin()
    await agent.load(k)
    return agent, k


@pytest.mark.asyncio
async def test_agent_process_returns_response(tmp_path):
    agent, kernel = await _make_agent_with_kernel(tmp_path)
    tokens = []

    async def fake_stream(messages, tools):
        yield ("token", "Hello from Atlas!")

    with patch.object(agent, "_stream", side_effect=fake_stream):
        # Also patch _reflect to avoid real network calls in background task
        with patch.object(agent, "_reflect", return_value=None):
            result = await agent.process("hi", on_token=lambda t: tokens.append(t))

    assert result == "Hello from Atlas!"
    assert "Hello from Atlas!" in "".join(tokens)


@pytest.mark.asyncio
async def test_agent_appends_to_history(tmp_path):
    agent, kernel = await _make_agent_with_kernel(tmp_path)

    async def fake_stream(messages, tools):
        yield ("token", "I remember you asked about Python.")

    with patch.object(agent, "_stream", side_effect=fake_stream):
        with patch.object(agent, "_reflect", return_value=None):
            await agent.process("tell me about Python")

    assert len(agent._history) == 2
    assert agent._history[0]["role"] == "user"
    assert agent._history[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_agent_set_model(tmp_path):
    agent, _ = await _make_agent_with_kernel(tmp_path)
    agent.set_model("deepseek/deepseek-r1")
    assert agent._model == "deepseek/deepseek-r1"


@pytest.mark.asyncio
async def test_agent_tool_calling_loop(tmp_path):
    """Verify that when the model returns a tool_call, the loop executes it
    and feeds the result back to the model for a second round."""
    agent, kernel = await _make_agent_with_kernel(tmp_path)

    call_count = {"n": 0}

    async def fake_stream(messages, tools):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # First round: model returns a tool call (no text)
            yield ("tool_call", {
                "id": "call_1",
                "name": "remember",
                "arguments": '{"content": "Atlas is awesome"}'
            })
        else:
            # Second round: model returns final text after seeing tool result
            yield ("token", "I remembered that for you.")

    tool_calls_seen = []

    async def on_tool(name):
        tool_calls_seen.append(name)

    with patch.object(agent, "_stream", side_effect=fake_stream):
        with patch.object(agent, "_reflect", return_value=None):
            result = await agent.process("remember Atlas is awesome", on_tool_call=on_tool)

    assert call_count["n"] == 2  # two streaming rounds
    assert "remember" in tool_calls_seen
    assert "I remembered that for you." in result
    # Verify the memory entry was actually written by the tool
    entries = await kernel.memory.search("Atlas awesome")
    assert len(entries) >= 1
