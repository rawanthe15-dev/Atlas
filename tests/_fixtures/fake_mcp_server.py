#!/usr/bin/env python3
"""Tiny but real MCP server for integration tests.

Speaks the JSON-RPC subset Atlas's MCPBridge needs: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`. Exposes three
tools — `echo`, `add`, and `boom` (which intentionally returns an
isError=true response) — so we can exercise success, structured args,
and error paths through the real bridge code.

This file is invoked as a subprocess by the integration test, NOT
imported. Keep it self-contained — pure stdlib only.
"""
from __future__ import annotations

import json
import sys


TOOLS = [
    {
        "name": "echo",
        "description": "Echo a string back.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "add",
        "description": "Add two numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
    {
        "name": "boom",
        "description": "Always fails with isError=true.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
]


def handle(method: str, params: dict) -> dict:
    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "0.0.1"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "echo":
            return {"content": [{"type": "text", "text": str(args.get("text", ""))}]}
        if name == "add":
            return {"content": [{"type": "text", "text": str(args.get("a", 0) + args.get("b", 0))}]}
        if name == "boom":
            return {"content": [{"type": "text", "text": "kaboom"}], "isError": True}
        return {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True}
    return {}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Notifications carry no id; ignore them silently.
        if "id" not in msg:
            continue
        result = handle(msg.get("method", ""), msg.get("params") or {})
        out = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
