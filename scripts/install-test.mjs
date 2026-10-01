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
  // The model's directory is discovered, so the test asks the skill where it is rather
  // than spelling a name that a change of checkpoint would quietly invalidate.
  const {MODEL_PREFIX, MODEL_ASSETS} = await import('../skills/laya-browser-use/prepare-model.mjs');
  for (const asset of MODEL_ASSETS) {
    assert.equal(await exists(join(target, MODEL_PREFIX + asset.sourcePath)), false);
  }

  const check = spawnSync(process.execPath, [join(target, 'prepare-model.mjs'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(check.status, 1);
  assert.match(check.stdout, /"status": "missing"/);
  console.log(JSON.stringify({status: 'install-tests-ok', deferredModel: true}, null, 2));
} finally {
  await rm(temporary, {recursive: true, force: true});
}
