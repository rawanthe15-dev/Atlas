"""Home Assistant bridge — preset over the HA REST API.

Atlas talks to a running Home Assistant via a long-lived access token.
Surfaces:
  - list_states           — every entity + its current state
  - get_state(entity_id)
  - call_service(domain, service, data)  — turn on/off, set brightness, …

This is the "smart home" entry point. Once mounted, the agent can drive
any HA-managed device (lights, TVs, locks, sensors, climate, scripts, …)
without any per-device coding.
"""
from __future__ import annotations

import json
from typing import List

from .base import Bridge, BridgeError
from .http_bridge import HTTPBridge
from .spec import ToolSpec, BridgeSpec, Capability


class HomeAssistantBridge(HTTPBridge):
    """`config`:
        url:    str — e.g. http://homeassistant.local:8123
        token:  str — long-lived access token
    """

    kind = "homeassistant"

    def __init__(self, spec: BridgeSpec):
        cfg = dict(spec.config)
        token = cfg.get("token")
        if not token:
            raise BridgeError("homeassistant bridge: 'token' is required")
        cfg.setdefault("base_url", cfg.get("url", "").rstrip("/") + "/api")
        cfg.setdefault("headers", {})["Authorization"] = f"Bearer {token}"
        cfg["headers"]["Content-Type"] = "application/json"
        spec = BridgeSpec(
            name=spec.name, kind=spec.kind, config=cfg,
            capabilities=spec.capabilities, description=spec.description,
            created_at=spec.created_at,
        )
        super().__init__(spec)

    async def discover(self) -> List[ToolSpec]:
        return [
            ToolSpec(
                name="list_states",
                description="List all Home Assistant entities and current state.",
                parameters={"type": "object", "properties": {}, "required": []},
                handler={"op": "ha_list_states"},
            ),
            ToolSpec(
                name="get_state",
                description="Get one entity's full state object by entity_id (e.g. 'light.kitchen').",
                parameters={
                    "type": "object",
                    "properties": {"entity_id": {"type": "string"}},
                    "required": ["entity_id"],
                },
                handler={"op": "ha_get_state"},
            ),
            ToolSpec(
                name="call_service",
                description=(
                    "Call a Home Assistant service. domain+service e.g. ('light','turn_on'); "
                    "data carries entity_id and service-specific fields like brightness, rgb_color."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "domain":  {"type": "string"},
                        "service": {"type": "string"},
                        "data":    {"type": "object", "additionalProperties": True},
                    },
                    "required": ["domain", "service"],
                },
                handler={"op": "ha_call_service"},
            ),
        ]

    async def invoke(self, tool: ToolSpec, arguments: dict) -> str:
        if self._client is None:
            await self.connect()
        assert self._client is not None
        op = tool.handler.get("op")
        try:
            if op == "ha_list_states":
                resp = await self._client.get("/states")
                resp.raise_for_status()
                data = resp.json()
                lines = [f"{e['entity_id']:<40} {e.get('state','')}" for e in data]
                return "\n".join(lines) if lines else "(no entities)"
            if op == "ha_get_state":
                entity = arguments["entity_id"]
                resp = await self._client.get(f"/states/{entity}")
                resp.raise_for_status()
                return json.dumps(resp.json(), indent=2)
            if op == "ha_call_service":
                domain = arguments["domain"]
                service = arguments["service"]
                data = arguments.get("data", {}) or {}
                resp = await self._client.post(f"/services/{domain}/{service}", json=data)
                resp.raise_for_status()
                return f"ok: {json.dumps(resp.json())[:600]}"
        except Exception as e:
            raise BridgeError(f"homeassistant: {e}") from e
        return await super().invoke(tool, arguments)

    @staticmethod
    def default_capabilities() -> list[str]:
        return [Capability.CONTROL.value, Capability.TELEMETRY.value]
