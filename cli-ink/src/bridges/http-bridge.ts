import { request } from "undici";
import { Bridge } from "./base.js";
import { BridgeError, type ToolSpec } from "./types.js";

function truncate(s: string, limit = 4000): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit - 100) + `\n... (${s.length - limit} chars truncated)`;
}

export class HTTPBridge extends Bridge {
  static override kind = "http";

  async connect(): Promise<void> {
    // No persistent connection — each request is independent.
  }

  async discover(): Promise<ToolSpec[]> {
    return [
      {
        name: "request",
        description:
          "Send an arbitrary HTTP request to this device's base URL. Returns status, content-type, and body.",
        parameters: {
          type: "object",
          properties: {
            method:  { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
            path:    { type: "string", description: "Path appended to base_url" },
            query:   { type: "object", description: "Querystring params", additionalProperties: true },
            json:    { type: "object", description: "JSON request body", additionalProperties: true },
            body:    { type: "string", description: "Raw text body" },
            headers: { type: "object", description: "Extra request headers", additionalProperties: { type: "string" } },
          },
          required: ["method", "path"],
        },
        handler: { op: "request" },
      },
    ];
  }

  async invoke(tool: ToolSpec, args: Record<string, any>): Promise<string> {
    const op = tool.handler?.op;
    const cfg = this.spec.config;
    const baseUrl = String(cfg.base_url ?? "").replace(/\/$/, "");
    const baseHeaders = (cfg.headers ?? {}) as Record<string, string>;
    const timeoutMs = Number(cfg.timeout ?? 30) * 1000;

    if (op === "request") {
      const method = String(args.method ?? "GET").toUpperCase();
      const path = String(args.path ?? "/");
      return this.doRequest(baseUrl, baseHeaders, method, path, args, timeoutMs);
    }

    // OpenAPI-derived tools live on the OpenAPI bridge subclass — handler['op']
    // is "call_operation" with method/path baked in. Substitute path params,
    // route remaining args to query (for GET) or JSON body.
    if (op === "call_operation") {
      const method = String(tool.handler.method ?? "GET").toUpperCase();
      let path = String(tool.handler.path ?? "/");
      const query: Record<string, any> = {};
      let jsonBody: any = undefined;
      for (const [k, v] of Object.entries(args ?? {})) {
        if (k === "body") {
          jsonBody = v;
          continue;
        }
        const placeholder = "{" + k + "}";
        if (path.includes(placeholder)) {
          path = path.replaceAll(placeholder, encodeURIComponent(String(v)));
        } else {
          query[k] = v;
        }
      }
      const passArgs: Record<string, any> = { query };
      if (jsonBody !== undefined) passArgs.json = jsonBody;
      return this.doRequest(baseUrl, baseHeaders, method, path, passArgs, timeoutMs);
    }

    throw new BridgeError(`unknown op: ${op}`);
  }

  protected async doRequest(
    baseUrl: string,
    baseHeaders: Record<string, string>,
    method: string,
    path: string,
    args: Record<string, any>,
    timeoutMs: number,
  ): Promise<string> {
    const url = new URL(path.startsWith("http") ? path : baseUrl + (path.startsWith("/") ? path : "/" + path));
    if (args.query && typeof args.query === "object") {
      for (const [k, v] of Object.entries(args.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      ...baseHeaders,
      ...((args.headers as Record<string, string>) ?? {}),
    };
    let body: string | Buffer | undefined;
    if (args.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(args.json);
    } else if (typeof args.body === "string") {
      body = args.body;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await request(url, {
        method: method as any,
        headers,
        body,
        signal: controller.signal,
      });
      const text = await res.body.text();
      const ct = String(res.headers["content-type"] ?? "");
      return truncate(`HTTP ${res.statusCode} ${method} ${path}\ncontent-type: ${ct}\n\n${text}`);
    } catch (e: any) {
      throw new BridgeError(`http request failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  static defaultCapabilities(): string[] {
    return ["control", "telemetry"];
  }
}
