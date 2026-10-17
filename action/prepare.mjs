import fs from 'node:fs';
import { createHash } from 'node:crypto';
if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Linux and macOS runners are supported');
const { commit } = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected an immutable source commit');
fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${commit}\n`);
const installer = fs.readFileSync(new URL('../install.sh', import.meta.url));
fs.appendFileSync(process.env.GITHUB_OUTPUT, `installer=${createHash('sha256').update(installer).update(fs.readFileSync(new URL('./install.mjs', import.meta.url))).digest('hex')}\n`);
