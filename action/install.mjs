import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Ambient installer controls must not change the pinned install or poison its cache.
export function installEnvironment(source, commit) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('NEATROOTS_')));
  const dir = path.join(source.RUNNER_TEMP, 'neatroots-action-install');
  const home = path.join(dir, 'home');
  return { ...env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: path.join(home, '.run'), NEATROOTS_HOME: path.join(dir, 'state'),
    NEATROOTS_REF: commit, NEATROOTS_FROM_SOURCE: '1', NEATROOTS_SOURCE_DIR: path.join(dir, 'src'), NEATROOTS_INSTALL_DIR: dir,
    NEATROOTS_BIN_DIR: path.join(dir, 'bin'), NEATROOTS_CONNECT: '0',
    NEATROOTS_LAYA: 'no', NEATROOTS_SERVICE: '0', NEATROOTS_NO_MODIFY_PATH: '1' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { commit, repository } = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(commit) || repository !== 'https://github.com/neatlogs/neatroots.git') throw new Error('Expected pinned public source');
  const env = installEnvironment(process.env, commit);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'NEATROOTS_HOME']) {
    fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  const source = env.NEATROOTS_SOURCE_DIR;
  fs.mkdirSync(source, { recursive: true });
  // git clone --branch cannot resolve raw SHAs; fetch that exact commit first.
  for (const args of [['init', source], ['-C', source, 'fetch', '--depth', '1', repository, commit], ['-C', source, 'checkout', '--detach', commit]]) {
    const git = spawnSync('git', args, { env, stdio: 'inherit', shell: false });
    if (git.error || git.status !== 0) throw new Error('Could not fetch pinned source');
  }
  const result = spawnSync('sh', [fileURLToPath(new URL('../install.sh', import.meta.url)), '--from-source', '--ref', commit, '--no-connect', '--no-laya', '--no-modify-path'], {
    env, stdio: 'inherit', shell: false,
  });
  process.exitCode = result.error || result.status !== 0 ? 2 : 0;
}
