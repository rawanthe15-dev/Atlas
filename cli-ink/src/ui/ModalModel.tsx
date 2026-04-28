import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal.js";
import { SingleLineInput } from "./SingleLineInput.js";

interface Props {
  favorites: string[];
  current: string;
  onPick: (model: string) => void;
  onClose: () => void;
}

/** /model interactive picker. Numbered favorites, "n" to enter a new model name, "b" or Esc to back out. */
export function ModalModel({ favorites, current, onPick, onClose }: Props): React.ReactElement {
  const [enteringNew, setEnteringNew] = useState(false);

  useInput(
    (input, key) => {
      if (enteringNew) return; // delegate to SingleLineInput
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "b") {
        onClose();
        return;
      }
      if (input === "n") {
        setEnteringNew(true);
        return;
      }
      const idx = Number.parseInt(input, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= favorites.length) {
        const chosen = favorites[idx - 1];
        if (chosen) onPick(chosen);
      }
    },
    { isActive: !enteringNew },
  );

  if (enteringNew) {
    return (
      <Modal title="switch model — new" hint="enter a model id (e.g. anthropic/claude-sonnet-4-5)">
        <SingleLineInput
          prompt="model › "
          onSubmit={(v) => {
            const name = v.trim();
            if (name) onPick(name);
            else onClose();
          }}
          onCancel={() => setEnteringNew(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal title="switch model" hint="press 1-3, n for new, b or esc to back out">
      {favorites.map((m, i) => {
        const isCurrent = m === current;
        return (
          <Box key={i}>
            <Text color={isCurrent ? "green" : "gray"}>{isCurrent ? "● " : "○ "}</Text>
            <Text color="cyan" bold>
              {i + 1}{"  "}
            </Text>
            <Text>{m || "(empty slot)"}</Text>
          </Box>
        );
      })}
      <Box>
        <Text color="gray">○ </Text>
        <Text color="cyan" bold>
          n{"  "}
        </Text>
        <Text>use a new model</Text>
      </Box>
      <Box>
        <Text color="gray">○ </Text>
        <Text color="cyan" bold>
          b{"  "}
        </Text>
        <Text>back</Text>
      </Box>
    </Modal>
  );
}
