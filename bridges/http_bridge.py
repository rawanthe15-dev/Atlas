"""Generic HTTP bridge — works against any REST endpoint without a spec.

Exposes one universal `request` tool the model can drive directly. This is
the lowest-common-denominator bridge: when nothing more specific exists,
the agent can still talk to anything that speaks HTTP.
"""
from __future__ import annotations

import json
from typing import List

import httpx

from .base import Bridge, BridgeError
from .spec import ToolSpec, BridgeSpec, Capability


def _truncate(s: str, limit: int = 4000) -> str:
    if len(s) <= limit:
        return s
    return s[: limit - 100] + f"\n... ({len(s) - limit} chars truncated)"


class HTTPBridge(Bridge):
    """`config`:
        base_url: str (required)
        headers:  dict[str, str] (optional, e.g. {"Authorization": "Bearer X"})
        timeout:  float (default 30)
    """

    kind = "http"

    def __init__(self, spec: BridgeSpec):
        super().__init__(spec)
        self._client: httpx.AsyncClient | None = None

    async def connect(self) -> None:
        if self._client is not None:
            return
        cfg = self.spec.config
        base = cfg.get("base_url", "")
        headers = cfg.get("headers", {})
        timeout = float(cfg.get("timeout", 30.0))
        self._client = httpx.AsyncClient(base_url=base, headers=headers, timeout=timeout)

    async def discover(self) -> List[ToolSpec]:
        return [
            ToolSpec(
                name="request",
                description=(
                    "Send an arbitrary HTTP request to this device's base URL. "
                    "Returns status, headers (subset), and response body."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        },
                        "path":   {"type": "string", "description": "Path appended to base_url"},
                        "query":  {"type": "object", "description": "Querystring params", "additionalProperties": True},
                        "json":   {"type": "object", "description": "JSON request body", "additionalProperties": True},
                        "body":   {"type": "string", "description": "Raw text body (use either json or body)"},
                        "headers": {"type": "object", "description": "Extra request headers", "additionalProperties": {"type": "string"}},
                    },
                    "required": ["method", "path"],
                },
                handler={"op": "request"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        if self._client is None:
            await self.connect()
        assert self._client is not None

        op = tool.handler.get("op")
        if op == "request":
            method  = arguments.get("method", "GET").upper()
            path    = arguments.get("path", "/")
            params  = arguments.get("query")
            body    = arguments.get("body")
            jbody   = arguments.get("json")
            headers = arguments.get("headers")
            try:
                resp = await self._client.request(
                    method, path, params=params, content=body,
                    json=jbody if body is None else None, headers=headers,
                )
            except Exception as e:
                raise BridgeError(f"http request failed: {e}") from e
            text = resp.text
            return _truncate(
                f"HTTP {resp.status_code} {method} {path}\n"
                f"content-type: {resp.headers.get('content-type','')}\n\n"
                f"{text}"
            )

        # OpenAPI-derived tools live on the OpenAPI bridge — handler['op']
        # there is "call_operation" with operationId/method/path baked in.
        if op == "call_operation":
            method = tool.handler["method"].upper()
            path   = tool.handler["path"]
            # Map declared params back to query/body using the parameters schema.
            query: dict = {}
            jbody: dict | None = None
            for key, value in arguments.items():
                if key == "body":
                    jbody = value
                else:
                    # Substitute path params like /things/{id}
                    placeholder = "{" + key + "}"
                    if placeholder in path:
                        path = path.replace(placeholder, str(value))
                    else:
                        query[key] = value
            try:
                resp = await self._client.request(
                    method, path, params=query or None, json=jbody,
                )
            except Exception as e:
                raise BridgeError(f"openapi call failed: {e}") from e
            return _truncate(
                f"HTTP {resp.status_code} {method} {path}\n\n{resp.text}"
            )

        raise BridgeError(f"unknown op: {op}")

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
