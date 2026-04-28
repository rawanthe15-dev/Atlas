import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal.js";
import { SingleLineInput } from "./SingleLineInput.js";
import { ModalEditor } from "./ModalEditor.js";
import { saveConfigKey, saveConfigPath, type AtlasConfig } from "../config/config.js";
import type { MemoryBackend } from "../memory/backend.js";

const MENU = [
  { id: "openrouter_key", label: "Set OpenRouter API key" },
  { id: "default_model", label: "Set default model" },
  { id: "favorites", label: "Manage favorite models" },
  { id: "brave_key", label: "Set Brave Search API key" },
  { id: "memory_backend", label: "Switch memory backend (file / vector)" },
  { id: "edit_soul", label: "Edit SOUL.md (in-app editor)" },
  { id: "edit_user", label: "Edit USER.md (in-app editor)" },
  { id: "reset_user", label: "Reset USER.md" },
  { id: "show_config", label: "Show current config" },
  { id: "back", label: "Back to chat" },
] as const;

type View =
  | { kind: "menu" }
  | { kind: "input"; field: "openrouter_key" | "default_model" | "brave_key"; secret: boolean; label: string }
  | { kind: "favorites"; favs: string[] }
  | { kind: "favorite-edit"; favs: string[]; index: number }
  | { kind: "memory-pick" }
  | { kind: "reset-user-confirm" }
  | { kind: "edit-soul"; initial: string }
  | { kind: "edit-user"; initial: string }
  | { kind: "show" }
  | { kind: "info"; lines: string[] };

interface Props {
  config: AtlasConfig;
  memory: MemoryBackend;
  onApiKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  onResetUser: () => Promise<void>;
  onMemoryBackendChange: (backend: "file" | "vector") => void;
  onClose: () => void;
}

export function ModalConfig({
  config,
  memory,
  onApiKeyChange,
  onModelChange,
  onResetUser,
  onMemoryBackendChange,
  onClose,
}: Props): React.ReactElement {
  const [view, setView] = useState<View>({ kind: "menu" });

  // Esc anywhere goes back / closes (sub-views handle their own input).
  useInput(
    (input, key) => {
      if (view.kind !== "menu") return;
      if (key.escape) {
        onClose();
        return;
      }
      const idx = Number.parseInt(input, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= MENU.length) {
        const item = MENU[idx - 1];
        void handleMenuPick(item.id);
      }
    },
    { isActive: view.kind === "menu" },
  );

  async function handleMenuPick(id: (typeof MENU)[number]["id"]): Promise<void> {
    if (id === "back") {
      onClose();
      return;
    }
    if (id === "openrouter_key") {
      setView({ kind: "input", field: "openrouter_key", secret: true, label: "openrouter api key › " });
      return;
    }
    if (id === "default_model") {
      setView({ kind: "input", field: "default_model", secret: false, label: "model name › " });
      return;
    }
    if (id === "brave_key") {
      setView({ kind: "input", field: "brave_key", secret: true, label: "brave search api key › " });
      return;
    }
    if (id === "favorites") {
      const favs = [...(config.openrouter?.favorite_models ?? [])];
      while (favs.length < 3) favs.push("");
      setView({ kind: "favorites", favs: favs.slice(0, 3) });
      return;
    }
    if (id === "memory_backend") {
      setView({ kind: "memory-pick" });
      return;
    }
    if (id === "edit_soul") {
      const initial = await memory.getSoul();
      setView({ kind: "edit-soul", initial });
      return;
    }
    if (id === "edit_user") {
      const initial = await memory.getUserProfile();
      setView({ kind: "edit-user", initial });
      return;
    }
    if (id === "reset_user") {
      setView({ kind: "reset-user-confirm" });
      return;
    }
    if (id === "show_config") {
      setView({ kind: "show" });
      return;
    }
  }

  if (view.kind === "input") {
    return (
      <Modal title={`config › ${view.field}`} hint="esc to cancel">
        <SingleLineInput
          prompt={view.label}
          secret={view.secret}
          onSubmit={(raw) => {
            const v = raw.trim();
            if (!v) {
              setView({ kind: "menu" });
              return;
            }
            if (view.field === "openrouter_key") {
              saveConfigKey("openrouter", "api_key", v);
              onApiKeyChange(v);
              setView({ kind: "info", lines: ["✓ key saved"] });
              return;
            }
            if (view.field === "default_model") {
              saveConfigKey("openrouter", "default_model", v);
              onModelChange(v);
              setView({ kind: "info", lines: [`✓ model: ${v}`] });
              return;
            }
            if (view.field === "brave_key") {
              saveConfigKey("tools", "brave_api_key", v);
              setView({ kind: "info", lines: ["✓ key saved (restart atlas to enable web_search tool)"] });
              return;
            }
          }}
          onCancel={() => setView({ kind: "menu" })}
        />
      </Modal>
    );
  }

  if (view.kind === "favorites") {
    return (
      <FavoritesView
        favs={view.favs}
        onClose={() => setView({ kind: "menu" })}
        onEdit={(idx) => setView({ kind: "favorite-edit", favs: view.favs, index: idx })}
      />
    );
  }

  if (view.kind === "favorite-edit") {
    return (
      <Modal title={`favorite slot ${view.index + 1}`} hint="enter blank to clear, esc to cancel">
        <SingleLineInput
          prompt={`slot ${view.index + 1}${view.favs[view.index] ? ` (current: ${view.favs[view.index]})` : ""} › `}
          onSubmit={(raw) => {
            const next = [...view.favs];
            next[view.index] = raw.trim();
            const cleaned = next.filter(Boolean);
            saveConfigKey("openrouter", "favorite_models", cleaned);
            while (next.length < 3) next.push("");
            setView({ kind: "favorites", favs: next.slice(0, 3) });
          }}
          onCancel={() => setView({ kind: "favorites", favs: view.favs })}
        />
      </Modal>
    );
  }

  if (view.kind === "memory-pick") {
    return (
      <MemoryPickView
        current={config.memory?.backend ?? "file"}
        onPick={(b) => {
          saveConfigKey("memory", "backend", b);
          onMemoryBackendChange(b);
          setView({
            kind: "info",
            lines: [
              `✓ memory backend: ${b}`,
              b === "vector"
                ? "set [memory.embeddings] api_key + model in /config or config.toml to enable embeddings"
                : "",
            ].filter(Boolean),
          });
        }}
        onClose={() => setView({ kind: "menu" })}
      />
    );
  }

  if (view.kind === "reset-user-confirm") {
    return (
      <Modal title="reset USER.md?" borderColor="yellow" hint="this clears everything Atlas knows about you">
        <SingleLineInput
          prompt="type yes › "
          onSubmit={(raw) => {
            if (raw.trim().toLowerCase() === "yes") {
              onResetUser().then(() => setView({ kind: "info", lines: ["✓ USER.md reset"] }));
            } else {
              setView({ kind: "menu" });
            }
          }}
          onCancel={() => setView({ kind: "menu" })}
        />
      </Modal>
    );
  }

  if (view.kind === "edit-soul") {
    return (
      <ModalEditor
        title="editing SOUL.md"
        initial={view.initial}
        onSave={async (next) => {
          // SOUL.md isn't part of MemoryBackend interface intentionally
          // (read-only for the agent). Persist via direct fs.
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const { ATLAS_ROOT } = await import("../config/config.js");
          await fs.writeFile(path.join(ATLAS_ROOT, "memory", "SOUL.md"), next);
        }}
        onClose={() => setView({ kind: "menu" })}
      />
    );
  }

  if (view.kind === "edit-user") {
    return (
      <ModalEditor
        title="editing USER.md"
        initial={view.initial}
        onSave={async (next) => {
          await memory.updateUserProfile(next);
        }}
        onClose={() => setView({ kind: "menu" })}
      />
    );
  }

  if (view.kind === "show") {
    return (
      <Modal title="current config" hint="any key to go back">
        <ConfigSummary config={config} onAny={() => setView({ kind: "menu" })} />
      </Modal>
    );
  }

  if (view.kind === "info") {
    return (
      <Modal title="config" hint="any key to continue">
        <InfoLines lines={view.lines} onAny={() => setView({ kind: "menu" })} />
      </Modal>
    );
  }

  return (
    <Modal title="config" hint="press a number, esc to close">
      {MENU.map((m, i) => (
        <Box key={m.id}>
          <Text color="cyan" bold>
            {String(i + 1).padStart(2, " ")}{"  "}
          </Text>
          <Text>{m.label}</Text>
        </Box>
      ))}
    </Modal>
  );
}

