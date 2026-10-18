"""Exercise the actual gRPC setup without importing provider dependencies."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import urlparse


class EndpointPolicy(unittest.TestCase):
    def test_transport_policy_before_exporter(self):
        source = ast.parse(Path(__file__).with_name("agent.py").read_text())
        branch = next(n for n in source.body if isinstance(n, ast.If) and 'OTLP_PROTOCOL' in ast.unparse(n.test))
        setup = ast.Module(body=branch.body[1:], type_ignores=[])
        for endpoint, expected in [("http://remote.example:4317", "reject"),
                                   ("https://remote.example:4317", None),
                                   ("remote.example:4317", None),
                                   ("http://localhost:4317", True),
                                   ("127.0.0.1:4317", True),
                                   ("http://[::1]:4317", True)]:
            with self.subTest(endpoint=endpoint), patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": endpoint}, clear=True):
                calls = []
                scope = {"os": os, "urlparse": urlparse, "OTLPSpanExporter": lambda **kw: calls.append(kw)}
                if expected == "reject":
                    with self.assertRaisesRegex(ValueError, "must use TLS"):
                        exec(compile(setup, "agent.py", "exec"), scope)
                    self.assertEqual(calls, [])
                else:
                    exec(compile(setup, "agent.py", "exec"), scope)
                    self.assertEqual(calls, [{"endpoint": endpoint, "insecure": expected}])


if __name__ == "__main__":
    unittest.main()
