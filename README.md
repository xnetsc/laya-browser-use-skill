# Laya Browser Use

A portable Skills-standard package for direct fact-based scoring with a bundled local Laya model.
It supports choosing one named option, scoring ordered levels, and estimating whether a statement
is true only when the answer follows directly from explicit supplied facts. It is not used to infer
missing information, derive facts, explain causes, plan steps, or predict unstated consequences.
A browser candidate-selection adapter is included.

`browser` remains in the package and skill name, but it does not limit applicability. The skill is
recommended for every decision that fits one of the supported question types; no browser task is
required.

The project contains the model manifest and files, WebGPU runtime, Chromium launcher, host-neutral
module API, persistent HTTP decision service, and a JSONL command interface. HTTP and stdio clients
share one fixed-port service, one loaded browser, and one bounded decision queue.

## Supported environments

- Windows, Linux, and macOS
- Node.js 22 or newer
- Google Chrome, Chromium, or Microsoft Edge with working WebGPU for the private model runtime
- any Skills-compatible host with a persistent Node.js context or shell
- access to the default Pyodide CDN on first runtime start, or a host-provided Pyodide mirror
- about 670 MB of installed data

The private Chromium process only runs the local model. When the optional browser adapter is used,
the target browser remains separate.

## Import or install

The portable skill directory is:

```text
skills/laya-browser-use/
```

A host that supports importing a skill directory can import that folder directly.

The repository excludes its LFS-managed model payloads from normal fetches. A regular clone or
pull therefore transfers source and runtime files while leaving manifest-listed model payloads as
LFS pointers:

```sh
git clone https://github.com/xnetsc/laya-browser-use-skill.git
cd laya-browser-use-skill
node scripts/install.mjs
```

The repository-level `.lfsconfig` applies the same exclusion to later `git pull` operations. Once
the model is needed, the installer overrides that exclusion for the manifest-listed payloads. It
first checks the temporary registry written by an existing Laya runtime. A live loopback server is
reused without copying the model; if its HTTP endpoint is unavailable, a verified model directory
recorded in the same marker is used directly. It does not scan ports. Only when neither local source
exists does it explicitly fetch the assets with `git lfs pull`, then resumable public HTTP downloads.
Downloads use the exact paths from the model manifest, byte counts, SHA-256 verification, atomic
final rename, and persistent `.part` files.

The installer defaults to the shared Agents Skills location:

```sh
node scripts/install.mjs
```

