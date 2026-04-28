import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";

export class OnboardingPlugin implements AtlasPlugin {
  name = "onboarding";
  version = "0.2.0";

  load(kernel: Kernel): void {
    kernel.registerCommand({
      name: "/onboarding",
      description: "Re-run the welcome flow (keeps existing keys & models)",
      handler: () => ({ kind: "modal", modal: "onboarding" }),
    });
  }
}
