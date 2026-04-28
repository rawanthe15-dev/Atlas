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
  private installPolicy = new InstallPolicy();
  private installer = new MCPInstaller(this.installPolicy);
  private mountConfirm?: InstallConfirmFn;

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
    return this.mountInternal(spec, { persist: true, source: candidate.source, skipPolicy: true });
  }

  async autoConnect(name: string, query: string): Promise<any> {
    const cands = await this.searchMcp(query, 10);
    if (cands.length === 0) {
      return { status: "no_match", message: `no MCP servers matched '${query}'`, candidates: [] };
    }
    const trusted = cands.filter(
      (c) => this.installPolicy.isTrusted(c.source, c.id) && c.installCommand.trim().length > 0,
    );
    if (trusted.length > 0) {
      const chosen = trusted[0]!;
      try {
        const record = await this.installAndMountMcp(chosen, name);
        return {
          status: "mounted",
          device: {
            name: record.spec.name,
            kind: record.spec.kind,
            tools: record.toolNames,
            capabilities: record.spec.capabilities,
          },
          chose: candidateToJSON(chosen),
        };
      } catch (e: any) {
        if (e instanceof PolicyDenied) {
          return { status: "denied", message: e.message, candidates: cands.map(candidateToJSON) };
        }
        return {
          status: "install_failed",
          message: `trusted candidate ${chosen.id} failed: ${e?.message ?? e}`,
          candidates: cands.map(candidateToJSON),
        };
      }
    }
    return {
      status: "needs_confirmation",
      message: "found candidates but none are from a trusted source. call install_mcp(...) on one to confirm and proceed.",
      candidates: cands.slice(0, 5).map(candidateToJSON),
    };
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
