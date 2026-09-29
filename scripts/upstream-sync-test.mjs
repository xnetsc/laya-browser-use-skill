import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {syncWebpytorch} from './sync-webpytorch.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'laya-upstream-sync-test-'));
const upstream = join(temporary, 'upstream');
const target = join(temporary, 'target');
const files = [
  'LICENSE',
  'NOTICE',
  'dist/wgpy-main.js',
  'dist/wgpy-worker.js',
  'dist/wgpy_webgl-1.0.0-py3-none-any.whl',
  'dist/wgpy_webgpu-1.0.0-py3-none-any.whl',
  'webtorch/js/webtorch-main.js',
  'webtorch/js/webtorch-host.js',
  'webtorch/js/webtorch-worker.js',
];

function git(args) {
  return execFileSync('git', ['-C', upstream, ...args], {encoding: 'utf8'}).trim();
}

async function put(root, path, value) {
  await mkdir(join(root, path, '..'), {recursive: true});
  await writeFile(join(root, path), value);
}

try {
  await mkdir(upstream, {recursive: true});
  git(['init']);
  git(['config', 'user.name', 'Sync Test']);
  git(['config', 'user.email', 'sync-test@example.invalid']);
  for (const file of files) await put(upstream, file, `first:${file}\n`);
  await put(upstream, 'unrelated.txt', 'one\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const firstCommit = git(['rev-parse', 'HEAD']);

  await mkdir(target, {recursive: true});
  await put(target, 'stale.txt', 'stale\n');
  const first = await syncWebpytorch({upstream, target});
  assert.equal(first.status, 'updated');
  assert.equal(first.commit, firstCommit);
  assert.equal((await readFile(join(target, 'UPSTREAM_SHA'), 'utf8')).trim(), firstCommit);
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, files.length);
  assert.equal(Number.isSafeInteger(manifest.runtimeVersion), true);
  await assert.rejects(readFile(join(target, 'stale.txt')));

  const current = await syncWebpytorch({upstream, target, check: true});
  assert.equal(current.status, 'current');

  await put(upstream, 'unrelated.txt', 'two\n');
  git(['add', 'unrelated.txt']);
  git(['commit', '-m', 'unrelated']);
  const unrelated = await syncWebpytorch({upstream, target, check: true});
  assert.equal(unrelated.status, 'current');
  assert.equal(unrelated.commit, firstCommit);

  await put(upstream, 'webtorch/js/webtorch-main.js', 'second\n');
  git(['add', 'webtorch/js/webtorch-main.js']);
  git(['commit', '-m', 'runtime']);
  const changedCommit = git(['rev-parse', 'HEAD']);
  const stale = await syncWebpytorch({upstream, target, check: true});
  assert.equal(stale.status, 'stale');
  const updated = await syncWebpytorch({upstream, target});
  assert.equal(updated.status, 'updated');
  assert.equal(updated.commit, changedCommit);
  assert.equal(await readFile(join(target, 'webtorch/js/webtorch-main.js'), 'utf8'), 'second\n');

  console.log(JSON.stringify({status: 'upstream-sync-tests-ok', files: files.length}, null, 2));
} finally {
  await rm(temporary, {recursive: true, force: true});
}
