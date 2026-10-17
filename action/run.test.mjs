import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { filesFor, run as capturedRun } from './run.mjs';
import { installEnvironment } from './install.mjs';

// Existing result fixtures supply JSON through the actual stdout descriptor.
function run(env, execute, write) {
  return capturedRun(env, (binary, args, options) => {
    const result = execute(binary, args, options);
    if (result.stdout) fs.writeSync(options.stdio[1], result.stdout);
    return result;
  }, write);
}

test('installer ignores ambient source, bundle, repo and runtime overrides', () => {
  const env = installEnvironment({ RUNNER_TEMP: '/tmp/runner', PATH: '/bin', NEATROOTS_BUNDLE: 'evil', NEATROOTS_FROM_SOURCE: '1', NEATROOTS_GITHUB_REPO: 'evil', NEATROOTS_NODE: 'evil', NEATROOTS_VERSION: 'latest', NEATROOTS_PORT: '4321', NEATROOTS_URL: 'http://caller.invalid:4321' }, '0.2.8');
  assert.equal(env.NEATROOTS_VERSION, undefined);
  assert.equal(env.NEATROOTS_REF, '0.2.8');
  assert.equal(env.NEATROOTS_BUNDLE, undefined);
  assert.equal(env.NEATROOTS_FROM_SOURCE, '1');
  assert.equal(env.NEATROOTS_GITHUB_REPO, undefined);
  assert.equal(env.NEATROOTS_NODE, undefined);
  assert.equal(env.NEATROOTS_URL, undefined);
  assert.equal(env.NEATROOTS_PORT, undefined);
  assert.equal(env.PATH, '/bin');
});

test('installer isolates user state and platform home paths inside runner temp', () => {
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
  const source = Object.fromEntries(keys.map(key => [key, `/host/${key}`]));
  const runner = path.resolve('runner temp');
  const env = installEnvironment({ ...source, RUNNER_TEMP: runner, NEATROOTS_HOME: '/host/state' }, 'a'.repeat(40));
  const install = path.join(runner, 'neatroots-action-install');
  for (const key of [...keys, 'NEATROOTS_HOME']) {
    const relative = path.relative(install, env[key]);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), key);
    assert.notEqual(env[key], source[key], key);
  }
  assert.equal(env.HOME, env.USERPROFILE);
  assert.equal(env.NEATROOTS_SERVICE, '0');
  assert.equal(env.NEATROOTS_LAYA, 'ask');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'action-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'trace.json'), '{}');
  return { dir, env: { INPUT_RUNS: path.join(dir, 'runs'), RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: path.join(dir, 'summary') } };
}
for (const status of [0, 1, 2]) test(`preserves CLI exit ${status} and contains private output`, t => {
  const { env } = fixture(t);
  const output = [];
  const data = { rules: ['hit'], errors: status === 2 ? ['SECRET'] : [], runs: [{ trace_id: 'a'.repeat(32), root_name: 'SECRET', findings: status === 1 ? [{ check_id: 'hit', title: 'SECRET\n::error::attack', params: { key: 'SECRET' }, evidence_span_ids: ['b'.repeat(16)] }] : [] }] };
  assert.equal(run(env, () => ({ status, stdout: JSON.stringify(data), stderr: 'SECRET' }), x => output.push(x)), status);
  const published = output.join('\n') + fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(!published.includes('SECRET'));
  if (status === 1) assert.match(published, /check hit; spans b/);
});
test('uses argument arrays and terminates variadic checks before file paths', t => {
  const { env, dir } = fixture(t);
  const dirs = ['checks with spaces', 'other'].map(name => path.join(dir, name));
  dirs.forEach(dir => fs.mkdirSync(dir));
  env.INPUT_CHECKS = dirs.join('\n');
  env.INPUT_ONLY = 'hit,$(touch unwanted)';
  assert.equal(run(env, (binary, args, opts) => {
    assert.equal(binary, process.execPath);
    assert.equal(args[0], path.join(dir, 'neatroots-action-install', 'src', 'packages', 'neatroots', 'dist', 'cli.js'));
    assert.equal(opts.shell, false);
    assert.equal(args[4], env.INPUT_ONLY);
    assert.deepEqual(args.slice(5, 9), ['--checks', ...dirs, '--']);
    assert.equal(args[9], path.join(dir, 'runs', 'trace.json'));
    assert.notEqual(opts.env.NEATROOTS_HOME, env.NEATROOTS_HOME);
    return { status: 0, stdout: '{"runs":[],"rules":[],"errors":[]}' };
  }, () => {}), 0);
});
for (const result of [{ status: null, error: new Error('SECRET') }, { status: 0, stdout: 'not JSON' }, { status: 0, stdout: '' }, { status: 7 }, { status: 0, stdout: '{"runs":[],"errors":["SECRET"],"rules":[]}' }]) {
  test('fails closed on unusable or inconsistent CLI results', t => {
    const { env } = fixture(t);
    assert.equal(run(env, () => result, () => {}), 2);
  });
}
test('recurses directories, ignores unrelated files, deduplicates and rejects empty inputs', t => {
  const { env } = fixture(t);
  fs.writeFileSync(path.join(env.INPUT_RUNS, 'ignored.txt'), 'SECRET');
  fs.mkdirSync(path.join(env.INPUT_RUNS, 'nested'));
  fs.writeFileSync(path.join(env.INPUT_RUNS, 'nested', 'trace.jsonl'), '{}');
  assert.equal(filesFor(`${env.INPUT_RUNS}\n${env.INPUT_RUNS}`).length, 2);
  assert.throws(() => filesFor(''));
});
test('withholds malformed identifiers and workflow command characters', t => {
  const { env } = fixture(t);
  const output = [];
  assert.equal(run(env, () => ({ status: 1, stdout: JSON.stringify({ rules: [], errors: [], runs: [{ trace_id: 'SECRET\n::error::injected', findings: [{ check_id: 'SECRET|<script>', evidence_span_ids: ['SECRET'] }] }] }) }), x => output.push(x)), 1);
  assert.ok(!output.join('').includes('SECRET'));
  assert.ok(!fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes('<script>'));
});

