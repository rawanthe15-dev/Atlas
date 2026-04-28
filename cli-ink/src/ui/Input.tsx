import React from "react";
import { Box, Text } from "ink";
import { MultilineInput } from "./MultilineInput.js";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  isFocused?: boolean;
  onTab?: (currentValue: string) => string | null;
}

export function Input(props: Props): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginRight={1}>
        <Text color="cyan">◈</Text>
      </Box>
      <Box flexGrow={1}>
        {props.disabled ? (
          <Text dimColor italic>
            {props.placeholder ?? "(streaming…)"}
          </Text>
        ) : (
          <MultilineInput {...props} />
        )}
      </Box>
    </Box>
  );
}
