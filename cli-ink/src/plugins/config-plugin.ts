import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

export class ConfigPlugin implements AtlasPlugin {
  name = "config";
  version = "0.2.0";

  load(kernel: Kernel): void {
    kernel.registerCommand({
      name: "/config",
      description: "Edit settings, API keys, persona",
      handler: () => ({ kind: "modal", modal: "config" }),
    });

    kernel.registerCommand({
      name: "/model",
      description: "Switch model — usage: /model [name]",
      handler: (ctx) => {
        if (ctx.arg) {
          // Inline: applied directly by the App via the `arg` payload — we
          // still return modal:model so the App takes the apply path. The
          // App reads the arg from the raw input.
          return { kind: "modal", modal: "model" };
        }
        return { kind: "modal", modal: "model" };
      },
    });

    kernel.registerCommand({
      name: "/update",
      description: "Pull the latest Atlas from git remote",
      handler: () => ({ kind: "modal", modal: "update" }),
    });

    kernel.registerCommand({
      name: "/version",
      description: "Show Atlas version + loaded plugins",
      handler: () => {
        const model = kernel.agent.getModel();
        const plugins = kernel.loadedPlugins().join(", ");
        return {
          kind: "text",
          text: `atlas-ink · model ${model} · plugins: ${plugins}`,
          color: "cyan",
        };
      },
    });
  }
}
