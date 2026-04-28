import path from "node:path";
import { ATLAS_ROOT } from "../config/config.js";
import type { AtlasPlugin } from "../kernel/plugin.js";
import type { Kernel } from "../kernel/kernel.js";
import type { Tool } from "../tools/tool.js";

import { Bridge } from "../bridges/base.js";
import { BridgeTool } from "../bridges/dynamic-tool.js";
import { InstallPolicy, PolicyDenied } from "../bridges/policy.js";
import { MCPInstaller, type InstallConfirmFn } from "../bridges/installer.js";
import {
  candidateToJSON,
  makeBridge,
  searchMcpRegistry,
  supportedKinds,
  type MCPCandidate,
} from "../bridges/registry.js";
import { DeviceStore } from "../bridges/state.js";
import type { BridgeSpec, DeviceRecord } from "../bridges/types.js";
import { specFromJSON } from "../bridges/types.js";
import { VerifiedStore, type VerifiedMCP } from "../bridges/verified.js";

import {
  makeAutoConnectTool,
  makeInspectDeviceTool,
  makeInstallMcpTool,
  makeIntrospectUrlTool,
  makeListDevicesTool,
  makeMountDeviceTool,
  makeSearchMcpTool,
  makeUnmountDeviceTool,
} from "../tools/device-tools.js";

export interface DevicesPluginOpts {
  installConfirm?: InstallConfirmFn;
}

export interface DevicesAPI {
  list(): DeviceRecord[];
  get(name: string): DeviceRecord | undefined;
  mount(spec: BridgeSpec, source?: string): Promise<DeviceRecord>;
  unmount(name: string): Promise<void>;
  searchMcp(query: string, limit?: number): Promise<MCPCandidate[]>;
  installAndMountMcp(c: MCPCandidate, deviceName: string, env?: Record<string, string>, cwd?: string): Promise<DeviceRecord>;
  autoConnect(name: string, query: string): Promise<{ status: string; [k: string]: any }>;
  policy(): InstallPolicy;
  setInstallConfirm(fn?: InstallConfirmFn): void;
  supportedKinds(): string[];
}

export class DevicesPlugin implements AtlasPlugin, DevicesAPI {
  name = "devices";
  version = "0.1.0";

  private records = new Map<string, DeviceRecord>();
  private bridges = new Map<string, Bridge>();
  private store!: DeviceStore;
  private verified!: VerifiedStore;
  private installPolicy = new InstallPolicy();
  private installer = new MCPInstaller(this.installPolicy);
  private mountConfirm?: InstallConfirmFn;
  private lastInstallQuery: string | null = null;

  constructor(private opts: DevicesPluginOpts = {}) {
    if (opts.installConfirm) {
      this.installer.setConfirm(opts.installConfirm);
      this.mountConfirm = opts.installConfirm;
    }
  }

  async load(kernel: Kernel): Promise<void> {
    this.kernelTools = kernel.tools;
    const cfg = (kernel.config as any).devices ?? {};
    this.installPolicy = new InstallPolicy(cfg.install_policy ?? "auto", cfg.trusted_sources);
    this.installer.setPolicy(this.installPolicy);

    const memPath = (kernel.config.memory?.path as string) ?? path.join(ATLAS_ROOT, "memory");
    this.store = new DeviceStore(path.join(memPath, "devices"));
    this.verified = new VerifiedStore(path.join(memPath, "devices"));

    // Expose the management tools on the agent's tool registry.
    const tools: Tool[] = [
      makeAutoConnectTool(this),
      makeMountDeviceTool(this),
      makeUnmountDeviceTool(this),
      makeListDevicesTool(this),
      makeInspectDeviceTool(this),
      makeSearchMcpTool(this),
      makeInstallMcpTool(this),
      makeIntrospectUrlTool(),
    ];
    for (const t of tools) kernel.tools.register(t);

    // Register a /devices command for interactive use.
    kernel.registerCommand({
      name: "/devices",
      description: "List connected devices",
      handler: () => {
        const list = this.list();
        if (list.length === 0) return { kind: "text", text: "(no devices mounted)", dim: true };
        const text = list
          .map((r) => {
            const caps = r.spec.capabilities.join(", ") || "—";
            return `  ${r.spec.name.padEnd(18)} ${r.spec.kind.padEnd(14)} caps=${caps}\n    tools: ${r.toolNames.join(", ") || "(none)"}`;
          })
          .join("\n");
        return { kind: "text", text, dim: true };
      },
    });

    // Auto-mount declared devices, then restore previously mounted ones.
    for (const entry of cfg.auto_mount ?? []) {
      try {
        await this.mountInternal(specFromJSON(entry), { persist: false, source: "config" });
      } catch (e: any) {
        // Log but don't abort startup.
        console.error(`[devices] auto_mount '${entry?.name ?? "?"}' failed: ${e?.message ?? e}`);
      }
    }
    const restored = await this.store.loadAll();
    for (const spec of restored) {
      if (this.records.has(spec.name)) continue;
      try {
        await this.mountInternal(spec, { persist: false, source: "restore" });
      } catch (e: any) {
        console.error(`[devices] could not restore '${spec.name}': ${e?.message ?? e}`);
      }
    }
  }

