import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

const supportedHosts = ['agents', 'codex', 'claude'];

export function resolveInstallTarget({host = 'agents', target = null, env = process.env, home = homedir()} = {}) {
  if (!supportedHosts.includes(host)) {
    throw new Error('--host must be agents, codex, or claude; use --target for another host');
  }

  const hostHomes = {
    agents: env.AGENTS_HOME || join(home, '.agents'),
    codex: env.CODEX_HOME || join(home, '.codex'),
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  };

  return resolve(target || join(hostHomes[host], 'skills', 'laya-browser-use'));
}
