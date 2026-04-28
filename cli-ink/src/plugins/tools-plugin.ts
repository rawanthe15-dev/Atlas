import { buildDefaultRegistry } from "../tools/registry.js";
import type { ShellConfirmFn } from "../tools/shell.js";
import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";
import { TodoStore } from "../memory/todos.js";

export interface ToolsPluginOpts {
  shellConfirm?: ShellConfirmFn;
}

export class ToolsPlugin implements AtlasPlugin {
  name = "tools";
  version = "0.3.0";

  constructor(private opts: ToolsPluginOpts = {}) {}

  load(kernel: Kernel): void {
    kernel.braveApiKey = kernel.config.tools?.brave_api_key;
    kernel.todos = new TodoStore();

    const registry = buildDefaultRegistry({
      memory: kernel.memory,
      todos: kernel.todos,
      shellConfirm: this.opts.shellConfirm,
      braveApiKey: kernel.braveApiKey,
    });
    // Migrate registered tools onto the kernel registry. We can't just
    // assign because other plugins may have registered tools first.
    for (const t of registry.all()) kernel.tools.register(t);

    kernel.registerCommand({
      name: "/tools",
      description: "List available tools",
      handler: () => {
        const text = kernel.tools
          .all()
          .map((t) => `  ${t.name.padEnd(22)} ${t.description.split("\n")[0]}`)
          .join("\n");
        return { kind: "text", text, dim: true };
      },
    });

    kernel.registerCommand({
      name: "/todos",
      description: "Show your active todo list",
      handler: async () => {
        const list = await kernel.todos.list({ includeDone: false });
        if (list.length === 0) return { kind: "text", text: "(no active todos)", dim: true };
        const text = list
          .map((t) => `[${t.id}] [${t.status.padEnd(11)}] ${t.title}`)
          .join("\n");
        return { kind: "text", text, dim: true };
      },
    });
  }
}