for (const invalid of ['missing', 'file', 'mixed']) test(`rejects ${invalid} explicit check directories before CLI execution`, t => {
  const { env, dir } = fixture(t);
  const missing = path.join(dir, 'SECRET-missing-checks');
  const regular = path.join(dir, 'SECRET-file');
  fs.writeFileSync(regular, 'SECRET');
  env.INPUT_CHECKS = invalid === 'missing' ? missing : invalid === 'file' ? regular : `${dir}\n${missing}`;
  let executed = false;
  const output = [];
  assert.equal(run(env, () => { executed = true; return { status: 0, stdout: '{"runs":[],"rules":[],"errors":[]}' }; }, x => output.push(x)), 2);
  assert.equal(executed, false);
  assert.ok(!(output.join('') + fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).includes('SECRET'));
});

test('reports schema-safe check IDs and retains identifier bounds', t => {
  const { env } = fixture(t);
  const output = [];
  const safe = ['pii_leak', 'a.rule', '2fa-check', 'a'.repeat(80)];
  const unsafe = ['a'.repeat(81), '_leading', '.leading', 'bad\n::error::INJECT', 'bad|<script>'];
  const findings = [...safe, ...unsafe].map(check_id => ({ check_id, evidence_span_ids: [] }));
  assert.equal(run(env, () => ({ status: 1, stdout: JSON.stringify({ rules: [], errors: [], runs: [{ trace_id: 'a'.repeat(32), findings }] }) }), x => output.push(x)), 1);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  for (const check of safe) {
    assert.ok(output.some(line => line.includes(`check ${check};`)), check);
    assert.ok(summary.includes(`| ${check} |`), check);
  }
  for (const check of unsafe) assert.ok(!(output.join('') + summary).includes(check), check);
  assert.equal(output.filter(line => line.includes('check [withheld];')).length, unsafe.length);
});

