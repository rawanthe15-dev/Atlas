import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal.js";
import { MultilineInput } from "./MultilineInput.js";

interface Props {
  title: string;
  /** Pre-loaded text to edit. */
  initial: string;
  onSave: (next: string) => Promise<void> | void;
  onClose: () => void;
}

/**
 * In-app editor for SOUL.md and USER.md. Avoids the $EDITOR / TTY-handoff
 * dance which is tricky inside Ink. Multi-line, ctrl+s saves, esc cancels.
 */
export function ModalEditor({ title, initial, onSave, onClose }: Props): React.ReactElement {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<"editing" | "saving" | "saved">("editing");

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  // Esc cancels at the modal level. The editor ignores Esc itself so the
  // app's outer useInput sees it.
  useInput((_input, key) => {
    if (key.escape && status !== "saving") onClose();
  });

  async function handleSave(next: string): Promise<void> {
    setStatus("saving");
    try {
      await onSave(next);
      setStatus("saved");
      // Brief "saved" pulse before closing.
      setTimeout(onClose, 450);
    } catch {
      setStatus("editing");
    }
  }

  const lineCount = value.split("\n").length;

  return (
    <Modal
      title={title}
      hint={
        status === "saving"
          ? "saving..."
          : status === "saved"
            ? "✓ saved"
            : "ctrl+s to save · esc to cancel · enter inserts newline"
      }
    >
      <Box flexDirection="column">
        <MultilineInput
          value={value}
          onChange={setValue}
          onSubmit={handleSave}
          submitKey="ctrl-s"
          isFocused={status === "editing"}
        />
        <Box marginTop={1}>
          <Text dimColor italic>
            {lineCount} line{lineCount !== 1 ? "s" : ""} · {value.length} chars
          </Text>
        </Box>
      </Box>
    </Modal>
  );
}
