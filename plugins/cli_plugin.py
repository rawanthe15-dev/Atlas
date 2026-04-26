import asyncio
import sys
from pathlib import Path

from rich.console import Console

from .base import AtlasPlugin


# Locate the project root reliably regardless of where atlas is launched from
ATLAS_ROOT = Path(__file__).resolve().parent.parent


# Block-letter ATLAS logo
ATLAS_ART = [
    "  █████╗ ████████╗██╗      █████╗ ███████╗",
    " ██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝",
    " ███████║   ██║   ██║     ███████║███████╗",
    " ██╔══██║   ██║   ██║     ██╔══██║╚════██║",
    " ██║  ██║   ██║   ███████╗██║  ██║███████║",
    " ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝",
]

ATLAS_ART_ASCII = [
    "    _   _____ _      _    ___ ",
    "   / \\ |_   _| |    / \\  / __|",
    "  / _ \\  | | | |   / _ \\ \\__ \\",
    " / ___ \\ | | | |__/ ___ \\___) ",
    "/_/   \\_\\|_| |____/_/   \\_____/",
]


COMMANDS = {
    "/help":           "Show available commands",
    "/memory":         "Show what Atlas knows about you (USER.md)",
    "/soul":           "Show Atlas's identity (SOUL.md)",
    "/tools":          "List available tools",
    "/sessions":       "List recent conversation sessions",
    "/model <name>":   "Switch model for this session",
    "/version":        "Show Atlas version and commit",
    "/update":         "Pull the latest Atlas from git remote",
    "/clear":          "Clear the screen",
    "/exit":           "Exit Atlas",
}


def _is_utf8() -> bool:
    try:
        enc = (sys.stdout.encoding or "").lower().replace("-", "")
        return enc in ("utf8",)
    except Exception:
        return False


