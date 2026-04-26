import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

from rich.console import Console
from rich.rule import Rule

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.styles import Style

try:
    import tomllib  # py311+
except ImportError:
    import tomli as tomllib  # type: ignore

import tomli_w

from .base import AtlasPlugin


# Locate the project root so commands work from any cwd
ATLAS_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ATLAS_ROOT / "config.toml"


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
    "/help":         "Show available commands",
    "/config":       "Edit settings, API keys, persona",
    "/memory":       "Show what Atlas knows about you (USER.md)",
    "/soul":         "Show Atlas's identity (SOUL.md)",
    "/tools":        "List available tools",
    "/sessions":     "List recent conversation sessions",
    "/model":        "Switch model — usage: /model <name>",
    "/version":      "Show Atlas version and commit",
    "/update":       "Pull the latest Atlas from git remote",
    "/clear":        "Clear the screen",
    "/exit":         "Exit Atlas",
}


PROMPT_STYLE = Style.from_dict({
    "prompt-symbol":     "ansicyan bold",
    "prompt-name":       "bold",
    "prompt-arrow":      "ansibrightblack",
    "completion-menu.completion":          "bg:#1a1a1a #cccccc",
    "completion-menu.completion.current":  "bg:#0078d4 #ffffff bold",
    "completion-menu.meta.completion":     "bg:#1a1a1a #888888",
    "completion-menu.meta.completion.current": "bg:#0078d4 #ffffff",
    "bottom-toolbar":    "bg:#1a1a1a #888888",
    "bottom-toolbar.text": "#888888",
    "bottom-toolbar.accent": "ansicyan",
})


def _is_utf8() -> bool:
    try:
        enc = (sys.stdout.encoding or "").lower().replace("-", "")
        return enc in ("utf8",)
    except Exception:
        return False


class SlashCompleter(Completer):
    """Pop the command list as soon as the user types '/'"""

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return
        for full_cmd, desc in COMMANDS.items():
            cmd = full_cmd.split()[0]
            if cmd.startswith(text):
                yield Completion(
                    cmd,
                    start_position=-len(text),
                    display=cmd,
                    display_meta=desc,
                )


