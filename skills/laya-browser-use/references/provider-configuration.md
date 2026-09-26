# Local Laya runtime maintenance

This installation uses no remote decision provider and no credential file. Model transfer is a
one-time preparation operation; inference remains local afterward.

## Installed components

- `bridge.mjs`: host-neutral action loop, decision API, and result validation
- `laya-cli.mjs`: portable JSONL and one-shot command interface
- `laya-local.mjs`: private Chromium lifecycle and local inference bridge
- `laya-page.html`: WebGPU model host page
- `prepare-model.mjs`: Git-LFS-first model materializer with verified resumable fallback
- `runtime/models/laya/`: `convaiinnovations/laya-multilingual` checkpoint, bundled or prepared later
- `runtime/webtorch/`: bundled webtorch runtime
- `runtime/node_modules/playwright*`: cross-platform Chromium launcher

The model page is served from a loopback HTTP origin because WebGPU workers require a secure,
cross-origin-isolated context and model loading requires byte-range responses. The server listens on
`127.0.0.1:8765` by default, or on the fixed `LAYA_RUNTIME_PORT` value, and returns COOP/COEP
headers. It serves static runtime files only and exposes no decision endpoint. Its private Chrome
profile is persistent so the same origin reuses one IndexedDB model-cache namespace.

The matched WgPy JavaScript bundles and WebGPU/WebGL wheels are part of the installed skill. The
Python runtime defaults to Pyodide 0.27.7 on jsDelivr. A host can set
`LAYA_PYODIDE_INDEX_URL` before the first runtime call to use another mirror of that same release;
the value must be an absolute base URL ending in `/`. The text-only Laya path does not load the
optional ONNX Vision worker or its tokenizer dependencies.

## Model preparation

The checkpoint and tokenizer are Git LFS objects. A repository host can first clone only ordinary
files with `GIT_LFS_SKIP_SMUDGE=1`, then run `node scripts/install.mjs --allow-local-reuse
--allow-model-download` after host authorization; the installer asks Git LFS for the exact two model
paths before copying the skill. A directly imported or deferred skill can
run:

```sh
node /absolute/path/to/laya-browser-use/prepare-model.mjs
```

The host must ask before enabling local reuse or any download. After authorization, pass
`--allow-local-reuse` and/or `--allow-download`, or set the corresponding
`LAYA_ALLOW_LOCAL_MODEL_REUSE=1` and `LAYA_ALLOW_MODEL_DOWNLOAD=1` environment variables. The
preparer uses this order:

1. accept existing files only when their byte counts and SHA-256 digests match;
2. inspect exact loopback addresses registered by running Laya instances, without scanning ports;
3. if registered HTTP is unavailable, validate and directly use its recorded model directory;
4. only when no local source remains, run `git lfs pull` for the checkpoint and tokenizer;
5. if Git LFS is unavailable or incomplete, use resumable HTTP with the skill's GitHub media URL,
   the Hugging Face mirror, and the upstream Hugging Face repository;
6. move each `.part` file into place only after full digest verification.

Set `LAYA_MODEL_BASE_URL` to put a host-owned mirror before the built-in sources. Its layout must be
`model.safetensors` and `tokenizer/tokenizer.json`. Re-running the command is safe and resumes an
interrupted `.part` file. `--check` performs no download; `--lfs-only` forbids HTTP fallback; and
`--no-lfs` skips the Git LFS attempt.

Every runtime that serves verified local files writes a manifest marker beneath the operating
system's temporary directory (from `os.tmpdir()`, never a hard-coded `/tmp`). The marker contains
the model manifest, exact `127.0.0.1` URL, absolute model directory, and persistent browser-profile
path.
It remains useful after the process exits: a later instance rejects the dead HTTP endpoint, checks
the recorded files by size and SHA-256, and serves that directory itself. If a reused HTTP endpoint
dies during loading, the same filesystem check happens before any authorized download fallback.
If the files are gone but the persistent profile still has complete IndexedDB chunks, startup binds
the recorded fixed port, exports those chunks, verifies both hashes, and restores the files before
loading. Cache recovery is local and needs no download authorization; incomplete chunks are rejected.

## Browser selection

The Skills host should provide the absolute path of a known WebGPU-capable Chrome, Chromium, or Edge
binary through `LAYA_BROWSER_EXECUTABLE` before it imports and warms the direct adapter or starts the
JSONL process. Pass only the executable path: the private runtime must not attach to the target tab,
reuse its profile, or receive its browsing data.

When the host has no browser path to provide, the runtime discovers a compatible executable. It
tries these sources in order:

1. host-provided `LAYA_BROWSER_EXECUTABLE`
2. Playwright's installed Google Chrome channel
3. Playwright's installed Microsoft Edge channel
4. common Chrome, Chromium, and Edge installation paths for the current operating system
5. Chrome/Chromium/Edge commands found on `PATH` on Linux

Every candidate must pass a loopback-origin probe for cross-origin isolation and a usable WebGPU
adapter before the model is loaded. macOS uses Metal flags, Linux uses Vulkan flags, and Windows
uses the browser's native WebGPU backend. Failure messages list the attempted candidates.

For the direct adapter, set the variable before the first `loadConfig()` or `decide()` call. For the
CLI adapter, include it in the environment of the persistent process:

```sh
LAYA_BROWSER_EXECUTABLE=/absolute/path/to/chrome node laya-cli.mjs warm
```

PowerShell:

```powershell
$env:LAYA_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node .\laya-cli.mjs warm
```

An invalid explicit path fails immediately; it never silently falls back to a different browser.

## Verification

Import `bridge.mjs` and call `loadConfig()`, or send `{"op":"warm"}` to the JSONL CLI. A healthy
result reports:

- provider: `laya-local`
- model: `convaiinnovations/laya-multilingual`
- backend: `webgpu`
- the selected runtime browser and operating system

Then call `decide()` with a synthetic state and a small action list. The result must contain a
supplied choice, finite confidence, and probabilities summing to approximately one.

## Updating the local runtime

Copy a complete compatible model directory as one unit; do not mix checkpoint files from different
revisions. Required files:

- `model.safetensors`
- `rl_agent_config.json`
- `encoder/config.json`
- `tokenizer/tokenizer.json`
- `tokenizer/tokenizer_config.json`

When updating webtorch, replace `runtime/webtorch/` as one matched build and preserve its `LICENSE`
and `NOTICE`. Run a real local decision after every runtime or model update.
