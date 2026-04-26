"""Smoke tests for ChromaMemoryBackend.
Skipped automatically if chromadb isn't installed."""

import pytest

chromadb = pytest.importorskip("chromadb")

from memory_backends.chroma_backend import ChromaMemoryBackend


@pytest.fixture
def backend(tmp_path):
    return ChromaMemoryBackend(str(tmp_path / "memory"))


@pytest.mark.asyncio
async def test_initialize_creates_dirs(backend, tmp_path):
    await backend.initialize()
    assert (tmp_path / "memory" / "sessions").exists()
    assert (tmp_path / "memory" / "chroma").exists()


@pytest.mark.asyncio
async def test_write_and_semantic_search(backend):
    await backend.initialize()
    await backend.write("Rawan is building Atlas, a personal AI system", tags=["project"])
    await backend.write("The dog likes long walks in the park", tags=["pets"])
    await backend.write("Atlas uses a micro-kernel plus plugin architecture", tags=["project"])

    # Semantic — searching for "AI assistant" should find the AI/Atlas entries,
    # not the dog one, even though the words don't overlap.
    results = await backend.search("AI assistant", limit=3)
    assert len(results) >= 1
    top_content = results[0].content.lower()
    assert "atlas" in top_content or "ai" in top_content


@pytest.mark.asyncio
async def test_search_empty_returns_empty(backend):
    await backend.initialize()
    results = await backend.search("anything")
    assert results == []


@pytest.mark.asyncio
async def test_user_profile_roundtrip(backend):
    await backend.initialize()
    await backend.update_user_profile("# User\n\n## Identity\nRawan")
    profile = await backend.get_user_profile()
    assert "Rawan" in profile


@pytest.mark.asyncio
async def test_append_and_get_sessions(backend):
    await backend.initialize()
    await backend.append_session("sess-001", {"user": "hi", "assistant": "hello"})
    sessions = await backend.get_recent_sessions(3)
    assert len(sessions) == 1
    assert sessions[0]["entries"][0]["user"] == "hi"
