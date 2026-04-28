import { exec } from "node:child_process";
import { InstallPolicy, PolicyDenied } from "./policy.js";
import type { MCPCandidate } from "./registry.js";
import type { BridgeSpec } from "./types.js";

export type InstallConfirmFn = (action: string, detail: string) => Promise<boolean> | boolean;

interface InstallPlan {
  preInstallCmd: string | null;
  runtimeCommand: string;
}

function planInstall(candidate: MCPCandidate): InstallPlan {
  const cmd = candidate.installCommand.trim();
  // npx / uvx self-install on first run.
  if (cmd.startsWith("npx ") || cmd.startsWith("uvx ")) {
    return { preInstallCmd: null, runtimeCommand: cmd };
  }
  // `pip install pkg && cmd`
  const pipMatch = cmd.match(/^pip install\s+([^\s;]+)\s*(?:&&\s*(.+))?$/);
  if (pipMatch) {
    const [, pkg, rest] = pipMatch;
    return {
      preInstallCmd: `pip install ${pkg}`,
      runtimeCommand: rest ?? pkg!.split("==")[0]!.split(">=")[0]!,
    };
  }
  return { preInstallCmd: null, runtimeCommand: cmd };
}

async function shellExec(cmd: string, timeoutMs = 600_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout ?? "") + (stderr ?? "");
      resolve({ code: err ? (err as any).code ?? 1 : 0, output });
    });
    child.on("error", () => {
      // exec callback handles this; harmless.
    });
  });
}

export class MCPInstaller {
  private policy: InstallPolicy;
  private confirm?: InstallConfirmFn;

  constructor(policy?: InstallPolicy, confirm?: InstallConfirmFn) {
    this.policy = policy ?? new InstallPolicy();
    this.confirm = confirm;
  }

  setConfirm(fn?: InstallConfirmFn): void {
    this.confirm = fn;
  }

  setPolicy(policy: InstallPolicy): void {
    this.policy = policy;
  }

  private async ask(action: string, detail: string): Promise<boolean> {
    if (!this.confirm) return true;
    const r = await this.confirm(action, detail);
    return Boolean(r);
  }

  /** Returns the BridgeSpec a DevicesPlugin can mount. */
  async installAndBuildSpec(
    candidate: MCPCandidate,
    deviceName: string,
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<BridgeSpec> {
    const plan = planInstall(candidate);
    const decision = this.policy.decideInstall(candidate.source, candidate.id);
    if (!decision.allow) throw new PolicyDenied(`install of '${candidate.id}' refused: ${decision.reason}`);

    if (decision.prompt) {
      const ok = await this.ask(
        "mount mcp server",
        `name: ${deviceName}\nsource: ${candidate.source}\nid: ${candidate.id}\nruntime command: ${plan.runtimeCommand}`,
      );
      if (!ok) throw new Error("user declined to mount MCP server");
    }

    if (plan.preInstallCmd) {
      if (decision.prompt) {
        const ok = await this.ask("install package", plan.preInstallCmd);
        if (!ok) throw new Error("user declined pre-install step");
      }
      const { code, output } = await shellExec(plan.preInstallCmd);
      if (code !== 0) throw new Error(`pre-install failed (exit ${code})\n${output.slice(-1000)}`);
    }

    return {
      name: deviceName,
      kind: "mcp",
      config: {
        transport: "stdio",
        command: plan.runtimeCommand,
        env: env ?? null,
        cwd: cwd ?? null,
      },
      capabilities: ["control", "telemetry"],
      description: `MCP server: ${candidate.description}`.slice(0, 300),
      createdAt: new Date().toISOString(),
    };
  }
}
