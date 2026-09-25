# Browser host adapters

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

The host owns browser selection, authorization, screenshots, text entry, and final verification.
Translate its native browser calls into the adapter without opening a second target browser.

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
{"id":"2","op":"decide","payload":{"goal":"Open settings","state":"Browser tab: Example. URL: \"https://example.com/\".\n1 button Settings","actions":[{"op":"click","name":"Settings","description":"Click Settings"}],"history":[]}}
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
12 button Settings
13 link Documentation
14 text field Search
```

If the host uses another accessibility representation, normalize it to this form before calling
the bridge. Stable numeric indexes are only needed for the direct session adapter; CLI callers may
use their own stable control identifier in the returned action mapping.
