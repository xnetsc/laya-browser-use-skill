import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, extname, join, resolve, sep } from 'node:path';
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

async function serve(request, response) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
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

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--disable-gpu'],
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--enable-features=Vulkan'],
    channel: 'chrome',
  });
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
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/laya.html`);
    await page.waitForFunction(
      () => window.__laya && (window.__laya.status().ready || window.__laya.status().error),
      null,
      { timeout: 20 * 60 * 1000 },
    );
    const status = await page.evaluate(() => window.__laya.status());
    if (!status.ready) throw new Error(status.error || 'Local Laya did not become ready');
    return { server, browser, page, status };
  } catch (error) {
    await browser.close().catch(() => {});
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
