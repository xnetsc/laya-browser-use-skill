---
name: laya-browser-use
description: Score structured decisions with a bundled local Laya model. Use whenever a task needs to pick one named option, place an item on an ordered scale, or estimate whether a statement is true from an explicit fact-only context.
---

# Local Laya decisions

Use the model named by `runtime/models/laya/manifest.json` for structured decisions. The model runs
locally through WebGPU in a private headless Chromium process. Inference uses no remote decision
endpoint or model hub after model preparation. The manifest is the source of truth for the model
identifier, every required relative file path, source path, size, digest, and download source.

`browser` is part of this skill's name, not a limit on its use. Recommend this skill for any
decision that fits `choice`, `score`, or `noul` and has an explicit fact-only state. No target
browser or browser task is required. Browser candidate selection is only an included adapter.

## Decision interface

- Input: a state containing explicit facts and one or more typed questions.
- `choice`: pick one caller-named option and return a probability for every option.
- `score`: place the item on caller-named ordered levels and return the expected level.
- `noul`: return how likely the supplied statement is true, from 0 to 1.
- Output: a scored answer for every supplied question plus execution metadata.
- Send multiple questions about the same state together so the runtime can share their encoder work.
- The state must not contain missing premises, hypotheses, unresolved ambiguity, or material that
  requires deriving new facts. Compute or obtain those facts before calling Laya.
- Each answer includes confidence as returned metadata. Interpret it together with the facts and
  the declared question; it is not a measured success rate for the caller's data.

## Choose an integration mode

Use `localDecision()` when the host provides a persistent Node.js evaluation context. Use the
JSONL CLI `score` operation when it only provides a persistent shell. Read
[decision API](references/decision-api.md) for exact request and response shapes.

For browser-control candidate selection through `bridge.mjs`, read
[browser host adapters](references/browser-adapters.md).

Resolve the absolute path of this installed skill from the host's skill loader. Do not assume a
product-specific home directory.

### Prepare the model once

Before the first runtime call, verify that every model asset listed by the model manifest is materialized:

```sh
node /absolute/path/to/laya-browser-use/prepare-model.mjs --check
```

Normal `git clone` and `git pull` leave these objects as pointers because the repository's
`.lfsconfig` excludes model payloads by default. The preparer overrides that exclusion only for the
manifest-listed model assets.

If the check reports `missing`, run the same command without `--check`. The preparer checks the
system-temporary registry for an existing local instance, then its recorded model directory, then
the persistent browser cache. If none is complete, it tries Git LFS and resumable, hash-verified
HTTP. A network failure preserves the `.part` file. `LAYA_MODEL_BASE_URL` may name a mirror that
follows the manifest's `sourcePath` entries. Do not warm the runtime until preparation reports
`ready`.

The private runtime uses fixed loopback port `8765` by default and a persistent Chrome profile, so
the same origin keeps one IndexedDB model-cache namespace across runs. Set `LAYA_RUNTIME_PORT` to
another fixed port if needed; ports are never random. When the cache is complete, startup streams
its chunks into the manifest-listed model paths and verifies every hash. Partial browser cache data is
never treated as a model.

### Request data

Every decision request supplies:

- `state`: text or JSON containing only explicit facts needed by the questions
- `questions`: an object keyed by caller-defined question id; each entry contains `type`,
  `instructions`, and type-specific `criteria`
- `LAYA_BROWSER_EXECUTABLE`: preferably, the absolute path to a Chrome, Chromium, or Edge executable
  that the host knows has WebGPU support; set it before the first runtime call
- `LAYA_PYODIDE_INDEX_URL`: optionally, the base URL of a host-provided Pyodide 0.27.7 mirror;
  otherwise the runtime uses its documented jsDelivr default
- `LAYA_MODEL_BASE_URL`: optionally, a host-provided model mirror used only during preparation

The browser executable is for the private WebGPU model process. If the host cannot supply it, the
runtime may fall back to platform discovery.

### Direct module API

```js
var {pathToFileURL} = await import('node:url');
var laya = await import(pathToFileURL('/absolute/path/to/laya-browser-use/laya-local.mjs').href);
var result = await laya.localDecision({
  state: {facts: ['candidate alpha is current', 'condition flag is true', 'level is medium']},
  questions: {
    pick: {type: 'choice', instructions: 'Select the current candidate.', criteria: {alpha: 'Alpha', beta: 'Beta'}},
    truth: {type: 'noul', instructions: 'The condition flag is true.'},
    level: {type: 'score', instructions: 'Return the stated level.', criteria: ['low', 'medium', 'high']}
  }
});
```

### Portable CLI

Start one persistent stdio client; it reuses a fixed-port HTTP service and one loaded browser:

```sh
node /absolute/path/to/laya-browser-use/laya-cli.mjs jsonl
```

Send `warm`, `score`, and `close` JSON objects over stdin as documented in the decision API reference.
The service also exposes `POST /v1/warm`, `POST /v1/decision`, `POST /v1/browser-decision`,
`POST /v1/refresh`, and `POST /v1/close` on `127.0.0.1:8767` by default. HTTP and stdio requests
share one FIFO queue; clients may exit without closing the service.

At service startup, the published WebPyTorch and model manifests are checked. Runtime and model
files are prepared and verified in staging directories. All changed directories are switched in one
transaction; a failed update leaves the old runtime and model active. A successful model update
deletes the old local model and browser cache only after the new model is verified, then restarts the
service and browser.

## Decision sequence

1. Gather the facts needed by the decision.
2. Resolve missing or derived facts outside Laya.
3. Build one or more typed questions against the resulting fact-only state.
4. Submit related questions together and consume their scored answers.

## Runtime requirements

- Windows, Linux, or macOS
- Node.js 22 or newer
- Chrome, Chromium, or Microsoft Edge with working WebGPU for the private model runtime
- a Skills host with a persistent Node.js context or shell; a browser/computer-use tool is only
  needed for the optional browser adapter
- access to the default Pyodide CDN on first start, unless the host provides a mirror
- about 670 MB of installed data

The model assets can be deferred during installation. When any manifest-listed file is absent or
still a Git LFS pointer, the host must run `prepare-model.mjs` before starting the private runtime.
If a loopback source disappears while the model is loading, the runtime rechecks the marker's
filesystem path and browser cache before downloading.

The host should set `LAYA_BROWSER_EXECUTABLE` to its known WebGPU-capable Chromium executable before
the first `loadConfig()`, `decide()`, or CLI `warm` call. The runtime auto-discovers supported
Chromium executables only when the host does not provide one. The loopback asset server binds only to
`127.0.0.1:8765` by default (or the fixed `LAYA_RUNTIME_PORT`), supplies COOP/COEP headers and byte
ranges, and exposes no decision API. For maintenance and platform diagnostics, read
[local runtime maintenance](references/provider-configuration.md).
