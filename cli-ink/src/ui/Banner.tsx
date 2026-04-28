import React from "react";
import { Box, Text } from "ink";

const ART = [
  " █████╗ ████████╗██╗      █████╗ ███████╗",
  "██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝",
  "███████║   ██║   ██║     ███████║███████╗",
  "██╔══██║   ██║   ██║     ██╔══██║╚════██║",
  "██║  ██║   ██║   ███████╗██║  ██║███████║",
  "╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝",
];

// Per-line gradient — manual fade from cyan → blue. ink-gradient flattens
// multi-Text children into a single wrapping line, which mangled the art.
const LINE_COLORS = ["cyanBright", "cyan", "cyan", "blueBright", "blue", "blue"];

interface Props {
  version: string;
  model: string;
  hasApiKey: boolean;
}

export function Banner({ version, model, hasApiKey }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" paddingLeft={1}>
        {ART.map((line, i) => (
          <Text key={i} color={LINE_COLORS[i]} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text dimColor italic>
          your second brain
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          v{version}  ·  {model}
        </Text>
      </Box>
      {!hasApiKey && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="yellow">⚠  no openrouter key — set openrouter.api_key in config.toml</Text>
        </Box>
      )}
    </Box>
  );
}
