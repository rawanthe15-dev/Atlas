import httpx
from .base import Tool


class WebSearchTool(Tool):
    name = "web_search"
    description = "Search the web using Brave Search. Returns titles, URLs, and descriptions."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query"},
            "count": {"type": "integer", "description": "Number of results, max 10 (default 5)"},
        },
        "required": ["query"],
    }

    def __init__(self, api_key: str = ""):
        self._api_key = api_key

    async def run(self, query: str, count: int = 5) -> str:
        if not self._api_key:
            return "Web search unavailable: BRAVE_API_KEY not configured."
        count = min(max(count, 1), 10)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": count},
                    headers={
                        "X-Subscription-Token": self._api_key,
                        "Accept": "application/json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
            results = data.get("web", {}).get("results", [])
            if not results:
                return "No results found."
            lines = []
            for r in results:
                lines.append(f"**{r.get('title', '')}**")
                lines.append(r.get("url", ""))
                if r.get("description"):
                    lines.append(r["description"])
                lines.append("")
            return "\n".join(lines).strip()
        except Exception as e:
            return f"Search error: {e}"