class CLIPlugin(AtlasPlugin):
    name = "cli"

    def __init__(self):
        self._console = Console(highlight=False)
        self._kernel = None
        self._running = False
        self._session: Optional[PromptSession] = None

    async def load(self, kernel) -> None:
        self._kernel = kernel
        self._running = True
        self._session = PromptSession(
            history=InMemoryHistory(),
            completer=SlashCompleter(),
            complete_while_typing=True,
            multiline=False,
            bottom_toolbar=self._toolbar,
            style=PROMPT_STYLE,
            mouse_support=False,
        )
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

    def _toolbar(self):
        cfg = self._kernel.config.get("openrouter", {})
        model = cfg.get("default_model", "?")
        agent = self._kernel.get_plugin("agent")
        n = len(agent._history) // 2
        api_ok = "●" if cfg.get("api_key") else "○"
        return HTML(
            f" <b>atlas</b>  <ansicyan>{api_ok}</ansicyan> {model}  ·  "
            f"{n} exchange{'s' if n != 1 else ''}  ·  "
            f"<ansibrightblack>type / for commands</ansibrightblack> "
        )

    # ── animated startup ───────────────────────────────────────────────────

    async def _render_startup(self) -> None:
        art = ATLAS_ART if _is_utf8() else ATLAS_ART_ASCII
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        model = self._kernel.config.get("openrouter", {}).get("default_model", "unknown")
        api_key = self._kernel.config.get("openrouter", {}).get("api_key", "")

        self._console.print()
        gradient = ["cyan", "bright_cyan", "cyan", "bright_blue", "blue", "blue"]
        for line, color in zip(art, gradient):
            self._console.print(line, style=f"bold {color}")
            await asyncio.sleep(0.04)

        await asyncio.sleep(0.1)
        self._console.print()
        self._console.print("          your second brain", style="dim italic")
        self._console.print(f"          v{version}  ·  {model}", style="dim")

        if not api_key:
            self._console.print()
            self._console.print(
                "          [yellow]⚠  no openrouter key — type /config to set one[/yellow]"
            )

        await asyncio.sleep(0.15)
        with self._console.status("[dim]booting...[/dim]", spinner="dots"):
            await asyncio.sleep(0.4)

        self._console.print()
        self._console.print(Rule(style="bright_black"))
        self._console.print()

    # ── command handling ───────────────────────────────────────────────────

    async def _handle_command(self, raw: str) -> bool:
        parts = raw.strip().split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if cmd == "/help":
            self._p()
            for c, d in COMMANDS.items():
                self._p(f"  [bold cyan]{c:<12}[/bold cyan] [dim]{d}[/dim]")
            self._p()
            return True

        if cmd == "/config":
            await self._handle_config()
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
                self._save_config_key("openrouter", "default_model", arg)
                self._p(f"[green]✓ model:[/green] {arg}")
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
            self._p("[dim]atlas signing off.[/dim]")
            return True

        return False

    # ── /config interactive ────────────────────────────────────────────────

    async def _handle_config(self) -> None:
        options = [
            ("openrouter_key",  "Set OpenRouter API key"),
            ("default_model",   "Set default model"),
            ("brave_key",       "Set Brave Search API key"),
            ("edit_soul",       "Edit SOUL.md (Atlas's persona)"),
            ("edit_user",       "Edit USER.md (what Atlas knows about you)"),
            ("reset_user",      "Reset USER.md"),
            ("show_config",     "Show current config"),
            ("back",            "Back to chat"),
        ]

        self._p()
        self._p("[bold]config[/bold]")
        for i, (_, desc) in enumerate(options, 1):
            self._p(f"  [bold cyan]{i:>2}[/bold cyan]  {desc}")
        self._p()

        try:
            choice = await self._prompt(HTML("<ansicyan>?</ansicyan> select › "))
        except (KeyboardInterrupt, EOFError):
            return
        if not choice:
            return

        try:
            idx = int(choice.strip()) - 1
            if not (0 <= idx < len(options)):
                raise ValueError
        except ValueError:
            self._p("[dim red]invalid choice[/dim red]")
            return

        action = options[idx][0]

        if action == "back":
            return

        if action == "openrouter_key":
            new_key = await self._prompt(
                HTML("<ansicyan>?</ansicyan> openrouter api key › "),
                is_password=True,
            )
            if new_key and new_key.strip():
                self._save_config_key("openrouter", "api_key", new_key.strip())
                self._kernel.config["openrouter"]["api_key"] = new_key.strip()
                self._kernel.get_plugin("agent")._api_key = new_key.strip()
                self._p("[green]✓ key saved[/green]")

        elif action == "default_model":
            current = self._kernel.config.get("openrouter", {}).get("default_model", "")
            new_model = await self._prompt(
                HTML(f"<ansicyan>?</ansicyan> model name (current: {current}) › "),
            )
            if new_model and new_model.strip():
                model = new_model.strip()
                self._save_config_key("openrouter", "default_model", model)
                self._kernel.config["openrouter"]["default_model"] = model
                self._kernel.get_plugin("agent").set_model(model)
                self._p(f"[green]✓ model:[/green] {model}")

        elif action == "brave_key":
            new_key = await self._prompt(
                HTML("<ansicyan>?</ansicyan> brave search api key › "),
                is_password=True,
            )
            if new_key and new_key.strip():
                self._save_config_key("tools", "brave_api_key", new_key.strip())
                self._p("[green]✓ key saved (restart atlas to apply)[/green]")

        elif action == "edit_soul":
            await self._open_in_editor(ATLAS_ROOT / "memory" / "SOUL.md")

        elif action == "edit_user":
            await self._open_in_editor(ATLAS_ROOT / "memory" / "USER.md")

        elif action == "reset_user":
            confirm = await self._prompt(
                HTML("<ansicyan>?</ansicyan> reset USER.md? type <b>yes</b> › "),
            )
            if confirm and confirm.strip().lower() == "yes":
                await self._kernel.memory.update_user_profile(
                    "# User Profile\n\n## Identity\n\n## Preferences\n\n"
                    "## Projects\n\n## Patterns\n\n## Context\n"
                )
                self._p("[green]✓ USER.md reset[/green]")

        elif action == "show_config":
            self._p()
            cfg = self._kernel.config
            opts = [
                ("model", cfg.get("openrouter", {}).get("default_model", "—")),
                ("api key", "set" if cfg.get("openrouter", {}).get("api_key") else "[red]not set[/red]"),
                ("brave key", "set" if cfg.get("tools", {}).get("brave_api_key") else "—"),
                ("memory backend", cfg.get("memory", {}).get("backend", "—")),
                ("memory path", cfg.get("memory", {}).get("path", "—")),
            ]
            for label, val in opts:
                self._p(f"  [dim]{label:<16}[/dim] {val}")
            self._p()

    async def _prompt(self, text, is_password=False) -> str:
        try:
            result = await self._session.prompt_async(text, is_password=is_password)
            return result or ""
        except (KeyboardInterrupt, EOFError):
            return ""

    async def _open_in_editor(self, path: Path) -> None:
        editor = os.environ.get("EDITOR", "nano")
        self._p(f"[dim]opening {path.name} in {editor}...[/dim]")
        proc = await asyncio.create_subprocess_shell(f'{editor} "{path}"')
        await proc.wait()
        self._p(f"[green]✓ closed editor[/green]")

    def _save_config_key(self, section: str, key: str, value: str) -> None:
        """Persist a value to config.toml, creating the file if missing."""
        if CONFIG_PATH.exists():
            with open(CONFIG_PATH, "rb") as f:
                cfg = tomllib.load(f)
        else:
            cfg = {}
        cfg.setdefault(section, {})[key] = value
        with open(CONFIG_PATH, "wb") as f:
            tomli_w.dump(cfg, f)

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
            self._p("[dim]   push first: git push -u origin main[/dim]")
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

        self._p("[green]✓ updated. restart atlas (/exit then `atlas`) to load new code.[/green]")

    async def _git(self, args: str) -> str:
        result = await self._git_capture(args)
        if result["returncode"] != 0:
            return ""
        return result["stdout"].strip()

    async def _git_capture(self, args: str) -> dict:
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
        try:
            return await self._session.prompt_async(
                HTML(
                    '<style fg="ansicyan" bold="true">◈</style> '
                    '<style bold="true">atlas</style> '
                    '<style fg="ansibrightblack">›</style> '
                ),
            )
        except EOFError:
            return None
        except KeyboardInterrupt:
            return ""

    # ── main loop ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        await self._render_startup()
        agent = self._kernel.get_plugin("agent")

        while self._running:
            user_input = await self._get_input()

            if user_input is None:
                self._p("[dim]atlas signing off.[/dim]")
                break

            if not user_input.strip():
                continue

            if user_input.startswith("/"):
                handled = await self._handle_command(user_input)
                if not handled:
                    self._p(f"[dim red]unknown command. type /help for a list.[/dim red]")
                continue

            # Tight spacing: one blank line between user and assistant blocks
            self._p()
            try:
                with patch_stdout():
                    await agent.process(
                        user_input,
                        on_token=self.stream_token,
                        on_tool_call=self.show_tool_call,
                    )
            except Exception as e:
                self._p(f"\n[bold red][error: {e}][/bold red]")

            self._p()  # one trailing blank line, not two
