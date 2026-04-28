import { request } from "undici";
import { readFile } from "node:fs/promises";
import { HTTPBridge } from "./http-bridge.js";
import { BridgeError, type ToolSpec } from "./types.js";

function safeOpName(operationId: string | undefined, method: string, path: string): string {
  if (operationId) {
    const cleaned = operationId.replace(/[^A-Za-z0-9_-]/g, "_");
    return cleaned.slice(0, 48) || `${method.toLowerCase()}_root`;
  }
  const pieces = [method.toLowerCase(), ...path.split("/").filter(p => p && !p.startsWith("{"))];
  let name = pieces.join("_") || `${method.toLowerCase()}_root`;
  name = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return name.slice(0, 48);
}

function paramsToSchema(parameters: any[], requestBody: any): any {
  const props: Record<string, any> = {};
  const required: string[] = [];
  for (const p of parameters ?? []) {
    if (!p?.name) continue;
    let schema = p.schema ?? { type: "string" };
    if (p.description) schema = { ...schema, description: p.description };
    props[p.name] = schema;
    if (p.required) required.push(p.name);
  }
  if (requestBody) {
    const content = requestBody.content ?? {};
    const json = content["application/json"]?.schema;
    if (json) {
      props.body = { ...json, description: "Request body (JSON)" };
      if (requestBody.required) required.push("body");
    }
  }
  return {
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  };
}

export class OpenAPIBridge extends HTTPBridge {
  static override kind = "openapi";
  private specDoc: any | undefined;

  override async connect(): Promise<void> {
    if (this.specDoc) return;
    const cfg = this.spec.config;
    const specUrl = cfg.spec_url;
    if (!specUrl) throw new BridgeError("openapi: 'spec_url' is required");

    let raw: string;
    if (typeof specUrl === "string" && (specUrl.startsWith("http://") || specUrl.startsWith("https://"))) {
      const res = await request(specUrl, { method: "GET" });
      if (res.statusCode >= 400) {
        throw new BridgeError(`could not fetch spec ${specUrl}: HTTP ${res.statusCode}`);
      }
      raw = await res.body.text();
    } else {
      raw = await readFile(String(specUrl), "utf8");
    }
    try {
      this.specDoc = JSON.parse(raw);
    } catch (e: any) {
      throw new BridgeError(`spec is not JSON: ${e?.message ?? e}`);
    }

    if (!cfg.base_url) {
      const servers = this.specDoc?.servers ?? [];
      if (servers[0]?.url) {
        cfg.base_url = servers[0].url;
      } else if (this.specDoc?.host) {
        const scheme = (this.specDoc.schemes ?? ["https"])[0];
        cfg.base_url = `${scheme}://${this.specDoc.host}${this.specDoc.basePath ?? ""}`;
      }
    }
  }

  override async discover(): Promise<ToolSpec[]> {
    await this.connect();
    const out: ToolSpec[] = [];
    const paths = this.specDoc?.paths ?? {};
    for (const [path, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== "object") continue;
      for (const [method, op] of Object.entries(methods as Record<string, any>)) {
        if (!["get", "post", "put", "patch", "delete", "head"].includes(method.toLowerCase())) continue;
        if (!op || typeof op !== "object") continue;
        const name = safeOpName(op.operationId, method, path);
        const desc = (op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).slice(0, 300);
        const schema = paramsToSchema(op.parameters ?? [], op.requestBody);
        out.push({
          name,
          description: desc,
          parameters: schema,
          handler: { op: "call_operation", method, path },
        });
      }
    }
    // Also expose the raw `request` escape-hatch — broken specs are common.
    out.push(...(await super.discover()));
    return out;
  }

  static override defaultCapabilities(): string[] {
    return ["control", "telemetry"];
  }
}
