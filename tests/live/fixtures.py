"""Fake targets for the live agent harness — increasing difficulty.

Level 1 — Camera with FULL OpenAPI spec:           agent should mount kind="openapi"
Level 2 — Camera with BROKEN OpenAPI (50% missing): agent should fall back to http kind
Level 3 — Camera with NO docs at all:               agent gets only base URL, must use kind="http"
Level 4 — A real MCP stdio server, no info given:   agent must figure out kind="mcp"
Level 5 — Two services running at once:             agent must use BOTH (camera snapshot + mcp add)

Everything binds to 127.0.0.1:0 so the OS picks a free port.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _CamHandler(BaseHTTPRequestHandler):
    """Routed by the FakeCamera wrapper which sets `level` on the class."""
    level = 1
    port_holder: dict = {"port": 0}

    def do_GET(self):
        if self.path == "/api/info":
            body = json.dumps({
                "model": "AtlasTestCam",
                "resolution": "1280x720",
                "firmware": "1.0.3",
            }).encode()
            return self._send(200, "application/json", body)

        if self.path == "/api/snapshot":
            body = b"\xff\xd8\xff\xe0\x00\x10JFIFatlas-test-snapshot"
            return self._send(200, "image/jpeg", body)

        if self.path == "/openapi.json":
            if self.level == 3:
                # Level 3: no docs. Camera refuses to expose a spec.
                return self._send(404, "text/plain", b"not found")

            paths = {
                "/api/info": {"get": {"operationId": "getInfo", "summary": "Camera info"}},
            }
            if self.level == 1:
                paths["/api/snapshot"] = {"get": {"operationId": "snapshot", "summary": "Capture a frame"}}
            # Level 2: snapshot deliberately missing from the spec.

            spec = {
                "openapi": "3.0.0",
                "info": {"title": "AtlasTestCam", "version": "1.0"},
                "servers": [{"url": f"http://127.0.0.1:{self.port_holder['port']}"}],
                "paths": paths,
            }
            return self._send(200, "application/json", json.dumps(spec).encode())

        return self._send(404, "text/plain", b"not found")

    def _send(self, status: int, ctype: str, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args, **kwargs):  # silence
        return


class FakeCamera:
    """Threaded HTTP server pretending to be an IP camera. `difficulty`
    selects what the camera tells the agent about itself."""

    def __init__(self, difficulty: int = 1):
        self.difficulty = difficulty

        # Subclass per-instance so multiple cameras can run simultaneously
        # without their `level` / `port_holder` clobbering each other.
        port_holder = {"port": 0}
        Handler = type(
            f"CamHandlerL{difficulty}",
            (_CamHandler,),
            {"level": difficulty, "port_holder": port_holder},
        )
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = self._server.server_address[1]
        port_holder["port"] = port
        self.port = port

    def start(self):
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def spec_url(self) -> str:
        return f"{self.base_url}/openapi.json"


FAKE_MCP_PATH = Path(__file__).resolve().parents[1] / "_fixtures" / "fake_mcp_server.py"
