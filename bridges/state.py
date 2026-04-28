"""Persistence for mounted devices.

Each device's BridgeSpec is written to `memory/devices/<name>.json`. On
startup, DevicesPlugin reads them all back and remounts in place.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .spec import BridgeSpec


class DeviceStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "_-." else "_" for c in name)
        return self.root / f"{safe}.json"

    def save(self, spec: BridgeSpec) -> None:
        with open(self._path(spec.name), "w", encoding="utf-8") as f:
            json.dump(spec.to_dict(), f, indent=2)

    def delete(self, name: str) -> None:
        path = self._path(name)
        if path.exists():
            os.remove(path)

    def load_all(self) -> list[BridgeSpec]:
        out: list[BridgeSpec] = []
        for p in sorted(self.root.glob("*.json")):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    out.append(BridgeSpec.from_dict(json.load(f)))
            except Exception:
                continue
        return out
