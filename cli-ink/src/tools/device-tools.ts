import { request } from "undici";
import type { Tool } from "./tool.js";
import type { DevicesAPI } from "../plugins/devices-plugin.js";
import type { BridgeSpec } from "../bridges/types.js";

function pickBaseDeviceName(id: string): string {
  return id.split("/").pop()!.replace(/^@/, "").replace(/^server-/, "");
}

export function makeAutoConnectTool(devices: DevicesAPI): Tool {
  return {
    name: "auto_connect",
    description:
      "Autonomously connect Atlas to a service or device. Searches public " +
      "MCP registries for an existing connector, picks the best match from " +
      "a TRUSTED source, installs it, and mounts it — all in one call. No " +
      "user prompts when the match is trusted. If no trusted match is " +
      "found, returns the candidate list so you can decide whether to " +
      "install a non-trusted one with `install_mcp`. If nothing matches, " +
      "fall back to `mount_device` with kind 'openapi' / 'http' / 'mcp'.\n\n" +
      "Use this FIRST whenever the user introduces a new device, app, or " +
      "service (browser, phone, camera, lights, github, slack, anything).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Local mount name to give this device" },
        query: { type: "string", description: "Keywords (e.g. 'playwright', 'github', 'spotify', 'filesystem')" },
      },
      required: ["name", "query"],
    },
    async run(args) {
      const name = String(args.name ?? "");
      const query = String(args.query ?? "");
      if (!name || !query) return "auto_connect requires both 'name' and 'query'";
      const result = await devices.autoConnect(name, query);
      return JSON.stringify(result, null, 2);
    },
  };
}

export function makeMountDeviceTool(devices: DevicesAPI): Tool {
  return {
    name: "mount_device",
    description:
      "Connect a new device to Atlas. Picks a Bridge implementation from " +
      "the supplied 'kind' and registers all of the device's tools as " +
      "`<device>__<tool>`. Persists across restarts.\n\n" +
      "Supported kinds (and required config keys):\n" +
      "  • http     — base_url, [headers], [timeout]\n" +
      "  • openapi  — spec_url, [base_url], [headers]\n" +
      "  • mcp      — transport ('stdio'|'http'), command|url, [env], [cwd], [headers]\n",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string" },
        config: { type: "object", additionalProperties: true },
        description: { type: "string" },
        capabilities: { type: "array", items: { type: "string" } },
      },
      required: ["name", "kind", "config"],
    },
    async run(args) {
      const spec: BridgeSpec = {
        name: String(args.name ?? ""),
        kind: String(args.kind ?? ""),
        config: (args.config as Record<string, any>) ?? {},
        description: String(args.description ?? ""),
        capabilities: Array.isArray(args.capabilities) ? args.capabilities.map(String) : [],
        createdAt: new Date().toISOString(),
      };
      try {
        const record = await devices.mount(spec);
        return `mounted '${record.spec.name}' (${record.spec.kind}) with ${record.toolNames.length} tools: ${record.toolNames.join(", ") || "(none)"}`;
      } catch (e: any) {
        return `mount failed: ${e?.message ?? e}`;
      }
    },
  };
}

export function makeUnmountDeviceTool(devices: DevicesAPI): Tool {
  return {
    name: "unmount_device",
    description: "Disconnect a mounted device and remove its tools.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async run(args) {
      try {
        await devices.unmount(String(args.name ?? ""));
        return `unmounted '${args.name}'`;
      } catch (e: any) {
        return `unmount failed: ${e?.message ?? e}`;
      }
    },
  };
}

export function makeListDevicesTool(devices: DevicesAPI): Tool {
  return {
    name: "list_devices",
    description: "List every device currently mounted in Atlas, with each device's tools and capabilities.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      const records = devices.list();
      if (records.length === 0) return "(no devices mounted)";
      return records
        .map((r) =>
          JSON.stringify(
            {
              name: r.spec.name,
              kind: r.spec.kind,
              capabilities: r.spec.capabilities,
              tools: r.toolNames,
              description: r.spec.description,
            },
            null,
            2,
          ),
        )
        .join("\n\n");
    },
  };
}

