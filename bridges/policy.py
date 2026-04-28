"""Trust policy for installing MCP servers and mounting code-running bridges.

The kernel needs to draw a line: "code from this source can run silently;
code from that source has to ask first." This is that line.

policy modes:
  - "auto":   trusted sources/kinds run silently; unknown sources prompt.
  - "prompt": every install / risky mount prompts (the conservative default
              before this policy existed).
  - "off":    installs and code-running bridge mounts are refused.

Risky kinds (those that exec arbitrary commands) — `mcp`, `process`,
`shell` — flow through the same gate when mounting, not just when
installing. Network-only kinds (`http`, `openapi`, `homeassistant`),
hardware-direct kinds (`ble`, `serial`, `adb`), and `mcp http` (no local
process) skip the gate.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass


RISKY_KINDS = {"mcp", "process", "shell"}

# Defaults — what counts as trusted out of the box. Conservative on
# purpose: official registry + the reference servers from the MCP team.
DEFAULT_TRUSTED = (
    "official",
    "npm:@modelcontextprotocol/*",
)


class PolicyDenied(Exception):
    """Raised when policy=='off' refuses an install or risky mount."""


@dataclass
class PolicyDecision:
    allow:  bool
    prompt: bool
    reason: str = ""


class InstallPolicy:
    """Centralized trust gate. One method: `decide(...)`.

    Patterns in `trusted_sources` match either:
      - a bare source name (e.g. `"official"`)  →  matches candidate.source
      - `"<source>:<glob>"` (e.g. `"npm:@modelcontextprotocol/*"`)
        → matches `candidate.source` AND fnmatch on `candidate.id`
    """

    def __init__(self, mode: str = "auto", trusted_sources=None):
        mode = (mode or "auto").lower()
        if mode not in ("auto", "prompt", "off"):
            mode = "auto"
        self.mode = mode
        self.trusted_sources = list(trusted_sources or DEFAULT_TRUSTED)

    def is_trusted(self, source: str, candidate_id: str) -> bool:
        for pat in self.trusted_sources:
            if ":" in pat:
                src, _, glob = pat.partition(":")
                if src == source and fnmatch.fnmatch(candidate_id, glob):
                    return True
            else:
                if pat == source:
                    return True
        return False

    def decide_install(self, source: str, candidate_id: str) -> PolicyDecision:
        if self.mode == "off":
            return PolicyDecision(allow=False, prompt=False,
                                  reason="install_policy=off")
        if self.mode == "prompt":
            return PolicyDecision(allow=True, prompt=True,
                                  reason="install_policy=prompt")
        # mode == "auto"
        if self.is_trusted(source, candidate_id):
            return PolicyDecision(allow=True, prompt=False,
                                  reason="trusted source")
        return PolicyDecision(allow=True, prompt=True,
                              reason="untrusted source — confirming")

    def decide_mount(self, kind: str, source: str = "user", id_: str = "") -> PolicyDecision:
        """Used when DevicesPlugin mounts a bridge directly (not via the
        MCP installer). Only risky kinds gate; everything else is allowed
        silently."""
        if kind not in RISKY_KINDS:
            return PolicyDecision(allow=True, prompt=False, reason="non-risky kind")
        if self.mode == "off":
            return PolicyDecision(allow=False, prompt=False,
                                  reason="install_policy=off")
        if self.mode == "prompt":
            return PolicyDecision(allow=True, prompt=True,
                                  reason="install_policy=prompt")
        if self.is_trusted(source, id_):
            return PolicyDecision(allow=True, prompt=False, reason="trusted")
        return PolicyDecision(allow=True, prompt=True,
                              reason="risky kind — confirming once")
