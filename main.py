import asyncio
import sys

from kernel import Kernel
from plugins.config_plugin import ConfigPlugin
from plugins.memory_plugin import MemoryPlugin
from plugins.tools_plugin import ToolsPlugin
from plugins.devices_plugin import DevicesPlugin
from plugins.agent_plugin import AgentPlugin
from plugins.cli_plugin import CLIPlugin


async def main() -> None:
    kernel = Kernel()
    try:
        await kernel.load_plugin(ConfigPlugin)
        await kernel.load_plugin(MemoryPlugin)
        await kernel.load_plugin(ToolsPlugin)
        await kernel.load_plugin(DevicesPlugin)
        await kernel.load_plugin(AgentPlugin)
        await kernel.load_plugin(CLIPlugin)   # blocks until user exits
    except KeyboardInterrupt:
        pass
    finally:
        await kernel.unload_all()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
