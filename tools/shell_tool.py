import asyncio
from typing import Awaitable, Callable, Optional, Union

from .base import Tool

# Default cap on tool output. Anything longer is truncated with a summary line
# so we never blow the context window on a noisy command.
DEFAULT_MAX_OUTPUT_CHARS = 4000


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit - 200]
    tail = text[-200:]
    omitted = len(text) - limit
    return f"{head}\n... ({omitted} chars truncated) ...\n{tail}"


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

    def __init__(
        self,
        confirm: Optional[Callable[[str], Union[bool, Awaitable[bool]]]] = None,
        max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS,
    ):
        # confirm is an optional async callable: command -> bool. When provided,
        # the user is asked before each shell exec. CLI plugin sets this.
        self._confirm = confirm
        self._max_chars = max_output_chars

    def set_confirm(self, fn: Optional[Callable[[str], Union[bool, Awaitable[bool]]]]) -> None:
        """Allow the CLI plugin to install a confirm callback after construction."""
        self._confirm = fn

    async def run(self, command: str, timeout: int = 30) -> str:
        if self._confirm is not None:
            try:
                result = self._confirm(command)
                allowed = await result if asyncio.iscoroutine(result) else result
            except Exception:
                allowed = False
            if not allowed:
                return "User declined to run the command."

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out = stdout.decode(errors="replace").strip()
            err = stderr.decode(errors="replace").strip()

            combined = ""
            if err and not out:
                combined = f"stderr: {err}"
            elif err:
                combined = f"{out}\nstderr: {err}"
            else:
                combined = out or "(no output)"

            return _truncate(combined, self._max_chars)
        except asyncio.TimeoutError:
            return f"Command timed out after {timeout}s"
        except Exception as e:
            return f"Error: {e}"
