# /// script
# requires-python = ">=3.10"
# ///
"""Scores what neatroots found on the samples against expected.json.

    uv run score.py            # after run_samples.py; waits until every sample is fully checked

must: the finding the scenario exists to show. may: also correct (the same failure seen through
another check). Anything else on a sample is unexpected; anything on happy is a false alarm.
Exits 1 when a must is missing or something unexpected was raised.
"""

import json
import os
import sys
import time
import urllib.request

URL = (os.environ.get("NEATROOTS_URL") or os.environ.get("NEATLOGS_ENDPOINT") or "http://localhost:4100").rstrip("/")
EXPECTED = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "expected.json")))


def get(path: str):
    with urllib.request.urlopen(URL + path, timeout=30) as r:
        return json.load(r)


def latest_runs() -> dict[str, str]:
    """The newest run of each sample scenario (samples tag their session as sample-<scenario>)."""
    out: dict[str, str] = {}
    for r in get("/api/runs?project=support-agent&limit=200")["runs"]:
        sid = r.get("session_id") or ""
        if sid.startswith("sample-") and sid[7:] in EXPECTED and sid[7:] not in out:
            out[sid[7:]] = r["trace_id"]
    return out


def mock_judge(status: dict) -> str | None:
    decision = ((status.get("engine") or {}).get("decision") or {})
    model = decision.get("model") or ""
    return model if decision.get("backend") == "llm" and model in ("mock", "mock-sloppy") else None


def main() -> int:
    runs = latest_runs()
    missing = [s for s in EXPECTED if s not in runs]
    if missing:
        print(f"no runs for {', '.join(missing)} at {URL}: run run_samples.py first")
        return 2
    if model := mock_judge(get("/api/status")):
        print(f"warning: {model} is the stand-in LLM, not a meaningful judge of the model-based checks.")
        print("Install Laya, enable Jev cloud, or configure a real local/hosted LLM before treating those MISS results as product failures.")
    deadline = time.time() + float(os.environ.get("SCORE_TIMEOUT", "900"))
    while True:
        details = {s: get(f"/api/runs/{t}") for s, t in runs.items()}
        waiting = [s for s, d in details.items() if (d.get("coverage") or {}).get("state") == "checking"]
        if not waiting or time.time() > deadline:
            break
        print(f"waiting for checks on {', '.join(waiting)}…", flush=True)
        time.sleep(10)
    bad = 0
    print(f"\n{'scenario':15} {'result':8} raised")
    for s, d in details.items():
        raised = sorted({f["check_id"] for f in d["findings"] if f["status"] in ("raised", "active")})
        cov = d.get("coverage") or {}
        must, may = set(EXPECTED[s]["must"]), set(EXPECTED[s]["may"])
        lost = sorted(must - set(raised))
        extra = sorted(set(raised) - must - may)
        ok = not lost and not extra
        bad += not ok
        note = []
        if lost:
            note.append(f"missing {', '.join(lost)}")
        if extra:
            note.append(f"unexpected {', '.join(extra)}")
        if cov.get("state") not in (None, "done"):
            note.append(f"checks {cov.get('state')}: {cov.get('answered')} of {cov.get('questions')} questions")
        print(f"{s:15} {'ok' if ok else 'MISS':8} {', '.join(raised) or '-'}{'   (' + '; '.join(note) + ')' if note else ''}")
    print(f"\n{len(details) - bad} of {len(details)} samples as expected")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