for (const input of ['file', 'directory', 'checks', 'parent traversal']) test(`rejects symlink ancestors for explicit ${input} inputs`, t => {
  const { env, dir } = fixture(t);
  const target = path.join(dir, 'target');
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(target, 'sub', 'run.json'), '{}');
  const link = path.join(dir, 'linked');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (input === 'checks') {
    env.INPUT_CHECKS = path.join(link, 'sub');
    let executed = false;
    assert.equal(run(env, () => { executed = true; return { status: 0, stdout: '{"runs":[],"rules":[],"errors":[]}' }; }, () => {}), 2);
    assert.equal(executed, false);
  } else if (input === 'parent traversal') {
    // Keep the link component in the input: path.join would erase it.
    assert.throws(() => filesFor(`${link}${path.sep}..${path.sep}runs`), /Symbolic links/);
  } else {
    assert.throws(() => filesFor(path.join(link, 'sub', ...(input === 'file' ? ['run.json'] : []))), /Symbolic links/);
  }
});

for (const size of [16 * 1024 * 1024 - 1, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
  test(`private file capture enforces the accepted byte limit at ${size}`, t => {
    const { env } = fixture(t);
    const published = [];
    let home, fd;
    const expected = size > 16 * 1024 * 1024 ? 2 : 0;
    assert.equal(capturedRun(env, (binary, args, opts) => {
      home = opts.env.NEATROOTS_HOME;
      fd = opts.stdio[1];
      assert.equal(opts.stdio[0], 'ignore');
      assert.equal(opts.stdio[2], 'ignore');
      assert.equal(opts.timeout, 300_000);
      assert.equal(opts.shell, false);
      assert.equal(opts.maxBuffer, undefined);
      assert.ok(fs.fstatSync(fd).isFile());
      if (process.platform !== 'win32') {
        assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
        assert.equal(fs.statSync(home).mode & 0o777, 0o700);
      }
      const json = '{"runs":[],"rules":[],"errors":[]}';
      fs.writeSync(fd, json + ' '.repeat(size - Buffer.byteLength(json)));
      return { status: 0 };
    }, x => published.push(x)), expected);
    assert.ok(!fs.existsSync(home), 'Capture/home must be removed');
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.ok(!published.join('').includes('{"runs"'));
  });
}

for (const failure of ['timeout', 'malformed', 'throw']) test(`file capture cleans up and withholds diagnostics after ${failure}`, t => {
  const { env } = fixture(t);
  const output = [];
  let home, fd;
  assert.equal(capturedRun(env, (binary, args, opts) => {
    home = opts.env.NEATROOTS_HOME;
    fd = opts.stdio[1];
    fs.writeSync(fd, 'SECRET invalid JSON');
    if (failure === 'throw') throw new Error('SECRET');
    return failure === 'timeout' ? { status: null, error: new Error('SECRET timeout') } : { status: 0 };
  }, x => output.push(x)), 2);
  assert.ok(!fs.existsSync(home));
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  assert.ok(!(output.join('') + fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).includes('SECRET'));
});

for (const status of [0, 1, 2]) for (const contents of ['', ' \t\r\n']) {
  test(`empty or whitespace capture fails closed for child ${status} (${contents ? 'whitespace' : 'empty'})`, t => {
    const { env } = fixture(t);
    const output = [];
    let home, fd;
    assert.equal(capturedRun(env, (binary, args, opts) => {
      home = opts.env.NEATROOTS_HOME;
      fd = opts.stdio[1];
      if (contents) fs.writeSync(fd, contents);
      return { status, stderr: 'SECRET private diagnostic' };
    }, x => output.push(x)), 2);
    assert.ok(!fs.existsSync(home));
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.ok(!(output.join('') + summary).includes('SECRET'));
    assert.match(summary, status === 2 ? /Invalid input or configuration/ : /Check could not complete \(exit 2\)/);
  });
}
