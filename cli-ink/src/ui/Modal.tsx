import React from "react";
import { Box, Text } from "ink";

interface Props {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
  hint?: string;
}

export function Modal({ title, borderColor = "cyan", children, hint }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color={borderColor} bold>
          {title}
        </Text>
      </Box>
      {children}
      {hint && (
        <Box marginTop={1}>
          <Text dimColor italic>
            {hint}
          </Text>
        </Box>
      )}
    </Box>
  );
}
