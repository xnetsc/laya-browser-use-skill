import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'laya-install-test-'));
const target = join(temporary, 'laya-browser-use');

async function exists(path) {
  return await stat(path).then(() => true, () => false);
}

try {
  execFileSync(process.execPath, [
    'scripts/install.mjs', '--defer-model', '--target', target,
  ], {stdio: 'pipe'});
  assert.equal(await exists(join(target, 'prepare-model.mjs')), true);
  assert.equal(await exists(join(target, 'runtime/webtorch/dist/wgpy-main.js')), true);
  assert.equal(await exists(join(target, 'runtime/models/laya/model.safetensors')), false);
  assert.equal(await exists(join(target, 'runtime/models/laya/tokenizer/tokenizer.json')), false);

  const check = spawnSync(process.execPath, [join(target, 'prepare-model.mjs'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(check.status, 1);
  assert.match(check.stdout, /"status": "missing"/);
  console.log(JSON.stringify({status: 'install-tests-ok', deferredModel: true}, null, 2));
} finally {
  await rm(temporary, {recursive: true, force: true});
}
