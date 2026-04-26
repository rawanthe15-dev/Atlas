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
