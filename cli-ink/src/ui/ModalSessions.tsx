import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal.js";
import type { Session } from "../memory/backend.js";

interface Props {
  sessions: Session[];
  /**
   * Resume a session into the active chat. The App is responsible for
   * committing the entries as turn views and seeding the agent's
   * conversation history.
   */
  onResume: (session: Session) => void;
  onClose: () => void;
}

type View = { kind: "list" } | { kind: "detail"; session: Session };

export function ModalSessions({ sessions, onResume, onClose }: Props): React.ReactElement {
  const [view, setView] = useState<View>({ kind: "list" });

  if (view.kind === "detail") {
    return <SessionDetail session={view.session} onBack={() => setView({ kind: "list" })} onResume={onResume} />;
  }
  return <SessionList sessions={sessions} onPick={(s) => setView({ kind: "detail", session: s })} onClose={onClose} />;
}

function SessionList({
  sessions,
  onPick,
  onClose,
}: {
  sessions: Session[];
  onPick: (s: Session) => void;
  onClose: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "b") {
      onClose();
      return;
    }
    const idx = Number.parseInt(input, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      onPick(sessions[idx - 1]);
    }
  });

  if (sessions.length === 0) {
    return (
      <Modal title="recent sessions" hint="press esc to close">
        <Text dimColor italic>
          no sessions yet — start a conversation
        </Text>
      </Modal>
    );
  }

  return (
    <Modal title="recent sessions" hint="press a number to open · esc / b to close">
      {sessions.map((s, i) => {
        const last = s.entries[s.entries.length - 1];
        const preview = last?.user.slice(0, 60).replace(/\n/g, " ") ?? "(empty)";
        return (
          <Box key={s.file}>
            <Text color="cyan" bold>
              {String(i + 1).padStart(2, " ")}{"  "}
            </Text>
            <Box flexDirection="column">
              <Text>
                <Text dimColor>{s.file.replace(".jsonl", "")}</Text>
                <Text dimColor>
                  {"  "}· {s.entries.length} exchange{s.entries.length !== 1 ? "s" : ""}
                </Text>
              </Text>
              <Text dimColor italic>
                {"   "}› {preview}
                {s.entries.length > 0 && last?.user && last.user.length > 60 ? "…" : ""}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Modal>
  );
}

function SessionDetail({
  session,
  onBack,
  onResume,
}: {
  session: Session;
  onBack: () => void;
  onResume: (s: Session) => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "b") {
      onBack();
      return;
    }
    if (input === "r") {
      onResume(session);
    }
  });

  // Show last 6 entries to fit on screen.
  const tail = session.entries.slice(-6);
  const hidden = session.entries.length - tail.length;

  return (
    <Modal title={`session › ${session.file.replace(".jsonl", "")}`} hint="press r to resume · b / esc to go back">
      {hidden > 0 && (
        <Text dimColor italic>
          … {hidden} earlier exchange{hidden !== 1 ? "s" : ""} hidden …
        </Text>
      )}
      {tail.map((e, i) => (
        <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Box>
            <Text color="cyan" bold>
              ›{" "}
            </Text>
            <Text>{truncate(e.user, 200)}</Text>
          </Box>
          <Text dimColor>{truncate(e.assistant, 240)}</Text>
        </Box>
      ))}
    </Modal>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
