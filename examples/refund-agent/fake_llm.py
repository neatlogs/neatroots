"""A scripted OpenAI-compatible chat server for testing steering without a real model.

It keeps asking for the same failing tool call until a <neatroots-guidance> note shows up in
the request, then gives up politely. Every request is appended to requests.jsonl.
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else "requests.jsonl"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        with open(LOG, "a") as f:
            f.write(json.dumps(body) + "\n")
        messages = body.get("messages", [])
        text = json.dumps(messages)
        guided = "<neatroots-guidance>" in text
        if guided:
            message = {"role": "assistant", "content": "I could not find order 4512 after several lookups. Please check the order id."}
            finish = "stop"
        else:
            n = sum(1 for m in messages if m.get("role") == "tool")
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": f"call_{n}", "type": "function", "function": {"name": "lookup_order", "arguments": json.dumps({"order_id": "4512"})}}],
            }
            finish = "tool_calls"
        resp = {
            "id": f"chatcmpl-{time.time_ns()}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.get("model", "fake"),
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 40, "completion_tokens": 12, "total_tokens": 52},
        }
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4199
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