export function makeInspectDeviceTool(devices: DevicesAPI): Tool {
  return {
    name: "inspect_device",
    description: "Return full details (capabilities + tool list) for one mounted device.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async run(args) {
      const r = devices.get(String(args.name ?? ""));
      if (!r) return `no device named '${args.name}' is mounted`;
      return JSON.stringify(
        {
          name: r.spec.name,
          kind: r.spec.kind,
          capabilities: r.spec.capabilities,
          tools: r.toolNames,
          description: r.spec.description,
        },
        null,
        2,
      );
    },
  };
}

export function makeSearchMcpTool(devices: DevicesAPI): Tool {
  return {
    name: "search_mcp",
    description:
      "Search public MCP server registries (official, npm, GitHub) for ready-made connectors. " +
      "Use BEFORE building a custom bridge — many devices and services already have an MCP server.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
    async run(args) {
      const cands = await devices.searchMcp(String(args.query ?? ""), Number(args.limit ?? 10));
      if (cands.length === 0) return "(no MCP servers found for that query)";
      return JSON.stringify(
        cands.map((c) => ({
          id: c.id,
          source: c.source,
          name: c.name,
          description: c.description,
          install_command: c.installCommand,
          homepage: c.homepage,
          score: c.score,
        })),
        null,
        2,
      );
    },
  };
}

export function makeInstallMcpTool(devices: DevicesAPI): Tool {
  return {
    name: "install_mcp",
    description:
      "Install and mount an MCP server discovered via `search_mcp`. The user is " +
      "prompted to confirm if the candidate is from an untrusted source (the policy " +
      "gate handles trusted ones silently). After this returns, the MCP server's " +
      "tools are exposed as `<device_name>__<tool>`.",
    parameters: {
      type: "object",
      properties: {
        device_name: { type: "string" },
        candidate_id: { type: "string" },
        source: { type: "string", enum: ["npm", "github", "official", "custom"] },
        install_command: { type: "string" },
        description: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["device_name"],
    },
    async run(args) {
      const candidate_id = String(args.candidate_id ?? "");
      let install_command = String(args.install_command ?? "");
      const source = (String(args.source ?? "custom") || "custom") as any;
      if (!candidate_id && !install_command) {
        return "either candidate_id or install_command is required";
      }
      if (!install_command && candidate_id) {
        install_command =
          source === "official" ? `uvx ${candidate_id}` : `npx -y ${candidate_id}`;
      }
      try {
        const record = await devices.installAndMountMcp(
          {
            id: candidate_id || String(args.device_name),
            source,
            name: String(args.device_name),
            description: String(args.description ?? ""),
            installCommand: install_command,
            transport: "stdio",
            homepage: "",
            score: 0,
          },
          String(args.device_name),
          (args.env as Record<string, string>) ?? undefined,
          args.cwd ? String(args.cwd) : undefined,
        );
        return `installed + mounted '${record.spec.name}' with ${record.toolNames.length} tools: ${record.toolNames.join(", ") || "(none)"}`;
      } catch (e: any) {
        return `install/mount declined or failed: ${e?.message ?? e}`;
      }
    },
  };
}

export function makeIntrospectUrlTool(): Tool {
  return {
    name: "introspect_url",
    description:
      "Fetch the contents of a URL (an OpenAPI spec, a README, any web page) and " +
      "return the raw text — handy when sizing up a device or service before building a bridge.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "integer", description: "Cap on returned chars (default 8000)" },
      },
      required: ["url"],
    },
    async run(args) {
      const url = String(args.url ?? "");
      const maxChars = Number(args.max_chars ?? 8000);
      try {
        const res = await request(url, { method: "GET" });
        let text = await res.body.text();
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + `\n... (${text.length - maxChars} chars truncated)`;
        }
        return `HTTP ${res.statusCode} ${url}\n\n${text}`;
      } catch (e: any) {
        return `fetch failed: ${e?.message ?? e}`;
      }
    },
  };
}

export function pickDefaultDeviceName(candidateId: string): string {
  return pickBaseDeviceName(candidateId);
}
