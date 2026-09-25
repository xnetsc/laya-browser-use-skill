# Laya Browser Use

A portable Skills-standard package for bounded browser actions selected by a bundled local Laya
decision model. It is not tied to one agent product or browser-control namespace.

The project contains the checkpoint, WebGPU runtime, Chromium launcher, host-neutral module API,
and a JSONL command interface. It uses no separately managed Laya service or remote decision
endpoint.

## Supported environments

- Windows, Linux, and macOS
- Node.js 22 or newer
- Google Chrome, Chromium, or Microsoft Edge with working WebGPU for the private model runtime
- any Skills-compatible host that can inspect and operate a target browser page
- about 670 MB of installed data

The target browser and private runtime browser are separate. The target may be any browser supported
by the host's browser/computer-use tool. The private Chromium process only runs the local model and
never opens the target site.

## Import or install

The portable skill directory is:

```text
skills/laya-browser-use/
```

A host that supports importing a skill directory can import that folder directly.

The installer defaults to the shared Agents Skills location:

```sh
node scripts/verify.mjs
node scripts/install.mjs
```

Default destination: `~/.agents/skills/laya-browser-use`.

Other destinations:

```sh
node scripts/install.mjs --host codex
node scripts/install.mjs --host claude
node scripts/install.mjs --target /absolute/path/to/skills/laya-browser-use
```

The Claude target installs to `~/.claude/skills/laya-browser-use`, or beneath
`$CLAUDE_CONFIG_DIR` when that variable is set. For a project-scoped Claude Code skill:

```sh
node scripts/install.mjs --target ./.claude/skills/laya-browser-use
```

PowerShell accepts the same options:

```powershell
node .\scripts\install.mjs --target 'C:\Users\me\.agents\skills\laya-browser-use'
```

An existing installation is never overwritten silently. `--force` first moves it to a timestamped
sibling backup. Reload or restart the host after installation.

## Host integration

The skill provides two equivalent entry points:

- `bridge.mjs`: direct module API for a host with a persistent Node.js evaluation context
- `laya-cli.mjs jsonl`: persistent stdin/stdout protocol for any host with shell access

Claude Code, Codex, or another host supplies the bounded goal, a fresh textual browser observation,
the exact authorized action list, and action history. The host retains control of authorization,
accessibility capture, clicks, scrolling, typing, screenshots, and final verification. See
[`references/browser-adapters.md`](skills/laya-browser-use/references/browser-adapters.md).

## Browser runtime selection

The runtime automatically checks Chrome, Chromium, and Edge locations appropriate for the current
operating system. To require one executable:

```sh
LAYA_BROWSER_EXECUTABLE=/absolute/path/to/chrome npm run verify:runtime
```

PowerShell:

```powershell
$env:LAYA_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run verify:runtime
```

The runtime uses Metal flags on macOS, Vulkan flags on Linux, and the native WebGPU backend on
Windows. Each candidate must pass a WebGPU probe before the model is loaded.

## Verify

```sh
npm test
npm run verify:runtime
npm run verify:cli
```

- `npm test` checks files, the model digest, host-neutral bridge behavior, and generated browser
  candidates for Windows, Linux, and macOS.
- `verify:runtime` loads the complete model and runs a direct module decision.
- `verify:cli` loads the complete model through the portable JSONL protocol and runs a decision.

No model download occurs during these checks.

## Create a transfer archive

```sh
npm run bundle
```

This writes `dist/laya-browser-use.zip`. The archive contains the full checkpoint rather than Git
LFS pointers. On Linux, the `zip` command must be installed; Windows uses PowerShell and macOS uses
the system `zip` utility.

## Layout

- `skills/laya-browser-use/`: portable skill directory
- `scripts/install.mjs`: non-destructive cross-host installer
- `scripts/install-target.mjs`: built-in Agents, Codex, and Claude install targets
- `scripts/verify.mjs`: static and direct-runtime verification
- `scripts/platform-test.mjs`: cross-platform discovery and bridge unit checks
- `scripts/cli-runtime-test.mjs`: real JSONL runtime verification
- `scripts/bundle.mjs`: transfer archive builder
- `licenses/` and `THIRD_PARTY_NOTICES.md`: redistribution notices
