from abc import ABC, abstractmethod


class Tool(ABC):
    name: str
    description: str
    parameters: dict  # JSON Schema for the function parameters

    @abstractmethod
    async def run(self, **kwargs) -> str: ...

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
