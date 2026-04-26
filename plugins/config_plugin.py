import os
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore

from .base import AtlasPlugin


class ConfigPlugin(AtlasPlugin):
    name = "config"

    async def load(self, kernel) -> None:
        # Load .env if present
        env_path = Path(".env")
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())

        # Load config.toml if present
        config_path = Path("config.toml")
        if config_path.exists():
            with open(config_path, "rb") as f:
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

        kernel.config = config

    async def unload(self) -> None:
        pass
