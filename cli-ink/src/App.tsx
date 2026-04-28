import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { Banner } from "./ui/Banner.js";
import { Input } from "./ui/Input.js";
import { Toolbar } from "./ui/Toolbar.js";
import { TurnView, type Turn, type TurnPart } from "./ui/StreamView.js";
import { Modal } from "./ui/Modal.js";
import { ModalModel } from "./ui/ModalModel.js";
import { ModalConfig } from "./ui/ModalConfig.js";
import { ModalSessions } from "./ui/ModalSessions.js";
import { ModalUpdate } from "./ui/ModalUpdate.js";
import { ModalOnboarding } from "./ui/ModalOnboarding.js";
import { SlashAutocomplete, completeSlash } from "./ui/SlashAutocomplete.js";
import type { Kernel } from "./kernel/kernel.js";
import type { ModalKind } from "./kernel/types.js";
import { saveConfigKey, loadConfig, type AtlasConfig } from "./config/config.js";
import { buildMemoryBackend } from "./plugins/memory-plugin.js";
import { userProfileIsEmpty, type Session } from "./memory/backend.js";
import type { ShellConfirmFn } from "./tools/shell.js";
import { makeBraveSearchTool } from "./tools/web-search.js";
import type { DiscordLogFn, DiscordLogLevel } from "./plugins/discord-plugin.js";

export interface DiscordLogEntry {
  level: DiscordLogLevel;
  message: string;
  ts: number;
}

const ATLAS_VERSION = "0.3.0-ink";

const DEFAULT_FAVORITES = [
  "deepseek/deepseek-chat",
  "openai/gpt-oss-120b:free",
  "anthropic/claude-sonnet-4-5",
];

interface Props {
  kernel: Kernel;
  shellConfirmRef: { current: ShellConfirmFn };
  /** Mutable handler for Discord status messages — buffered before mount. */
  discordLogRef: { current: DiscordLogFn };
  /** Discord log entries queued before the App mounted. Drained on mount. */
  discordLogQueue: DiscordLogEntry[];
  discordEnabled: boolean;
}

interface StaticItem {
  id: string;
  node: React.ReactElement;
}

interface ConfirmRequest {
  prompt: string;
  resolve: (ok: boolean) => void;
}

type ModalState =
  | { kind: "closed" }
  | { kind: "model" }
  | { kind: "config" }
  | { kind: "sessions"; sessions: Session[] }
  | { kind: "update" }
  | { kind: "onboarding" };

