"""Run every shell dispatch branch with local command stubs and private logs."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RunnerLogs(unittest.TestCase):
    def test_private_logs_and_cleanup(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bins = root / "bin"
                bins.mkdir()
                logs = root / "logs"
                logs.mkdir()
                script = Path(__file__).with_name("run-all.sh").read_text()
                # Relocate the old predictable target for a safe baseline control.
                target = root / "sentinel"
                target.write_text("preserve me")
                link = root / "neatroots-example.log"
                link.symlink_to(target)
                script = script.replace("/tmp/neatroots-example.log", str(link))
                (root / "run-all.sh").write_text(script)
                stub = """#!/usr/bin/env python3
import json, os, pathlib, stat, sys
root=pathlib.Path(os.environ['FIXTURE'])
name=pathlib.Path(sys.argv[0]).name
count=root/'count'
n=int(count.read_text()) if count.exists() else 0
if name=='curl':
    url=sys.argv[-1]
    print(json.dumps({'runs':[{}]*n}) if '/api/runs?' in url else '{}')
elif name!='sleep':
    info=os.fstat(1)
    log_path=next(p for p in pathlib.Path(os.environ['TMPDIR']).glob('neatroots-example.*')
                  if os.path.samestat(info, p.stat()))
    with (root/'records').open('a') as f:
        f.write(json.dumps({'path':str(log_path),'mode':stat.S_IMODE(info.st_mode)})+'\\n')
    print('fixture output')
    if os.environ['FAIL']=='0': count.write_text(str(n+1))
"""
                for name in ("curl", "uv", "npm", "sleep"):
                    p = bins / name
                    p.write_text(stub)
                    p.chmod(0o755)
                names = ["python-openai", "python-pydanticai", "typescript-openai", "http-api"]
                for name in names:
                    folder = root / name
                    folder.mkdir()
                    if name.startswith("typescript"):
                        (folder / "node_modules").mkdir()
                    (folder / "send.sh").write_text('uv fixture\n')
                env = dict(os.environ, PATH=str(bins)+os.pathsep+os.environ["PATH"], FIXTURE=str(root), TMPDIR=str(logs), FAIL=str(int(fail)))
                result = subprocess.run(["sh", "run-all.sh", *names], cwd=root, env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, int(fail), result.stdout+result.stderr)
                self.assertEqual(target.read_text(), "preserve me")
                import json
                records = [json.loads(line) for line in (root / "records").read_text().splitlines()]
                self.assertEqual(len(records), 4)
                self.assertTrue(all(r["mode"] == 0o600 and Path(r["path"]).parent == logs for r in records))
                self.assertEqual(list(logs.iterdir()), [])
                if fail:
                    self.assertEqual(result.stdout.count("fixture output"), 4)


if __name__ == "__main__":
    unittest.main()
