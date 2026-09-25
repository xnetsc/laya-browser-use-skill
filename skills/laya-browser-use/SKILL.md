---
name: laya-browser-use
description: Select fast, bounded browser actions with a bundled local Laya model. Use when a Skills-compatible host has a browser or computer-use tool and repetitive low-risk clicks, navigation keys, reloads, toggles, or scrolling can be delegated while the host retains authorization, text input, visual judgment, and verification.
---

# Local Laya browser operations

Use the bundled `convaiinnovations/laya-multilingual` checkpoint to select one action from a
host-supplied bounded list. The model runs locally through WebGPU in a private headless Chromium
process. It uses no remote decision endpoint, credential, model hub, or separately managed service.

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
- about 670 MB of installed data

The runtime auto-discovers supported Chromium executables. Set `LAYA_BROWSER_EXECUTABLE` to an
absolute executable path when discovery is insufficient. The loopback asset server binds only to
`127.0.0.1` on an ephemeral port, supplies COOP/COEP headers and byte ranges, and exposes no
decision API. For maintenance and platform diagnostics, read
[local runtime maintenance](references/provider-configuration.md).
