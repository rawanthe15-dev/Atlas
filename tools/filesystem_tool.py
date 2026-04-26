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
