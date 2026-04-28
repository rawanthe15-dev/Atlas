import type { Tool } from "../tools/tool.js";
import type { Bridge } from "./base.js";
import type { ToolSpec } from "./types.js";

/**
 * Convert non-alphanumeric/_/- characters to `_`, then truncate to 64 —
 * matching OpenAI's tool-name rules. Namespace as `<device>__<tool>`.
 */
export function namespacedToolName(device: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${safe(device)}__${safe(tool)}`;
  return full.slice(0, 64);
}

/**
 * Adapter: turns `(Bridge, ToolSpec)` into the existing `Tool` interface so
 * the agent calls bridge tools just like any built-in.
 */
export class BridgeTool implements Tool {
  name: string;
  description: string;
  parameters: any;
  private bridge: Bridge;
  private spec: ToolSpec;

  constructor(bridge: Bridge, spec: ToolSpec) {
    this.bridge = bridge;
    this.spec = spec;
    this.name = namespacedToolName(bridge.name, spec.name);
    this.description = `[${bridge.name}] ${spec.description}`.trim();
    this.parameters = spec.parameters && typeof spec.parameters === "object"
      ? spec.parameters
      : { type: "object", properties: {}, required: [] };
  }

  async run(args: Record<string, any>): Promise<string> {
    try {
      const out = await this.bridge.invoke(this.spec, args);
      // Final safety net — if a bridge that doesn't already chunk its
      // output (e.g., http) returns a giant blob, truncate before it
      // hits the model's context. MCPBridge handles this internally with
      // file offloading; this is for everything else.
      const HARD_CAP = 32_000;
      if (out.length > HARD_CAP) {
        return (
          out.slice(0, HARD_CAP - 200) +
          `\n... (truncated — ${out.length - HARD_CAP} more chars dropped to protect context)`
        );
      }
      return out;
    } catch (e: any) {
      return `Bridge '${this.bridge.name}' error: ${e?.message ?? e}`;
    }
  }
}
