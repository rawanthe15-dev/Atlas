import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  prompt: string;
  initial?: string;
  secret?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Minimal single-line input used inside modals. Enter submits, Esc cancels. */
export function SingleLineInput({ prompt, initial = "", secret, onSubmit, onCancel }: Props): React.ReactElement {
  const [value, setValue] = useState(initial);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });

  const display = secret ? "•".repeat(value.length) : value;

  return (
    <Box>
      <Text>{prompt}</Text>
      <Text>{display}</Text>
      <Text inverse> </Text>
    </Box>
  );
}
