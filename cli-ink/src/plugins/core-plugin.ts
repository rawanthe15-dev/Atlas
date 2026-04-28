import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

/**
 * Built-in commands every channel needs: /help, /clear, /exit. These
 * resolve to "ui actions" rather than text — the App translates clear/
 * exit into the right side-effect for its surface.
 */
export class CorePlugin implements AtlasPlugin {
  name = "core";
  version = "0.2.0";

  load(kernel: Kernel): void {
    kernel.registerCommand({
      name: "/help",
      description: "Show available commands",
      handler: () => {
        const lines = [...kernel.commands.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `  ${c.name.padEnd(13)} ${c.description}`)
          .join("\n");
        return { kind: "text", text: lines, dim: true };
      },
    });

    kernel.registerCommand({
      name: "/clear",
      description: "Clear the screen",
      handler: () => ({ kind: "clear" }),
    });

    kernel.registerCommand({
      name: "/exit",
      description: "Exit Atlas",
      handler: () => ({ kind: "exit" }),
    });
  }
}
