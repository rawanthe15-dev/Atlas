import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Modal } from "./Modal.js";
import { SingleLineInput } from "./SingleLineInput.js";
import { saveConfigKey } from "../config/config.js";
import type { AtlasConfig } from "../config/config.js";
import type { MemoryBackend } from "../memory/backend.js";
import { userProfileIsEmpty } from "../memory/backend.js";
import { streamChat, type ChatMessage } from "../agent/openrouter.js";

interface Props {
  config: AtlasConfig;
  memory: MemoryBackend;
  /** Called when the user finishes (or skips) the flow. */
  onClose: () => void;
  /** Apply changes to live App state — keys, model, etc. */
  onApply: (next: { apiKey?: string; model?: string; braveKey?: string; userProfile?: string }) => void;
}

const PROFILE_QUESTIONS: { id: string; q: string; placeholder?: string }[] = [
  { id: "name", q: "What should I call you?", placeholder: "your name or handle" },
  {
    id: "what_you_do",
    q: "What do you do — career, studies, projects?",
    placeholder: "e.g. ml engineer at acme · cs student · solo founder",
  },
  {
    id: "current_focus",
    q: "What are you working on right now?",
    placeholder: "current project / goal / problem you're chewing on",
  },
  {
    id: "patterns",
    q: "What helps you most when you're trying to focus or get unstuck?",
    placeholder: "tools, rituals, environments",
  },
  {
    id: "remember",
    q: "What kinds of things do you want me to remember about you?",
    placeholder: "preferences, hot takes, recurring threads",
  },
  {
    id: "style",
    q: "How should I talk to you — formal/casual, terse/verbose?",
    placeholder: "e.g. terse, no fluff, casual, technical-first",
  },
  {
    id: "anything_else",
    q: "Anything else important I should know?",
    placeholder: "leave blank to skip",
  },
];

type Step =
  | { kind: "welcome" }
  | { kind: "api-key"; existing: boolean }
  | { kind: "model"; existing: string | null }
  | { kind: "brave"; existing: boolean }
  | { kind: "profile-prompt"; userEmpty: boolean }
  | { kind: "profile-qa"; qIndex: number; answers: Record<string, string> }
  | { kind: "profile-saving" }
  | { kind: "profile-saved" }
  | { kind: "done" };

