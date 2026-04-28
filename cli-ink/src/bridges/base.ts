import type { BridgeSpec, ToolSpec } from "./types.js";

/**
 * The universal connection contract. Subclasses know how to talk to
 * one *kind* of system — Atlas only ever sees this interface.
 *
 * Lifecycle: `connect()` → `discover()` → `invoke()` per call → `aclose()`.
 */
export abstract class Bridge {
  static kind: string = "abstract";
  spec: BridgeSpec;

  constructor(spec: BridgeSpec) {
    this.spec = spec;
  }

  abstract connect(): Promise<void>;
  abstract discover(): Promise<ToolSpec[]>;
  abstract invoke(tool: ToolSpec, args: Record<string, any>): Promise<string>;

  async aclose(): Promise<void> {
    // default: nothing to close
  }

  get name(): string {
    return this.spec.name;
  }
}
