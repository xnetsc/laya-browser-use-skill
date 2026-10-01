import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {modelPrefix, modelRoot} from './model-dir.mjs';

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/xnetsc/laya-browser-use-skill/main/skills/laya-browser-use/runtime/webtorch/manifest.json';
const MODEL_REGISTRY = process.env.LAYA_MODEL_REGISTRY
  || join(tmpdir(), 'laya-browser-use-model-servers-v1');
const REQUIRED = new Set([
  'LICENSE',
  'NOTICE',
  'dist/wgpy-main.js',
  'dist/wgpy-worker.js',
  'dist/wgpy_webgl-1.0.0-py3-none-any.whl',
  'dist/wgpy_webgpu-1.0.0-py3-none-any.whl',
  'webtorch/js/webtorch-main.js',
  'webtorch/js/webtorch-host.js',
  'webtorch/js/webtorch-worker.js',
]);

function safePath(value) {
  return typeof value === 'string' && value && !value.startsWith('/') && !value.startsWith('\\')
    && !value.includes('\\') && !value.split('/').includes('..');
}

function modelLocalPath(asset, prefix) {
  const relative = String(asset?.relative || '');
  return relative.startsWith(prefix) ? relative.slice(prefix.length) : relative;
}

function validateManifest(value) {
  if (value?.protocol !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > 500) {
    throw new Error('Invalid WebPyTorch runtime manifest.');
  }
  if (value.runtimeVersion !== undefined
      && (!Number.isSafeInteger(value.runtimeVersion) || value.runtimeVersion < 1)) {
    throw new Error('Invalid WebPyTorch runtime version.');
  }
  if (!/^[0-9a-f]{40}$/.test(String(value.upstream?.commit || ''))) {
    throw new Error('Invalid WebPyTorch runtime commit.');
  }
  const seen = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!safePath(file?.path) || seen.has(file.path)) throw new Error('Invalid WebPyTorch runtime path.');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 128 * 1024 * 1024) {
      throw new Error(`Invalid WebPyTorch runtime size: ${file.path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(file.sha256 || ''))) {
      throw new Error(`Invalid WebPyTorch runtime digest: ${file.path}`);
    }
    seen.add(file.path);
    total += file.bytes;
  }
  if (total > 256 * 1024 * 1024) throw new Error('WebPyTorch runtime manifest is too large.');
  for (const path of REQUIRED) {
    if (!seen.has(path)) throw new Error(`WebPyTorch runtime manifest is missing ${path}.`);
  }
  return value;
}

function validateModelManifest(value, prefix) {
  if (value?.protocol !== 1 || typeof value.model !== 'string' || !value.model
      || !Array.isArray(value.sources) || !value.sources.length
      || !Array.isArray(value.assets) || !value.assets.length || value.assets.length > 32
      || !Array.isArray(value.supportFiles) || !value.supportFiles.length) {
    throw new Error('Invalid Laya model manifest.');
  }
  for (const source of value.sources) {
    const url = new URL(source);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid Laya model source.');
  }
  const seen = new Set();
  for (const asset of value.assets) {
    // `relative` is where the asset lands in the skill, and the manifest need not say: it is
    // the model's directory plus the asset's own path, and the directory is found on disk.
    // A manifest that does say it has to agree, so that a published manifest cannot redirect
    // a write somewhere else.
    if (asset && asset.relative === undefined && safePath(asset.sourcePath)) {
      asset.relative = prefix + asset.sourcePath;
    }
    if (!safePath(asset?.relative) || !asset.relative.startsWith(prefix)
        || !safePath(asset?.sourcePath) || seen.has(asset.relative)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1
        || !/^[0-9a-f]{64}$/.test(String(asset.sha256 || ''))) {
      throw new Error('Invalid Laya model asset manifest.');
    }
    seen.add(asset.relative);
  }
  for (const file of value.supportFiles) {
    if (!safePath(file?.path) || seen.has(`support:${file.path}`)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1
        || !/^[0-9a-f]{64}$/.test(String(file.sha256 || ''))) {
      throw new Error('Invalid Laya model support-file manifest.');
    }
    seen.add(`support:${file.path}`);
  }
  return value;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function validFile(path, file) {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isFile() && info.size === file.bytes && await digest(path) === file.sha256);
}

async function localIsCurrent(root, remote) {
  const localText = await readFile(join(root, 'manifest.json'), 'utf8').catch(() => null);
  if (!localText) return false;
  let local;
  try {
    local = validateManifest(JSON.parse(localText));
  } catch {
    return false;
  }
  if (local.upstream.commit !== remote.upstream.commit
      || JSON.stringify(local.files) !== JSON.stringify(remote.files)) return false;
  for (const file of remote.files) {
    if (!(await validFile(join(root, file.path), file))) return false;
  }
  return true;
}

async function readLocalManifest(root) {
  try {
    return validateManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  } catch {
    return null;
  }
}

function runtimeUpdateDisposition(local, remote) {
  const localVersion = local?.runtimeVersion;
  const remoteVersion = remote?.runtimeVersion;
  if (!Number.isSafeInteger(localVersion)) return 'allow';
  if (!Number.isSafeInteger(remoteVersion) || remoteVersion < localVersion) return 'older';
  if (remoteVersion === localVersion && remote.upstream.commit !== local.upstream.commit) return 'conflict';
  return 'allow';
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  return await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)});
}

async function fetchRange(fetchImpl, url, destination, offset) {
  const headers = {'User-Agent': 'laya-browser-use-updater/1.0'};
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  const response = await fetchImpl(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (response.status === 416 && offset > 0) return offset;
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  let append = offset > 0 && response.status === 206;
  if (offset > 0 && response.status === 200) {
    offset = 0;
    append = false;
  }
  const handle = await open(destination, append ? 'a' : 'w');
  let received = offset;
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
      received += chunk.byteLength;
    }
  } finally {
    await handle.close();
  }
  return received;
}

async function downloadVerified({fetchImpl, urls, destination, file, log}) {
  await mkdir(dirname(destination), {recursive: true});
  if (await validFile(destination, file)) return;
  const partial = `${destination}.part`;
  const failures = [];
  for (const url of urls) {
    try {
      let offset = (await stat(partial).catch(() => null))?.size || 0;
      if (offset > file.bytes) {
        await rm(partial, {force: true});
        offset = 0;
      }
      log(`downloading ${file.path || file.sourcePath}${offset ? ` from byte ${offset}` : ''}`);
      const received = await fetchRange(fetchImpl, url, partial, offset);
      if (received !== file.bytes) throw new Error(`incomplete file: ${received} of ${file.bytes} bytes`);
      if (await digest(partial) !== file.sha256) {
        await rm(partial, {force: true});
        throw new Error('SHA-256 mismatch');
      }
      await rename(partial, destination);
      return;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Unable to prepare ${file.path || file.sourcePath}: ${failures.join('; ')}`);
}

