import {cp, mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(projectRoot, 'dist');
const withoutModel = process.argv.includes('--without-model');
const output = join(dist, withoutModel ? 'laya-browser-use-lite.zip' : 'laya-browser-use.zip');
const temporary = await mkdtemp(join(tmpdir(), 'laya-browser-use-'));
const staged = join(temporary, 'laya-browser-use');
const excludedRoots = new Set([join(projectRoot, '.git'), dist]);

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
      return !normalized.endsWith('/runtime/models/laya/model.safetensors')
        && !normalized.endsWith('/runtime/models/laya/tokenizer/tokenizer.json');
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
  const bundledModel = join(staged, 'skills/laya-browser-use/runtime/models/laya/model.safetensors');
  const bundledTokenizer = join(staged, 'skills/laya-browser-use/runtime/models/laya/tokenizer/tokenizer.json');
  if (withoutModel) {
    if (await stat(bundledModel).then(() => true, () => false)) throw new Error('Lite bundle unexpectedly contains model.safetensors');
    if (await stat(bundledTokenizer).then(() => true, () => false)) throw new Error('Lite bundle unexpectedly contains tokenizer.json');
  } else {
    if ((await stat(bundledModel)).size !== 643835514) throw new Error('Full bundle contains an invalid model file');
    if ((await stat(bundledTokenizer)).size !== 34363188) throw new Error('Full bundle contains an invalid tokenizer file');
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
