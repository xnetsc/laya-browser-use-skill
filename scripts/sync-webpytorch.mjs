import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = join(projectRoot, 'skills', 'laya-browser-use', 'runtime', 'webtorch');
const managedPaths = ['LICENSE', 'NOTICE', 'dist', 'webtorch'];
const requiredFiles = [
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

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function git(upstream, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', upstream, ...args], {encoding});
}

function safeRelative(value) {
  return value && !value.startsWith('/') && !value.startsWith('\\')
    && !value.split('/').includes('..') && !value.includes('\\');
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesEqual(left, right) {
  const [a, b] = await Promise.all([
    stat(left).catch(() => null),
    stat(right).catch(() => null),
  ]);
  if (!a?.isFile() || !b?.isFile() || a.size !== b.size) return false;
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  return leftHash === rightHash;
}

async function listFiles(root, base = root) {
  const entries = await readdir(root, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'));
    else throw new Error(`Unsupported upstream entry: ${path}`);
  }
  return files;
}

async function treesEqual(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listFiles(left), listFiles(right)]);
  leftFiles.sort();
  rightFiles.sort();
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  for (const file of leftFiles) {
    if (!(await filesEqual(join(left, file), join(right, file)))) return false;
  }
  return true;
}

async function replaceDirectory(staged, target) {
  await mkdir(dirname(target), {recursive: true});
  const targetInfo = await stat(target).catch(() => null);
  if (!targetInfo) {
    await rename(staged, target);
    return;
  }
  if (!targetInfo.isDirectory()) throw new Error(`WebPyTorch target is not a directory: ${target}`);
  const backup = `${target}.sync-backup-${process.pid}-${Date.now()}`;
  await rename(target, backup);
  try {
    await rename(staged, target);
    await rm(backup, {recursive: true, force: true});
  } catch (error) {
    await rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function syncWebpytorch({upstream, target = defaultTarget, check = false} = {}) {
  if (!upstream) throw new Error('An upstream WebPyTorch checkout is required.');
  upstream = resolve(upstream);
  target = resolve(target);
  git(upstream, ['rev-parse', '--is-inside-work-tree']);
  try {
    git(upstream, ['diff', '--quiet', 'HEAD', '--', ...managedPaths]);
    git(upstream, ['diff', '--cached', '--quiet', 'HEAD', '--', ...managedPaths]);
  } catch {
    throw new Error('The upstream checkout has modified managed files.');
  }

  const tracked = git(upstream, ['ls-files', '-z', '--', ...managedPaths], 'buffer')
    .toString('utf8').split('\0').filter(Boolean).sort();
  for (const file of tracked) {
    if (!safeRelative(file)) throw new Error(`Unsafe upstream path: ${file}`);
  }
  for (const file of requiredFiles) {
    if (!tracked.includes(file)) throw new Error(`Required upstream file is missing: ${file}`);
  }

  const dependencyCommit = git(upstream, ['log', '-1', '--format=%H', '--', ...managedPaths]).trim();
  if (!/^[0-9a-f]{40}$/.test(dependencyCommit)) throw new Error('Cannot resolve the WebPyTorch dependency commit.');
  const staged = await mkdtemp(join(dirname(target), '.webpytorch-sync-'));
  try {
    const manifestFiles = [];
    for (const file of tracked) {
      const source = join(upstream, file);
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`Managed upstream path is not a file: ${file}`);
      const destination = join(staged, file);
      await mkdir(dirname(destination), {recursive: true});
      await copyFile(source, destination);
      manifestFiles.push({path: file, bytes: info.size, sha256: await digest(source)});
    }
    const manifest = {
      protocol: 1,
      upstream: {
        repository: 'https://github.com/xnetsc/webpytorch.git',
        ref: 'main',
        commit: dependencyCommit,
      },
      files: manifestFiles,
    };
    await writeFile(join(staged, 'UPSTREAM_SHA'), `${dependencyCommit}\n`);
    await writeFile(join(staged, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const current = await stat(target).then((value) => value.isDirectory(), () => false)
      && await treesEqual(staged, target);
    if (current) {
      await rm(staged, {recursive: true, force: true});
      return {status: 'current', commit: dependencyCommit, files: tracked.length};
    }
    if (check) {
      await rm(staged, {recursive: true, force: true});
      return {status: 'stale', commit: dependencyCommit, files: tracked.length};
    }
    await replaceDirectory(staged, target);
    return {status: 'updated', commit: dependencyCommit, files: tracked.length};
  } catch (error) {
    await rm(staged, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const result = await syncWebpytorch({
    upstream: option(args, '--upstream'),
    target: option(args, '--target') || defaultTarget,
    check: args.includes('--check'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'stale') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
