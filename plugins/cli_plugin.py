from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional, TextIO, cast

from rich.console import Console

from prompt_toolkit import Application, PromptSession
from prompt_toolkit.application.run_in_terminal import in_terminal
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import FloatContainer, Float, HSplit, Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.patch_stdout import StdoutProxy
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import Frame, TextArea

try:
    import tomllib  # py311+
except ImportError:
    import tomli as tomllib  # type: ignore

import tomli_w

from .base import AtlasPlugin


ATLAS_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ATLAS_ROOT / "config.toml"

# patch_stdout's default sleep_between_writes is 200ms — that bundles tokens into
# visible chunks. 20ms keeps token streaming smooth without thrashing the renderer.
STREAMING_FLUSH_INTERVAL = 0.02

# How often to force-drain the StdoutProxy buffer while a response is in flight.
# Newline-terminated content flushes naturally; this exists for models that
# emit long stretches without newlines, so the user sees progress instead of
# nothing until the next \n arrives.
PARTIAL_FLUSH_INTERVAL = 0.15


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
    "/memory":       "Show what Atlas knows about you",
    "/soul":         "Show Atlas's identity",
    "/tools":        "List available tools",
    "/devices":      "Manage connected devices and MCP servers",
    "/sessions":     "List recent conversation sessions",
    "/model":        "Switch model — usage: /model <name>",
    "/version":      "Show Atlas version and commit",
    "/update":       "Pull the latest Atlas from git remote",
    "/clear":        "Clear the screen",
    "/exit":         "Exit Atlas",
}


INPUT_STYLE = Style.from_dict({
    "frame.border":  "ansicyan",
    "frame.label":   "ansicyan bold",

    "toolbar":             "#5a6a7a italic",
    "toolbar.accent":      "ansicyan bold",
    "toolbar.warn":        "ansiyellow",

    "completion-menu":                          "bg:#0d1620",
    "completion-menu.completion":               "bg:#0d1620 #c0d0e0",
    "completion-menu.completion.current":       "bg:ansicyan #000000 bold",
    "completion-menu.meta.completion":          "bg:#0d1620 #5a7a9a italic",
    "completion-menu.meta.completion.current":  "bg:ansicyan #1a3040 italic",
    "completion-menu.multi-column-meta":        "bg:#0d1620 #5a7a9a",

    "scrollbar.background":  "bg:#0d1620",
    "scrollbar.button":      "bg:#3a4a5a",
})


def _is_utf8() -> bool:
    try:
        enc = (sys.stdout.encoding or "").lower().replace("-", "")
        return enc in ("utf8",)
    except Exception:
        return False


DEFAULT_FAVORITES = [
    "deepseek/deepseek-chat",
    "deepseek/deepseek-r1",
    "anthropic/claude-sonnet-4-5",
]


