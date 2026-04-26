import asyncio
import sys

from rich.console import Console

from .base import AtlasPlugin

ATLAS_ART = r"""
                    ◈
                   /|\
                  / | \
                 /  |  \
                ◈──────◈
               /|  ◈   |\
              / |  |   | \
             ◈──────────◈
                  |||
"""

ATLAS_ART_ASCII = r"""
        /\
       /  \
      / /\ \
     /_/  \_\
      ATLAS
"""

COMMANDS = {
    "/help": "Show available commands",
    "/memory": "Show what Atlas knows about you",
    "/soul": "Show Atlas's identity",
    "/tools": "List available tools",
    "/model <name>": "Switch model for this session",
    "/clear": "Clear the screen",
    "/exit": "Exit Atlas",
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

    # ── startup ────────────────────────────────────────────────────────────

    async def _render_startup(self) -> None:
        art = ATLAS_ART if _is_utf8() else ATLAS_ART_ASCII
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        model = self._kernel.config.get("openrouter", {}).get("default_model", "unknown")
        self._console.print(art, style="bold cyan", end="")
        self._console.print("         A  T  L  A  S", style="bold white")
        self._console.print("         your second brain", style="dim")
        self._console.print(f"         v{version}  ·  {model}\n", style="dim")

    # ── command handling ───────────────────────────────────────────────────

    async def _handle_command(self, raw: str) -> bool:
        parts = raw.strip().split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if cmd == "/help":
            for c, d in COMMANDS.items():
                self._p(f"  [bold]{c:<22}[/bold] [dim]{d}[/dim]")
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
            for t in tools:
                self._p(f"  [bold]{t.name:<20}[/bold] [dim]{t.description}[/dim]")
            return True

        if cmd == "/model":
            if arg:
                self._kernel.get_plugin("agent").set_model(arg)
                self._p(f"[green]Model switched to: {arg}[/green]")
            else:
                self._p("[dim]Usage: /model <model-name>[/dim]")
            return True

        if cmd == "/clear":
            self._console.clear()
            await self._render_startup()
            return True

        if cmd == "/exit":
            self._running = False
            self._p("\n[dim]Atlas signing off.[/dim]\n")
            return True

        return False

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
                self._p("\n[dim]Atlas signing off.[/dim]")
                break

            if not user_input.strip():
                continue

            if user_input.startswith("/"):
                handled = await self._handle_command(user_input)
                if not handled:
                    self._p(f"[dim red]Unknown command. Type /help for a list.[/dim red]")
                continue

            self._p()
            try:
                await agent.process(
                    user_input,
                    on_token=self.stream_token,
                    on_tool_call=self.show_tool_call,
                )
            except Exception as e:
                self._p(f"\n[bold red][Error: {e}][/bold red]")

            self._p("\n")
