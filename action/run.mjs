import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lines = value => (value ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const escape = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
// IDs are the only trace-controlled fields published. Arbitrary names, titles,
// paths, params and diagnostic errors may contain secrets and stay private.
const id = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : '[withheld]';
const traceId = value => id(value, /^[a-fA-F0-9]{32}$/);
const spanId = value => id(value, /^[a-fA-F0-9]{16}$/);
const checkId = value => id(value, /^[a-z0-9][a-z0-9_.-]{0,79}$/);
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

function readReport(fd) {
  const size = fs.fstatSync(fd).size;
  if (size > MAX_REPORT_BYTES) throw new Error('Report too large');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset);
    if (!count) throw new Error('Incomplete report');
    offset += count;
  }
  return bytes.toString('utf8');
}

function noSymlinkStat(file) {
  // Preserve dot/parent components until each preceding component is checked.
  if (!path.isAbsolute(file)) file = `${process.cwd()}${path.sep}${file}`;
  const root = path.parse(file).root;
  let current = root;
  let stat = fs.lstatSync(current);
  for (const part of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported');
  }
  return stat;
}

export function filesFor(inputs) {
  const files = new Set();
  function visit(file, explicit = false, stat = fs.lstatSync(file)) {
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(file, entry));
    } else if (stat.isFile() && (explicit || /\.jsonl?$/i.test(file))) files.add(path.resolve(file));
  }
  for (const file of lines(inputs)) visit(path.resolve(file), true, noSymlinkStat(file));
  if (!files.size) throw new Error('No saved runs');
  return [...files];
}

export function run(env = process.env, execute = spawnSync, write = console.log) {
  let home;
  let report;
  const summary = ['## neatroots saved-run checks', '', '| Run | Check | Severity | Message |', '| --- | --- | --- | --- |'];
  let status = 2;
  try {
    const files = filesFor(env.INPUT_RUNS);
    const args = ['check', '--json'];
    if (env.INPUT_ONLY?.trim()) args.push('--only', env.INPUT_ONLY.trim());
    const dirs = lines(env.INPUT_CHECKS).map(dir => {
      if (!noSymlinkStat(dir).isDirectory()) throw new Error('Expected a check directory');
      return path.resolve(dir);
    });
    if (dirs.length) args.push('--checks', ...dirs);
    // -- ends the variadic --checks option and prevents paths becoming flags.
    args.push('--', ...files);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'neatroots-action-'));
    // Node drains writes synchronously to a regular file on supported runners,
    // even when this pinned CLI exits immediately after printing its JSON.
    report = fs.openSync(path.join(home, 'report.json'), 'wx+', 0o600);
    // The installer's shell wrapper embeds absolute paths. Invoke its built CLI
    // with this action's Node so a cache restored to another temp root relocates.
    const cli = path.join(env.RUNNER_TEMP, 'neatroots-action-install', 'src', 'packages', 'neatroots', 'dist', 'cli.js');
    const result = execute(process.execPath, [cli, ...args], {
      // The CLI's offline database uses os.tmpdir(), independently of rootsHome.
      // Keep every platform's temp selector inside the directory removed below,
      // including when a timeout kills the child before its own finally runs.
      env: { ...env, NEATROOTS_HOME: home, TMPDIR: home, TMP: home, TEMP: home }, stdio: ['ignore', report, 'ignore'],
      timeout: 300_000, shell: false,
    });
    if (result.error || ![0, 1, 2].includes(result.status)) throw new Error('Check process failed');
    status = result.status;
    const stdout = readReport(report);
    if (stdout.trim()) {
      const data = JSON.parse(stdout);
      if (!Array.isArray(data.runs) || !Array.isArray(data.errors) || !Array.isArray(data.rules)) throw new Error('Invalid result');
      let count = 0;
      for (const run of data.runs) {
        if (!Array.isArray(run.findings)) throw new Error('Invalid run');
        for (const finding of run.findings) {
          if (!Array.isArray(finding.evidence_span_ids)) throw new Error('Invalid evidence');
          count++;
          const trace = traceId(run.trace_id), check = checkId(finding.check_id);
          const spans = finding.evidence_span_ids.map(spanId).slice(0, 20).join(', ') || 'none';
          const message = `Rule fired; run ${trace}; check ${check}; spans ${spans}`;
          if (count <= 50) write(`::error::${escape(message)}`);
          if (count <= 200) summary.push(`| ${trace} | ${check} | error | Rule fired; spans ${spans} |`);
        }
      }
      // Severity and rendered messages are not supplied by the current CLI schema.
      summary.push('', `${data.runs.length} run(s), ${count} finding(s), ${data.errors.length} configuration error(s).`,
        'Annotations limited to 50; table limited to 200 findings. Trace content and finding parameters are omitted.');
      if (data.errors.length) write('::error::neatroots check configuration is invalid; diagnostic content withheld.');
      if (status !== (data.errors.length ? 2 : count ? 1 : 0)) throw new Error('Inconsistent result');
    } else if (status !== 2) throw new Error('Missing JSON');
    if (status === 2) summary.push('', 'Invalid input or configuration; diagnostic content withheld.');
  } catch {
    status = 2;
    write('::error::neatroots check could not complete; input or diagnostic content withheld.');
    summary.push('', 'Check could not complete (exit 2).');
  } finally {
    if (report !== undefined) fs.closeSync(report);
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run();