async function prepareModelDirectory({skillRoot, remoteModel, modelManifestUrl, fetchImpl, log}) {
  const modelDir = modelRoot(skillRoot);
  const prefix = modelPrefix(skillRoot);
  const version = createHash('sha256').update(JSON.stringify(remoteModel)).digest('hex').slice(0, 16);
  const staged = resolve(dirname(modelDir), `.laya-update-${version}`);
  await mkdir(staged, {recursive: true});
  const sourceValues = [process.env.LAYA_MODEL_BASE_URL, ...remoteModel.sources].filter(Boolean);
  const sources = [...new Set(sourceValues.map((value) => value.endsWith('/') ? value : `${value}/`))];

  await mapLimit(remoteModel.assets, 2, async (asset) => {
    const localPath = modelLocalPath(asset, prefix);
    const destination = resolve(staged, localPath);
    const current = resolve(modelDir, localPath);
    if (await validFile(current, asset) && !(await stat(destination).catch(() => null))) {
      await mkdir(dirname(destination), {recursive: true});
      await copyFile(current, destination);
    }
    await downloadVerified({
      fetchImpl,
      urls: sources.map((base) => new URL(asset.sourcePath, base).href),
      destination,
      file: {...asset, path: localPath},
      log,
    });
  });

  const supportBase = new URL('./', modelManifestUrl);
  await mapLimit(remoteModel.supportFiles, 4, async (file) => {
    const destination = resolve(staged, file.path);
    const current = resolve(modelDir, file.path);
    if (await validFile(current, file) && !(await stat(destination).catch(() => null))) {
      await mkdir(dirname(destination), {recursive: true});
      await copyFile(current, destination);
    }
    const encoded = file.path.split('/').map(encodeURIComponent).join('/');
    await downloadVerified({
      fetchImpl,
      urls: [new URL(encoded, supportBase).href],
      destination,
      file,
      log,
    });
  });
  await writeFile(join(staged, 'manifest.json'), `${JSON.stringify(remoteModel, null, 2)}\n`);
  for (const asset of remoteModel.assets) {
    const localPath = modelLocalPath(asset, prefix);
    if (!(await validFile(resolve(staged, localPath), asset))) throw new Error(`Staged model is invalid: ${localPath}`);
  }
  for (const file of remoteModel.supportFiles) {
    if (!(await validFile(resolve(staged, file.path), file))) throw new Error(`Staged model is invalid: ${file.path}`);
  }
  return staged;
}

