import type { Tool, ToolSchema } from "./tool.js";
import { toSchema } from "./tool.js";
import { makeShellTool, type ShellConfirmFn } from "./shell.js";
import { readFileTool, writeFileTool, listDirTool } from "./filesystem.js";
import { makeGetUserProfileTool, makeUpdateUserProfileTool } from "./memory-tool.js";
import { makeBraveSearchTool } from "./web-search.js";
import { makeTodoTools } from "./todo-tools.js";
import type { MemoryBackend } from "../memory/backend.js";
import type { TodoStore } from "../memory/todos.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.all().map(toSchema);
  }
}

export interface RegistryOpts {
  memory: MemoryBackend;
  todos: TodoStore;
  shellConfirm?: ShellConfirmFn;
  braveApiKey?: string;
}

export function buildDefaultRegistry(opts: RegistryOpts): ToolRegistry {
  const r = new ToolRegistry();
  r.register(makeShellTool({ confirm: opts.shellConfirm }));
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(listDirTool);
  r.register(makeGetUserProfileTool(opts.memory));
  r.register(makeUpdateUserProfileTool(opts.memory));
  for (const t of makeTodoTools(opts.todos)) r.register(t);
  if (opts.braveApiKey) {
    r.register(makeBraveSearchTool(opts.braveApiKey));
  }
  return r;
}