class SlashCompleter(Completer):
    """Pop the command list when the user types '/', suggest favorite models for /model."""

    def __init__(self, favorites_getter=None, current_model_getter=None):
        self._favorites = favorites_getter or (lambda: [])
        self._current_model = current_model_getter or (lambda: "")

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return

        if text.startswith("/model "):
            arg = text[len("/model "):]
            current = self._current_model()
            for model in self._favorites():
                if not model:
                    continue
                if model.startswith(arg):
                    meta = "current" if model == current else "favorite"
                    yield Completion(
                        model,
                        start_position=-len(arg),
                        display=model,
                        display_meta=meta,
                    )
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
        self._history = InMemoryHistory()
        self._completer = SlashCompleter(
            favorites_getter=self._get_favorite_models,
            current_model_getter=self._get_current_model,
        )

        self._app: Optional[Application] = None
        self._text_area: Optional[TextArea] = None
        self._input_queue: Optional[asyncio.Queue] = None
        self._processor_task: Optional[asyncio.Task] = None
        self._current_process_task: Optional[asyncio.Task] = None
        self._is_processing = False

        self._showed_thinking_header = False
        self._showed_response_header = False
        self._response_buffer = ""

    # ── favorites accessors ───────────────────────────────────────────────

    def _get_favorite_models(self) -> list:
        if self._kernel is None:
            return list(DEFAULT_FAVORITES)
        favs = self._kernel.config.get("openrouter", {}).get("favorite_models")
        if not favs:
            favs = list(DEFAULT_FAVORITES)
        return favs

    def _get_current_model(self) -> str:
        if self._kernel is None:
            return ""
        return self._kernel.config.get("openrouter", {}).get("default_model", "")

    async def load(self, kernel) -> None:
        self._kernel = kernel
        self._running = True
        self._input_queue = asyncio.Queue()

        shell_confirm = kernel.config.get("tools", {}).get("shell_confirm", True)
        if shell_confirm:
            shell_tool = kernel.get_plugin("tools").get("shell")
            if shell_tool and hasattr(shell_tool, "set_confirm"):
                shell_tool.set_confirm(self._confirm_shell)

        # Wire user-confirmation for installing MCP servers.
        try:
            devices_plugin = kernel.get_plugin("devices")
            devices_plugin.set_install_confirm(self._confirm_install)
        except KeyError:
            pass  # devices plugin not loaded — fine

        # Banner uses asyncio.sleep / rich spinners — print it before the
        # persistent app takes over the terminal.
        await self._render_startup()

        self._app = self._build_persistent_app()
        self._processor_task = asyncio.create_task(self._processor_loop())

        try:
            await self._app.run_async()
        except (EOFError, KeyboardInterrupt):
            pass
        finally:
            self._running = False
            if self._processor_task and not self._processor_task.done():
                self._processor_task.cancel()
                try:
                    await self._processor_task
                except (asyncio.CancelledError, Exception):
                    pass

    async def unload(self) -> None:
        self._running = False
        if self._app and self._app.is_running:
            self._app.exit()

    # ── rendering helpers ──────────────────────────────────────────────────

    def _p(self, text: str = "", style: str = "") -> None:
        self._console.print(text, style=style, end="\n")

    async def stream_reasoning(self, token: str) -> None:
        """Stream thinking/reasoning tokens in dim grey.
        Re-applies the dim ANSI on every chunk because rich's tool-call print
        between rounds resets SGR — without this re-apply, the second round
        of reasoning shows up in default color.

        We deliberately don't `flush()` mid-line. patch_stdout flushes on
        every newline naturally; forcing a flush mid-line leaves the cursor
        mid-row and then the input frame redraws on top of the partial token,
        which is what produced text-on-the-border artifacts."""
        if not self._showed_thinking_header:
            sys.stdout.write("\n\033[2m✦ thinking\n")
            self._showed_thinking_header = True
        sys.stdout.write("\033[2m" + token)
        await asyncio.sleep(0)

    async def stream_token(self, token: str) -> None:
        if self._showed_thinking_header and not self._showed_response_header:
            sys.stdout.write("\033[0m\n\n")
            self._showed_response_header = True
        self._response_buffer += token
        sys.stdout.write(token)
        await asyncio.sleep(0)

    async def show_tool_call(self, tool_name: str) -> None:
        # Force any in-flight buffered tokens to settle as a newline-terminated
        # line before the tool-call notification appears.
        sys.stdout.write("\033[0m\n")
        self._console.print(f"[dim]\\[calling: {tool_name}...][/dim]")

    # ── banners ────────────────────────────────────────────────────────────

    async def _render_banner_static(self) -> None:
        """Plain non-animated banner — safe to call while the persistent
        Application is running (no asyncio.sleep, no rich.status spinner)."""
        art = ATLAS_ART if _is_utf8() else ATLAS_ART_ASCII
        version = self._kernel.config.get("atlas", {}).get("version", "0.1.0")
        model = self._kernel.config.get("openrouter", {}).get("default_model", "unknown")

        gradient = ["cyan", "bright_cyan", "cyan", "bright_blue", "blue", "blue"]
        self._console.print()
        for line, color in zip(art, gradient):
            self._console.print(line, style=f"bold {color}")
        self._console.print()
        self._console.print("          your second brain", style="dim italic")
        self._console.print(f"          v{version}  ·  {model}\n", style="dim")

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

    # ── persistent input box ──────────────────────────────────────────────

    def _toolbar_text(self):
        cfg = self._kernel.config.get("openrouter", {})
        model = cfg.get("default_model", "?")
        agent = self._kernel.get_plugin("agent")
        n = len(agent._history) // 2
        api_set = bool(cfg.get("api_key"))
        dot = ("class:toolbar.accent", "●") if api_set else ("class:toolbar.warn", "○")

        if self._is_processing:
            tail = [
                ("class:toolbar.accent", "thinking…"),
                ("class:toolbar", "  ·  press "),
                ("class:toolbar.accent", "esc"),
                ("class:toolbar", " to interrupt"),
            ]
        else:
            tail = [
                ("class:toolbar", f"{n} exchange{'s' if n != 1 else ''}"),
                ("class:toolbar", "  ·  type "),
                ("class:toolbar.accent", "/"),
                ("class:toolbar", " for commands  ·  "),
                ("class:toolbar.accent", "alt+enter"),
                ("class:toolbar", " for newline"),
            ]

        return [
            ("class:toolbar", "  "),
            dot,
            ("class:toolbar", f"  {model}  ·  "),
            *tail,
        ]

    def _on_accept(self, buff) -> bool:
        text = buff.text
        if text.strip():
            self._input_queue.put_nowait(text)
        buff.reset()
        return False  # keep the application running

    def _build_persistent_app(self) -> Application:
        """Long-lived Application that owns the input box.
        Stays mounted across turns so the prompt never disappears while
        Atlas streams a response above it."""
        text_area = TextArea(
            multiline=True,
            wrap_lines=True,
            history=self._history,
            completer=self._completer,
            complete_while_typing=True,
            accept_handler=self._on_accept,
            scrollbar=False,
            prompt="◈ ",
            height=Dimension(min=1, max=8, preferred=1),
        )
        self._text_area = text_area

        kb = KeyBindings()

        @kb.add("enter")
        def _(event):
            event.current_buffer.validate_and_handle()

        @kb.add("escape", "enter")
        def _(event):
            event.current_buffer.insert_text("\n")

        # Esc alone — interrupt streaming when one is in flight. Don't use
        # eager=True or escape+enter would never match (ptk waits a beat for
        # the next key).
        @kb.add("escape")
        def _(event):
            if (
                self._is_processing
                and self._current_process_task
                and not self._current_process_task.done()
            ):
                self._current_process_task.cancel()

        @kb.add("c-c")
        def _(event):
            if (
                self._is_processing
                and self._current_process_task
                and not self._current_process_task.done()
            ):
                self._current_process_task.cancel()
            elif text_area.text:
                text_area.buffer.reset()
            else:
                self._running = False
                event.app.exit()

        @kb.add("c-d")
        def _(event):
            if not text_area.text:
                self._running = False
                event.app.exit()

        layout = Layout(
            FloatContainer(
                content=HSplit([
                    Frame(body=text_area, style="class:frame"),
                    Window(
                        content=FormattedTextControl(self._toolbar_text),
                        height=Dimension.exact(1),
                        style="class:toolbar",
                    ),
                ]),
                floats=[
                    Float(
                        xcursor=True,
                        ycursor=True,
                        content=CompletionsMenu(max_height=12, scroll_offset=2),
                    )
                ],
            ),
            focused_element=text_area,
        )

        return Application(
            layout=layout,
            key_bindings=kb,
            style=INPUT_STYLE,
            mouse_support=False,
            full_screen=False,
        )

    # ── streaming helpers ─────────────────────────────────────────────────

    async def _partial_flush_pump(self) -> None:
        """Force-drain the StdoutProxy buffer every PARTIAL_FLUSH_INTERVAL.

        StdoutProxy only auto-flushes on newline. For models that emit long
        runs of text without newlines, the buffer can sit unrendered for the
        full response. This pump nudges any partial-line content to the
        terminal so the user sees progress.

        Trade-off: each partial flush gets rendered as its own row (run_in_terminal
        appends \\r\\n after each call), so a slow no-newline stream looks
        slightly fragmented. Newline-terminated streams are unaffected because
        the buffer is empty by the time the pump fires."""
        try:
            while self._is_processing:
                await asyncio.sleep(PARTIAL_FLUSH_INTERVAL)
                if not self._is_processing:
                    break
                try:
                    sys.stdout.flush()
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    # ── processor (drains the input queue) ─────────────────────────────────

    async def _processor_loop(self) -> None:
        """Drain submitted inputs. While this runs, sys.stdout is wrapped in
        a StdoutProxy so prints/streams appear above the persistent input
        box. The proxy uses a 20ms flush cadence (vs the 200ms default) so
        per-token streaming actually feels live for streaming-capable models."""
        agent = self._kernel.get_plugin("agent")

        proxy = StdoutProxy(sleep_between_writes=STREAMING_FLUSH_INTERVAL, raw=True)
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        sys.stdout = cast(TextIO, proxy)
        sys.stderr = cast(TextIO, proxy)

        try:
            while self._running:
                try:
                    user_input = await asyncio.wait_for(
                        self._input_queue.get(), timeout=0.5
                    )
                except asyncio.TimeoutError:
                    continue
                except asyncio.CancelledError:
                    break

                self._console.print(f"\n[bold cyan]›[/bold cyan] {user_input}")

                if user_input.startswith("/"):
                    try:
                        handled = await self._handle_command(user_input)
                        if not handled:
                            self._p("[dim red]unknown command. type /help[/dim red]")
                    except Exception as e:
                        self._p(f"[bold red]command error: {e}[/bold red]")
                    continue

                self._is_processing = True
                if self._app:
                    self._app.invalidate()  # refresh toolbar to show "thinking…"

                self._showed_thinking_header = False
                self._showed_response_header = False
                self._response_buffer = ""
                self._p()

                flush_pump = asyncio.create_task(self._partial_flush_pump())

                self._current_process_task = asyncio.create_task(
                    agent.process(
                        user_input,
                        on_token=self.stream_token,
                        on_tool_call=self.show_tool_call,
                        on_reasoning=self.stream_reasoning,
                    )
                )
                try:
                    await self._current_process_task
                except asyncio.CancelledError:
                    # `\033[0m\n` ends any in-flight dim/partial line before
                    # rich.print runs — without the trailing newline, partial
                    # tokens stay buffered in the StdoutProxy.
                    sys.stdout.write("\033[0m\n")
                    self._p("[dim][interrupted][/dim]")
                except Exception as e:
                    sys.stdout.write("\033[0m\n")
                    self._p(f"[dim red][error: {e}][/dim red]")
                finally:
                    self._is_processing = False
                    self._current_process_task = None
                    flush_pump.cancel()
                    try:
                        await flush_pump
                    except (asyncio.CancelledError, Exception):
                        pass
                    if self._app:
                        self._app.invalidate()

                # Reset any lingering SGR and end on a blank line. The trailing
                # \n triggers the proxy's newline-based flush, so we don't
                # need an explicit flush() here (that would push partial-line
                # content and confuse the input redraw).
                sys.stdout.write("\033[0m\n")
                self._p()
        finally:
            sys.stdout = original_stdout
            sys.stderr = original_stderr
            proxy.close()

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
            # Sub-prompts need stdin — suspend live rendering.
            async with in_terminal():
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
                self._kernel.config["openrouter"]["default_model"] = arg
                self._p(f"[green]✓ model:[/green] {arg}")
            else:
                async with in_terminal():
                    await self._pick_model_interactive()
            return True

        if cmd == "/devices":
            async with in_terminal():
                await self._handle_devices(arg)
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
            # Reach in to the renderer instead of console.clear() — clearing
            # via rich corrupts the input-frame width on the next paint.
            if self._app and self._app.renderer:
                self._app.renderer.clear()
            await self._render_banner_static()
            return True

        if cmd == "/exit":
            self._p("[dim]atlas signing off.[/dim]")
            self._running = False
            if self._app and self._app.is_running:
                self._app.exit()
            return True

        return False

    # ── /model interactive picker ──────────────────────────────────────────

    async def _pick_model_interactive(self) -> None:
        favs = self._get_favorite_models()
        current = self._get_current_model()

        self._p()
        self._p("[bold]switch model[/bold]")
        for i, m in enumerate(favs, 1):
            marker = "[green]●[/green]" if m == current else "[bright_black]○[/bright_black]"
            label = m if m else "[dim](empty slot)[/dim]"
            self._p(f"  {marker} [bold cyan]{i}[/bold cyan]  {label}")
        self._p(f"  [bright_black]○[/bright_black] [bold cyan]n[/bold cyan]  use a new model")
        self._p(f"  [bright_black]○[/bright_black] [bold cyan]b[/bold cyan]  back")
        self._p()

        choice = (await self._simple_prompt("pick › ")).strip().lower()
        if not choice or choice == "b":
            return

        if choice == "n":
            new_model = (await self._simple_prompt("new model name › ")).strip()
            if not new_model:
                return
            self._apply_model(new_model)
            return

        try:
            idx = int(choice) - 1
            if not (0 <= idx < len(favs)):
                raise ValueError
            chosen = favs[idx]
            if not chosen:
                self._p("[dim red]that slot is empty — use /config to fill it[/dim red]")
                return
            self._apply_model(chosen)
        except ValueError:
            self._p("[dim red]invalid choice[/dim red]")

    def _apply_model(self, model: str) -> None:
        self._kernel.get_plugin("agent").set_model(model)
        self._save_config_key("openrouter", "default_model", model)
        self._kernel.config["openrouter"]["default_model"] = model
        self._p(f"[green]✓ model:[/green] {model}")

    # ── /devices interactive ──────────────────────────────────────────────

    async def _handle_devices(self, arg: str) -> None:
        try:
            devices = self._kernel.get_plugin("devices")
        except KeyError:
            self._p("[dim red]devices plugin is not loaded[/dim red]")
            return

        # `list` is the default if no sub-command was given.
        sub = (arg or "list").strip().split(maxsplit=1)
        action = sub[0].lower() if sub else "list"
        rest = sub[1] if len(sub) > 1 else ""

        if action in ("ls", "list"):
            self._render_device_list(devices)
            self._p()
            self._p("[dim]/devices search <query>   · find an MCP server[/dim]")
            self._p("[dim]/devices install         · pick one to install + mount[/dim]")
            self._p("[dim]/devices unmount <name>  · disconnect a device[/dim]")
            return

        if action == "unmount":
            name = rest.strip()
            if not name:
                name = (await self._simple_prompt("device name › ")).strip()
            if not name:
                return
            try:
                await devices.unmount(name)
                self._p(f"[green]✓ unmounted {name}[/green]")
            except Exception as e:
                self._p(f"[red]✗ {e}[/red]")
            return

        if action == "search":
            query = rest.strip() or (await self._simple_prompt("search MCP for › ")).strip()
            if not query:
                return
            with self._console.status("[dim]searching MCP registries...[/dim]", spinner="dots"):
                cands = await devices.search_mcp(query, limit=10)
            if not cands:
                self._p("[dim](no MCP servers matched)[/dim]")
                return
            self._render_candidates(cands)
            return

        if action == "install":
            query = rest.strip() or (await self._simple_prompt("search MCP for › ")).strip()
            if not query:
                return
            with self._console.status(f"[dim]searching for '{query}'...[/dim]", spinner="dots"):
                cands = await devices.search_mcp(query, limit=10)
            if not cands:
                self._p("[dim](no MCP servers matched)[/dim]")
                return
            self._render_candidates(cands)
            choice = (await self._simple_prompt("pick number (or b to cancel) › ")).strip().lower()
            if not choice or choice == "b":
                return
            try:
                idx = int(choice) - 1
                if not (0 <= idx < len(cands)):
                    raise ValueError
            except ValueError:
                self._p("[dim red]invalid number[/dim red]")
                return
            cand = cands[idx]
            default_name = cand.name.split("/")[-1].replace("@", "").replace("server-", "")
            name = (await self._simple_prompt(f"local device name [{default_name}] › ")).strip() or default_name
            try:
                record = await devices.install_and_mount_mcp(cand, device_name=name)
                self._p(
                    f"[green]✓ mounted {record.spec.name}[/green] "
                    f"with {len(record.tool_names)} tools"
                )
            except Exception as e:
                self._p(f"[red]✗ {e}[/red]")
            return

        self._p(f"[dim red]unknown /devices subcommand: {action}[/dim red]")

    def _render_device_list(self, devices) -> None:
        records = devices.list()
        self._p()
        if not records:
            self._p("[dim](no devices mounted)[/dim]")
            return
        for r in records:
            caps = ", ".join(r.spec.capabilities) or "—"
            self._p(f"  [bold cyan]{r.spec.name}[/bold cyan] [dim]({r.spec.kind})[/dim]")
            self._p(f"    [dim]capabilities:[/dim] {caps}")
            self._p(f"    [dim]tools:[/dim] {', '.join(r.tool_names) or '(none)'}")

    def _render_candidates(self, cands) -> None:
        self._p()
        for i, c in enumerate(cands, 1):
            self._p(
                f"  [bold cyan]{i:>2}[/bold cyan]  "
                f"[bold]{c.name}[/bold] [dim]({c.source})[/dim]"
            )
            if c.description:
                self._p(f"      [dim]{c.description}[/dim]")
            self._p(f"      [dim]install: {c.install_command}[/dim]")
        self._p()

    # ── /config interactive ────────────────────────────────────────────────

    async def _handle_config(self) -> None:
        options = [
            ("openrouter_key",  "Set OpenRouter API key"),
            ("default_model",   "Set default model"),
            ("favorites",       "Manage favorite models (used by /model autocomplete)"),
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

        choice = await self._simple_prompt("select › ")
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
            new_key = await self._simple_prompt("openrouter api key › ", is_password=True)
            if new_key and new_key.strip():
                self._save_config_key("openrouter", "api_key", new_key.strip())
                self._kernel.config["openrouter"]["api_key"] = new_key.strip()
                self._kernel.get_plugin("agent")._api_key = new_key.strip()
                self._p("[green]✓ key saved[/green]")

        elif action == "default_model":
            current = self._kernel.config.get("openrouter", {}).get("default_model", "")
            new_model = await self._simple_prompt(f"model name (current: {current}) › ")
            if new_model and new_model.strip():
                model = new_model.strip()
                self._save_config_key("openrouter", "default_model", model)
                self._kernel.config["openrouter"]["default_model"] = model
                self._kernel.get_plugin("agent").set_model(model)
                self._p(f"[green]✓ model:[/green] {model}")

        elif action == "favorites":
            await self._manage_favorites()

        elif action == "brave_key":
            new_key = await self._simple_prompt("brave search api key › ", is_password=True)
            if new_key and new_key.strip():
                self._save_config_key("tools", "brave_api_key", new_key.strip())
                self._p("[green]✓ key saved (restart atlas to apply)[/green]")

        elif action == "edit_soul":
            await self._open_in_editor(ATLAS_ROOT / "memory" / "SOUL.md")

        elif action == "edit_user":
            await self._open_in_editor(ATLAS_ROOT / "memory" / "USER.md")

        elif action == "reset_user":
            confirm = await self._simple_prompt("reset USER.md? type yes › ")
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

    async def _manage_favorites(self) -> None:
        favs = list(self._get_favorite_models())
        while len(favs) < 3:
            favs.append("")
        favs = favs[:3]

        while True:
            self._p()
            self._p("[bold]favorite models[/bold] [dim](shown when you type /model <space>)[/dim]")
            for i, m in enumerate(favs, 1):
                label = m if m else "[dim](empty)[/dim]"
                self._p(f"  [bold cyan]{i}[/bold cyan]  {label}")
            self._p()
            self._p("  [bold cyan]1-3[/bold cyan]  edit slot")
            self._p("  [bold cyan]b[/bold cyan]    back")
            self._p()

            choice = (await self._simple_prompt("favorites › ")).strip().lower()
            if not choice or choice == "b":
                break

            try:
                idx = int(choice) - 1
                if not (0 <= idx < 3):
                    raise ValueError
            except ValueError:
                self._p("[dim red]pick 1, 2, 3, or b[/dim red]")
                continue

            current = favs[idx]
            label = f"slot {idx + 1}"
            if current:
                label += f" (current: {current}, blank to remove)"
            new_val = (await self._simple_prompt(f"{label} › ")).strip()

            if new_val == "":
                favs[idx] = ""
                self._p(f"[green]✓ slot {idx + 1} cleared[/green]")
            else:
                favs[idx] = new_val
                self._p(f"[green]✓ slot {idx + 1}:[/green] {new_val}")

            cleaned = [m for m in favs if m]
            self._save_config_key("openrouter", "favorite_models", cleaned)
            self._kernel.config.setdefault("openrouter", {})["favorite_models"] = cleaned

    async def _confirm_shell(self, command: str) -> bool:
        """Ask the user to approve a shell command before ShellTool runs it."""
        async with in_terminal():
            self._console.print()
            self._console.print(f"[bold yellow]⚠  shell command requested[/bold yellow]")
            self._console.print(f"  [bright_white]{command}[/bright_white]")
            answer = (await self._simple_prompt("run this? (y/N) › ")).strip().lower()
        return answer in ("y", "yes")

    async def _confirm_install(self, action: str, detail: str) -> bool:
        """Approve an MCP install / mount step."""
        async with in_terminal():
            self._console.print()
            self._console.print(f"[bold yellow]⚠  {action}[/bold yellow]")
            for line in detail.splitlines():
                self._console.print(f"  [bright_white]{line}[/bright_white]")
            answer = (await self._simple_prompt("proceed? (y/N) › ")).strip().lower()
        return answer in ("y", "yes")

    async def _simple_prompt(self, label: str, is_password: bool = False) -> str:
        """Quick non-framed prompt for /config sub-questions."""
        sess = PromptSession()
        try:
            return await sess.prompt_async(label, is_password=is_password)
        except (KeyboardInterrupt, EOFError):
            return ""

    async def _open_in_editor(self, path: Path) -> None:
        editor = os.environ.get("EDITOR", "nano")
        self._p(f"[dim]opening {path.name} in {editor}...[/dim]")
        proc = await asyncio.create_subprocess_shell(f'{editor} "{path}"')
        await proc.wait()
        self._p(f"[green]✓ closed editor[/green]")

    def _save_config_key(self, section: str, key: str, value) -> None:
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
            return

        with self._console.status("[dim]checking for updates...[/dim]", spinner="dots"):
            await self._git("fetch")
            local = await self._git("rev-parse HEAD")
            remote = await self._git("rev-parse @{u}")

        if not remote:
            self._p("[yellow]⚠  no upstream branch set.[/yellow]")
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
