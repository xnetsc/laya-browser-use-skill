import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {stdin, stdout} from 'node:process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(ROOT, 'laya-service.mjs');
const SERVICE_PORT = Number.parseInt(process.env.LAYA_SERVICE_PORT || '8767', 10) || 8767;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;

function write(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function health(timeoutMs = 750) {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, {signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) return null;
    const value = await response.json();
    return value?.ok ? value : null;
  } catch {
    return null;
  }
}

async function ensureService() {
  const existing = await health();
  if (existing) return {spawned: false, health: existing};
  const child = spawn(process.execPath, [SERVICE], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await health();
    if (current) return {spawned: true, health: current};
    await sleep(200);
  }
  throw new Error(`Laya decision service did not start on ${SERVICE_URL}.`);
}

async function rpc(message, timeoutMs = 20 * 60 * 1000) {
  const response = await fetch(`${SERVICE_URL}/v1/rpc`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Laya decision service returned HTTP ${response.status}.`);
  }
  if (!response.ok && value?.ok !== false) throw new Error(`Laya decision service returned HTTP ${response.status}.`);
  return value;
}

async function connect() {
  const service = await ensureService();
  if (!service.spawned) {
    const refreshed = await rpc({id: null, op: 'refresh'});
    if (!refreshed.ok) throw new Error(refreshed.error || 'Laya runtime refresh failed.');
    if (refreshed.result?.requiresProcessRestart) {
      const previousPid = refreshed.service?.pid;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await health();
        if (!current || current.result?.pid !== previousPid) break;
        await sleep(100);
      }
      return await ensureService();
    }
  }
  return service;
}

async function readAll() {
  let value = '';
  for await (const chunk of stdin) value += chunk;
  return value;
}

async function oneShot(op, payload) {
  await connect();
  const response = await rpc({id: null, op, ...(payload === undefined ? {} : {payload})});
  write(response);
  if (!response.ok) process.exitCode = 1;
}

async function jsonl() {
  await connect();
  const lines = createInterface({input: stdin, crlfDelay: Infinity});
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    pending = pending.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({id: null, ok: false, error: 'Invalid JSON'});
        return;
      }
      const response = await rpc(message);
      write(response);
      if (message.op === 'close') lines.close();
    }).catch((error) => {
      write({id: null, ok: false, error: error instanceof Error ? error.message : String(error)});
    });
  });
  await new Promise((resolve) => lines.once('close', resolve));
  await pending;
}

const mode = process.argv[2] || 'jsonl';
if (mode === 'serve') {
  const {startDecisionService} = await import('./laya-service.mjs');
  await startDecisionService();
} else if (mode === 'warm') {
  await oneShot('warm');
} else if (mode === 'decide' || mode === 'score') {
  await oneShot(mode, JSON.parse(await readAll()));
} else if (mode === 'jsonl') {
  await jsonl();
} else {
  throw new Error('Usage: node laya-cli.mjs [serve|jsonl|warm|score|decide]');
}
