import {cp, mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MODEL_ASSETS} from '../skills/laya-browser-use/prepare-model.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(projectRoot, 'dist');
const withoutModel = process.argv.includes('--without-model');
const output = join(dist, withoutModel ? 'laya-browser-use-lite.zip' : 'laya-browser-use.zip');
const temporary = await mkdtemp(join(tmpdir(), 'laya-browser-use-'));
const staged = join(temporary, 'laya-browser-use');
const excludedRoots = new Set([join(projectRoot, '.git'), dist]);
const modelPaths = MODEL_ASSETS.map((asset) => `/${asset.relative}`);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  await cp(projectRoot, staged, {
    recursive: true,
    filter: (source) => {
      if (excludedRoots.has(resolve(source))) return false;
      if (!withoutModel) return true;
      const normalized = source.split(sep).join('/');
      return !modelPaths.some((path) => normalized.endsWith(path));
    },
  });
  for (const relative of [
    'skills/laya-browser-use/runtime/webtorch/dist/wgpy-main.js',
    'skills/laya-browser-use/runtime/webtorch/dist/wgpy-worker.js',
    'skills/laya-browser-use/runtime/webtorch/dist/wgpy_webgl-1.0.0-py3-none-any.whl',
    'skills/laya-browser-use/runtime/webtorch/dist/wgpy_webgpu-1.0.0-py3-none-any.whl',
  ]) {
    const info = await stat(join(staged, relative));
    if (!info.isFile() || info.size < 1000) throw new Error(`Bundle is missing required runtime file: ${relative}`);
  }
  for (const asset of MODEL_ASSETS) {
    const bundled = join(staged, 'skills/laya-browser-use', asset.relative);
    const exists = await stat(bundled).then(() => true, () => false);
    if (withoutModel) {
      if (exists) throw new Error(`Lite bundle unexpectedly contains ${asset.sourcePath}`);
    } else if (!exists || (await stat(bundled)).size !== asset.bytes) {
      throw new Error(`Full bundle contains an invalid model file: ${asset.sourcePath}`);
    }
  }
  await mkdir(dist, {recursive: true});
  await rm(output, {force: true});
  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath ${quote(staged)} -DestinationPath ${quote(output)} -CompressionLevel Optimal -Force`,
    ]);
  } else {
    const zip = process.platform === 'darwin' ? '/usr/bin/zip' : 'zip';
    await run(zip, ['-q', '-r', '-X', output, 'laya-browser-use'], {
      cwd: temporary,
      env: {...process.env, COPYFILE_DISABLE: '1'},
    });
  }
  const info = await stat(output);
  console.log(`Created ${output} (${info.size} bytes)`);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
