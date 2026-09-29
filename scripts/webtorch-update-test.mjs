import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const temporary = await mkdtemp(join(tmpdir(), 'laya-webtorch-update-test-'));
const skillRoot = join(temporary, 'skill');
const registry = join(temporary, 'registry');
process.env.LAYA_MODEL_REGISTRY = registry;
const {updateWebtorchRuntime} = await import(`../skills/laya-browser-use/webtorch-update.mjs?test=${Date.now()}`);

const runtimePaths = [
  'LICENSE',
  'NOTICE',
  'dist/wgpy-main.js',
  'dist/wgpy-worker.js',
  'dist/wgpy_webgl-1.0.0-py3-none-any.whl',
  'dist/wgpy_webgpu-1.0.0-py3-none-any.whl',
  'webtorch/js/webtorch-main.js',
  'webtorch/js/webtorch-host.js',
  'webtorch/js/webtorch-worker.js',
];
const runtimeFiles = new Map(runtimePaths.map((path) => [path, Buffer.from(`new:${path}\n`)]));
const oldRuntimeFiles = new Map(runtimePaths.map((path) => [path, Buffer.from(`old:${path}\n`)]));
const modelFiles = new Map([
  ['model.safetensors', Buffer.from('new-model-weights')],
  ['tokenizer/tokenizer.json', Buffer.from('new-tokenizer')],
]);
const oldModelFiles = new Map([
  ['model.safetensors', Buffer.from('old-model-weights')],
  ['tokenizer/tokenizer.json', Buffer.from('old-tokenizer')],
]);
const supportFiles = new Map([
  ['rl_agent_config.json', Buffer.from('{"model":"new"}\n')],
  ['encoder/config.json', Buffer.from('{"encoder":"new"}\n')],
  ['tokenizer/tokenizer_config.json', Buffer.from('{"tokenizer":"new"}\n')],
]);
const oldSupportFiles = new Map([...supportFiles].map(([path]) => [path, Buffer.from(`old:${path}\n`)]));

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runtimeManifest(commit, values, runtimeVersion) {
  return {
    protocol: 1,
    runtimeVersion,
    upstream: {repository: 'https://github.com/xnetsc/webpytorch.git', ref: 'main', commit},
    files: [...values].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha(bytes)})),
  };
}

function modelManifest(name, assets, support, sources) {
  return {
    protocol: 1,
    model: name,
    sources,
    supportFiles: [...support].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha(bytes)})),
    assets: [...assets].map(([sourcePath, bytes]) => ({
      relative: `runtime/models/laya/${sourcePath}`,
      sourcePath,
      bytes: bytes.length,
      sha256: sha(bytes),
    })),
  };
}

async function put(root, path, value) {
  await mkdir(join(root, path, '..'), {recursive: true});
  await writeFile(join(root, path), value);
}