export function ModalOnboarding({ config, memory, onClose, onApply }: Props): React.ReactElement {
  const initialApiKey = config.openrouter?.api_key ?? "";
  const initialModel = config.openrouter?.default_model ?? "";
  const initialBrave = config.tools?.brave_api_key ?? "";
  const baseUrl = config.openrouter?.base_url ?? "https://openrouter.ai/api/v1/chat/completions";

  const [userProfile, setUserProfile] = useState<string>("");
  const [userEmpty, setUserEmpty] = useState(false);

  // Load USER.md once to decide whether to offer Q&A.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const p = await memory.getUserProfile();
      if (cancelled) return;
      setUserProfile(p);
      setUserEmpty(userProfileIsEmpty(p));
    })();
    return () => {
      cancelled = true;
    };
  }, [memory]);

  const [step, setStep] = useState<Step>({ kind: "welcome" });
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [model, setModel] = useState(initialModel);
  const [braveKey, setBraveKey] = useState(initialBrave);

  function next(): void {
    setStep((s) => {
      if (s.kind === "welcome") return { kind: "api-key", existing: !!apiKey };
      if (s.kind === "api-key") return { kind: "model", existing: model || null };
      if (s.kind === "model") return { kind: "brave", existing: !!braveKey };
      if (s.kind === "brave") return { kind: "profile-prompt", userEmpty };
      if (s.kind === "profile-prompt") return { kind: "done" };
      return s;
    });
  }

  function finish(markOnboarded: boolean): void {
    if (markOnboarded) saveConfigKey("atlas", "onboarded", true);
    onClose();
  }

  if (step.kind === "welcome") {
    return <WelcomeStep onContinue={next} onSkip={() => finish(true)} />;
  }
  if (step.kind === "api-key") {
    return (
      <ApiKeyStep
        existing={initialApiKey}
        value={apiKey}
        onChange={setApiKey}
        onContinue={(v) => {
          if (v && v !== initialApiKey) {
            saveConfigKey("openrouter", "api_key", v);
            onApply({ apiKey: v });
          }
          next();
        }}
        onSkip={next}
      />
    );
  }
  if (step.kind === "model") {
    return (
      <ModelStep
        existing={initialModel}
        favorites={config.openrouter?.favorite_models ?? []}
        value={model}
        onChange={setModel}
        onContinue={(v) => {
          if (v && v !== initialModel) {
            saveConfigKey("openrouter", "default_model", v);
            onApply({ model: v });
          }
          next();
        }}
        onSkip={next}
      />
    );
  }
  if (step.kind === "brave") {
    return (
      <BraveStep
        existing={initialBrave}
        value={braveKey}
        onChange={setBraveKey}
        onContinue={(v) => {
          if (v && v !== initialBrave) {
            saveConfigKey("tools", "brave_api_key", v);
            onApply({ braveKey: v });
          }
          next();
        }}
        onSkip={next}
      />
    );
  }
  if (step.kind === "profile-prompt") {
    return (
      <ProfilePromptStep
        userEmpty={step.userEmpty}
        existingProfile={userProfile}
        onYes={() => setStep({ kind: "profile-qa", qIndex: 0, answers: {} })}
        onNo={() => setStep({ kind: "done" })}
      />
    );
  }
  if (step.kind === "profile-qa") {
    return (
      <ProfileQAStep
        qIndex={step.qIndex}
        answers={step.answers}
        onAnswer={(answer) => {
          const q = PROFILE_QUESTIONS[step.qIndex];
          const nextAnswers = { ...step.answers, [q.id]: answer };
          if (step.qIndex + 1 < PROFILE_QUESTIONS.length) {
            setStep({ kind: "profile-qa", qIndex: step.qIndex + 1, answers: nextAnswers });
          } else {
            void runProfileSave(nextAnswers);
          }
        }}
        onSkipAll={() => setStep({ kind: "done" })}
      />
    );
  }
  if (step.kind === "profile-saving") {
    return <ProfileSavingStep />;
  }
  if (step.kind === "profile-saved") {
    return <ProfileSavedStep onContinue={() => setStep({ kind: "done" })} />;
  }
  return <DoneStep onClose={() => finish(true)} />;

  async function runProfileSave(answers: Record<string, string>): Promise<void> {
    setStep({ kind: "profile-saving" });
    const profile = await synthesizeProfile({
      apiKey: apiKey || initialApiKey,
      baseUrl,
      model: model || initialModel || "deepseek/deepseek-chat",
      answers,
      previous: userProfile,
    });
    if (profile) {
      await memory.updateUserProfile(profile);
      onApply({ userProfile: profile });
    }
    setStep({ kind: "profile-saved" });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────

const WELCOME_LINES = [
  "Welcome to Atlas.",
  "I'm your second brain — a system designed to know you,",
  "remember what you forgot, and connect to the things you use.",
  "",
  "This is a quick setup. It won't overwrite what's already saved.",
];

function WelcomeStep({
  onContinue,
  onSkip,
}: {
  onContinue: () => void;
  onSkip: () => void;
}): React.ReactElement {
  // Typewriter — reveal characters across all lines as one stream.
  const fullText = WELCOME_LINES.join("\n");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (cursor >= fullText.length) return;
    const id = setInterval(() => setCursor((c) => Math.min(c + 2, fullText.length)), 18);
    return () => clearInterval(id);
  }, [cursor, fullText.length]);

  useInput((input, key) => {
    if (cursor < fullText.length) {
      setCursor(fullText.length);
      return;
    }
    if (key.escape || input === "s") {
      onSkip();
      return;
    }
    if (key.return || input === " ") onContinue();
  });

  const visible = fullText.slice(0, cursor).split("\n");
  while (visible.length < WELCOME_LINES.length) visible.push("");

  const isDone = cursor >= fullText.length;

  return (
    <Modal
      title="atlas · onboarding"
      hint={isDone ? "enter / space to continue · s or esc to skip" : "press any key to skip animation"}
    >
      <Box flexDirection="column">
        {visible.map((line, i) => {
          if (i === 0) {
            return (
              <Text key={i} color="cyan" bold>
                {line}
                {!isDone && i === visible.length - 1 ? <Text inverse> </Text> : null}
              </Text>
            );
          }
          return (
            <Text key={i} dimColor={i > 0}>
              {line}
              {!isDone && i === visible.length - 1 ? <Text inverse> </Text> : null}
            </Text>
          );
        })}
      </Box>
    </Modal>
  );
}

