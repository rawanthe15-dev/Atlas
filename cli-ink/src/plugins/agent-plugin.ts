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

    kernel.registerCommand({
      name: "/compact",
      description: "Compact conversation history (summarise prior turns to free up context)",
      handler: async () => {
        try {
          const result = await kernel.agent.compact();
          if (result.before === 0) {
            return { kind: "text", text: "(history is empty — nothing to compact)", dim: true };
          }
          return {
            kind: "text",
            text:
              `compacted ${result.before} → ${result.after} tokens ` +
              `(${Math.round(((result.before - result.after) / result.before) * 100)}% reduction) ` +
              `via ${result.modelUsed}`,
            dim: true,
          };
        } catch (e: any) {
          return { kind: "error", text: `compact failed: ${e?.message ?? e}` };
        }
      },
    });
  }
}
