#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {createReadStream, readFileSync, realpathSync} from 'node:fs';
import {mkdir, open, readdir, readFile, rename, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const skillRoot = dirname(fileURLToPath(import.meta.url));
export const LOCAL_MODEL_REGISTRY = process.env.LAYA_MODEL_REGISTRY
  || join(tmpdir(), 'laya-browser-use-model-servers-v1');

const MODEL_MANIFEST_PATH = join(skillRoot, 'runtime', 'models', 'laya', 'manifest.json');
const MODEL_SPEC = JSON.parse(readFileSync(MODEL_MANIFEST_PATH, 'utf8'));
if (MODEL_SPEC?.protocol !== 1 || typeof MODEL_SPEC.model !== 'string' || !Array.isArray(MODEL_SPEC.assets)) {
  throw new Error('Invalid bundled model manifest.');
}
export const MODEL_ASSETS = MODEL_SPEC.assets.map((asset) => ({...asset}));
export const MODEL_SUPPORT_FILES = (MODEL_SPEC.supportFiles || []).map((file) => ({...file}));

const MODEL_PREFIX = 'runtime/models/laya/';

export function modelLocalPath(asset) {
  const relativePath = String(asset?.relative || '');
  return relativePath.startsWith(MODEL_PREFIX) ? relativePath.slice(MODEL_PREFIX.length) : relativePath;
}

const DEFAULT_BASE_URLS = Array.isArray(MODEL_SPEC.sources) ? MODEL_SPEC.sources : [];

export function modelManifest() {
  return {
    protocol: MODEL_SPEC.protocol,
    model: MODEL_SPEC.model,
    sources: [...DEFAULT_BASE_URLS],
    supportFiles: MODEL_SUPPORT_FILES.map((file) => ({...file})),
    assets: MODEL_ASSETS.map(({relative, sourcePath, bytes, sha256}) => ({
      relative, sourcePath, bytes, sha256,
    })),
  };
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function validAsset(root, asset) {
  const path = join(root, asset.relative);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== asset.bytes) return false;
  return await digest(path) === asset.sha256;
}

async function validModelAsset(modelRoot, asset) {
  const path = join(modelRoot, modelLocalPath(asset));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== asset.bytes) return false;
  return await digest(path) === asset.sha256;
}

export async function validModelDirectory(modelRoot) {
  if (!modelRoot || !isAbsolute(modelRoot)) return false;
  for (const asset of MODEL_ASSETS) if (!(await validModelAsset(modelRoot, asset))) return false;
  for (const file of MODEL_SUPPORT_FILES) {
    const path = join(modelRoot, file.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size !== file.bytes || await digest(path) !== file.sha256) return false;
  }
  return true;
}

function sourceBases(env) {
  const custom = env.LAYA_MODEL_BASE_URL?.trim();
  const values = custom ? [custom, ...DEFAULT_BASE_URLS] : DEFAULT_BASE_URLS;
  return [...new Set(values.map((value) => value.endsWith('/') ? value : `${value}/`))];
}

function sameManifest(value) {
  if (value?.protocol !== MODEL_SPEC.protocol || value.model !== MODEL_SPEC.model) return false;
  return MODEL_ASSETS.every((expected) => value.assets?.some((actual) =>
    actual.relative === expected.relative
    && actual.sourcePath === expected.sourcePath
    && actual.bytes === expected.bytes
    && actual.sha256 === expected.sha256))
    && MODEL_SUPPORT_FILES.every((expected) => value.supportFiles?.some((actual) =>
      actual.path === expected.path && actual.bytes === expected.bytes
      && actual.sha256 === expected.sha256));
}

async function probeLocalBase(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) return false;
  const manifestResponse = await fetch(new URL('model-manifest.json', base), {
    signal: AbortSignal.timeout(1500),
  });
  if (!manifestResponse.ok || !sameManifest(await manifestResponse.json())) return false;
  for (const asset of MODEL_ASSETS) {
    const response = await fetch(new URL(`models/laya/${modelLocalPath(asset)}`, base), {
      headers: {Range: 'bytes=0-0'},
      signal: AbortSignal.timeout(1500),
    });
    const contentRange = response.headers.get('content-range') || '';
    await response.body?.cancel();
    if (response.status !== 206 || !contentRange.endsWith(`/${asset.bytes}`)) return false;
  }
  return true;
}

async function registryRecords(registry) {
  const entries = await readdir(registry, {withFileTypes: true}).catch(() => []);
  const records = [];
  for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(registry, entry.name), 'utf8'));
      if (sameManifest(record)) records.push({...record, record: entry.name});
    } catch {
      // Ignore malformed records without scanning any port.
    }
  }
  return records;
}

export async function discoverLocalModelSource({
  registry = LOCAL_MODEL_REGISTRY,
  validateModelRoot = validModelDirectory,
  allowHttp = true,
  allowFilesystem = true,
  allowBrowserCache = true,
} = {}) {
  const records = await registryRecords(registry);
  for (const record of allowHttp ? records : []) {
    try {
      if (await probeLocalBase(record.baseUrl)) return {kind: 'http', ...record};
    } catch {
      // A crashed process can leave a valid filesystem path behind.
    }
  }
  for (const record of allowFilesystem ? records : []) {
    if (await validateModelRoot(record.modelRoot)) return {kind: 'filesystem', ...record};
  }
  if (allowBrowserCache) {
    for (const record of records) {
      const profile = record.browserProfile;
      const info = profile && await stat(profile).catch(() => null);
      if (info?.isDirectory()) return {kind: 'browser-cache', ...record};
    }
  }
  return null;
}

