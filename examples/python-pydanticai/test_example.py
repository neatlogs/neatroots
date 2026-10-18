"""No providers or dependencies needed: execute only the script's configuration prefix."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import patch


class RoutingTests(unittest.TestCase):
    def configure(self, real):
        tree = ast.parse(Path(__file__).with_name("agent.py").read_text())
        prefix = []
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module == "opentelemetry":
                break
            prefix.append(node)
        env = {"OPENAI_BASE_URL": "http://127.0.0.1:19001/v1", "OPENAI_API_KEY": "ambient-secret",
               "MOCK_LLM_URL": "http://127.0.0.1:19002/v1"}
        if real is not None:
            env["REAL_LLM"] = real
        with patch.dict(os.environ, env, clear=True):
            exec(compile(ast.Module(body=prefix, type_ignores=[]), "agent-prefix", "exec"), {})
            return os.environ["OPENAI_BASE_URL"], os.environ["OPENAI_API_KEY"]

    def test_mock_overrides_ambient_base_and_key(self):
        for real in [None, "0"]:
            with self.subTest(real=real):
                self.assertEqual(self.configure(real), ("http://127.0.0.1:19002/v1", "mock"))

    def test_explicit_real_preserves_provider_configuration_without_calling_it(self):
        self.assertEqual(self.configure("1"), ("http://127.0.0.1:19001/v1", "ambient-secret"))

    def test_shutdown_is_in_finally(self):
        tree = ast.parse(Path(__file__).with_name("agent.py").read_text())
        main = tree.body[-1]
        self.assertIsInstance(main.body[0], ast.Try)
        self.assertIn("provider.shutdown()", ast.unparse(main.body[0].finalbody[0]))

    def test_failure_flushes_before_exception_propagates(self):
        from types import SimpleNamespace
        flushed = []
        def fail(_):
            raise RuntimeError("synthetic run failure")
        tree = ast.parse(Path(__file__).with_name("agent.py").read_text())
        main = ast.Module(body=tree.body[-1].body, type_ignores=[])
        with self.assertRaisesRegex(RuntimeError, "synthetic run failure"):
            exec(compile(main, "agent-main", "exec"), {
                "agent": SimpleNamespace(run_sync=fail),
                "provider": SimpleNamespace(shutdown=lambda: flushed.append(True)),
                "sys": SimpleNamespace(argv=["agent.py"]),
            })
        self.assertEqual(flushed, [True])


if __name__ == "__main__":
    unittest.main()
