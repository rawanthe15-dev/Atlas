import React from "react";
import { Box, Text } from "ink";

interface Props {
  model: string;
  exchanges: number;
  apiKeySet: boolean;
  isProcessing: boolean;
}

export function Toolbar({ model, exchanges, apiKeySet, isProcessing }: Props): React.ReactElement {
  const dot = apiKeySet ? "●" : "○";
  const dotColor = apiKeySet ? "cyan" : "yellow";

  return (
    <Box paddingLeft={2} paddingRight={2}>
      <Text color={dotColor} bold>
        {dot}
      </Text>
      <Text dimColor italic>
        {"  "}{model}{"  ·  "}
      </Text>
      {isProcessing ? (
        <>
          <Text color="cyan" bold>
            thinking…
          </Text>
          <Text dimColor italic>
            {"  ·  press "}
          </Text>
          <Text color="cyan" bold>
            esc
          </Text>
          <Text dimColor italic>
            {" to interrupt"}
          </Text>
        </>
      ) : (
        <>
          <Text dimColor italic>
            {exchanges} exchange{exchanges !== 1 ? "s" : ""}{"  ·  type "}
          </Text>
          <Text color="cyan" bold>
            /
          </Text>
          <Text dimColor italic>
            {" for commands"}
          </Text>
        </>
      )}
    </Box>
  );
}
