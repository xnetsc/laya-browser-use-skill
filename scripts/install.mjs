import {cp, mkdir, rename, stat} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInstallTarget} from './install-target.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(projectRoot, 'skills', 'laya-browser-use');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

const explicitTarget = option('--target');
const host = option('--host') || 'agents';
const target = resolveInstallTarget({host, target: explicitTarget});
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

if (basename(target) !== 'laya-browser-use') {
  throw new Error('Install target must end with laya-browser-use');
}

for (const relative of [
  'SKILL.md',
  'bridge.mjs',
  'laya-cli.mjs',
  'laya-local.mjs',
  'laya-page.html',
  'runtime/models/laya/model.safetensors',
  'runtime/models/laya/rl_agent_config.json',
  'runtime/models/laya/encoder/config.json',
  'runtime/models/laya/tokenizer/tokenizer.json',
  'runtime/models/laya/tokenizer/tokenizer_config.json',
  'runtime/node_modules/playwright/index.mjs',
  'runtime/webtorch/dist/wgpy-main.js',
]) {
  if (!(await exists(join(source, relative)))) throw new Error(`Package file is missing: ${relative}`);
}

let backup = null;
if (await exists(target)) {
  if (!force) {
    throw new Error(`Target already exists: ${target}\nRun with --force to replace it with a recoverable backup.`);
  }
  backup = `${target}.backup-${stamp()}`;
}

console.log(`Source: ${source}`);
console.log(`Target: ${target}`);
if (backup) console.log(`Backup: ${backup}`);
if (dryRun) {
  console.log('Dry run complete; no files changed.');
  process.exit(0);
}

await mkdir(dirname(target), {recursive: true});
if (backup) await rename(target, backup);
try {
  await cp(source, target, {recursive: true, errorOnExist: true, force: false});
} catch (error) {
  if (backup && !(await exists(target))) await rename(backup, target);
  throw error;
}

console.log('Installed laya-browser-use. Reload or restart the Skills host before using it.');
