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
- access to the default Pyodide CDN on first runtime start, or a host-provided Pyodide mirror
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

To fetch the repository without transferring the two large model objects first:

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/xnetsc/laya-browser-use-skill.git
cd laya-browser-use-skill
node scripts/install.mjs --allow-local-reuse --allow-model-download
```

The two allow flags must be passed only after the host has asked for and received permission. The
installer first checks the temporary registry written by an existing Laya runtime. A live loopback
server is reused without copying the model; if its HTTP endpoint is unavailable, a verified model
directory recorded in the same marker is used directly. It does not scan ports. Only when neither
local source exists does it try `git lfs pull`, then resumable public HTTP downloads. Downloads use
exact byte counts, SHA-256 verification, atomic final rename, and a persistent `.part` file.

The installer defaults to the shared Agents Skills location:

```sh
node scripts/install.mjs
```

The short form succeeds without authorization when the repository already contains verified model
files. If they are absent or still LFS pointers, the installer stops and tells the host to obtain
authorization rather than choosing a source by itself.

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

To install only the runtime and defer both large model objects:

```sh
node scripts/install.mjs --defer-model
node /absolute/path/to/installed/laya-browser-use/prepare-model.mjs --allow-local-reuse --allow-download
```

For a manually imported skill directory, run its `prepare-model.mjs` before first use. A host can
provide a private mirror base with `LAYA_MODEL_BASE_URL`; it must contain `model.safetensors` and
`tokenizer/tokenizer.json` at those relative paths. The built-in sources require no credential.
Equivalent host-controlled environment grants are `LAYA_ALLOW_LOCAL_MODEL_REUSE=1` and
`LAYA_ALLOW_MODEL_DOWNLOAD=1`. The host must ask before setting either variable.

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

The private runtime uses a stable loopback origin on port `8765` by default, so its persistent
Chrome profile reuses the same IndexedDB model-cache namespace. Set `LAYA_RUNTIME_PORT` to another
fixed port before starting it if `8765` is occupied; the runtime never chooses a random port.

The repository includes the matched WgPy JavaScript bundles and WebGPU/WebGL backend wheels; a
clean clone needs no WgPy build step. Pyodide itself is loaded from jsDelivr by default. A host that
mirrors Pyodide can provide its absolute base URL, including the trailing slash:

```sh
LAYA_PYODIDE_INDEX_URL=https://example.invalid/pyodide/v0.27.7/full/ npm run verify:runtime
```

PowerShell:

```powershell
$env:LAYA_PYODIDE_INDEX_URL = 'https://example.invalid/pyodide/v0.27.7/full/'
npm run verify:runtime
```

## Verify

```sh
node skills/laya-browser-use/prepare-model.mjs --check
npm test
npm run verify:runtime
npm run verify:cli
```

If the model files are absent but a previous run's persistent browser cache is complete, the next
run starts from that cache and streams the two files back to `runtime/models/laya/` with size and
SHA-256 checks. Cache recovery does not require model-download authorization. A partial cache is
not accepted as a model.

- `npm test` checks files, the model digest, host-neutral bridge behavior, and generated browser
  candidates for Windows, Linux, and macOS.
- `verify:runtime` loads the complete model and runs a direct module decision.
- `verify:cli` loads the complete model through the portable JSONL protocol and runs a decision.

No model download occurs during these checks.

## Create a transfer archive

```sh
npm run bundle
npm run bundle:lite
```

This writes `dist/laya-browser-use.zip`. The archive contains the full checkpoint rather than Git
LFS pointers. `dist/laya-browser-use-lite.zip` excludes both large LFS objects; after extracting it,
run `node skills/laya-browser-use/prepare-model.mjs`. On Linux, the `zip` command must be installed;
Windows uses PowerShell and macOS uses the system `zip` utility.

## Layout

- `skills/laya-browser-use/`: portable skill directory
- `scripts/install.mjs`: non-destructive cross-host installer
- `skills/laya-browser-use/prepare-model.mjs`: Git-LFS-first, resumable model preparation
- `scripts/install-target.mjs`: built-in Agents, Codex, and Claude install targets
- `scripts/verify.mjs`: static and direct-runtime verification
- `scripts/platform-test.mjs`: cross-platform discovery and bridge unit checks
- `scripts/cli-runtime-test.mjs`: real JSONL runtime verification
- `scripts/bundle.mjs`: transfer archive builder
- `licenses/` and `THIRD_PARTY_NOTICES.md`: redistribution notices