The installer accepts existing verified model files or prepares them automatically when they are
absent or still LFS pointers. The model manifest is the source of truth for the model identifier,
every file's relative path, source path, size, digest, support files, and download sources.

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
node /absolute/path/to/installed/laya-browser-use/prepare-model.mjs
```

For a manually imported skill directory, run its `prepare-model.mjs` before first use. A host can
provide a private mirror base with `LAYA_MODEL_BASE_URL`; it must follow the `sourcePath` entries in
the model manifest. The built-in sources require no credential.

## Host integration

The skill provides these entry points:

- `laya-local.mjs` → `localDecision({state, questions})`: generic module API
- `laya-cli.mjs jsonl` → `score`: generic persistent stdin/stdout API
- `laya-service.mjs` → persistent local HTTP service shared by HTTP and stdio clients
- `bridge.mjs`: browser candidate-selection adapter

Decision state must contain explicit facts; missing or derived facts are resolved before the call
and supplied in the state. The host must inspect each answer together with its probability
distribution and confidence. Low confidence commonly means the state is incomplete or ambiguous;
the host may add facts and retry, or explicitly accept the result according to its own policy. The
skill does not impose a threshold or block a result.

The browser adapter deliberately asks the same choice in forward and reverse option order because
the bundled legacy checkpoint is position-sensitive and either ordering may win. It averages the two
distributions symmetrically for the final choice and reports a top-two margin as `confidence`. That
aggregate is an ensemble score, not a second calibrated model probability:
`probabilitiesCalibrated` is `false`, `confidenceKind` is `top-two-share`, and `components` preserves
both original temperature-scaled distributions and their `answerConfidence` values. Calibrate the ensemble
separately on held-out adapter decisions before applying an accuracy threshold to it.
Do not treat names, URLs, or platform labels as type facts. A list containing `GitHub` and `Hugging
Face` does not by itself answer “which is the code repository”; the host must first supply facts
such as `GitHub is a source-code repository` and `Hugging Face is a model repository`. Then ask
“Select the candidate explicitly recorded as the source-code repository” with those two names as
the choices. The direct answer is `GitHub`; inferring the types from the names is outside this
skill.
See [`references/decision-api.md`](skills/laya-browser-use/references/decision-api.md). For the
optional browser adapter, see
[`references/browser-adapters.md`](skills/laya-browser-use/references/browser-adapters.md).

## HTTP and stdio service

The service listens on `127.0.0.1:8767` by default. The model page and static WebGPU files remain on
`127.0.0.1:8765`; set `LAYA_SERVICE_PORT` or `LAYA_RUNTIME_PORT` to other fixed ports when needed.
The service keeps the HTTP server and headless browser alive for reuse. Clients do not close it when
their own process exits; send `close` to stop it. Concurrent HTTP and stdio requests share a FIFO
queue, whose default capacity is 64 and can be changed with `LAYA_MAX_QUEUE`.

```sh
node /absolute/path/to/laya-browser-use/laya-cli.mjs warm
curl -X POST http://127.0.0.1:8767/v1/decision \
  -H 'content-type: application/json' \
  --data '{"state":{"facts":["condition flag is true"]},"questions":{"truth":{"type":"noul","instructions":"The condition flag is true."}}}'
```

Each service startup checks the published WebPyTorch and model manifests. A changed WebPyTorch
runtime is downloaded into a staging directory, verified, switched atomically, and the browser is
restarted. A changed model is first fully downloaded and verified; only then are the old model
directory and browser cache removed and the new model activated. All changed directories switch in
one transaction; a failed switch rolls back. Failed checks leave the current runtime and model in
place. The runtime manifest carries a monotonic `runtimeVersion`; automatic updates accept only a
higher version (or repair the same version at the same commit), so a stale published manifest cannot
downgrade a newer bundled or installed runtime.

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

If any manifest-listed model file is absent but a previous run's persistent browser cache is
complete, the next run starts from that cache and streams the listed assets back to the model's
directory with size and SHA-256 checks. A partial cache is not accepted as a model.

- `npm test` checks files, the model digest, structured decision interfaces, and generated runtime
  browser candidates for Windows, Linux, and macOS.
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
- `skills/laya-browser-use/runtime/models/<model>/manifest.json`: model identifier, sources, sizes
  and hashes. The directory is **found**, not named in code: whichever one under
  `runtime/models/` carries a `manifest.json` is the model, so changing the checkpoint is
  dropping a directory in and taking the old one out. `LAYA_MODEL_DIR` picks one when several
  are present. It currently holds `mccoysc/xDecision`.
- `skills/laya-browser-use/model-dir.mjs`: that rule, in one place
- `skills/laya-browser-use/runtime/webtorch/manifest.json`: synced WebPyTorch file list and hashes
- `scripts/sync-webpytorch.mjs`: upstream dependency synchronizer
- `skills/laya-browser-use/webtorch-update.mjs`: startup updater with atomic runtime/model switching
- `skills/laya-browser-use/laya-service.mjs`: persistent HTTP decision service
- `scripts/install-target.mjs`: built-in Agents, Codex, and Claude install targets
- `scripts/verify.mjs`: static and direct-runtime verification
- `scripts/platform-test.mjs`: cross-platform discovery and bridge unit checks
- `scripts/cli-runtime-test.mjs`: real JSONL runtime verification
- `scripts/bundle.mjs`: transfer archive builder
- `licenses/` and `THIRD_PARTY_NOTICES.md`: redistribution notices
