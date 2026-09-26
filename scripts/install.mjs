import {cp, mkdir, rename, stat} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInstallTarget} from './install-target.mjs';
import {ensureModel, MODEL_ASSETS} from '../skills/laya-browser-use/prepare-model.mjs';

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
const deferModel = args.includes('--defer-model');

if (basename(target) !== 'laya-browser-use') {
  throw new Error('Install target must end with laya-browser-use');
}

for (const relative of [
  'SKILL.md',
  'bridge.mjs',
  'laya-cli.mjs',
  'laya-local.mjs',
  'laya-page.html',
  'prepare-model.mjs',
  'references/decision-api.md',
  'runtime/models/laya/rl_agent_config.json',
  'runtime/models/laya/encoder/config.json',
  'runtime/models/laya/tokenizer/tokenizer_config.json',
  'runtime/node_modules/playwright/index.mjs',
  'runtime/webtorch/dist/wgpy-main.js',
  'runtime/webtorch/dist/wgpy-worker.js',
  'runtime/webtorch/dist/wgpy_webgl-1.0.0-py3-none-any.whl',
  'runtime/webtorch/dist/wgpy_webgpu-1.0.0-py3-none-any.whl',
  'runtime/webtorch/webtorch/js/webtorch-main.js',
  'runtime/webtorch/webtorch/js/webtorch-host.js',
  'runtime/webtorch/webtorch/js/webtorch-worker.js',
]) {
  if (!(await exists(join(source, relative)))) throw new Error(`Package file is missing: ${relative}`);
}

let modelPreparation = null;
if (!dryRun && !deferModel) {
  modelPreparation = await ensureModel({
    root: source,
    useGitLfs: true,
  });
  console.log(`Model preparation: ${modelPreparation.method}`);
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
  console.log(`Dry run complete; no files changed. Model preparation: ${deferModel ? 'deferred' : 'required before copy'}.`);
  process.exit(0);
}

await mkdir(dirname(target), {recursive: true});
if (backup) await rename(target, backup);
try {
  const omitModel = deferModel || ['local-http', 'local-files', 'browser-cache'].includes(modelPreparation?.method);
  const deferredPaths = new Set(MODEL_ASSETS.map((asset) => resolve(source, asset.relative)));
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: omitModel ? (path) => !deferredPaths.has(resolve(path)) : undefined,
  });
} catch (error) {
  if (backup && !(await exists(target))) await rename(backup, target);
  throw error;
}

if (deferModel) {
  console.log('Installed laya-browser-use without model files.');
  console.log(`Prepare them before first use: node ${join(target, 'prepare-model.mjs')}`);
} else if (['local-http', 'local-files', 'browser-cache'].includes(modelPreparation?.method)) {
  const sourceLabel = modelPreparation.method === 'browser-cache'
    ? 'a reusable browser cache is available'
    : 'a reusable local model source is available';
  console.log(`Installed laya-browser-use without copying model files; ${sourceLabel}.`);
} else {
  console.log('Installed laya-browser-use. Reload or restart the Skills host before using it.');
}
