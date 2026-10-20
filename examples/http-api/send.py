"""The same trace from Python with only the standard library: no SDK, no dependencies.

    python send.py
"""

import json
import os
import urllib.request

trace = {
    "name": "research",
    "project": "example-http-api",
    "input": "Find three papers on agent evaluation",
    "children": [
        {"name": "search", "kind": "RETRIEVER", "query": "agent evaluation", "documents": [{"title": "AgentBench"}, {"title": "GAIA"}, {"title": "tau-bench"}], "duration_ms": 120},
        {"name": "rank", "kind": "LLM", "model": "gpt-4o-mini", "input": "Rank these by relevance", "output": "1. tau-bench 2. GAIA 3. AgentBench", "tokens": {"prompt": 80, "completion": 15}, "duration_ms": 400},
        {"name": "fetch_pdf", "kind": "TOOL", "tool_name": "fetch_pdf", "input": {"title": "GAIA"}, "status": "ERROR", "error": "403 Forbidden", "duration_ms": 90},
    ],
    "output": "Here are three papers: tau-bench, GAIA and AgentBench.",
}
req = urllib.request.Request(
    os.environ.get("NEATROOTS_URL", "http://localhost:4100") + "/v1/trace",
    data=json.dumps(trace).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
print(urllib.request.urlopen(req).read().decode())
