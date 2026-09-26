---
name: laya-browser-use
description: Select fast, bounded browser actions with a bundled local Laya model. Use when a Skills-compatible host has a browser or computer-use tool and repetitive low-risk clicks, navigation keys, reloads, toggles, or scrolling can be delegated while the host retains authorization, text input, visual judgment, and verification.
---

# Local Laya browser operations

Use the bundled `convaiinnovations/laya-multilingual` checkpoint to select one action from a
host-supplied bounded list. The model runs locally through WebGPU in a private headless Chromium
process. Inference uses no remote decision endpoint, credential, model hub, or separately managed
service after the one-time model preparation step.

The target page remains in the browser tool supplied by the Skills host. The private runtime browser
never visits the target site.

## Boundaries

- The host owns the goal, authorization, browser selection, text entry, screenshots, graphical
  interpretation, sensitive actions, and final verification.
- Laya only chooses among concrete actions the host has already allowed. It never expands scope or
  grants permission.
- Do not delegate payments, deletions, messages, publishing, account or security changes, CAPTCHAs,
  legal agreements, uploads, or other consequential actions without the host's normal safeguards.
- A `needs_verification` result is not success. Inspect fresh browser state and, when useful, a
  screenshot before reporting completion.
- Keep `minConfidence` at or above `0.55`. The checkpoint score is not a measured success rate for
  the current site.

## Choose an integration mode

Use the direct module adapter when the host provides a persistent Node.js evaluation context. Use
the JSONL CLI when it only provides a persistent shell. Read
[browser host adapters](references/browser-adapters.md) for the exact contracts and examples.

Resolve the absolute path of this installed skill from the host's skill loader. Do not assume a
product-specific home directory.

### Prepare the model once

Before the first runtime call, verify that the two LFS-managed model objects are materialized:

```sh
node /absolute/path/to/laya-browser-use/prepare-model.mjs --check
```

Normal `git clone` and `git pull` leave these objects as pointers because the repository's
`.lfsconfig` excludes model payloads by default. After download authorization, the preparer
overrides that exclusion only for the two required model objects.

If the check reports `missing`, run the same command without `--check`. In a Git checkout it tries
only after authorization as described below. A complete model already present in the private
browser's persistent cache is an exception: the runtime may use that cache without authorization
and write the verified files back before inference.

Before choosing any model source, the host must ask whether it may (a) inspect and reuse another
local Laya runtime, and (b) download model files if no local copy exists. Do not infer either grant
from the browser task. After approval, pass `--allow-local-reuse` and/or `--allow-download`, or set
`LAYA_ALLOW_LOCAL_MODEL_REUSE=1` and/or `LAYA_ALLOW_MODEL_DOWNLOAD=1`. Without a grant the preparer
stops; it never scans ports or starts network transfer on its own.

With local reuse allowed, the skill reads its system-temporary registry and validates the exact
loopback address written by another instance. If HTTP is unavailable, it validates and directly
uses the model directory recorded in that marker. Only when neither exists, and download was also
allowed, does it try Git LFS and then resumable, hash-verified HTTP. A network failure preserves the
`.part` file. `LAYA_MODEL_BASE_URL` may name a host mirror containing `model.safetensors` and
`tokenizer/tokenizer.json`. Do not warm the runtime until preparation reports `ready`.

The private runtime uses fixed loopback port `8765` by default and a persistent Chrome profile, so
the same origin keeps one IndexedDB model-cache namespace across runs. Set `LAYA_RUNTIME_PORT` to
another fixed port if needed; ports are never random. When the cache is complete, startup streams
its chunks into the expected model paths and verifies both hashes. Partial browser cache data is
never treated as a model.

### Information supplied by the host

This skill is host-neutral. Claude Code, Codex, or another Skills-compatible host must provide the
following information from its own browser or computer-use tool for every decision:

- `goal`: the current bounded browser objective
- `state`: a fresh textual observation containing the current URL and relevant accessible controls
- `actions`: the exact actions currently authorized, each with `op`, `name`, and `description`
- `history`: actions already attempted in this bounded run and their observed effects
- `LAYA_BROWSER_EXECUTABLE`: preferably, the absolute path to a Chrome, Chromium, or Edge executable
  that the host knows has WebGPU support; set it before the first runtime call
- `LAYA_PYODIDE_INDEX_URL`: optionally, the base URL of a host-provided Pyodide 0.27.7 mirror;
  otherwise the runtime uses its documented jsDelivr default
