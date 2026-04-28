import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

export class SessionsPlugin implements AtlasPlugin {
  name = "sessions";
  version = "0.2.0";

  load(kernel: Kernel): void {
    kernel.registerCommand({
      name: "/sessions",
      description: "Browse + resume past conversations",
      handler: () => ({ kind: "modal", modal: "sessions" }),
    });
  }
}
