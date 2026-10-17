import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const diagnostic = 'neatroots action installation could not complete; diagnostic content withheld.\n';
for (const failure of ['read', 'parse', 'pin', 'mkdir', 'init', 'fetch', 'checkout', 'spawn', 'installer', 'success']) {
  test(`direct installer handles ${failure} without uncaught/private diagnostics`, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'action-install-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'install.mjs');
    fs.copyFileSync(new URL('./install.mjs', import.meta.url), script);
    if (failure !== 'read') fs.writeFileSync(path.join(root, 'source.json'), failure === 'parse' ? 'SECRET invalid JSON' : JSON.stringify({ commit: failure === 'pin' ? 'SECRET' : 'a'.repeat(40), repository: 'https://github.com/neatlogs/neatroots.git' }));
    const runner = path.join(root, 'runner');
    if (failure === 'mkdir') fs.writeFileSync(runner, 'SECRET');
    const calls = path.join(root, 'calls.jsonl');
    const preload = path.join(root, 'preload.mjs');
    fs.writeFileSync(preload, `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
cp.spawnSync = (cmd, args, options) => {
  const stage = cmd === 'git' ? args.includes('fetch') ? 'fetch' : args.includes('checkout') ? 'checkout' : 'init' : 'installer';
  fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({stage, shell: options.shell, stdio: options.stdio}) + String.fromCharCode(10));
  if (process.env.TEST_FAILURE === 'spawn') throw new Error('SECRET spawn exception');
  return { status: stage === process.env.TEST_FAILURE ? 1 : 0, stderr: 'SECRET child stderr', stdout: 'SECRET child stdout' };
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
      env: { ...process.env, RUNNER_TEMP: runner, TEST_CALLS: calls, TEST_FAILURE: failure }, encoding: 'utf8', shell: false,
    });
    assert.equal(result.status, failure === 'success' ? 0 : 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, failure === 'success' ? '' : diagnostic);
    const stages = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    if (['read','parse','pin','mkdir'].includes(failure)) assert.deepEqual(stages, []);
    else {
      assert.deepEqual(stages.map(x => x.stage), ['init','fetch','checkout','installer'].slice(0, failure === 'spawn' ? 1 : failure === 'success' ? 4 : ['init','fetch','checkout','installer'].indexOf(failure)+1));
      assert.ok(stages.every(x => x.shell === false));
      assert.ok(stages.every(x => x.stdio === 'ignore'), 'Discard child output without a pipe buffer or inherited private diagnostics');
    }
  });
}
