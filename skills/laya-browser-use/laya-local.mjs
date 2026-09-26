import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, extname, join, posix, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from './runtime/node_modules/playwright/index.mjs';
import {
  discoverLocalModelSource, ensureModel, LOCAL_MODEL_REGISTRY, MODEL_ASSETS,
  modelManifest, validModelDirectory,
} from './prepare-model.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEBTORCH = join(ROOT, 'runtime', 'webtorch');
const MODEL = join(ROOT, 'runtime', 'models', 'laya');
const PAGE = join(ROOT, 'laya-page.html');
const RUNTIME_PORT = Number.parseInt(process.env.LAYA_RUNTIME_PORT || '8765', 10) || 8765;
const PROXY_PORT = RUNTIME_PORT + 1;
const CACHE_FILES = [
  ...MODEL_ASSETS.map((asset) => ({...asset, cachePath: `/models/laya/${asset.sourcePath}`})),
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.whl': 'application/octet-stream',
  '.py': 'text/plain; charset=utf-8', '.zip': 'application/octet-stream',
};
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

let runtimePromise = null;
let decisionQueue = Promise.resolve();

function mountedPath(url, modelRoot = MODEL) {
  if (url.pathname === '/laya.html') return PAGE;
  if (url.pathname.startsWith('/models/laya/')) {
    const relative = decodeURIComponent(url.pathname.slice('/models/laya/'.length));
    const path = resolve(modelRoot, relative);
    if (path !== modelRoot && !path.startsWith(modelRoot + sep)) return null;
    return path;
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const path = resolve(WEBTORCH, relative);
  if (path !== WEBTORCH && !path.startsWith(WEBTORCH + sep)) return null;
  return path;
}

function profileFor(modelRoot) {
  const key = createHash('sha256').update(modelRoot).digest('hex').slice(0, 16);
  return join(LOCAL_MODEL_REGISTRY, 'profiles', `model-${key}`);
}

function launchModes(platform) {
  const base = ['--enable-unsafe-webgpu'];
  if (platform === 'darwin') {
    return [
      {name: 'metal', args: [...base, '--use-angle=metal']},
      {name: 'browser-default', args: base},
    ];
  }
  if (platform === 'linux') {
    return [
      {name: 'vulkan', args: [...base, '--enable-features=Vulkan', '--use-angle=vulkan']},
      {name: 'browser-default', args: base},
    ];
  }
  return [{name: 'browser-default', args: base}];
}

export function platformBrowserCandidates({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const candidates = [];
  const override = String(env.LAYA_BROWSER_EXECUTABLE || '').trim();
  if (override) candidates.push({label: 'LAYA_BROWSER_EXECUTABLE', executablePath: override, required: true});

  candidates.push({label: 'Google Chrome', channel: 'chrome'});
  candidates.push({label: 'Microsoft Edge', channel: 'msedge'});

  const paths = [];
  if (platform === 'darwin') {
    paths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      pathApi.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      pathApi.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else if (platform === 'win32') {
    for (const root of [
      env.PROGRAMFILES || env.ProgramFiles,
      env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'],
      env.LOCALAPPDATA || env.LocalAppData,
    ].filter(Boolean)) {
      paths.push(
        pathApi.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        pathApi.join(root, 'Chromium', 'Application', 'chrome.exe'),
        pathApi.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else if (platform === 'linux') {
    paths.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium',
    );
    const pathValue = String(env.PATH || env.Path || '');
    const pathDelimiter = platform === 'win32' ? ';' : ':';
    for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
      for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge']) {
        paths.push(pathApi.join(directory, name));
      }
    }
  }

  for (const executablePath of paths) {
    candidates.push({label: executablePath, executablePath});
  }
  const seen = new Set();
  return candidates
    .filter((candidate) => {
      const key = candidate.executablePath ? `path:${candidate.executablePath}` : `channel:${candidate.channel}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => ({...candidate, launchModes: launchModes(platform)}));
}

async function proxyModel(request, response, url, modelBaseUrl) {
  const relative = decodeURIComponent(url.pathname.slice('/models/laya/'.length));
  const allowed = MODEL_ASSETS.some((asset) => asset.sourcePath === relative)
    || ['rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer_config.json'].includes(relative);
  if (!allowed) {
    response.writeHead(403, ISOLATION).end('forbidden');
    return;
  }
  const headers = {};
  if (request.headers.range) headers.Range = request.headers.range;
  const upstream = await fetch(new URL(`models/laya/${relative}`, modelBaseUrl), {
    headers,
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  const forwarded = {...ISOLATION};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) forwarded[name] = value;
  }
  response.writeHead(upstream.status, forwarded);
  if (!upstream.body) response.end();
  else Readable.fromWeb(upstream.body).pipe(response);
}

async function serve(request, response, {modelBaseUrl = null, modelRoot = MODEL} = {}) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/probe.html') {
      const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>WebGPU probe</title>');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ...ISOLATION,
      }).end(body);
      return;
    }
    if (url.pathname === '/model-manifest.json') {
      const body = Buffer.from(JSON.stringify(modelManifest()));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...ISOLATION,
      }).end(body);
      return;
    }
    if (modelBaseUrl && url.pathname.startsWith('/models/laya/')) {
      await proxyModel(request, response, url, modelBaseUrl);
      return;
    }
    const path = mountedPath(url, modelRoot);
    if (!path) {
      response.writeHead(403, ISOLATION).end('forbidden');
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const type = TYPES[extname(path)] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2] || 0));
      const end = range[1]
        ? (range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1)
        : info.size - 1;
      if (!(start >= 0 && start <= end && end < info.size)) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, ...ISOLATION }).end();
        return;
      }
      response.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes', ...ISOLATION,
      });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      'Content-Type': type, 'Content-Length': info.size,
      'Accept-Ranges': 'bytes', ...ISOLATION,
    });
    createReadStream(path).pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404, ISOLATION).end('not found');
    else response.destroy();
  }
}

async function pathExists(path) {
  return access(path).then(() => true, () => false);
}

async function launchBrowser(probeUrl, {profileDir = null} = {}) {
  const errors = [];
  for (const candidate of platformBrowserCandidates()) {
    if (candidate.executablePath && !(await pathExists(candidate.executablePath))) {
      if (candidate.required) throw new Error(`LAYA_BROWSER_EXECUTABLE does not exist: ${candidate.executablePath}`);
      continue;
    }
    const candidateErrors = [];
    for (const mode of candidate.launchModes) {
      let browser;
      try {
        const options = {
          headless: true,
          ignoreDefaultArgs: ['--disable-gpu'],
          args: mode.args,
          ...(candidate.executablePath ? {executablePath: candidate.executablePath} : {channel: candidate.channel}),
        };
        browser = profileDir
          ? await chromium.launchPersistentContext(profileDir, options)
          : await chromium.launch(options);
        const page = await browser.newPage();
        await page.goto(probeUrl);
        const probe = await page.evaluate(async () => {
          if (!globalThis.crossOriginIsolated || !navigator.gpu) return {isolated: globalThis.crossOriginIsolated, gpu: false};
          const adapter = await navigator.gpu.requestAdapter();
          return {isolated: true, gpu: Boolean(adapter)};
        });
        if (!probe.isolated || !probe.gpu) throw new Error('WebGPU is unavailable');
        return {browser, page, label: `${candidate.label} (${mode.name})`};
      } catch (error) {
        await browser?.close().catch(() => {});
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        candidateErrors.push(`${mode.name}: ${message}`);
      }
    }
    if (candidate.required) throw new Error(`LAYA_BROWSER_EXECUTABLE failed: ${candidateErrors.join('; ')}`);
    errors.push(`${candidate.label}: ${candidateErrors.join('; ')}`);
  }
  throw new Error(`No compatible Chromium browser with WebGPU was found on ${process.platform}. Set LAYA_BROWSER_EXECUTABLE to a Chrome, Chromium, or Edge executable. Attempts: ${errors.join('; ')}`);
}

async function localModelReady(modelRoot = MODEL) {
  return await validModelDirectory(modelRoot);
}

function cacheKeyPath(key) {
  return String(key).replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '/');
}

async function recoverModelFromCache(page, modelRoot) {
  const entries = await page.evaluate(() => window.__laya.cacheInfo());
  const byPath = new Map(entries.map((entry) => [cacheKeyPath(entry.key), entry]));
  for (const file of CACHE_FILES) {
    const entry = byPath.get(file.cachePath);
    if (!entry?.complete || !Number.isFinite(entry.total) || entry.total <= 0) {
      throw new Error(`Browser model cache is incomplete: ${file.cachePath}`);
    }
    if (file.bytes != null && entry.total !== file.bytes) {
      throw new Error(`Browser model cache has an unexpected size: ${file.cachePath}`);
    }
  }

  for (const file of CACHE_FILES) {
    const destination = join(modelRoot, file.sourcePath);
    const partial = `${destination}.browser-cache-part`;
    await mkdir(dirname(destination), {recursive: true});
    const handle = await open(partial, 'w');
    try {
      for (let offset = 0; offset < byPath.get(file.cachePath).total; offset += 8 * 1024 * 1024) {
        const length = Math.min(8 * 1024 * 1024, byPath.get(file.cachePath).total - offset);
        const encoded = await page.evaluate(({name, at, size}) => window.__laya.readCached(name, at, size), {
          name: file.cachePath, at: offset, size: length,
        });
        if (!encoded) throw new Error(`Browser model cache has a missing span: ${file.cachePath} at ${offset}`);
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== length) throw new Error(`Browser model cache returned a short span: ${file.cachePath}`);
        await handle.write(bytes);
      }
    } finally {
      await handle.close();
    }
    await rm(destination, {force: true});
    await rename(partial, destination);
  }
  if (!(await localModelReady(modelRoot))) throw new Error('Browser cache export failed model verification.');
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolvePromise(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function registerModelServer(baseUrl, modelRoot, browserProfile) {
  await mkdir(LOCAL_MODEL_REGISTRY, {recursive: true, mode: 0o700});
  const key = createHash('sha256').update(modelRoot).digest('hex').slice(0, 16);
  const destination = join(LOCAL_MODEL_REGISTRY, `model-${key}.json`);
  await writeFile(destination, JSON.stringify({
    ...modelManifest(),
    baseUrl,
    modelRoot,
    browserProfile,
    pid: process.pid,
    startedAt: Date.now(),
  }), {mode: 0o600});
  return destination;
}

async function startRuntimeOnce({
  modelBaseUrl = null,
  modelRoot = MODEL,
  browserProfile = null,
  preferredPort = null,
  recoverCache = false,
} = {}) {
  if (!modelBaseUrl && !recoverCache && !(await localModelReady(modelRoot))) {
    throw new Error('Local Laya model files are not ready.');
  }
  const server = createServer((request, response) => void serve(request, response, {modelBaseUrl, modelRoot}));
  const port = preferredPort || (modelBaseUrl ? PROXY_PORT : RUNTIME_PORT);
  await listen(server, port);
  const address = server.address();
  let browser;
  let registryPath = null;
  try {
    if (browserProfile) await mkdir(dirname(browserProfile), {recursive: true, mode: 0o700});
    if (!modelBaseUrl && !recoverCache) {
      registryPath = await registerModelServer(
        `http://127.0.0.1:${address.port}/`, modelRoot, browserProfile || profileFor(modelRoot),
      );
    }
    const launched = await launchBrowser(`http://127.0.0.1:${address.port}/probe.html`, {
      profileDir: browserProfile,
    });
    browser = launched.browser;
    const page = launched.page;
    const runtimeUrl = new URL(`http://127.0.0.1:${address.port}/laya.html`);
    const pyodideIndexUrl = String(process.env.LAYA_PYODIDE_INDEX_URL || '').trim();
    if (pyodideIndexUrl) runtimeUrl.searchParams.set('pyodide', pyodideIndexUrl);
    if (recoverCache) runtimeUrl.searchParams.set('deferModel', '1');
    await page.goto(runtimeUrl.href);
    if (recoverCache) {
      await page.waitForFunction(
        () => window.__laya && (window.__laya.status().ioReady || window.__laya.status().error),
        null, {timeout: 20 * 60 * 1000},
      );
      await recoverModelFromCache(page, modelRoot);
      await page.evaluate(() => window.__laya.load());
    } else {
      await page.waitForFunction(
        () => window.__laya && (window.__laya.status().ready || window.__laya.status().error),
        null, { timeout: 20 * 60 * 1000 },
      );
    }
    const status = await page.evaluate(() => window.__laya.status());
    if (!status.ready) throw new Error(status.error || 'Local Laya did not become ready');
    return {
      server, browser, page, registryPath,
      status: {...status, runtimeBrowser: launched.label, platform: process.platform},
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    server.close();
    throw error;
  }
}

async function startRuntime() {
  if (await localModelReady()) {
    return await startRuntimeOnce({browserProfile: profileFor(MODEL)});
  }

  let local = await discoverLocalModelSource();
  if (local?.kind === 'filesystem') {
    return await startRuntimeOnce({
      modelRoot: local.modelRoot,
      browserProfile: local.browserProfile || profileFor(local.modelRoot),
    });
  }
  if (local?.kind === 'browser-cache') {
    try {
      const preferredPort = Number(new URL(local.baseUrl).port) || RUNTIME_PORT;
      return await startRuntimeOnce({
        modelRoot: MODEL,
        browserProfile: local.browserProfile,
        preferredPort,
        recoverCache: true,
      });
    } catch {
      const replacement = await discoverLocalModelSource({
        allowBrowserCache: true,
      });
      if (replacement?.kind === 'filesystem') {
        return await startRuntimeOnce({
          modelRoot: replacement.modelRoot,
          browserProfile: replacement.browserProfile || profileFor(replacement.modelRoot),
        });
      }
      local = replacement?.kind === 'http' ? replacement : null;
    }
  }
  if (local?.kind === 'http') {
    try {
      return await startRuntimeOnce({modelBaseUrl: local.baseUrl, preferredPort: PROXY_PORT});
    } catch {
      const replacement = await discoverLocalModelSource({
        allowHttp: false,
        allowBrowserCache: true,
      });
      if (replacement?.kind === 'filesystem') {
        return await startRuntimeOnce({
          modelRoot: replacement.modelRoot,
          browserProfile: replacement.browserProfile || profileFor(replacement.modelRoot),
        });
      }
      if (replacement?.kind === 'browser-cache') {
        try {
          const preferredPort = Number(new URL(replacement.baseUrl).port) || RUNTIME_PORT;
          return await startRuntimeOnce({
            modelRoot: MODEL,
            browserProfile: replacement.browserProfile,
            preferredPort,
            recoverCache: true,
          });
        } catch {
          local = null;
        }
      }
      local = null;
    }
  }

  await ensureModel({root: ROOT, allowBrowserCache: false, useGitLfs: true});
  return await startRuntimeOnce({browserProfile: profileFor(MODEL)});
}

async function runtime() {
  runtimePromise ??= startRuntime().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export async function warmLocalDecision() {
  return (await runtime()).status;
}

export async function localDecision({ state, questions }) {
  const active = await runtime();
  const request = { state, questions };
  const pending = decisionQueue.then(() => active.page.evaluate(
    (payload) => window.__laya.decide(payload), request,
  ));
  decisionQueue = pending.catch(() => {});
  const result = await pending;
  return { ...result, model: active.status.model, backend: active.status.backend };
}

export async function closeLocalDecision() {
  if (!runtimePromise) return;
  const active = await runtimePromise.catch(() => null);
  runtimePromise = null;
  if (!active) return;
  await active.browser.close().catch(() => {});
  await new Promise((resolve) => active.server.close(resolve));
}
