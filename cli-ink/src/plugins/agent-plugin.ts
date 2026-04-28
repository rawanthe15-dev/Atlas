import { Agent } from "../agent/agent.js";
import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

export class AgentPlugin implements AtlasPlugin {
  name = "agent";
  version = "0.2.0";

  load(kernel: Kernel): void {
    const c = kernel.config;
    kernel.agent = new Agent({
      apiKey: c.openrouter?.api_key ?? "",
      baseUrl: c.openrouter?.base_url ?? "https://openrouter.ai/api/v1/chat/completions",
      model: c.openrouter?.default_model ?? "deepseek/deepseek-chat",
      tools: kernel.tools,
      memory: kernel.memory,
      todos: kernel.todos,
      maxContextEntries: c.memory?.max_context_entries ?? 5,
      maxSessionHistory: c.memory?.max_session_history ?? 3,
    });
  }
}
