import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(projectRoot, 'skills', 'laya-browser-use', 'laya-cli.mjs');
const child = spawn(process.execPath, [cli, 'jsonl'], {stdio: ['pipe', 'pipe', 'pipe']});
const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
const waiting = new Map();
let stderr = '';
let sequence = 0;

child.stderr.on('data', (chunk) => { stderr += chunk; });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  pending.resolve(message);
});
child.once('exit', (code) => {
  for (const pending of waiting.values()) pending.reject(new Error(`CLI exited with ${code}: ${stderr}`));
  waiting.clear();
});

function request(op, payload) {
  const id = String(++sequence);
  const response = new Promise((resolvePromise, reject) => {
    waiting.set(id, {resolve: resolvePromise, reject});
  });
  child.stdin.write(`${JSON.stringify({id, op, ...(payload === undefined ? {} : {payload})})}\n`);
  return response;
}

const timeout = setTimeout(() => child.kill(), 20 * 60 * 1000);
try {
  const warm = await request('warm');
  assert.equal(warm.ok, true, warm.error);
  assert.equal(warm.result.backend, 'webgpu');
  assert.equal(typeof warm.result.runtimeBrowser, 'string');
  assert.equal(typeof warm.result.platform, 'string');

  const decision = await request('decide', {
    ...warm.result,
    goal: 'Open settings.',
    state: 'Browser tab: Test. URL: "https://example.com/".\n1 button Settings\n2 button Delete account',
    actions: [
      {op: 'click', name: 'Settings', description: 'Click Settings'},
      {op: 'click', name: 'Delete account', description: 'Click Delete account'},
    ],
  });
  assert.equal(decision.ok, true, decision.error);
  assert.equal(decision.result.choice, 'a0');
  assert(decision.result.confidence >= 0.55);

  const closed = await request('close');
  assert.equal(closed.ok, true, closed.error);
  child.stdin.end();
  console.log(JSON.stringify({
    status: 'cli-runtime-ok',
    config: warm.result,
    decision: decision.result,
  }, null, 2));
} finally {
  clearTimeout(timeout);
  if (!child.killed) child.kill();
}
