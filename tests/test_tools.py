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
