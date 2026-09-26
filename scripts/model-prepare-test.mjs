import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  discoverLocalModelServer, discoverLocalModelSource, downloadVerifiedFile,
  LOCAL_MODEL_REGISTRY, MODEL_ASSETS, modelManifest,
} from '../skills/laya-browser-use/prepare-model.mjs';

const payload = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
const sha256 = createHash('sha256').update(payload).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'laya-model-prepare-test-'));
const destination = join(temporary, 'model.bin');
let requests = 0;
let resumed = false;
await writeFile(`${destination}.part`, payload.subarray(0, 128 * 1024));

const server = createServer((request, response) => {
  if (request.url === '/model-manifest.json') {
    response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(modelManifest()));
    return;
  }
  const modelPrefix = '/models/laya/';
  if (request.url.startsWith(modelPrefix)) {
    const sourcePath = decodeURIComponent(request.url.slice(modelPrefix.length));
    const asset = MODEL_ASSETS.find((value) => value.sourcePath === sourcePath);
    if (!asset || request.headers.range !== 'bytes=0-0') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(206, {
      'Content-Length': 1,
      'Content-Range': `bytes 0-0/${asset.bytes}`,
      'Accept-Ranges': 'bytes',
    }).end(Buffer.from([0]));
    return;
  }
  requests += 1;
  const range = request.headers.range;
  const offset = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
  if (offset > 0) resumed = true;
  const body = payload.subarray(offset);
  response.writeHead(offset > 0 ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': body.length,
    ...(offset > 0 ? {'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`} : {}),
  });
  response.end(body);
});

try {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  await downloadVerifiedFile({
    url: `http://127.0.0.1:${address.port}/model.bin`,
    destination,
    bytes: payload.length,
    sha256,
  });
  assert.deepEqual(await readFile(destination), payload);
  assert.equal(resumed, true);
  assert(requests >= 1);
  const registry = join(temporary, 'registry');
  await mkdir(registry);
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  await writeFile(join(registry, 'runtime.json'), JSON.stringify({...modelManifest(), baseUrl}));
  assert.equal((await discoverLocalModelServer({registry}))?.baseUrl, baseUrl);
  const staleRegistry = join(temporary, 'stale-registry');
  const fakeModelRoot = join(temporary, 'existing-model');
  await mkdir(staleRegistry);
  await writeFile(join(staleRegistry, 'runtime.json'), JSON.stringify({
    ...modelManifest(), baseUrl: 'http://127.0.0.1:1/', modelRoot: fakeModelRoot,
  }));
  const filesystem = await discoverLocalModelSource({
    registry: staleRegistry,
    validateModelRoot: async (value) => value === fakeModelRoot,
  });
  assert.equal(filesystem?.kind, 'filesystem');
  assert.equal(filesystem?.modelRoot, fakeModelRoot);
  assert.equal(LOCAL_MODEL_REGISTRY.startsWith(tmpdir()), true);
  console.log(JSON.stringify({
    status: 'model-prepare-tests-ok', resumed, localDiscovery: true,
    filesystemFallback: true, dynamicTempDirectory: true, requests,
  }, null, 2));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(temporary, {recursive: true, force: true});
}
