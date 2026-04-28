/**
 * Trust policy gate. Trusted MCP sources install silently; unknown sources
 * prompt once. `auto` is the default — autonomy without recklessness.
 */

const RISKY_KINDS = new Set(["mcp", "process", "shell"]);

const DEFAULT_TRUSTED = ["official", "npm:@modelcontextprotocol/*"];

export class PolicyDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDenied";
  }
}

export interface PolicyDecision {
  allow: boolean;
  prompt: boolean;
  reason: string;
}

export type PolicyMode = "auto" | "prompt" | "off";

function fnmatch(pattern: string, value: string): boolean {
  // Convert glob to a regex anchored at both ends.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(value);
}

export class InstallPolicy {
  mode: PolicyMode;
  trustedSources: string[];

  constructor(mode: string = "auto", trustedSources?: string[]) {
    const m = (mode || "auto").toLowerCase();
    this.mode = (m === "auto" || m === "prompt" || m === "off" ? m : "auto") as PolicyMode;
    this.trustedSources = trustedSources ?? [...DEFAULT_TRUSTED];
  }

  isTrusted(source: string, candidateId: string): boolean {
    for (const pat of this.trustedSources) {
      if (pat.includes(":")) {
        const idx = pat.indexOf(":");
        const src = pat.slice(0, idx);
        const glob = pat.slice(idx + 1);
        if (src === source && fnmatch(glob, candidateId)) return true;
      } else if (pat === source) {
        return true;
      }
    }
    return false;
  }

  decideInstall(source: string, candidateId: string): PolicyDecision {
    if (this.mode === "off") return { allow: false, prompt: false, reason: "install_policy=off" };
    if (this.mode === "prompt") return { allow: true, prompt: true, reason: "install_policy=prompt" };
    if (this.isTrusted(source, candidateId)) return { allow: true, prompt: false, reason: "trusted source" };
    return { allow: true, prompt: true, reason: "untrusted source — confirming" };
  }

  decideMount(kind: string, source = "user", id = ""): PolicyDecision {
    if (!RISKY_KINDS.has(kind)) return { allow: true, prompt: false, reason: "non-risky kind" };
    if (this.mode === "off") return { allow: false, prompt: false, reason: "install_policy=off" };
    if (this.mode === "prompt") return { allow: true, prompt: true, reason: "install_policy=prompt" };
    if (this.isTrusted(source, id)) return { allow: true, prompt: false, reason: "trusted" };
    return { allow: true, prompt: true, reason: "risky kind — confirming once" };
  }
}
