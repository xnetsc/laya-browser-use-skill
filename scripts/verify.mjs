import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = join(projectRoot, 'skills', 'laya-browser-use');
const lfsExclude = 'skills/laya-browser-use/runtime/models/**';
const model = await import(pathToFileURL(join(skillRoot, 'prepare-model.mjs')).href);
const withoutModel = process.argv.includes('--without-model');

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireFile(relative, minimumBytes = 1) {
  const path = join(skillRoot, relative);
  const info = await stat(path);
  if (!info.isFile() || info.size < minimumBytes) throw new Error(`Invalid file: ${relative}`);
  return path;
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) throw new Error(`Node.js 22+ is required; found ${process.version}`);

const lfsConfig = await readFile(join(projectRoot, '.lfsconfig'), 'utf8');
if (!lfsConfig.includes(`fetchexclude = ${lfsExclude}`)) {
  throw new Error(`.lfsconfig must exclude model payloads by default: ${lfsExclude}`);
}

const required = [
  ['SKILL.md', 100],
  ['bridge.mjs', 100],
  ['laya-cli.mjs', 100],
  ['laya-service.mjs', 100],
  ['laya-local.mjs', 100],
  ['laya-page.html', 100],
  ['prepare-model.mjs', 1000],
  ['webtorch-update.mjs', 1000],
  ['references/browser-adapters.md', 100],
  ['references/decision-api.md', 100],
  ['references/provider-configuration.md', 100],
  [`${model.MODEL_PREFIX}manifest.json`, 100],
  ['runtime/node_modules/playwright/index.mjs', 100],
  ['runtime/webtorch/dist/wgpy-main.js', 1000],
  ['runtime/webtorch/dist/wgpy-worker.js', 1000],
  ['runtime/webtorch/dist/wgpy_webgl-1.0.0-py3-none-any.whl', 1000],
  ['runtime/webtorch/dist/wgpy_webgpu-1.0.0-py3-none-any.whl', 1000],
  ['runtime/webtorch/manifest.json', 100],
  ['runtime/webtorch/UPSTREAM_SHA', 40],
  ['runtime/webtorch/webtorch/js/webtorch-main.js', 1000],
  ['runtime/webtorch/webtorch/js/webtorch-host.js', 1000],
  ['runtime/webtorch/webtorch/js/webtorch-worker.js', 1000],
];
for (const file of model.MODEL_SUPPORT_FILES) required.push([`${model.MODEL_PREFIX}${file.path}`, file.bytes]);
if (!withoutModel) {
  for (const asset of model.MODEL_ASSETS) required.push([asset.relative, asset.bytes]);
}
for (const [relative, minimumBytes] of required) await requireFile(relative, minimumBytes);

const gitMetadata = await stat(join(projectRoot, '.git')).then(() => true, () => false);
if (gitMetadata) {
  for (const [relative] of required) {
    const repositoryPath = `skills/laya-browser-use/${relative}`;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', repositoryPath], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(`Required package file is not tracked by Git: ${repositoryPath}`);
    }
  }
}

const skillText = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
if (!/^---\s*\nname: laya-browser-use\n/m.test(skillText)) {
  throw new Error('SKILL.md frontmatter does not declare laya-browser-use');
}

if (!withoutModel && !(await model.validModelDirectory(join(skillRoot, model.MODEL_PREFIX.replace(/\/$/, ''))))) {
  throw new Error('Bundled model files failed manifest verification. Run: node skills/laya-browser-use/prepare-model.mjs');
}

console.log(JSON.stringify({
  status: 'static-ok',
  skill: 'laya-browser-use',
  platform: process.platform,
  model: withoutModel ? 'skipped' : model.modelManifest().model,
  modelAssets: withoutModel ? 'skipped' : model.MODEL_ASSETS.map((asset) => ({bytes: asset.bytes, sha256: asset.sha256})),
}, null, 2));

if (process.argv.includes('--runtime')) {
  const bridge = await import(pathToFileURL(join(skillRoot, 'bridge.mjs')).href);
  const local = await import(pathToFileURL(join(skillRoot, 'laya-local.mjs')).href);
  try {
    const config = await bridge.loadConfig();
    const decision = await bridge.decide({
      ...config,
      goal: 'Click Alpha.',
      state: 'Browser tab: Test. URL: "https://example.com/".\nExplicit fact: Alpha is the candidate that directly matches the goal.\n1 button Alpha\n2 button Beta',
      actions: [
        {op: 'click', name: 'Alpha', description: 'Click Alpha'},
        {op: 'click', name: 'Beta', description: 'Click Beta'},
      ],
    });
    if (decision.choice !== 'a0') throw new Error(`Runtime chose the wrong action: ${decision.choice}`);
    if (!Number.isFinite(decision.confidence)) throw new Error(`Runtime confidence is invalid: ${decision.confidence}`);
    console.log(JSON.stringify({status: 'runtime-ok', config, decision}, null, 2));
  } finally {
    await local.closeLocalDecision();
  }
}
