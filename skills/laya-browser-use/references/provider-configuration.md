# Local Laya runtime maintenance

This installation uses no remote decision provider and no credential file.

## Installed components

- `bridge.mjs`: host-neutral action loop, decision API, and result validation
- `laya-cli.mjs`: portable JSONL and one-shot command interface
- `laya-local.mjs`: private Chromium lifecycle and local inference bridge
- `laya-page.html`: WebGPU model host page
- `runtime/models/laya/`: bundled `convaiinnovations/laya-multilingual` checkpoint
- `runtime/webtorch/`: bundled webtorch runtime
- `runtime/node_modules/playwright*`: cross-platform Chromium launcher

The model page is served from a temporary loopback HTTP origin because WebGPU workers require a
secure, cross-origin-isolated context and model loading requires byte-range responses. The server
listens on `127.0.0.1` with an operating-system-selected ephemeral port and returns COOP/COEP
headers. It serves static runtime files only and exposes no decision endpoint.

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
