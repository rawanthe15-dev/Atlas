"""OpenAPI / Swagger bridge — fetches the spec and turns every operation
into its own ToolSpec. Reuses HTTPBridge as the transport.
"""
from __future__ import annotations

import json
from typing import List
from urllib.parse import urljoin

import httpx

from .base import BridgeError
from .http_bridge import HTTPBridge
from .spec import ToolSpec, BridgeSpec, Capability


def _safe_op_name(operation_id: str | None, method: str, path: str) -> str:
    if operation_id:
        cleaned = "".join(c if c.isalnum() or c in "_-" else "_" for c in operation_id)
        return cleaned[:48] or f"{method.lower()}_root"
    pieces = [method.lower()] + [p for p in path.split("/") if p and not p.startswith("{")]
    name = "_".join(pieces) or f"{method.lower()}_root"
    name = "".join(c if c.isalnum() or c in "_-" else "_" for c in name)
    return name[:48]


def _params_to_schema(parameters: list[dict], request_body: dict | None) -> dict:
    """Squash OpenAPI parameter list + requestBody into one JSON Schema."""
    props: dict = {}
    required: list[str] = []
    for p in parameters or []:
        name = p.get("name")
        if not name:
            continue
        schema = p.get("schema") or {"type": "string"}
        # Carry description through so the model knows which is which.
        if p.get("description"):
            schema = {**schema, "description": p["description"]}
        props[name] = schema
        if p.get("required"):
            required.append(name)
    if request_body:
        content = (request_body.get("content") or {})
        json_schema = (content.get("application/json") or {}).get("schema")
        if json_schema:
            props["body"] = {**json_schema, "description": "Request body (JSON)"}
            if request_body.get("required"):
                required.append("body")
    return {
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": False,
    }


class OpenAPIBridge(HTTPBridge):
    """`config`:
        spec_url:  str (required)            — URL or local path to OpenAPI/Swagger doc
        base_url:  str (optional override)   — falls back to `servers[0].url`
        headers:   dict[str,str] (optional)
    """

    kind = "openapi"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._spec_doc: dict = {}

    async def connect(self) -> None:
        if self._spec_doc:
            return
        cfg = self.spec.config
        spec_url = cfg.get("spec_url")
        if not spec_url:
            raise BridgeError("openapi bridge: 'spec_url' is required")

        if spec_url.startswith("http://") or spec_url.startswith("https://"):
            async with httpx.AsyncClient(timeout=30) as cli:
                resp = await cli.get(spec_url)
                resp.raise_for_status()
                self._spec_doc = resp.json()
        else:
            with open(spec_url, "r", encoding="utf-8") as f:
                self._spec_doc = json.load(f)

        # Derive base_url if not provided.
        if not cfg.get("base_url"):
            servers = self._spec_doc.get("servers") or []
            if servers and servers[0].get("url"):
                cfg["base_url"] = servers[0]["url"]
            else:
                # Swagger 2.x
                host = self._spec_doc.get("host")
                schemes = self._spec_doc.get("schemes") or ["https"]
                base_path = self._spec_doc.get("basePath") or ""
                if host:
                    cfg["base_url"] = f"{schemes[0]}://{host}{base_path}"
        self.spec.config = cfg
        await super().connect()

    async def discover(self) -> List[ToolSpec]:
        await self.connect()
        tools: list[ToolSpec] = []
        paths = self._spec_doc.get("paths") or {}
        for path, methods in paths.items():
            if not isinstance(methods, dict):
                continue
            for method, op in methods.items():
                if method.lower() not in {"get", "post", "put", "patch", "delete", "head"}:
                    continue
                if not isinstance(op, dict):
                    continue
                tool_name = _safe_op_name(op.get("operationId"), method, path)
                desc = op.get("summary") or op.get("description") or f"{method.upper()} {path}"
                schema = _params_to_schema(op.get("parameters", []), op.get("requestBody"))
                tools.append(ToolSpec(
                    name=tool_name,
                    description=desc[:300],
                    parameters=schema,
                    handler={"op": "call_operation", "method": method, "path": path},
                ))
        # Always offer the raw `request` escape hatch too — the discovered
        # tool list might not cover everything, especially with broken specs.
        tools.extend(await super().discover())
        return tools

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
