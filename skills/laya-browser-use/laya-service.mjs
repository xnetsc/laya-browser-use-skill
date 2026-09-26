import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {updateWebtorchRuntime} from './webtorch-update.mjs';

const SERVICE_PORT = Number.parseInt(process.env.LAYA_SERVICE_PORT || '8767', 10) || 8767;
const MAX_BODY = Math.max(1024, Number.parseInt(process.env.LAYA_SERVICE_MAX_BODY || `${16 * 1024 * 1024}`, 10));
const startedAt = Date.now();
const ROOT = dirname(fileURLToPath(import.meta.url));
let api = null;

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }).end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error(`Request body exceeds ${MAX_BODY} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

function serviceStatus() {
  return {pid: process.pid, port: SERVICE_PORT, startedAt, ...api.localDecisionServiceStatus()};
}

async function execute(message) {
  const op = message?.op;
  if (op === 'warm') return await api.loadConfig();
  if (op === 'score') return await api.localDecision(message.payload ?? {});
  if (op === 'decide') return await api.decide(message.payload ?? {});
  if (op === 'refresh') return await api.refreshLocalDecisionRuntime();
  if (op === 'status') return serviceStatus();
  if (op === 'close') return {closed: await api.closeLocalDecision()};
  const error = new Error('Unsupported operation; expected status, refresh, warm, score, decide, or close.');
  error.statusCode = 400;
  throw error;
}

export async function startDecisionService({port = SERVICE_PORT} = {}) {
  await updateWebtorchRuntime({skillRoot: ROOT});
  const [bridge, local] = await Promise.all([import('./bridge.mjs'), import('./laya-local.mjs')]);
  api = {...bridge, ...local};
  let closing = false;
  const server = createServer(async (request, response) => {
    let requestId = null;
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, {ok: true, result: serviceStatus()});
        return;
      }
      const routes = {
        '/v1/rpc': null,
        '/v1/warm': 'warm',
        '/v1/decision': 'score',
        '/v1/browser-decision': 'decide',
        '/v1/refresh': 'refresh',
        '/v1/close': 'close',
      };
      if (request.method !== 'POST' || !(url.pathname in routes)) {
        writeJson(response, 404, {ok: false, error: 'not found'});
        return;
      }
      const body = await readJson(request);
      const message = routes[url.pathname] ? {op: routes[url.pathname], payload: body} : body;
      requestId = message?.id ?? null;
      const result = await execute(message);
      writeJson(response, 200, {id: message?.id ?? null, ok: true, result, service: serviceStatus()});
      if ((message.op === 'close' || result?.requiresProcessRestart) && !closing) {
        closing = true;
        setImmediate(() => server.close(() => process.exit(0)));
      }
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      writeJson(response, status, {
        id: requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        service: serviceStatus(),
      });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await api.closeLocalDecision().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(`[laya:service] listening on http://127.0.0.1:${port}`);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDecisionService();
}
