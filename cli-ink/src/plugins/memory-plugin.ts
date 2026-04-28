import { FileMemoryBackend } from "../memory/file-backend.js";
import { VectorMemoryBackend } from "../memory/vector-backend.js";
import type { MemoryBackend } from "../memory/backend.js";
import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

/**
 * Reads `[memory]` from config and instantiates the matching backend.
 * Vector backend silently degrades to file-style search if the
 * embeddings endpoint isn't configured.
 */
export class MemoryPlugin implements AtlasPlugin {
  name = "memory";
  version = "0.2.0";

  async load(kernel: Kernel): Promise<void> {
    kernel.memory = await buildMemoryBackend(kernel);
    await kernel.memory.init();

    kernel.registerCommand({
      name: "/memory",
      description: "Show what Atlas knows about you",
      handler: async () => {
        const profile = await kernel.memory.getUserProfile();
        return { kind: "text", text: profile.trim() || "(no user profile yet)", dim: true };
      },
    });

    kernel.registerCommand({
      name: "/soul",
      description: "Show Atlas's identity (SOUL.md)",
      handler: async () => {
        const soul = await kernel.memory.getSoul();
        return { kind: "text", text: soul.trim(), dim: true };
      },
    });
  }
}

export async function buildMemoryBackend(kernel: Kernel): Promise<MemoryBackend> {
  const cfg = kernel.config.memory;
  const want = cfg?.backend ?? "file";
  if (want === "vector") {
    const e = cfg?.embeddings;
    if (e?.api_key && e?.model) {
      return new VectorMemoryBackend({
        basePath: cfg?.path,
        embeddings: {
          apiKey: e.api_key,
          model: e.model,
          baseUrl: e.base_url ?? "https://api.openai.com/v1",
        },
      });
    }
    // Misconfigured — fall back to file silently. /config will surface
    // the missing keys so the user can fix it.
  }
  return new FileMemoryBackend({ basePath: cfg?.path });
}