function ApiKeyStep({
  existing,
  value,
  onChange,
  onContinue,
  onSkip,
}: {
  existing: string;
  value: string;
  onChange: (v: string) => void;
  onContinue: (v: string) => void;
  onSkip: () => void;
}): React.ReactElement {
  const [mode, setMode] = useState<"summary" | "input">(existing ? "summary" : "input");

  useInput(
    (input, key) => {
      if (mode !== "summary") return;
      if (key.escape || input === "s") {
        onSkip();
        return;
      }
      if (input === "k") {
        setMode("input");
        return;
      }
      if (key.return || input === " ") onContinue(value);
    },
    { isActive: mode === "summary" },
  );

  if (mode === "input") {
    return (
      <StepShell title="step 1/4 · openrouter api key" hint="esc to cancel">
        <Box marginBottom={1}>
          <Text dimColor>
            grab one at openrouter.ai/keys — atlas talks to OpenRouter for chat models.
          </Text>
        </Box>
        <SingleLineInput
          prompt="api key › "
          secret
          initial={value}
          onSubmit={(v) => {
            onChange(v.trim());
            onContinue(v.trim());
          }}
          onCancel={() => (existing ? setMode("summary") : onSkip())}
        />
      </StepShell>
    );
  }

  return (
    <StepShell
      title="step 1/4 · openrouter api key"
      hint="enter / space to keep · k to change · s or esc to skip"
    >
      <Box>
        <Text color="green">✓ </Text>
        <Text>openrouter key </Text>
        <Text dimColor italic>
          ({maskKey(existing)})
        </Text>
      </Box>
      <Text dimColor>
        keeping your existing key — press <Text bold>k</Text> to replace it.
      </Text>
    </StepShell>
  );
}

