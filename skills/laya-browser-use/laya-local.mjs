import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, extname, join, posix, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from './runtime/node_modules/playwright/index.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEBTORCH = join(ROOT, 'runtime', 'webtorch');
const MODEL = join(ROOT, 'runtime', 'models', 'laya');
const PAGE = join(ROOT, 'laya-page.html');
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

function mountedPath(url) {
  if (url.pathname === '/laya.html') return PAGE;
  if (url.pathname.startsWith('/models/laya/')) {
    const relative = decodeURIComponent(url.pathname.slice('/models/laya/'.length));
    const path = resolve(MODEL, relative);
    if (path !== MODEL && !path.startsWith(MODEL + sep)) return null;
    return path;
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const path = resolve(WEBTORCH, relative);
  if (path !== WEBTORCH && !path.startsWith(WEBTORCH + sep)) return null;
  return path;
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

async function serve(request, response) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/probe.html') {
      const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>WebGPU probe</title>');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ...ISOLATION,
      }).end(body);
      return;
    }
    const path = mountedPath(url);
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
    const body = await readFile(path);
    response.writeHead(200, {
      'Content-Type': type, 'Content-Length': body.length,
      'Accept-Ranges': 'bytes', ...ISOLATION,
    }).end(body);
  } catch {
    response.writeHead(404, ISOLATION).end('not found');
  }
}

async function pathExists(path) {
  return access(path).then(() => true, () => false);
}

async function launchBrowser(probeUrl) {
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
        browser = await chromium.launch({
          headless: true,
          ignoreDefaultArgs: ['--disable-gpu'],
          args: mode.args,
          ...(candidate.executablePath ? {executablePath: candidate.executablePath} : {channel: candidate.channel}),
        });
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

async function startRuntime() {
  for (const path of [
    join(MODEL, 'model.safetensors'), join(MODEL, 'rl_agent_config.json'),
    join(MODEL, 'encoder', 'config.json'), join(MODEL, 'tokenizer', 'tokenizer.json'),
    join(MODEL, 'tokenizer', 'tokenizer_config.json'),
  ]) {
    const info = await stat(path);
    if (!info.isFile() || !info.size) throw new Error(`Local Laya file is missing: ${path}`);
  }
  const server = createServer((request, response) => void serve(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  let browser;
  try {
    const launched = await launchBrowser(`http://127.0.0.1:${address.port}/probe.html`);
    browser = launched.browser;
    const page = launched.page;
    await page.goto(`http://127.0.0.1:${address.port}/laya.html`);
    await page.waitForFunction(
      () => window.__laya && (window.__laya.status().ready || window.__laya.status().error),
      null,
      { timeout: 20 * 60 * 1000 },
    );
    const status = await page.evaluate(() => window.__laya.status());
    if (!status.ready) throw new Error(status.error || 'Local Laya did not become ready');
    return {
      server, browser, page,
      status: {...status, runtimeBrowser: launched.label, platform: process.platform},
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    server.close();
    throw error;
  }
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
