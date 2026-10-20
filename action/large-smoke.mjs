// Exercise the immutable CLI through the action, including reports larger than a pipe buffer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'action-large-'));
try {
  const checks = path.join(dir, 'checks');
  fs.mkdirSync(checks);
  fs.copyFileSync(new URL('./fixtures/checks/hit.yaml', import.meta.url), path.join(checks, 'hit.yaml'));
  for (const [kind, expected, extra] of [['clean', 0, ''], ['finding', 1, ''], ['overlimit', 2, 'x'.repeat(18000)]]) {
    const base = JSON.parse(fs.readFileSync(new URL(`./fixtures/${kind === 'finding' ? 'failing' : 'clean'}.json`, import.meta.url), 'utf8'));
    const scope = base.resourceSpans[0].scopeSpans[0];
    const template = scope.spans[0];
    scope.spans = Array.from({ length: 1000 }, (_, i) => ({ ...template, traceId: (i + 1).toString(16).padStart(32, '0'), name: `${template.name} SECRET ${extra}` }));
    const file = path.join(dir, `${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(base));
    const summary = path.join(dir, `${kind}.md`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], {
      env: { ...process.env, INPUT_RUNS: file, INPUT_CHECKS: checks, INPUT_ONLY: 'action-fixture-hit', GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8', shell: false, timeout: 300_000,
    });
    assert.equal(result.status, expected, `1000 ${kind} runs should exit ${expected}`);
    const published = result.stdout + result.stderr + fs.readFileSync(summary, 'utf8');
    assert.ok(!published.includes('SECRET'), 'Private names must not be published');
    if (kind !== 'overlimit') assert.ok(published.includes(`1000 run(s), ${kind === 'finding' ? 1000 : 0} finding(s)`));
    console.log(`Pinned CLI: 1000 ${kind} runs -> exit ${expected}; private content withheld`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