async function replaceDirectories(entries) {
  const transaction = entries.map(({staged, target}) => ({
    staged,
    target,
    backup: `${target}.update-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hadTarget: false,
    switched: false,
  }));
  try {
    for (const entry of transaction) {
      const current = await stat(entry.target).catch(() => null);
      if (current && !current.isDirectory()) throw new Error(`Update target is not a directory: ${entry.target}`);
      entry.hadTarget = Boolean(current);
      if (entry.hadTarget) await rename(entry.target, entry.backup);
    }
    for (const entry of transaction) {
      await rename(entry.staged, entry.target);
      entry.switched = true;
    }
  } catch (error) {
    for (const entry of [...transaction].reverse()) {
      if (entry.switched) await rm(entry.target, {recursive: true, force: true}).catch(() => {});
      if (entry.hadTarget) await rename(entry.backup, entry.target).catch(() => {});
    }
    throw error;
  }
  for (const entry of transaction) {
    if (entry.hadTarget) await rm(entry.backup, {recursive: true, force: true});
  }
}

async function mapLimit(values, limit, worker) {
  let cursor = 0;
  const runners = Array.from({length: Math.min(limit, values.length)}, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await worker(values[index], index);
    }
  });
  await Promise.all(runners);
}

export async function updateWebtorchRuntime({
  skillRoot,
  manifestUrl = process.env.LAYA_RUNTIME_MANIFEST_URL || DEFAULT_MANIFEST_URL,
  modelManifestUrl = process.env.LAYA_MODEL_MANIFEST_URL
    || new URL(`../models/${modelPrefix(skillRoot).split('/')[2]}/manifest.json`, manifestUrl).href,
  fetchImpl = fetch,
  beforeApply = async () => {},
  log = (message) => console.error(`[laya:update] ${message}`),
} = {}) {
  if (!skillRoot) throw new Error('A skill root is required.');
  const target = resolve(skillRoot, 'runtime', 'webtorch');
  let remote;
  let remoteModel;
  try {
    const [runtimeResponse, modelResponse] = await Promise.all([
      fetchWithTimeout(fetchImpl, manifestUrl, 5000),
      fetchWithTimeout(fetchImpl, modelManifestUrl, 5000),
    ]);
    if (!runtimeResponse.ok) throw new Error(`runtime manifest HTTP ${runtimeResponse.status}`);
    if (!modelResponse.ok) throw new Error(`model manifest HTTP ${modelResponse.status}`);
    remote = validateManifest(await runtimeResponse.json());
    remoteModel = validateModelManifest(await modelResponse.json(), modelPrefix(skillRoot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`check unavailable; keeping the installed runtime (${message})`);
    return {status: 'unavailable', error: message};
  }
  const modelManifestPath = resolve(modelRoot(skillRoot), 'manifest.json');
  let localModel = null;
  try {
    localModel = validateModelManifest(JSON.parse(await readFile(modelManifestPath, 'utf8')),
                                      modelPrefix(skillRoot));
  } catch {}
  const modelChanged = JSON.stringify(localModel) !== JSON.stringify(remoteModel);
  const localRuntime = await readLocalManifest(target);
  // Automatic updates are mandatory, but they must be monotonic. During publication propagation
  // the installed package can already contain a newer runtime than the raw manifest endpoint.
  // Keep checking and updating the model, but never replace that runtime with an older commit.
  const runtimeDisposition = runtimeUpdateDisposition(localRuntime, remote);
  if (runtimeDisposition === 'older') {
    log(`remote runtime version ${remote.runtimeVersion ?? 'legacy'} is older than installed ${localRuntime.runtimeVersion}; keeping the installed runtime`);
  } else if (runtimeDisposition === 'conflict') {
    log(`remote runtime version ${remote.runtimeVersion} names a different commit; keeping the installed runtime`);
  }
  const runtimeChanged = runtimeDisposition === 'allow' && !(await localIsCurrent(target, remote));
  if (!modelChanged && !runtimeChanged) {
    return {status: 'current', commit: localRuntime?.upstream?.commit || remote.upstream.commit,
      runtimeVersion: (localRuntime || remote).runtimeVersion,
      files: (localRuntime || remote).files.length,
      remoteRuntimeOlder: runtimeDisposition === 'older',
      runtimeVersionConflict: runtimeDisposition === 'conflict'};
  }

  let stagedRuntime = null;
  let stagedModel = null;
  try {
    if (runtimeChanged) {
      await mkdir(dirname(target), {recursive: true});
      stagedRuntime = await mkdtemp(join(dirname(target), '.webtorch-update-'));
      const base = new URL('./', manifestUrl);
      let localManifest = null;
      try {
        localManifest = validateManifest(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')));
      } catch {}
      const localByPath = new Map((localManifest?.files || []).map((file) => [file.path, file]));
      await mapLimit(remote.files, 4, async (file) => {
        const destination = join(stagedRuntime, file.path);
        await mkdir(dirname(destination), {recursive: true});
        const local = localByPath.get(file.path);
        const localPath = join(target, file.path);
        if (local?.sha256 === file.sha256 && local.bytes === file.bytes && await validFile(localPath, file)) {
          await copyFile(localPath, destination);
          return;
        }
        const encoded = file.path.split('/').map(encodeURIComponent).join('/');
        const fileResponse = await fetchWithTimeout(fetchImpl, new URL(encoded, base), 60000);
        if (!fileResponse.ok) throw new Error(`${file.path} HTTP ${fileResponse.status}`);
        const bytes = Buffer.from(await fileResponse.arrayBuffer());
        if (bytes.length !== file.bytes) throw new Error(`${file.path} has an unexpected size.`);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== file.sha256) throw new Error(`${file.path} failed SHA-256 verification.`);
        await writeFile(destination, bytes);
      });
      await writeFile(join(stagedRuntime, 'UPSTREAM_SHA'), `${remote.upstream.commit}\n`);
      await writeFile(join(stagedRuntime, 'manifest.json'), `${JSON.stringify(remote, null, 2)}\n`);
    }
    if (modelChanged) {
      stagedModel = await prepareModelDirectory({
        skillRoot, remoteModel, modelManifestUrl, fetchImpl, log,
      });
    }

    await beforeApply();
    const swaps = [];
    if (runtimeChanged) swaps.push({staged: stagedRuntime, target});
    if (modelChanged) swaps.push({
      staged: stagedModel,
      target: modelRoot(skillRoot),
    });
    await replaceDirectories(swaps);
    stagedRuntime = null;
    stagedModel = null;
    if (modelChanged) {
      await rm(MODEL_REGISTRY, {recursive: true, force: true});
    }
    const appliedRuntime = runtimeChanged ? remote : localRuntime;
    log(`updated dependencies at WebPyTorch ${appliedRuntime.upstream.commit.slice(0, 12)}`);
    return {
      status: 'updated',
      commit: appliedRuntime.upstream.commit,
      runtimeVersion: appliedRuntime.runtimeVersion,
      files: appliedRuntime.files.length,
      modelUpdated: modelChanged,
      requiresProcessRestart: modelChanged,
      remoteRuntimeOlder: runtimeDisposition === 'older',
      runtimeVersionConflict: runtimeDisposition === 'conflict',
    };
  } catch (error) {
    if (stagedRuntime) await rm(stagedRuntime, {recursive: true, force: true}).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    log(`update failed; keeping the installed dependencies (${message})`);
    return {status: 'failed', error: message};
  }
}
