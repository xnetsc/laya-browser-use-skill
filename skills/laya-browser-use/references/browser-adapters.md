# Browser host adapters

Use this adapter only after constructing a fresh accessibility state made of directly observed
facts. Resolve any missing or derived information before asking Laya to select a candidate action.
Candidate descriptions must already state the relevant effect; do not ask the adapter to infer a
hidden page state, plan intermediate steps, or predict an unstated consequence. The host must inspect
the returned candidate, probability distribution, and confidence. Low confidence commonly means
the observed state is incomplete or ambiguous; the host may gather more facts and retry or accept
the result according to its own policy.

The skill does not assume a particular agent product or browser-control namespace. The target page
stays in the browser tool supplied by the host. The private Chromium process started by
`laya-local.mjs` is only the local model runtime and never opens the target site.

## Direct module adapter

Use this mode when the host provides a persistent Node.js evaluation context. Pass `createSession`
an adapter with these asynchronous methods:

- `getAXState(options)`: return the current tab URL and accessibility controls as one string
- `click(index)`: click the control identified by the current accessibility snapshot
- `scroll(target, direction, amount)`: scroll the page or a host-identified region
- `pressKey(target, key)`: send a supported navigation key
- `reload()`: reload the current page

Translate the host's native browser calls into the adapter without opening a second target browser.

Claude Code, Codex, and other Skills-compatible hosts use this same contract. Product-specific tool
names belong in the host-side adapter or orchestration loop, not in this skill's model runtime.

## Portable JSONL adapter

Use this mode when the host can run a persistent shell process but cannot import Node modules into
its browser-control context:

```sh
node /absolute/path/to/laya-browser-use/laya-cli.mjs jsonl
```

Write one JSON object per line and read one response per line. Keep the process alive so the loaded
model remains resident.

Warm the runtime:

```json
{"id":"1","op":"warm"}
```

Request a decision after the host has observed the page and constructed a bounded action list:

```json
{"id":"2","op":"decide","payload":{"goal":"Use the explicitly marked current action","state":"Browser tab: Example. URL: \"https://example.com/\".\n1 button Primary action, marked current","actions":[{"op":"click","name":"Primary action","description":"Click the action explicitly marked current"}],"history":[]}}
```

The response contains `result.action`; execute that action with the host browser tool, observe fresh
state, verify the origin, and repeat. Shut down cleanly with:

```json
{"id":"3","op":"close"}
```

Do not pass page text in command-line arguments because process listings may expose it. JSONL stdin
keeps the payload out of the command line. The CLI reports short errors and does not write page
state to disk.

## Accessibility text

`bridge.mjs` currently recognizes lines shaped like:

```text
12 button Primary action
13 link Secondary action
14 text field Input
```

If the host uses another accessibility representation, normalize it to this form before calling
the bridge. Stable numeric indexes are only needed for the direct session adapter; CLI callers may
use their own stable control identifier in the returned action mapping.
