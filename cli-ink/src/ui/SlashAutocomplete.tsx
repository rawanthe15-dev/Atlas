import React from "react";
import { Box, Text } from "ink";

interface Props {
  input: string;
  commands: Record<string, string>;
}

/** Compact dropdown shown above the Input when the user starts typing a slash command. */
export function SlashAutocomplete({ input, commands }: Props): React.ReactElement | null {
  if (!input.startsWith("/")) return null;
  const lowered = input.toLowerCase();
  const matches = Object.entries(commands).filter(([cmd]) => cmd.startsWith(lowered));
  if (matches.length === 0) return null;

  // Cap how many we show to keep the popup compact.
  const visible = matches.slice(0, 8);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {visible.map(([cmd, desc]) => {
        // Highlight the matched prefix on each line.
        const matched = cmd.slice(0, input.length);
        const remainder = cmd.slice(input.length);
        return (
          <Box key={cmd}>
            <Text color="cyan" bold>
              {matched}
            </Text>
            <Text>{remainder}</Text>
            <Text>{"  "}</Text>
            <Text dimColor italic>
              {desc}
            </Text>
          </Box>
        );
      })}
      {matches.length > visible.length && (
        <Text dimColor italic>
          {"… "}
          {matches.length - visible.length} more
        </Text>
      )}
      <Text dimColor italic>
        tab to autocomplete
      </Text>
    </Box>
  );
}

/**
 * Compute the autocompletion for the current input.
 *
 * Returns null if no match. Otherwise:
 * - exactly one match → the full command + a trailing space
 * - multiple matches → the longest common prefix (only if it extends the current input)
 */
export function completeSlash(input: string, commands: Record<string, string>): string | null {
  if (!input.startsWith("/")) return null;
  const lowered = input.toLowerCase();
  const matches = Object.keys(commands).filter((c) => c.startsWith(lowered));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] + " ";
  let prefix = matches[0];
  for (const m of matches) {
    while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix.length > input.length ? prefix : null;
}