export async function discoverLocalModelServer(options = {}) {
  const source = await discoverLocalModelSource(options);
  return source?.kind === 'http' ? source : null;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', () => resolvePromise(false));
    child.once('exit', (code) => resolvePromise(code === 0));
  });
}

async function tryGitLfs(root) {
  let repositoryRoot;
  try {
    repositoryRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return false;
  }

  const include = MODEL_ASSETS.map((asset) => {
    const absolute = join(root, asset.relative);
    return relative(repositoryRoot, absolute).split(sep).join('/');
  }).join(',');
  console.log('Preparing bundled model with Git LFS...');
  return await run('git', ['-C', repositoryRoot, 'lfs', 'pull', '--include', include, '--exclude', '']);
}

async function fetchRange(url, destination, offset) {
  const headers = {'User-Agent': 'laya-browser-use-model-preparer/1.0'};
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  const response = await fetch(url, {headers, redirect: 'follow'});
  if (response.status === 416 && offset > 0) return offset;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('response has no body');

  let append = offset > 0 && response.status === 206;
  if (append) {
    const match = /^bytes (\d+)-/i.exec(response.headers.get('content-range') || '');
    if (!match || Number(match[1]) !== offset) throw new Error('server returned an invalid byte range');
  }
  if (offset > 0 && response.status === 200) {
    console.log('Server does not support resume; restarting this file.');
    offset = 0;
    append = false;
  }

  const handle = await open(destination, append ? 'a' : 'w');
  let received = offset;
  let nextReport = received + 64 * 1024 * 1024;
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
      received += chunk.byteLength;
      if (received >= nextReport) {
        console.log(`  received ${Math.round(received / 1024 / 1024)} MiB`);
        nextReport = received + 64 * 1024 * 1024;
      }
    }
  } finally {
    await handle.close();
  }
  return received;
}

export async function downloadVerifiedFile({url, destination, bytes, sha256, attempts = 3}) {
  await mkdir(dirname(destination), {recursive: true});
  const partial = `${destination}.part`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let offset = (await stat(partial).catch(() => null))?.size || 0;
    if (offset > bytes) {
      await rm(partial, {force: true});
      offset = 0;
    }
    console.log(`Downloading ${url}${offset ? ` (resuming at ${offset} bytes)` : ''}`);
    try {
      const received = await fetchRange(url, partial, offset);
      if (received !== bytes) throw new Error(`incomplete file: ${received} of ${bytes} bytes`);
      if (await digest(partial) !== sha256) {
        await rm(partial, {force: true});
        throw new Error('SHA-256 mismatch');
      }
      await rm(destination, {force: true});
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Download attempt ${attempt}/${attempts} failed: ${error.message}`);
    }
  }
  throw lastError;
}

async function downloadAsset(root, asset, env) {
  const destination = join(root, asset.relative);
  const failures = [];
  for (const base of sourceBases(env)) {
    const url = new URL(asset.sourcePath, base).href;
    try {
      await downloadVerifiedFile({...asset, url, destination});
      return;
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`Unable to download ${asset.relative}:\n${failures.join('\n')}`);
}

export async function ensureModel({
  root = skillRoot,
  env = process.env,
  registry = LOCAL_MODEL_REGISTRY,
  allowBrowserCache = true,
  useGitLfs = true,
  allowHttpDownload = true,
} = {}) {
  let missing = [];
  for (const asset of MODEL_ASSETS) if (!(await validAsset(root, asset))) missing.push(asset);
  if (missing.length === 0) return {status: 'ready', method: 'existing'};

  const local = await discoverLocalModelSource({registry, allowBrowserCache});
  if (local?.kind === 'http') {
    return {status: 'ready', method: 'local-http', baseUrl: local.baseUrl, modelRoot: local.modelRoot};
  }
  if (local?.kind === 'filesystem') {
    return {status: 'ready', method: 'local-files', modelRoot: local.modelRoot};
  }
  if (local?.kind === 'browser-cache') {
    return {status: 'ready', method: 'browser-cache', browserProfile: local.browserProfile, baseUrl: local.baseUrl};
  }

  const missingSupport = [];
  const modelRoot = join(root, 'runtime', 'models', 'laya');
  for (const file of MODEL_SUPPORT_FILES) {
    const path = join(modelRoot, file.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size !== file.bytes || await digest(path) !== file.sha256) missingSupport.push(file.path);
  }
  if (missingSupport.length) {
    throw new Error(`Manifest support files are missing or invalid: ${missingSupport.join(', ')}`);
  }

  if (useGitLfs) {
    const lfsCompleted = await tryGitLfs(root);
    missing = [];
    for (const asset of MODEL_ASSETS) if (!(await validAsset(root, asset))) missing.push(asset);
    if (missing.length === 0) return {status: 'ready', method: 'git-lfs'};
    if (lfsCompleted) console.warn('Git LFS completed but did not materialize every required model file.');
  }

  if (!allowHttpDownload) {
    throw new Error('Git LFS did not materialize every required model file and HTTP fallback is disabled.');
  }
  for (const asset of missing) await downloadAsset(root, asset, env);
  return {status: 'ready', method: 'resumable-download'};
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const lfsOnly = args.includes('--lfs-only');
  const result = checkOnly
    ? {status: (await validModelDirectory(join(skillRoot, 'runtime', 'models', 'laya'))) ? 'ready' : 'missing', method: 'check'}
    : await ensureModel({
      useGitLfs: !args.includes('--no-lfs'),
      allowHttpDownload: !lfsOnly,
    });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ready') process.exitCode = 1;
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url)))) {
  await main();
}