async function seed(root, manifest, values) {
  for (const [path, bytes] of values) await put(root, path, bytes);
  await put(root, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

let serveCorruptModel = true;
let server;
try {
  await mkdir(registry, {recursive: true});
  await put(registry, 'profiles/old-cache/marker', 'cached');
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let body;
    let type = 'application/octet-stream';
    if (url.pathname === '/runtime/manifest.json') {
      body = Buffer.from(JSON.stringify(remoteRuntime));
      type = 'application/json';
    } else if (url.pathname === '/model/manifest.json') {
      body = Buffer.from(JSON.stringify(remoteModel));
      type = 'application/json';
    } else if (url.pathname.startsWith('/runtime/')) {
      body = runtimeFiles.get(decodeURIComponent(url.pathname.slice('/runtime/'.length)));
    } else if (url.pathname.startsWith('/model/')) {
      body = supportFiles.get(decodeURIComponent(url.pathname.slice('/model/'.length)));
    } else if (url.pathname.startsWith('/assets/')) {
      const path = decodeURIComponent(url.pathname.slice('/assets/'.length));
      body = modelFiles.get(path);
      if (serveCorruptModel && path === 'model.safetensors') body = Buffer.from('corrupt-model-data');
    }
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {'Content-Type': type, 'Content-Length': body.length}).end(body);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  const oldRuntime = runtimeManifest('1'.repeat(40), oldRuntimeFiles, 100);
  let remoteRuntime = runtimeManifest('2'.repeat(40), runtimeFiles, 200);
  const oldModel = modelManifest('old-model', oldModelFiles, oldSupportFiles, [`${base}/assets/`]);
  const remoteModel = modelManifest('new-model', modelFiles, supportFiles, [`${base}/assets/`]);
  await seed(join(skillRoot, 'runtime', 'webtorch'), oldRuntime, oldRuntimeFiles);
  await seed(join(skillRoot, 'runtime', 'models', 'laya'), oldModel, new Map([...oldModelFiles, ...oldSupportFiles]));

  let beforeApply = 0;
  const first = await updateWebtorchRuntime({
    skillRoot,
    manifestUrl: `${base}/runtime/manifest.json`,
    modelManifestUrl: `${base}/model/manifest.json`,
    beforeApply: async () => { beforeApply += 1; },
    log: () => {},
  });
  assert.equal(first.status, 'failed');
  assert.equal(beforeApply, 0);
  assert.deepEqual(await readFile(join(skillRoot, 'runtime/models/laya/model.safetensors')), oldModelFiles.get('model.safetensors'));
  assert.deepEqual(await readFile(join(skillRoot, 'runtime/webtorch/dist/wgpy-main.js')), oldRuntimeFiles.get('dist/wgpy-main.js'));

  serveCorruptModel = false;
  const second = await updateWebtorchRuntime({
    skillRoot,
    manifestUrl: `${base}/runtime/manifest.json`,
    modelManifestUrl: `${base}/model/manifest.json`,
    beforeApply: async () => {
      beforeApply += 1;
      assert.deepEqual(await readFile(join(skillRoot, 'runtime/models/laya/model.safetensors')), oldModelFiles.get('model.safetensors'));
    },
    log: () => {},
  });
  assert.equal(second.status, 'updated');
  assert.equal(second.modelUpdated, true);
  assert.equal(second.requiresProcessRestart, true);
  assert.equal(beforeApply, 1);
  assert.deepEqual(await readFile(join(skillRoot, 'runtime/models/laya/model.safetensors')), modelFiles.get('model.safetensors'));
  assert.deepEqual(await readFile(join(skillRoot, 'runtime/webtorch/dist/wgpy-main.js')), runtimeFiles.get('dist/wgpy-main.js'));
  await assert.rejects(access(registry));

  const current = await updateWebtorchRuntime({
    skillRoot,
    manifestUrl: `${base}/runtime/manifest.json`,
    modelManifestUrl: `${base}/model/manifest.json`,
    log: () => {},
  });
  assert.equal(current.status, 'current');

  remoteRuntime = oldRuntime;
  const noDowngrade = await updateWebtorchRuntime({
    skillRoot,
    manifestUrl: `${base}/runtime/manifest.json`,
    modelManifestUrl: `${base}/model/manifest.json`,
    log: () => {},
  });
  assert.equal(noDowngrade.status, 'current');
  assert.equal(noDowngrade.remoteRuntimeOlder, true);
  assert.equal(noDowngrade.commit, '2'.repeat(40));
  assert.deepEqual(await readFile(join(skillRoot, 'runtime/webtorch/dist/wgpy-main.js')), runtimeFiles.get('dist/wgpy-main.js'));

  remoteRuntime = runtimeManifest('3'.repeat(40), oldRuntimeFiles, 200);
  const noSidegrade = await updateWebtorchRuntime({
    skillRoot,
    manifestUrl: `${base}/runtime/manifest.json`,
    modelManifestUrl: `${base}/model/manifest.json`,
    log: () => {},
  });
  assert.equal(noSidegrade.status, 'current');
  assert.equal(noSidegrade.runtimeVersionConflict, true);
  assert.equal(noSidegrade.commit, '2'.repeat(40));
  console.log(JSON.stringify({status: 'webtorch-update-tests-ok', atomicModelSwitch: true}, null, 2));
} finally {
  await new Promise((resolvePromise) => server?.close(resolvePromise));
  await rm(temporary, {recursive: true, force: true});
}
