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
