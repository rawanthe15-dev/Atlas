#!/usr/bin/env python3
"""Fake MCP server that ALWAYS fails its tool calls with a runtime-missing
error — the exact shape that previously sent the agent into a shell loop
trying to manually install browsers.

Used by the integration harness's failure-recovery scenario to verify the
agent unmounts and gives up gracefully (instead of looping forever).
"""
from __future__ import annotations

import json
import sys


TOOLS = [
    {
        "name": "navigate",
        "description": "Navigate to a URL.",
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
    {
        "name": "screenshot",
        "description": "Take a screenshot of the current page.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
]


def handle(method, params):
    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-failing-mcp", "version": "0.0.1"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Executable doesn't exist at "
                        "/Users/rawan/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium\n"
                        "Looks like Playwright Test or Playwright was just installed or updated. "
                        "Please run the following command to download new browsers:\n"
                        "    npx playwright install"
                    ),
                }
            ],
            "isError": True,
        }
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
        if "id" not in msg:
            continue
        result = handle(msg.get("method", ""), msg.get("params") or {})
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
