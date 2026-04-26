import os
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore

from .base import AtlasPlugin

# Resolve paths relative to the Atlas install dir so config persists no matter
# where `atlas` is launched from.
ATLAS_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ATLAS_ROOT / "config.toml"
ENV_PATH = ATLAS_ROOT / ".env"


class ConfigPlugin(AtlasPlugin):
    name = "config"

    async def load(self, kernel) -> None:
        # Load .env if present (looked up relative to Atlas install dir)
        if ENV_PATH.exists():
            for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())

        # Load config.toml from the Atlas install dir
        if CONFIG_PATH.exists():
            with open(CONFIG_PATH, "rb") as f:
                config: dict = tomllib.load(f)
        else:
            config = {}

        # Apply env var overrides and defaults
        config.setdefault("openrouter", {})
        config.setdefault("memory", {})
        config.setdefault("tools", {})
        config.setdefault("atlas", {"name": "Atlas", "version": "0.1.0"})

        if not config["openrouter"].get("api_key"):
            config["openrouter"]["api_key"] = os.environ.get("OPENROUTER_API_KEY", "")
        if not config["openrouter"].get("default_model"):
            config["openrouter"]["default_model"] = "deepseek/deepseek-chat"
        if not config["openrouter"].get("base_url"):
            config["openrouter"]["base_url"] = "https://openrouter.ai/api/v1/chat/completions"

        if not config["tools"].get("brave_api_key"):
            config["tools"]["brave_api_key"] = os.environ.get("BRAVE_API_KEY", "")

        # Default memory path also relative to Atlas install dir if unset
        if not config["memory"].get("path"):
            config["memory"]["path"] = str(ATLAS_ROOT / "memory")

        kernel.config = config

    async def unload(self) -> None:
        pass