  async unload(): Promise<void> {
    for (const name of [...this.records.keys()]) {
      try {
        await this.unmountInternal(name, { persist: false });
      } catch {
        /* best-effort */
      }
    }
  }

  // ── public API ────────────────────────────────────────────────────────

  list(): DeviceRecord[] {
    return [...this.records.values()];
  }

  get(name: string): DeviceRecord | undefined {
    return this.records.get(name);
  }

  policy(): InstallPolicy {
    return this.installPolicy;
  }

  setInstallConfirm(fn?: InstallConfirmFn): void {
    this.mountConfirm = fn;
    this.installer.setConfirm(fn);
  }

  supportedKinds(): string[] {
    return supportedKinds();
  }

  async mount(spec: BridgeSpec, source = "user"): Promise<DeviceRecord> {
    return this.mountInternal(spec, { persist: true, source });
  }

  async unmount(name: string): Promise<void> {
    await this.unmountInternal(name, { persist: true });
  }

  async searchMcp(query: string, limit = 10): Promise<MCPCandidate[]> {
    return searchMcpRegistry(query, limit);
  }

  async installAndMountMcp(
    candidate: MCPCandidate,
    deviceName: string,
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<DeviceRecord> {
    const spec = await this.installer.installAndBuildSpec(candidate, deviceName, env, cwd);
    const record = await this.mountInternal(spec, {
      persist: true,
      source: candidate.source,
      skipPolicy: true,
    });
    // Smoke test catches MCPs that mount fine but their runtime is broken.
    // This protects EVERY install path (auto_connect AND manual install_mcp).
    const smoke = await this.smokeTestMounted(record);
    if (!smoke.ok) {
      try {
        await this.unmount(deviceName);
      } catch {
        /* ignore */
      }
      // If this candidate was previously verified for some other query,
      // its runtime is now missing — forget it so we don't reuse it.
      try {
        await this.verified.forget(candidate.id);
      } catch {
        /* ignore */
      }
      throw new Error(
        `installed but the runtime is missing on this machine: ${smoke.error ?? "smoke test failed"}`,
      );
    }
    // Smoke passed — remember this candidate as known-good for the query
    // that brought us here. `lastInstallQuery` is set by autoConnect; for
    // direct install_mcp calls there's no query, so we use the candidate's
    // own name as a weak keyword.
    try {
      const queryHint = this.lastInstallQuery ?? `${candidate.name} ${candidate.description}`;
      await this.verified.record(candidate, queryHint);
    } catch {
      /* best-effort */
    }
    return record;
  }

  async autoConnect(name: string, query: string): Promise<any> {
    this.lastInstallQuery = query;
    // 0. Verified cache — try anything we've previously confirmed works
    //    on THIS machine for a similar query, before hitting public registries.
    const verifiedHits = await this.verified.match(query);
    const tried: Array<{ id: string; reason: string }> = [];
    const MAX_ATTEMPTS = 3;
    for (const v of verifiedHits.slice(0, MAX_ATTEMPTS)) {
      const fakeCandidate: MCPCandidate = {
        id: v.id, source: v.source, name: v.name, description: v.description,
        installCommand: v.installCommand, transport: "stdio", homepage: "", score: 100,
      };
      try {
        const record = await this.installAndMountMcp(fakeCandidate, name);
        return {
          status: "mounted",
          source_used: "verified_cache",
          device: {
            name: record.spec.name,
            kind: record.spec.kind,
            tools: record.toolNames,
            capabilities: record.spec.capabilities,
          },
          chose: candidateToJSON(fakeCandidate),
        };
      } catch (e: any) {
        tried.push({ id: v.id, reason: `verified-cache entry failed: ${String(e?.message ?? e).slice(0, 200)}` });
        // verified entry got forgotten in installAndMountMcp on smoke-fail
      }
    }

    const cands = await this.searchMcp(query, 10);
    if (cands.length === 0 && tried.length === 0) {
      return { status: "no_match", message: `no MCP servers matched '${query}'`, candidates: [] };
    }
    const trusted = cands.filter(
      (c) => this.installPolicy.isTrusted(c.source, c.id) && c.installCommand.trim().length > 0,
    );
    if (trusted.length === 0 && tried.length === 0) {
      return {
        status: "needs_confirmation",
        message:
          "found candidates but none are from a trusted source. call install_mcp(...) on one to confirm and proceed.",
        candidates: cands.slice(0, 5).map(candidateToJSON),
      };
    }
    // Walk trusted candidates. installAndMountMcp runs smoke test
    // internally and throws on failure, so a successful return = working MCP.
    for (const cand of trusted.slice(0, MAX_ATTEMPTS - tried.length)) {
      try {
        const record = await this.installAndMountMcp(cand, name);
        return {
          status: "mounted",
          source_used: "registry_search",
          device: {
            name: record.spec.name,
            kind: record.spec.kind,
            tools: record.toolNames,
            capabilities: record.spec.capabilities,
          },
          chose: candidateToJSON(cand),
          tried,
        };
      } catch (e: any) {
        if (e instanceof PolicyDenied) {
          return { status: "denied", message: e.message, candidates: cands.map(candidateToJSON) };
        }
        tried.push({ id: cand.id, reason: String(e?.message ?? e).slice(0, 240) });
        continue;
      }
    }
    return {
      status: "all_candidates_failed",
      message:
        `tried ${tried.length} trusted candidate${tried.length === 1 ? "" : "s"} for '${query}'; ` +
        `each one mounted but the runtime is missing on this machine. ` +
        `report this to the user — don't keep retrying. tell them what was tried and the error pattern.`,
      tried,
      candidates: cands.slice(0, 5).map(candidateToJSON),
    };
  }

  /**
   * Probe a freshly-mounted MCP to verify its runtime is actually usable.
   *
   * Strategy: pick a low-risk tool (read-only-looking name like list_*,
   * get_*, status, ping; otherwise a tool with required params so the
   * empty-args call fails validation harmlessly). Call it with empty args.
   * Examine the result for runtime-missing patterns ("Executable doesn't
   * exist", "ENOENT", "MODULE_NOT_FOUND", "please run ... install", etc.).
   *
   * Validation errors and other non-runtime errors mean the MCP is alive —
   * smoke passes. Only the runtime-missing patterns are treated as fatal.
   *
   * If no tool is safe to probe, smoke is skipped (returns ok). Better to
   * let a real call surface the issue than to side-effect on smoke.
   */
  private async smokeTestMounted(record: DeviceRecord): Promise<{ ok: boolean; error?: string }> {
    if (record.spec.kind !== "mcp" || record.toolNames.length === 0) {
      return { ok: true };
    }
    const probeName = this.pickSmokeTool(record);
    if (!probeName) return { ok: true };
    const tool = this.kernelTools.get(probeName);
    if (!tool) return { ok: true };
    try {
      const TIMEOUT_MS = 30_000;
      const result = await Promise.race([
        tool.run({}),
        new Promise<string>((resolve) => setTimeout(() => resolve("__smoke_timeout__"), TIMEOUT_MS)),
      ]);
      if (result === "__smoke_timeout__") return { ok: true };
      if (looksLikeRuntimeMissing(result)) {
        return { ok: false, error: result.slice(0, 240) };
      }
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (looksLikeRuntimeMissing(msg)) {
        return { ok: false, error: msg.slice(0, 240) };
      }
      return { ok: true };
    }
  }

  private pickSmokeTool(record: DeviceRecord): string | undefined {
    // Tier 1: action-style tools that EXERCISE the runtime. These are the
    // ones most likely to surface missing-binary errors ("Executable doesn't
    // exist") because their handlers call into the underlying engine before
    // bothering to validate args. For non-browser MCPs, none of these
    // prefixes match, so we fall through to safer probes.
    const ACTION_PROBES =
      /^(playwright_|browser_|browse_|page_|navigate|launch|open_page|open_browser|start_browser)/i;
    for (const fullName of record.toolNames) {
      const stripped = fullName.replace(`${record.spec.name}__`, "");
      if (ACTION_PROBES.test(stripped)) return fullName;
    }
    // Tier 2: read-only-looking names — safe to call with empty args.
    const READONLY_PREFIXES =
      /^(list|get|info|status|describe|ping|health|version|tools|capabilities)/i;
    for (const fullName of record.toolNames) {
      const stripped = fullName.replace(`${record.spec.name}__`, "");
      if (READONLY_PREFIXES.test(stripped)) return fullName;
    }
    // Tier 3: any tool whose schema requires args. Empty-args call fails
    // validation harmlessly (and we'll inspect the error pattern).
    for (const fullName of record.toolNames) {
      const tool = this.kernelTools.get(fullName);
      const required = (tool as any)?.parameters?.required;
      if (Array.isArray(required) && required.length > 0) return fullName;
    }
    return undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async mountInternal(
    spec: BridgeSpec,
    opts: { persist: boolean; source?: string; skipPolicy?: boolean },
  ): Promise<DeviceRecord> {
    if (this.records.has(spec.name)) {
      throw new Error(`device '${spec.name}' is already mounted; unmount first`);
    }

    if (!opts.skipPolicy) {
      const decision = this.installPolicy.decideMount(spec.kind, opts.source ?? "user", spec.name);
      if (!decision.allow) throw new PolicyDenied(`mount '${spec.name}' refused: ${decision.reason}`);
      if (decision.prompt && this.mountConfirm) {
        const ok = await this.mountConfirm(
          "mount risky bridge",
          `name: ${spec.name}\nkind: ${spec.kind}\nconfig: ${JSON.stringify(spec.config)}`,
        );
        if (!ok) throw new Error("user declined to mount risky bridge");
      }
    }

    const bridge = await makeBridge(spec);
    await bridge.connect();
    const toolSpecs = await bridge.discover();
    if (spec.capabilities.length === 0) {
      const ctor = bridge.constructor as any;
      if (typeof ctor.defaultCapabilities === "function") {
        spec.capabilities = ctor.defaultCapabilities();
      }
    }

    const registered: string[] = [];
    for (const ts of toolSpecs) {
      const tool = new BridgeTool(bridge, ts);
      this.kernelTools.register(tool);
      registered.push(tool.name);
    }

    const record: DeviceRecord = { spec, toolNames: registered };
    this.records.set(spec.name, record);
    this.bridges.set(spec.name, bridge);
    if (opts.persist) await this.store.save(spec);
    return record;
  }

  private async unmountInternal(name: string, opts: { persist: boolean }): Promise<void> {
    const record = this.records.get(name);
    const bridge = this.bridges.get(name);
    if (!record) throw new Error(`device '${name}' is not mounted`);
    this.records.delete(name);
    this.bridges.delete(name);

    for (const tn of record.toolNames) this.kernelTools.unregister(tn);
    if (bridge) {
      try {
        await bridge.aclose();
      } catch {
        /* ignore */
      }
    }
    if (opts.persist) await this.store.delete(name);
  }

  // We need a stable reference to the kernel's ToolRegistry — captured in `load`.
  private kernelTools!: Kernel["tools"];
}

const RUNTIME_MISSING_PATTERNS = [
  /Executable doesn'?t exist/i,
  /Browser was not found/i,
  /Looks like Playwright Test or Playwright was just installed/i,
  /please run.*install/i,
  /\bENOENT\b/,
  /\bMODULE_NOT_FOUND\b/,
  /Cannot find module/i,
  /command not found/i,
  /spawn .* ENOENT/,
];

function looksLikeRuntimeMissing(s: string): boolean {
  return RUNTIME_MISSING_PATTERNS.some((p) => p.test(s));
}
