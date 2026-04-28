import React from "react";
import { Box, Text } from "ink";

export interface TurnPart {
  kind: "reasoning" | "tool_call" | "response";
  text: string;
}

export interface Turn {
  user: string;
  parts: TurnPart[];
}

interface Props {
  turn: Turn;
  /** When true, this turn is committed history; render slightly differently if desired. */
  done?: boolean;
}

/** Renders a user prompt + the assistant's reasoning, tool calls, and response in order. */
export function TurnView({ turn }: Props): React.ReactElement {
  // Group consecutive reasoning parts so they share one "✦ thinking" header.
  const blocks: TurnPart[] = [];
  for (const p of turn.parts) {
    const last = blocks[blocks.length - 1];
    if (p.kind === "reasoning" && last && last.kind === "reasoning") {
      last.text += p.text;
    } else {
      blocks.push({ ...p });
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          ›{" "}
        </Text>
        <Text>{turn.user}</Text>
      </Box>
      {blocks.map((b, i) => {
        if (b.kind === "reasoning") {
          return (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Text dimColor italic>
                ✦ thinking
              </Text>
              <Text dimColor>{b.text}</Text>
            </Box>
          );
        }
        if (b.kind === "tool_call") {
          return (
            <Box key={i} marginTop={1}>
              <Text dimColor>[calling: {b.text}…]</Text>
            </Box>
          );
        }
        return (
          <Box key={i} marginTop={1}>
            <Text>{b.text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
