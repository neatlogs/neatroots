// Integration test against the action's installed, immutable source build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function check(file, checks, only) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], {
    env: { ...process.env, INPUT_RUNS: file, INPUT_CHECKS: checks, INPUT_ONLY: only },
    encoding: 'utf8', shell: false,
  });
}

for (const [file, only, expected] of [
  ['clean.json', 'action-fixture-hit', 0],
  ['failing.json', 'action-fixture-hit', 1],
  ['clean.json', 'no-such-action-fixture-rule', 2],
]) {
  const result = check(fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), fileURLToPath(new URL('./fixtures/checks', import.meta.url)), only);
  assert.equal(result.status, expected, `Expected ${expected} for ${file}; ${result.stdout}`);
  console.log(`Real CLI ${file} / ${only}: exit ${expected}`);
}

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'action-smoke-'));
try {
  const clean = fileURLToPath(new URL('./fixtures/clean.json', import.meta.url));
  const failing = fileURLToPath(new URL('./fixtures/failing.json', import.meta.url));
  assert.equal(check(clean, path.join(dir, 'missing'), '').status, 2);
  assert.equal(check(clean, clean, '').status, 2); // A file is not a check directory.
  const checks = path.join(dir, 'checks');
  fs.mkdirSync(checks);
  const template = fs.readFileSync(new URL('./fixtures/checks/hit.yaml', import.meta.url), 'utf8');
  for (const id of ['pii_leak', 'a.rule', '2fa-check']) {
    fs.writeFileSync(path.join(checks, 'hit.yaml'), template.replace('action-fixture-hit', id));
    const result = check(failing, checks, id);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`check ${id};`), `Missing safe ID ${id}`);
  }
  const target = path.join(dir, 'target');
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.copyFileSync(clean, path.join(target, 'sub', 'run.json'));
  const link = path.join(dir, 'linked');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(check(path.join(link, 'sub', 'run.json'), checks, '').status, 2);
  assert.equal(check(clean, path.join(link, 'sub'), '').status, 2);
  console.log('Real CLI safe IDs and fail-closed explicit check/symlink inputs: passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
