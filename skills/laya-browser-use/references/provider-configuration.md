# Local Laya runtime maintenance

This customized installation uses no remote decision provider and no credential file.

## Installed components

- `bridge.mjs`: browser-action loop and result validation
- `laya-local.mjs`: private headless Chrome lifecycle and local inference bridge
- `laya-page.html`: WebGPU model host page
- `runtime/models/laya/`: copied `convaiinnovations/laya-multilingual` checkpoint
- `runtime/webtorch/`: copied webtorch runtime
- `runtime/node_modules/playwright*`: browser launch library

The model page is served from a temporary loopback HTTP origin because WebGPU workers require a
secure, cross-origin-isolated context and model loading requires byte-range responses. The server
listens on `127.0.0.1` with an operating-system-selected ephemeral port and returns COOP/COEP
headers. It serves static runtime files only; it does not expose a decision endpoint.

## Verification

From Node.js, import `bridge.mjs`, call `loadConfig()`, then call `decide()` with a synthetic state
and a small action list. A healthy result reports:

- provider: `laya-local`
- model: `convaiinnovations/laya-multilingual`
- a choice present in the supplied criteria
- finite confidence and probabilities summing to approximately one

On first startup, system Google Chrome is launched headlessly with GPU enabled. If it cannot launch,
report the Chrome launch error; do not add a remote-provider or non-Chrome fallback silently.

## Updating the local runtime

Copy a complete compatible model directory as one unit; do not mix checkpoint files from different
revisions. The required files are:

- `model.safetensors`
- `rl_agent_config.json`
- `encoder/config.json`
- `tokenizer/tokenizer.json`
- `tokenizer/tokenizer_config.json`

When updating webtorch, replace `runtime/webtorch/` as a matched runtime build and preserve its
`LICENSE` and `NOTICE`. Run a real local decision after every update.
