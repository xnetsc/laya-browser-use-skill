import {cp, mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(projectRoot, 'dist');
const output = join(dist, 'laya-browser-use.zip');
const temporary = await mkdtemp(join(tmpdir(), 'laya-browser-use-'));
const staged = join(temporary, 'laya-browser-use');

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
    filter: (source) => !['.git', 'dist'].includes(basename(source)),
  });
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
