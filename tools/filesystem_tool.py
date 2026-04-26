from pathlib import Path
from .base import Tool

# Cap file reads to keep context windows safe.
DEFAULT_MAX_CHARS = 8000


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

    def __init__(self, max_chars: int = DEFAULT_MAX_CHARS):
        self._max_chars = max_chars

    async def run(self, path: str, max_lines: int = 200) -> str:
        try:
            p = Path(path)
            if not p.exists():
                return f"File not found: {path}"
            text = p.read_text(encoding="utf-8", errors="replace")
            lines = text.splitlines()
            total_lines = len(lines)

            if total_lines > max_lines:
                text = "\n".join(lines[:max_lines]) + f"\n... ({total_lines} total lines, truncated by max_lines)"

            if len(text) > self._max_chars:
                head = text[: self._max_chars - 200]
                tail = text[-200:]
                omitted = len(text) - self._max_chars
                text = f"{head}\n... ({omitted} chars truncated) ...\n{tail}"

            return text
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
