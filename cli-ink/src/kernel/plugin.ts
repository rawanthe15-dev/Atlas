import type { Kernel } from "./kernel.js";

/**
 * A plugin is anything that wires capabilities into the kernel: tools,
 * slash commands, the memory backend, the agent, etc. The kernel calls
 * `load(kernel)` once at startup. `unload()` is optional — used by long-
 * lived channels (Telegram, voice) to teardown cleanly.
 */
export interface AtlasPlugin {
  name: string;
  version?: string;
  load(kernel: Kernel): Promise<void> | void;
  unload?(): Promise<void> | void;
}
