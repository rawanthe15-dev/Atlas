import { request } from "undici";
import { Bridge } from "./base.js";
import type { BridgeSpec } from "./types.js";

export interface MCPCandidate {
  id: string;
  source: "official" | "npm" | "github" | "custom";
  name: string;
  description: string;
  installCommand: string;
  transport: "stdio" | "http";
  homepage: string;
  score: number;
}

export function candidateToJSON(c: MCPCandidate): any {
  return {
    id: c.id,
    source: c.source,
    name: c.name,
    description: c.description,
    install_command: c.installCommand,
    transport: c.transport,
    homepage: c.homepage,
    score: c.score,
  };
}

export async function makeBridge(spec: BridgeSpec): Promise<Bridge> {
  const k = spec.kind.toLowerCase();
  if (k === "http") {
    const m = await import("./http-bridge.js");
    return new m.HTTPBridge(spec);
  }
  if (k === "openapi") {
    const m = await import("./openapi-bridge.js");
    return new m.OpenAPIBridge(spec);
  }
  if (k === "mcp") {
    const m = await import("./mcp-bridge.js");
    return new m.MCPBridge(spec);
  }
  throw new Error(`unknown bridge kind '${spec.kind}'. supported: http, openapi, mcp`);
}

export function supportedKinds(): string[] {
  return ["http", "openapi", "mcp"];
}

// ─── MCP server search across public registries ──────────────────────────

async function searchNpm(query: string, limit: number): Promise<MCPCandidate[]> {
  try {
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", `${query} mcp-server`);
    url.searchParams.set("size", String(limit));
    const res = await request(url, { method: "GET" });
    if (res.statusCode !== 200) return [];
    const data: any = await res.body.json();
    const out: MCPCandidate[] = [];
    for (const hit of data?.objects ?? []) {
      const pkg = hit?.package ?? {};
      const name = String(pkg.name ?? "");
      const isMcp =
        name.startsWith("@modelcontextprotocol/server-") ||
        name.includes("mcp-server") ||
        (Array.isArray(pkg.keywords) && pkg.keywords.includes("mcp"));
      if (!isMcp) continue;
      out.push({
        id: name,
        source: "npm",
        name,
        description: String(pkg.description ?? "").slice(0, 240),
        installCommand: `npx -y ${name}`,
        transport: "stdio",
        homepage: String(pkg.links?.homepage ?? ""),
        score: Number(hit?.score?.final ?? 0),
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function searchGithub(query: string, limit: number): Promise<MCPCandidate[]> {
  try {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", `${query} topic:mcp-server`);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("per_page", String(limit));
    const res = await request(url, {
      method: "GET",
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.statusCode !== 200) return [];
    const data: any = await res.body.json();
    const out: MCPCandidate[] = [];
    for (const repo of data?.items ?? []) {
      const full = String(repo.full_name ?? "");
      const lang = String(repo.language ?? "").toLowerCase();
      const install =
        lang === "python" || lang === "py"
          ? `uvx --from git+https://github.com/${full} mcp-server`
          : `npx -y github:${full}`;
      out.push({
        id: full,
        source: "github",
        name: String(repo.name ?? full),
        description: String(repo.description ?? "").slice(0, 240),
        installCommand: install,
        transport: "stdio",
        homepage: String(repo.html_url ?? ""),
        score: Number(repo.stargazers_count ?? 0) / 100,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function searchOfficial(query: string, limit: number): Promise<MCPCandidate[]> {
  try {
    const url = new URL("https://registry.modelcontextprotocol.io/v0/servers");
    url.searchParams.set("search", query);
    url.searchParams.set("limit", String(limit));
    const res = await request(url, { method: "GET" });
    if (res.statusCode !== 200) return [];
    const data: any = await res.body.json();
    const out: MCPCandidate[] = [];
    for (const server of data?.servers ?? []) {
      const pkg = (server?.packages ?? [{}])[0] ?? {};
      const pkgName = String(pkg.name ?? server.name ?? "");
      if (!pkgName) continue;  // skip malformed registry rows
      const runtime = String(pkg.runtime_hint ?? pkg.registry_name ?? "").toLowerCase();
      let install = pkgName;
      if (runtime === "node" || runtime === "npm" || runtime === "npx") install = `npx -y ${pkgName}`;
      else if (runtime === "python" || runtime === "pypi" || runtime === "uvx") install = `uvx ${pkgName}`;
      // If we still don't have a runnable command (no recognised runtime
      // hint), skip — auto-install would fail with a confusing error.
      if (!install || install === pkgName) continue;
      out.push({
        id: String(server.name ?? pkgName),
        source: "official",
        name: String(server.name ?? pkgName),
        description: String(server.description ?? "").slice(0, 240),
        installCommand: install,
        transport: "stdio",
        homepage: String(server.repository?.url ?? ""),
        score: 10,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function searchMcpRegistry(query: string, limit = 10): Promise<MCPCandidate[]> {
  const batches = await Promise.allSettled([
    searchOfficial(query, limit),
    searchNpm(query, limit),
    searchGithub(query, limit),
  ]);
  const seen = new Map<string, MCPCandidate>();
  for (const b of batches) {
    if (b.status !== "fulfilled") continue;
    for (const c of b.value) {
      const existing = seen.get(c.id);
      if (!existing || c.score > existing.score) seen.set(c.id, c);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
