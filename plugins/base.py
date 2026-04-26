from abc import ABC, abstractmethod

class AtlasPlugin(ABC):
    name: str
    version: str = "0.1.0"

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not hasattr(cls, 'name') or cls.name is AtlasPlugin.__dict__.get('name'):
            pass  # name will be checked at instantiation

    @abstractmethod
    async def load(self, kernel) -> None:
        pass

    @abstractmethod
    async def unload(self) -> None:
        pass