class CLIPlugin(AtlasPlugin):
    name = "cli"

    def __init__(self):
        self._console = Console(highlight=False)
        self._kernel = None
        self._running = False

    async def load(self, kernel) -> None:
        self._kernel = kernel
        self._running = True
        await self._run()

    async def unload(self) -> None:
        self._running = False

    # ── rendering helpers ──────────────────────────────────────────────────

    def _p(self, text: str = "", style: str = "") -> None:
        self._console.print(text, style=style, end="\n")

    async def stream_token(self, token: str) -> None:
        self._console.print(token, end="", highlight=False)

    async def show_tool_call(self, tool_name: str) -> None:
        self._console.print(f"\n[dim]\\[calling: {tool_name}...][/dim]")

    # ── animated startup ───────────────────────────────────────────────────

    async def _render_startup(self) -> None:
        art = ATLAS_ART if _is_utf8() else ATLAS_ART_ASCII
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        model = self._kernel.config.get("openrouter", {}).get("default_model", "unknown")

        self._console.print()

        # Reveal the logo line by line with a soft cyan gradient
        gradient = ["cyan", "bright_cyan", "cyan", "bright_blue", "blue", "blue"]
        for line, color in zip(art, gradient):
            self._console.print(line, style=f"bold {color}")
            await asyncio.sleep(0.04)

        # Tagline appears after a small pause
        await asyncio.sleep(0.1)
        self._console.print()
        self._console.print("          your second brain", style="dim italic")
        await asyncio.sleep(0.05)
        self._console.print(f"          v{version}  ·  {model}", style="dim")

        # Brief "booting" pulse, then prompt is ready
        await asyncio.sleep(0.15)
        with self._console.status("[dim]booting...[/dim]", spinner="dots"):
            await asyncio.sleep(0.4)

        self._console.print()

    # ── command handling ───────────────────────────────────────────────────

    async def _handle_command(self, raw: str) -> bool:
        parts = raw.strip().split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if cmd == "/help":
            self._p()
            for c, d in COMMANDS.items():
                self._p(f"  [bold cyan]{c:<18}[/bold cyan] [dim]{d}[/dim]")
            self._p()
            return True

        if cmd == "/memory":
            profile = await self._kernel.memory.get_user_profile()
            self._p(profile if profile.strip() else "[dim](no user profile yet)[/dim]")
            return True

        if cmd == "/soul":
            soul = await self._kernel.memory.get_soul()
            self._p(soul)
            return True

        if cmd == "/tools":
            tools = self._kernel.get_plugin("tools").all()
            self._p()
            for t in tools:
                self._p(f"  [bold cyan]{t.name:<14}[/bold cyan] [dim]{t.description}[/dim]")
            self._p()
            return True

        if cmd == "/model":
            if arg:
                self._kernel.get_plugin("agent").set_model(arg)
                self._p(f"[green]✓ model switched to:[/green] {arg}")
            else:
                self._p("[dim]usage: /model <model-name>[/dim]")
            return True

        if cmd == "/sessions":
            sessions = await self._kernel.memory.get_recent_sessions(10)
            if not sessions:
                self._p("[dim](no sessions yet)[/dim]")
                return True
            self._p()
            for s in sessions:
                count = len(s.get("entries", []))
                plural = "s" if count != 1 else ""
                self._p(f"  [bold cyan]{s['file']}[/bold cyan]  [dim]{count} exchange{plural}[/dim]")
            self._p()
            return True

        if cmd == "/version":
            await self._show_version()
            return True

        if cmd == "/update":
            await self._update_atlas()
            return True

        if cmd == "/clear":
            self._console.clear()
            await self._render_startup()
            return True

        if cmd == "/exit":
            self._running = False
            self._p("\n[dim]atlas signing off.[/dim]\n")
            return True

        return False

    # ── version / update ───────────────────────────────────────────────────

    async def _show_version(self) -> None:
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        commit = await self._git("rev-parse --short HEAD")
        branch = await self._git("rev-parse --abbrev-ref HEAD")
        self._p()
        self._p(f"  [bold]atlas[/bold]   v{version}")
        if commit:
            self._p(f"  [dim]commit  {commit}[/dim]")
        if branch:
            self._p(f"  [dim]branch  {branch}[/dim]")
        self._p(f"  [dim]path    {ATLAS_ROOT}[/dim]")
        self._p()

    async def _update_atlas(self) -> None:
        """Pull the latest Atlas from the configured git remote."""
        in_repo = await self._git("rev-parse --is-inside-work-tree")
        if in_repo != "true":
            self._p("[red]✗ not a git repository — can't update.[/red]")
            return

        remotes = await self._git("remote")
        if not remotes:
            self._p("[yellow]⚠  no git remote configured.[/yellow]")
            self._p("[dim]   add one with: git remote add origin <url>[/dim]")
            return

        with self._console.status("[dim]checking for updates...[/dim]", spinner="dots"):
            await self._git("fetch")
            local = await self._git("rev-parse HEAD")
            remote = await self._git("rev-parse @{u}")

        if not remote:
            self._p("[yellow]⚠  no upstream branch set.[/yellow]")
            self._p("[dim]   push first: git push -u origin <branch>[/dim]")
            return

        if local == remote:
            self._p("[green]✓ atlas is up to date.[/green]")
            return

        log = await self._git(f"log --oneline {local}..{remote}")
        self._p()
        self._p("[bold]incoming changes:[/bold]")
        for line in log.splitlines():
            self._p(f"  [dim]{line}[/dim]")
        self._p()

        with self._console.status("[dim]pulling...[/dim]", spinner="dots"):
            result = await self._git_capture("pull --rebase --autostash")

        if result["returncode"] != 0:
            err = result["stderr"] or result["stdout"]
            self._p(f"[red]✗ update failed:[/red]\n{err}")
            return

        self._p("[green]✓ updated. restart atlas to load new code.[/green]")
        self._p("[dim]  exit with /exit and run `atlas` again.[/dim]")

    async def _git(self, args: str) -> str:
        """Run a git command, return trimmed stdout (empty string on error)."""
        result = await self._git_capture(args)
        if result["returncode"] != 0:
            return ""
        return result["stdout"].strip()

    async def _git_capture(self, args: str) -> dict:
        """Run a git command, return {returncode, stdout, stderr}."""
        try:
            proc = await asyncio.create_subprocess_shell(
                f"git {args}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(ATLAS_ROOT),
            )
            stdout, stderr = await proc.communicate()
            return {
                "returncode": proc.returncode,
                "stdout": stdout.decode(errors="replace"),
                "stderr": stderr.decode(errors="replace"),
            }
        except Exception as e:
            return {"returncode": 1, "stdout": "", "stderr": str(e)}

    # ── input ─────────────────────────────────────────────────────────────

    async def _get_input(self):
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, lambda: input("◈ atlas › "))
        except EOFError:
            return None
        except KeyboardInterrupt:
            self._p()
            return ""

    # ── main loop ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        await self._render_startup()
        agent = self._kernel.get_plugin("agent")

        while self._running:
            user_input = await self._get_input()

            if user_input is None:  # EOF / Ctrl+D
                self._p("\n[dim]atlas signing off.[/dim]")
                break

            if not user_input.strip():
                continue

            if user_input.startswith("/"):
                handled = await self._handle_command(user_input)
                if not handled:
                    self._p(f"[dim red]unknown command. type /help for a list.[/dim red]")
                continue

            self._p()
            try:
                await agent.process(
                    user_input,
                    on_token=self.stream_token,
                    on_tool_call=self.show_tool_call,
                )
            except Exception as e:
                self._p(f"\n[bold red][error: {e}][/bold red]")

            self._p("\n")