- `LAYA_MODEL_BASE_URL`: optionally, a host-provided model mirror used only during preparation
- `LAYA_ALLOW_LOCAL_MODEL_REUSE`: set to `1` only after permission to read the temporary marker and
  reuse its loopback service or recorded model directory
- `LAYA_ALLOW_MODEL_DOWNLOAD`: set to `1` only after permission to use Git LFS or HTTP download

The browser executable is for the private WebGPU model process, not the target tab or its profile.
If the host cannot supply it, the runtime may fall back to platform discovery. The host must also
retain the target-tab handle and execute the selected action itself. If its
browser tool returns screenshots rather than accessibility text, the host interprets the image and
constructs the textual `state` and bounded `actions`; the local model does not inspect the target
screenshot. Never ask the runtime to discover controls or permissions on its own.

### Direct module adapter

```js
var {pathToFileURL} = await import('node:url');
var layaBrowser = await import(pathToFileURL('/absolute/path/to/laya-browser-use/bridge.mjs').href);
var layaConfig = await layaBrowser.loadConfig();
```

`createSession(tab, options)` accepts a host adapter implementing `getAXState`, `click`, `scroll`,
`pressKey`, and `reload`. It does not open or attach to the target browser.

### Portable CLI

Start one persistent process so the model is loaded once:

```sh
node /absolute/path/to/laya-browser-use/laya-cli.mjs jsonl
```

Send `warm`, `decide`, and `close` JSON objects over stdin as documented in the adapter reference.
The host observes and operates the target page; the CLI only scores the supplied state and actions.

## Run a bounded task

1. Inspect the authorized target tab and record its current origin.
2. Define the goal, expected final state, exact allowed origins, and a focused action list.
3. Exclude text fields and consequential controls. Use `denyNames`, `allowNames`, and
   `requireHostNames` to narrow busy pages.
4. Ask Laya for one choice, verify the target state is still fresh, then execute that choice through
   the host browser tool.
5. Observe again after every action. Stop on an origin change, stale state, low confidence, repeated
   no-effect action, time limit, or step limit.
6. Independently verify the requested final state.

For a direct adapter:

```js
var session = layaBrowser.createSession(targetTabAdapter, {
  ...layaConfig,
  allowedOrigins: ['https://example.com'],
  maxSteps: 12,
  maxMs: 45000,
  minConfidence: 0.55
});
var outcome = await session.run({
  goal: 'Open settings and expand notification preferences without changing settings.',
  controls: [
    {op:'click', name:'Settings'},
    {op:'click', name:'Notification preferences'}
  ],
  policy: {
    click: true,
    scrollDirections: ['down', 'up'],
    denyNames: [/delete/i, /purchase/i],
    requireHostNames: [/publish/i, /send/i]
  }
});
```

The direct bridge validates the origin before every decision and action, rejects stale state,
validates probability output, and enforces step and time limits. CLI users must apply the same
origin and freshness checks in the host loop.

## Handle results

- `needs_verification`: inspect the current target state independently.
- `low_confidence`, `blocked`, `no_progress`, `loading_timeout`, `decision_error`, or
  `action_error`: inspect the handoff reason and continue manually only when authorized.
- `step_limit` or `budget`: inspect progress before starting another bounded chunk.

Report executed actions, elapsed decision time, handoffs, verification, and limitations briefly.

## Runtime requirements

- Windows, Linux, or macOS
- Node.js 22 or newer
- Chrome, Chromium, or Microsoft Edge with working WebGPU for the private model runtime
- a Skills host with a browser/computer-use tool for the target page
- access to the default Pyodide CDN on first start, unless the host provides a mirror
- about 670 MB of installed data

The checkpoint and tokenizer can be deferred during installation. When either is absent or still a
Git LFS pointer, the host must run `prepare-model.mjs` before starting the private runtime.
If an authorized loopback source disappears while the model is loading, the runtime rechecks the
marker's filesystem path first and downloads only when no valid local source remains and download
permission was already granted.

The host should set `LAYA_BROWSER_EXECUTABLE` to its known WebGPU-capable Chromium executable before
the first `loadConfig()`, `decide()`, or CLI `warm` call. The runtime auto-discovers supported
Chromium executables only when the host does not provide one. The loopback asset server binds only to
`127.0.0.1:8765` by default (or the fixed `LAYA_RUNTIME_PORT`), supplies COOP/COEP headers and byte
ranges, and exposes no decision API. For maintenance and platform diagnostics, read
[local runtime maintenance](references/provider-configuration.md).
