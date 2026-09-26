import {createInterface} from 'node:readline';
import {stdin, stdout} from 'node:process';
import {decide, loadConfig} from './bridge.mjs';
import {closeLocalDecision, localDecision} from './laya-local.mjs';

function write(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(message) {
  const id = message?.id ?? null;
  try {
    if (message?.op === 'warm') return {id, ok: true, result: await loadConfig()};
    if (message?.op === 'score') return {id, ok: true, result: await localDecision(message.payload ?? {})};
    if (message?.op === 'decide') return {id, ok: true, result: await decide(message.payload ?? {})};
    if (message?.op === 'close') {
      await closeLocalDecision();
      return {id, ok: true, result: {closed: true}};
    }
    throw new Error('Unsupported operation; expected warm, score, decide, or close');
  } catch (error) {
    return {id, ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

async function readAll() {
  let value = '';
  for await (const chunk of stdin) value += chunk;
  return value;
}

const mode = process.argv[2] || 'jsonl';
if (mode === 'warm') {
  const response = await handle({op: 'warm'});
  write(response);
  if (!response.ok) process.exitCode = 1;
  await closeLocalDecision();
} else if (mode === 'decide') {
  const input = JSON.parse(await readAll());
  const response = await handle({op: 'decide', payload: input});
  write(response);
  if (!response.ok) process.exitCode = 1;
  await closeLocalDecision();
} else if (mode === 'score') {
  const input = JSON.parse(await readAll());
  const response = await handle({op: 'score', payload: input});
  write(response);
  if (!response.ok) process.exitCode = 1;
  await closeLocalDecision();
} else if (mode === 'jsonl') {
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
      const response = await handle(message);
      write(response);
      if (message.op === 'close') lines.close();
    });
  });
  await new Promise((resolve) => lines.once('close', resolve));
  await pending;
  await closeLocalDecision();
} else {
  throw new Error('Usage: node laya-cli.mjs [jsonl|warm|score|decide]');
}
