/**
 * Shared types for the device-connectivity layer.
 *
 * A `Bridge` is anything Atlas can plug into — a REST API, an MCP server,
 * a browser, a phone over ADB, an arbitrary HTTP endpoint. Each bridge
 * exposes a list of `ToolSpec`s that get registered into the agent's
 * tool registry as namespaced `<device>__<tool>` callables.
 */

export type Capability =
  | "control"
  | "telemetry"
  | "vision"
  | "audio"
  | "stream"
  | "navigation"
  | "communication";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-Schema parameters object suitable for OpenAI function-calling. */
  parameters: Record<string, any>;
  /** Opaque payload the bridge interprets when `invoke()` is called. */
  handler: Record<string, any>;
}

export interface BridgeSpec {
  name: string;
  kind: string;                 // "http" | "openapi" | "mcp" | …
  config: Record<string, any>;
  capabilities: string[];
  description: string;
  createdAt: string;
}

export interface DeviceRecord {
  spec: BridgeSpec;
  toolNames: string[];
}

/** Persistable JSON form of BridgeSpec — stable over Atlas restarts. */
export function specToJSON(s: BridgeSpec): any {
  return {
    name: s.name,
    kind: s.kind,
    config: s.config,
    capabilities: s.capabilities,
    description: s.description,
    created_at: s.createdAt,
  };
}

export function specFromJSON(obj: any): BridgeSpec {
  return {
    name: String(obj.name),
    kind: String(obj.kind),
    config: obj.config ?? {},
    capabilities: Array.isArray(obj.capabilities) ? obj.capabilities.map(String) : [],
    description: String(obj.description ?? ""),
    createdAt: String(obj.created_at ?? new Date().toISOString()),
  };
}

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}
