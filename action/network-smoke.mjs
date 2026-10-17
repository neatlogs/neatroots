// Exercise the exact pinned installer choice and CLI, with all networking blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installEnvironment } from './install.mjs';

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'action-network-'));
try {
  const fixture = path.join(dir, 'host.json');
  const log = path.join(dir, 'network.jsonl');
  const calls = path.join(dir, 'calls');
  const host = '{"consent":"yes","sentinel":"keep"}';
  fs.writeFileSync(fixture, host);
  fs.writeFileSync(log, '');
  const preload = path.join(dir, 'guard.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import net from 'node:net';
const record=value=>fs.appendFileSync(process.env.TEST_NET_LOG,JSON.stringify(value)+String.fromCharCode(10));
net.Socket.prototype.connect=function(){record({kind:'socket'});throw new Error('Network forbidden');};
globalThis.fetch=async(input,init={})=>{
 record({kind:'fetch',url:String(input),method:init.method??'GET'});
 throw new Error('Network forbidden');
};
`);
  const { commit } = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
  const env = installEnvironment({ ...process.env, RUNNER_TEMP: dir, NEATROOTS_LAYA: 'yes', NEATROOTS_PORT: '4321', NEATROOTS_URL: 'http://caller.invalid:4321' }, commit);
  fs.mkdirSync(env.NEATROOTS_HOME, { recursive: true });
  fs.mkdirSync(env.NEATROOTS_BIN_DIR, { recursive: true });
  const config = path.join(env.NEATROOTS_HOME, 'config.yaml');
  const state = 'port: 4321\n';
  fs.writeFileSync(config, state);
  const source = path.join(process.env.RUNNER_TEMP, 'neatroots-action-install', 'src');
  const cli = path.join(source, 'packages', 'neatroots', 'dist', 'cli.js');
  const script = fs.readFileSync(path.join(source, 'install.sh'), 'utf8');
  const start = script.indexOf('choose_laya() {');
  const end = script.indexOf('\nfinish() {', start);
  assert.ok(start >= 0 && end > start, 'Expected pinned installer function');
  const wrapper = path.join(env.NEATROOTS_BIN_DIR, 'neatroots');
  fs.writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$*" >>"$TEST_CALLS"\n"$TEST_NODE" --import "$TEST_PRELOAD" "$TEST_CLI" "$@"\nstatus=$?\nprintf "%s" "$status" >"$TEST_STATUS"\nexit "$status"\n', { mode: 0o700 });
  const harness = path.join(dir, 'choose.sh');
  fs.writeFileSync(harness, `set -eu\n${script.slice(start, end)}\nLAYA="$NEATROOTS_LAYA"\nBIN_DIR="$NEATROOTS_BIN_DIR"\nchoose_laya\n`);
  const result = spawnSync('sh', [harness], {
    env: { ...env, TEST_NET_LOG: log, TEST_CALLS: calls, TEST_STATUS: path.join(dir, 'status'), TEST_NODE: process.execPath, TEST_PRELOAD: pathToFileURL(preload).href, TEST_CLI: cli },
    stdio: 'ignore', shell: false, timeout: 10_000,
  });
  assert.equal(result.status, 0, 'Pinned installer noninteractive choice should succeed');
  assert.equal(fs.readFileSync(path.join(dir, 'status'), 'utf8'), '0', 'Real pinned CLI succeeded');
  assert.equal(fs.readFileSync(calls, 'utf8'), 'laya choose --no-ask\n');
  assert.equal(fs.readFileSync(log, 'utf8'), '', 'No fetch or socket attempt, including model downloads');
  assert.equal(fs.readFileSync(fixture, 'utf8'), host);
  assert.equal(fs.readFileSync(config, 'utf8'), state, 'Choice must not save consent');
  assert.deepEqual(fs.readdirSync(env.NEATROOTS_HOME).sort(), ['config.yaml', 'laya']);
  assert.deepEqual(fs.readdirSync(path.join(env.NEATROOTS_HOME, 'laya')), ['token'], 'Only the local manager token is initialized; no model download');
  assert.equal(env.NEATROOTS_PORT, undefined);
  assert.equal(env.NEATROOTS_URL, undefined);
  console.log('Pinned installer: laya choose --no-ask; no network attempt, consent change or model download');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