export function App({
  kernel,
  shellConfirmRef,
  discordLogRef,
  discordLogQueue,
  discordEnabled,
}: Props): React.ReactElement {
  const { exit } = useApp();

  const [config, setConfig] = useState<AtlasConfig>(kernel.config);
  const apiKey = config.openrouter?.api_key ?? "";
  const initialModel = config.openrouter?.default_model ?? "deepseek/deepseek-chat";

  const [model, setModel] = useState(initialModel);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingTurn, setStreamingTurn] = useState<Turn | null>(null);

  // Banner is the first Static item — Static commits items to terminal
  // scroll-back once, so the banner stays put as the user scrolls history.
  const [history, setHistory] = useState<StaticItem[]>(() => [
    {
      id: "banner",
      node: (
        <Banner
          version={ATLAS_VERSION}
          model={initialModel}
          hasApiKey={Boolean(kernel.config.openrouter?.api_key)}
        />
      ),
    },
  ]);

  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });

  const abortRef = useRef<AbortController | null>(null);
  const exchangesRef = useRef(0);
  const [, forceRerender] = useState(0);

  // Wire the shell-confirm callback owned by index.tsx to our modal state.
  useEffect(() => {
    shellConfirmRef.current = (cmd) =>
      new Promise<boolean>((resolve) => {
        setConfirmReq({ prompt: cmd, resolve });
      });
  }, [shellConfirmRef]);

  // Drain pre-mount Discord logs and switch the routing function so future
  // logs render as system lines instead of corrupting the Ink frame.
  useEffect(() => {
    if (!discordEnabled) return;
    for (const entry of discordLogQueue) renderDiscordLog(entry.level, entry.message);
    discordLogQueue.length = 0;
    discordLogRef.current = (level, message) => {
      renderDiscordLog(level, message);
    };
    function renderDiscordLog(level: DiscordLogLevel, message: string): void {
      const color = level === "error" ? "red" : level === "warn" ? "yellow" : undefined;
      pushSystemLine(`discord: ${message}`, color, level === "info");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open onboarding on first run: no api_key OR onboarded flag absent.
  // Skipped when re-entering /onboarding (handler always opens it explicitly).
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const needs =
      !config.openrouter?.api_key || config.atlas?.onboarded !== true;
    if (needs) {
      setModal({ kind: "onboarding" });
    }
  }, [config]);

  // Esc cancels in-flight streaming when no modal is open.
  useInput((inputChar, key) => {
    if (confirmReq) {
      if (inputChar === "y" || inputChar === "Y") {
        confirmReq.resolve(true);
        setConfirmReq(null);
        return;
      }
      if (inputChar === "n" || inputChar === "N" || key.return || key.escape) {
        confirmReq.resolve(false);
        setConfirmReq(null);
        return;
      }
      return;
    }
    if (modal.kind !== "closed") return;
    if (key.escape && isProcessing) {
      abortRef.current?.abort();
    }
  });

  function commitTurn(turn: Turn): void {
    const id = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setHistory((h) => [...h, { id, node: <TurnView key={id} turn={turn} done /> }]);
  }

  function pushSystemLine(text: string, color?: string, dim?: boolean): void {
    const id = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setHistory((h) => [
      ...h,
      {
        id,
        node: (
          <Box key={id} marginBottom={1}>
            <Text color={color} dimColor={dim}>
              {text}
            </Text>
          </Box>
        ),
      },
    ]);
  }

  async function runUserInput(text: string): Promise<void> {
    if (!text.trim()) return;

    if (text.startsWith("/")) {
      await handleSlash(text.trim());
      return;
    }

    if (!apiKey) {
      pushSystemLine("✗ no openrouter key — type /onboarding or /config to set one", "red");
      return;
    }

    const turn: Turn = { user: text, parts: [] };
    setStreamingTurn(turn);
    setIsProcessing(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const updateLast = (kind: TurnPart["kind"], chunk: string) => {
      const last = turn.parts[turn.parts.length - 1];
      if (last && last.kind === kind) {
        last.text += chunk;
      } else {
        turn.parts.push({ kind, text: chunk });
      }
      setStreamingTurn({ ...turn, parts: [...turn.parts] });
    };

    try {
      await kernel.agent.process(
        text,
        {
          onReasoning: (t) => updateLast("reasoning", t),
          onToken: (t) => updateLast("response", t),
          onToolCall: (name) => updateLast("tool_call", name),
        },
        ac.signal,
      );
      exchangesRef.current = kernel.agent.exchangeCount();
      commitTurn(turn);
    } catch (e: any) {
      if (ac.signal.aborted) {
        turn.parts.push({ kind: "response", text: "[interrupted]" });
        commitTurn(turn);
      } else {
        commitTurn(turn);
        pushSystemLine(`error: ${e?.message ?? e}`, "red");
      }
    } finally {
      setStreamingTurn(null);
      setIsProcessing(false);
      abortRef.current = null;
      forceRerender((n) => n + 1);
    }
  }

  async function handleSlash(raw: string): Promise<void> {
    const [name, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();

    // /model X applies directly without opening the picker.
    if (name === "/model" && arg) {
      applyModel(arg);
      return;
    }

    const cmd = kernel.commands.get(name);
    if (!cmd) {
      pushSystemLine("unknown command. type /help", "red", true);
      return;
    }

    const result = await cmd.handler({ raw, arg });
    switch (result.kind) {
      case "text":
        pushSystemLine(result.text, result.color, result.dim ?? false);
        return;
      case "modal":
        await openModal(result.modal);
        return;
      case "exit":
        // Kill any standalone atlas-bot launchers so /exit cleans up the
        // whole Atlas process group, not just the CLI. The in-process
        // Discord plugin is already torn down by kernel.unloadAll() on exit.
        try {
          const { spawnSync } = await import("node:child_process");
          spawnSync("pkill", ["-f", "atlas-bot"], { stdio: "ignore" });
        } catch {}
        exit();
        return;
      case "clear":
        process.stdout.write("\x1b[2J\x1b[H");
        setHistory([]);
        return;
      case "error":
        pushSystemLine(result.text, "red");
        return;
      case "noop":
        return;
    }
  }

  async function openModal(kind: ModalKind): Promise<void> {
    if (kind === "model") setModal({ kind: "model" });
    else if (kind === "config") setModal({ kind: "config" });
    else if (kind === "update") setModal({ kind: "update" });
    else if (kind === "onboarding") setModal({ kind: "onboarding" });
    else if (kind === "sessions") {
      const sessions = await kernel.memory.getRecentSessions(10);
      setModal({ kind: "sessions", sessions });
    }
    // edit-soul / edit-user are reachable via /config; not exposed at App level.
  }

  function applyModel(name: string): void {
    setModel(name);
    kernel.agent.setModel(name);
    try {
      saveConfigKey("openrouter", "default_model", name);
    } catch {}
    const next = { ...config, openrouter: { ...(config.openrouter ?? {}), default_model: name } };
    setConfig(next);
    kernel.setConfig(next);
    pushSystemLine(`✓ model: ${name}`, "green");
  }

  function applyApiKey(key: string): void {
    kernel.agent.setApiKey(key);
    const next = { ...config, openrouter: { ...(config.openrouter ?? {}), api_key: key } };
    setConfig(next);
    kernel.setConfig(next);
  }

  function applyBraveKey(key: string): void {
    if (!key) return;
    kernel.tools.register(makeBraveSearchTool(key));
    kernel.braveApiKey = key;
    const next = { ...config, tools: { ...(config.tools ?? {}), brave_api_key: key } };
    setConfig(next);
    kernel.setConfig(next);
  }

  async function applyMemoryBackend(backend: "file" | "vector"): Promise<void> {
    const next: AtlasConfig = {
      ...config,
      memory: { ...(config.memory ?? {}), backend },
    };
    setConfig(next);
    kernel.setConfig(next);
    const newBackend = await buildMemoryBackend(kernel);
    await newBackend.init();
    kernel.memory = newBackend;
    kernel.agent.setMemory(newBackend);
    pushSystemLine(`✓ memory backend: ${backend}`, "green");
  }

  async function resetUserProfile(): Promise<void> {
    await kernel.memory.updateUserProfile(
      "# User Profile\n\n## Identity\n\n## Preferences\n\n## Projects\n\n## Patterns\n\n## Context\n",
    );
  }

  async function resumeSession(session: Session): Promise<void> {
    setModal({ kind: "closed" });
    // Replay each entry as a committed Turn so the user can scroll back through it.
    for (const e of session.entries) {
      const turn: Turn = {
        user: e.user,
        parts: [{ kind: "response", text: e.assistant }],
      };
      commitTurn(turn);
    }
    // Seed the agent's chat memory so the next reply has continuity.
    kernel.agent.seedHistory(session.entries);
    exchangesRef.current = kernel.agent.exchangeCount();
    pushSystemLine(
      `✓ resumed ${session.file.replace(".jsonl", "")} — ${session.entries.length} exchange${
        session.entries.length !== 1 ? "s" : ""
      } loaded into context`,
      "green",
    );
    forceRerender((n) => n + 1);
  }

  // Onboarding completion — apply changes to live app + agent.
  function handleOnboardingApply(next: {
    apiKey?: string;
    model?: string;
    braveKey?: string;
    userProfile?: string;
  }): void {
    if (next.apiKey) applyApiKey(next.apiKey);
    if (next.model) {
      setModel(next.model);
      kernel.agent.setModel(next.model);
      const merged = {
        ...config,
        openrouter: { ...(config.openrouter ?? {}), default_model: next.model },
      };
      setConfig(merged);
      kernel.setConfig(merged);
    }
    if (next.braveKey) applyBraveKey(next.braveKey);
    // userProfile is already saved to disk by the onboarding modal; no app state to update.
  }

  // The favorites list shown by /model picker — fall back to defaults if config has none.
  const favorites = useMemo(() => {
    const fromCfg = config.openrouter?.favorite_models?.filter(Boolean) ?? [];
    return fromCfg.length > 0 ? fromCfg : DEFAULT_FAVORITES;
  }, [config.openrouter?.favorite_models]);

  const commandsRecord = useMemo(() => kernel.getCommandsAsRecord(), [kernel, modal.kind]);

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            {item.node}
          </Box>
        )}
      </Static>

      {streamingTurn && (
        <Box flexDirection="column">
          <TurnView turn={streamingTurn} />
        </Box>
      )}

      {modal.kind === "closed" && !confirmReq && !isProcessing && (
        <SlashAutocomplete input={input} commands={commandsRecord} />
      )}

      {modal.kind === "model" && (
        <ModalModel
          favorites={favorites}
          current={model}
          onPick={(m) => {
            applyModel(m);
            setModal({ kind: "closed" });
          }}
          onClose={() => setModal({ kind: "closed" })}
        />
      )}
      {modal.kind === "config" && (
        <ModalConfig
          config={config}
          memory={kernel.memory}
          onApiKeyChange={applyApiKey}
          onModelChange={(m) => {
            setModel(m);
            kernel.agent.setModel(m);
            const merged = { ...config, openrouter: { ...(config.openrouter ?? {}), default_model: m } };
            setConfig(merged);
            kernel.setConfig(merged);
          }}
          onResetUser={resetUserProfile}
          onMemoryBackendChange={applyMemoryBackend}
          onClose={() => {
            // re-read config to capture changes (favorites, brave key, etc.)
            const fresh = loadConfig();
            setConfig(fresh);
            kernel.setConfig(fresh);
            setModal({ kind: "closed" });
          }}
        />
      )}
      {modal.kind === "sessions" && (
        <ModalSessions
          sessions={modal.sessions}
          onResume={(s) => void resumeSession(s)}
          onClose={() => setModal({ kind: "closed" })}
        />
      )}
      {modal.kind === "update" && <ModalUpdate onClose={() => setModal({ kind: "closed" })} />}
      {modal.kind === "onboarding" && (
        <ModalOnboarding
          config={config}
          memory={kernel.memory}
          onApply={handleOnboardingApply}
          onClose={() => {
            const fresh = loadConfig();
            setConfig(fresh);
            kernel.setConfig(fresh);
            setModal({ kind: "closed" });
          }}
        />
      )}

      {modal.kind === "closed" && confirmReq && (
        <Modal title="⚠  shell command requested" borderColor="yellow" hint="press y to allow, n / esc to deny">
          <Text>{confirmReq.prompt}</Text>
        </Modal>
      )}

      {modal.kind === "closed" && !confirmReq && (
        <Input
          value={input}
          onChange={setInput}
          onSubmit={(v) => {
            setInput("");
            void runUserInput(v);
          }}
          onTab={(current) => completeSlash(current, commandsRecord)}
          disabled={isProcessing}
          placeholder={
            isProcessing
              ? "thinking… press esc to interrupt"
              : "ask anything · alt+enter for newline · / for commands"
          }
        />
      )}

      <Toolbar
        model={model}
        exchanges={exchangesRef.current}
        apiKeySet={Boolean(apiKey)}
        isProcessing={isProcessing}
      />
    </Box>
  );
}
