import type { Tool } from "./tool.js";
import type { MemoryBackend } from "../memory/backend.js";

export function makeGetUserProfileTool(memory: MemoryBackend): Tool {
  return {
    name: "get_user_profile",
    description: "Read the current USER.md profile to recall facts about the user.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      return memory.getUserProfile();
    },
  };
}

export function makeUpdateUserProfileTool(memory: MemoryBackend): Tool {
  return {
    name: "update_user_profile",
    description:
      "Replace USER.md with a new full markdown profile. Use only when persistent facts about the user have changed.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown profile to save as USER.md." },
      },
      required: ["content"],
    },
    async run(args) {
      const content = String(args.content ?? "");
      if (!content) return "Tool error: missing 'content'.";
      await memory.updateUserProfile(content);
      return "USER.md updated.";
    },
  };
}