function ModelStep({
  existing,
  favorites,
  value,
  onChange,
  onContinue,
  onSkip,
}: {
  existing: string;
  favorites: string[];
  value: string;
  onChange: (v: string) => void;
  onContinue: (v: string) => void;
  onSkip: () => void;
}): React.ReactElement {
  const opts = useMemo(() => {
    const fromCfg = favorites.filter(Boolean);
    if (fromCfg.length > 0) return fromCfg;
    return ["deepseek/deepseek-chat", "openai/gpt-oss-120b:free", "anthropic/claude-sonnet-4-5"];
  }, [favorites]);

  const [mode, setMode] = useState<"pick" | "input">("pick");

  useInput(
    (input, key) => {
      if (mode !== "pick") return;
      if (key.escape || input === "s") {
        onSkip();
        return;
      }
      if (input === "n") {
        setMode("input");
        return;
      }
      if ((key.return || input === " ") && (existing || value)) {
        onContinue(value || existing);
        return;
      }
      const idx = Number.parseInt(input, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= opts.length) {
        const pick = opts[idx - 1];
        onChange(pick);
        onContinue(pick);
      }
    },
    { isActive: mode === "pick" },
  );

  if (mode === "input") {
    return (
      <StepShell title="step 2/4 · custom model" hint="esc to cancel">
        <SingleLineInput
          prompt="model id › "
          initial={value}
          onSubmit={(v) => {
            const m = v.trim();
            if (m) {
              onChange(m);
              onContinue(m);
            } else {
              setMode("pick");
            }
          }}
          onCancel={() => setMode("pick")}
        />
      </StepShell>
    );
  }

  return (
    <StepShell
      title="step 2/4 · default model"
      hint="press 1-3 · n for custom · enter to keep · s or esc to skip"
    >
      {existing && (
        <Box marginBottom={1}>
          <Text color="green">✓ </Text>
          <Text dimColor>currently </Text>
          <Text>{existing}</Text>
        </Box>
      )}
      {opts.map((m, i) => (
        <Box key={m}>
          <Text color={m === existing ? "green" : "gray"}>{m === existing ? "● " : "○ "}</Text>
          <Text color="cyan" bold>
            {i + 1}{"  "}
          </Text>
          <Text>{m}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor italic>
          press <Text bold>n</Text> to type a custom model id.
        </Text>
      </Box>
    </StepShell>
  );
}

function BraveStep({
  existing,
  value,
  onChange,
  onContinue,
  onSkip,
}: {
  existing: string;
  value: string;
  onChange: (v: string) => void;
  onContinue: (v: string) => void;
  onSkip: () => void;
}): React.ReactElement {
  const [mode, setMode] = useState<"summary" | "input">(existing ? "summary" : "summary");

  useInput(
    (input, key) => {
      if (mode !== "summary") return;
      if (key.escape || input === "s") {
        onSkip();
        return;
      }
      if (input === "k") {
        setMode("input");
        return;
      }
      if (key.return || input === " ") onContinue(value);
    },
    { isActive: mode === "summary" },
  );

  if (mode === "input") {
    return (
      <StepShell title="step 3/4 · brave search api key" hint="esc to skip">
        <Box marginBottom={1}>
          <Text dimColor>
            free at brave.com/search/api — enables the web_search tool. you can skip and add it later.
          </Text>
        </Box>
        <SingleLineInput
          prompt="brave key › "
          secret
          initial={value}
          onSubmit={(v) => {
            onChange(v.trim());
            onContinue(v.trim());
          }}
          onCancel={() => setMode("summary")}
        />
      </StepShell>
    );
  }

  return (
    <StepShell
      title="step 3/4 · brave search (optional)"
      hint="enter to skip · k to add a key · s or esc to skip step"
    >
      {existing ? (
        <>
          <Box>
            <Text color="green">✓ </Text>
            <Text>brave key </Text>
            <Text dimColor italic>
              ({maskKey(existing)})
            </Text>
          </Box>
          <Text dimColor>
            press <Text bold>k</Text> to replace it.
          </Text>
        </>
      ) : (
        <>
          <Text dimColor>
            no brave key set — atlas can't search the web yet.
          </Text>
          <Text dimColor>
            press <Text bold>k</Text> to add one, or <Text bold>enter</Text> to skip.
          </Text>
        </>
      )}
    </StepShell>
  );
}

function ProfilePromptStep({
  userEmpty,
  existingProfile,
  onYes,
  onNo,
}: {
  userEmpty: boolean;
  existingProfile: string;
  onYes: () => void;
  onNo: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onNo();
      return;
    }
    if (input === "y" || key.return) onYes();
    else if (input === "n") onNo();
  });

  return (
    <StepShell title="step 4/4 · profile" hint="y to do it · n / esc to skip">
      {userEmpty ? (
        <>
          <Text>your USER.md is empty.</Text>
          <Text dimColor>
            want to answer a few quick questions so I know how to help you?
          </Text>
        </>
      ) : (
        <>
          <Text>you already have a profile.</Text>
          <Text dimColor>
            running through the questions again will <Text bold>replace</Text> it. continue?
          </Text>
          <Box marginTop={1}>
            <Text dimColor italic>
              current profile preview ({existingProfile.length} chars):
            </Text>
          </Box>
          <Text dimColor>{existingProfile.slice(0, 200).replace(/\n+/g, " ")}…</Text>
        </>
      )}
    </StepShell>
  );
}

function ProfileQAStep({
  qIndex,
  answers,
  onAnswer,
  onSkipAll,
}: {
  qIndex: number;
  answers: Record<string, string>;
  onAnswer: (a: string) => void;
  onSkipAll: () => void;
}): React.ReactElement {
  const q = PROFILE_QUESTIONS[qIndex];
  return (
    <StepShell
      title={`profile setup · ${qIndex + 1}/${PROFILE_QUESTIONS.length}`}
      hint="enter to submit · empty line skips this one · esc abandons"
    >
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ›{" "}
        </Text>
        <Text>{q.q}</Text>
      </Box>
      <SingleLineInput
        prompt="› "
        onSubmit={(v) => onAnswer(v.trim())}
        onCancel={onSkipAll}
      />
      {q.placeholder && (
        <Box marginTop={1}>
          <Text dimColor italic>
            e.g. {q.placeholder}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <ProgressBar current={qIndex + 1} total={PROFILE_QUESTIONS.length} />
      </Box>
      {Object.keys(answers).length > 0 && (
        <Box marginTop={1}>
          <Text dimColor italic>
            ✓ {Object.keys(answers).length} answer{Object.keys(answers).length !== 1 ? "s" : ""} captured so far
          </Text>
        </Box>
      )}
    </StepShell>
  );
}

function ProfileSavingStep(): React.ReactElement {
  return (
    <StepShell title="profile · saving">
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text dimColor> distilling your answers into USER.md...</Text>
      </Box>
    </StepShell>
  );
}

function ProfileSavedStep({ onContinue }: { onContinue: () => void }): React.ReactElement {
  useInput(() => onContinue());
  return (
    <StepShell title="profile · saved" hint="any key to continue">
      <Box>
        <Text color="green">✓ </Text>
        <Text>USER.md updated. Atlas now knows you a little better.</Text>
      </Box>
    </StepShell>
  );
}

function DoneStep({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput(() => onClose());

  return (
    <Modal title="atlas · ready" hint="press any key to start">
      <Box flexDirection="column">
        <Text color="green" bold>
          ✓ all set
        </Text>
        <Text dimColor>type anything to start a conversation.</Text>
        <Text dimColor>
          press <Text bold>/</Text> for commands · <Text bold>/onboarding</Text> to redo this anytime.
        </Text>
      </Box>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function StepShell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Modal title={title} hint={hint}>
      <Box flexDirection="column">{children}</Box>
    </Modal>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }): React.ReactElement {
  const filled = "█".repeat(current);
  const empty = "░".repeat(total - current);
  return (
    <Box>
      <Text color="cyan">{filled}</Text>
      <Text dimColor>{empty}</Text>
      <Text dimColor>
        {"  "}
        {current}/{total}
      </Text>
    </Box>
  );
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return key.slice(0, 3) + "•".repeat(Math.max(0, key.length - 7)) + key.slice(-4);
}

// ─────────────────────────────────────────────────────────────────────
// Profile synthesis (one shot LLM call to merge answers → USER.md)
// ─────────────────────────────────────────────────────────────────────

interface SynthOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  answers: Record<string, string>;
  previous: string;
}

async function synthesizeProfile(opts: SynthOpts): Promise<string | null> {
  if (!opts.apiKey) {
    return fallbackProfile(opts.answers, opts.previous);
  }
  const lines = PROFILE_QUESTIONS.map(
    (q) => `Q: ${q.q}\nA: ${(opts.answers[q.id] ?? "").trim() || "(skipped)"}`,
  ).join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are constructing a USER.md profile from a short interview. Output ONLY clean GitHub-flavored markdown with these sections: Identity, Preferences, Projects, Patterns, Context. Be concise — 1-4 bullets per section, max. If the user skipped a question, omit that section instead of inventing content. Do not add a preamble or postscript.",
    },
    {
      role: "user",
      content: `Existing profile (may be empty):\n---\n${opts.previous || "(empty)"}\n---\n\nInterview:\n${lines}\n\nReturn the new USER.md content.`,
    },
  ];

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let out = "";
    for await (const ev of streamChat({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      messages,
      signal: ctrl.signal,
    })) {
      if (ev.type === "token") out += ev.content;
    }
    clearTimeout(timer);
    out = out.trim();
    if (!out) return fallbackProfile(opts.answers, opts.previous);
    return out;
  } catch {
    return fallbackProfile(opts.answers, opts.previous);
  }
}

function fallbackProfile(answers: Record<string, string>, _previous: string): string {
  const sections: string[] = ["# User Profile", ""];
  const map: Array<[string, string]> = [
    ["Identity", `${answers["name"] ? `- name: ${answers["name"]}\n` : ""}${answers["what_you_do"] ? `- what you do: ${answers["what_you_do"]}\n` : ""}`],
    ["Preferences", answers["style"] ? `- style: ${answers["style"]}\n` : ""],
    ["Projects", answers["current_focus"] ? `- current focus: ${answers["current_focus"]}\n` : ""],
    ["Patterns", answers["patterns"] ? `- focus aids: ${answers["patterns"]}\n` : ""],
    [
      "Context",
      `${answers["remember"] ? `- worth remembering: ${answers["remember"]}\n` : ""}${
        answers["anything_else"] ? `- other: ${answers["anything_else"]}\n` : ""
      }`,
    ],
  ];
  for (const [heading, body] of map) {
    if (body.trim()) {
      sections.push(`## ${heading}`);
      sections.push("");
      sections.push(body.trim());
      sections.push("");
    }
  }
  return sections.join("\n");
}
