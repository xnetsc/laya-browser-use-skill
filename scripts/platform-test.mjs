import assert from 'node:assert/strict';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInstallTarget} from './install-target.mjs';
import {discoverActions} from '../skills/laya-browser-use/bridge.mjs';
import {platformBrowserCandidates} from '../skills/laya-browser-use/laya-local.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const mac = platformBrowserCandidates({platform: 'darwin', env: {}, home: '/Users/test'});
assert.equal(mac[0].channel, 'chrome');
assert(mac.some((entry) => entry.executablePath === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
assert(mac.every((entry) => entry.launchModes.some((mode) => mode.args.includes('--use-angle=metal'))));
assert(mac.every((entry) => entry.launchModes.some((mode) => mode.name === 'browser-default')));

const linux = platformBrowserCandidates({
  platform: 'linux', env: {PATH: '/opt/browser/bin:/usr/local/bin'}, home: '/home/test',
});
assert(linux.some((entry) => entry.executablePath === '/opt/browser/bin/chromium'));
assert(linux.every((entry) => entry.launchModes.some((mode) => mode.args.includes('--use-angle=vulkan'))));
assert(linux.every((entry) => entry.launchModes.some((mode) => mode.name === 'browser-default')));

const windows = platformBrowserCandidates({
  platform: 'win32',
  env: {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    LAYA_BROWSER_EXECUTABLE: 'D:\\Browsers\\chrome.exe',
  },
  home: 'C:\\Users\\test',
});
assert.equal(windows[0].executablePath, 'D:\\Browsers\\chrome.exe');
assert.equal(windows[0].required, true);
assert(windows.some((entry) => entry.executablePath === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
assert(windows.every((entry) => entry.launchModes.every((mode) => !mode.args.some((arg) => arg.includes('metal') || arg.includes('vulkan')))));

assert.equal(
  resolveInstallTarget({host: 'claude', env: {}, home: '/Users/test'}),
  '/Users/test/.claude/skills/laya-browser-use',
);
assert.equal(
  resolveInstallTarget({
    host: 'claude',
    env: {CLAUDE_CONFIG_DIR: '/opt/claude'},
    home: '/Users/test',
  }),
  '/opt/claude/skills/laya-browser-use',
);
assert.throws(
  () => resolveInstallTarget({host: 'unknown', env: {}, home: '/Users/test'}),
  /agents, codex, or claude/,
);

const actions = discoverActions(
  'Browser tab: Test. URL: "https://example.com/".\n1 button Settings\n2 button Delete account',
  {click: true, requireHostNames: [/delete/i]},
);
assert.deepEqual(actions.map((action) => action.name), ['Settings']);

assert.equal(join(projectRoot, 'skills', 'laya-browser-use').endsWith('laya-browser-use'), true);
console.log(JSON.stringify({
  status: 'platform-tests-ok',
  platforms: ['win32', 'linux', 'darwin'],
  installHosts: ['agents', 'codex', 'claude'],
  hostPolicy: 'ok',
}, null, 2));