function FavoritesView({
  favs,
  onClose,
  onEdit,
}: {
  favs: string[];
  onClose: () => void;
  onEdit: (i: number) => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "b") {
      onClose();
      return;
    }
    const idx = Number.parseInt(input, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= 3) onEdit(idx - 1);
  });

  return (
    <Modal title="favorite models" hint="1-3 to edit slot, b or esc to back out">
      {favs.map((m, i) => (
        <Box key={i}>
          <Text color="cyan" bold>
            {i + 1}{"  "}
          </Text>
          <Text>{m || "(empty)"}</Text>
        </Box>
      ))}
    </Modal>
  );
}

function MemoryPickView({
  current,
  onPick,
  onClose,
}: {
  current: "file" | "vector";
  onPick: (b: "file" | "vector") => void;
  onClose: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "b") {
      onClose();
      return;
    }
    if (input === "1") onPick("file");
    if (input === "2") onPick("vector");
  });
  return (
    <Modal title="memory backend" hint="1 file · 2 vector · b/esc back">
      <Box>
        <Text color={current === "file" ? "green" : "gray"}>{current === "file" ? "● " : "○ "}</Text>
        <Text color="cyan" bold>
          1{"  "}
        </Text>
        <Text>file — token overlap (zero deps, fast)</Text>
      </Box>
      <Box>
        <Text color={current === "vector" ? "green" : "gray"}>{current === "vector" ? "● " : "○ "}</Text>
        <Text color="cyan" bold>
          2{"  "}
        </Text>
        <Text>vector — embedding similarity (needs OpenAI-compatible embeddings endpoint)</Text>
      </Box>
    </Modal>
  );
}

function InfoLines({ lines, onAny }: { lines: string[]; onAny: () => void }): React.ReactElement {
  useInput(() => onAny());
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

function ConfigSummary({ config, onAny }: { config: AtlasConfig; onAny: () => void }): React.ReactElement {
  useInput(() => onAny());
  const rows: [string, string][] = [
    ["model", config.openrouter?.default_model ?? "—"],
    ["api key", config.openrouter?.api_key ? "set" : "not set"],
    ["brave key", config.tools?.brave_api_key ? "set" : "—"],
    ["memory backend", config.memory?.backend ?? "file"],
    [
      "embeddings",
      config.memory?.embeddings?.api_key
        ? `${config.memory.embeddings.model ?? "(no model set)"}`
        : "not configured",
    ],
    ["onboarded", config.atlas?.onboarded ? "yes" : "no"],
  ];
  return (
    <Box flexDirection="column">
      {rows.map(([k, v]) => (
        <Box key={k}>
          <Text dimColor>{k.padEnd(16)}</Text>
          <Text>{v}</Text>
        </Box>
      ))}
    </Box>
  );
}

// re-export so App can write embeddings settings
export { saveConfigPath };
