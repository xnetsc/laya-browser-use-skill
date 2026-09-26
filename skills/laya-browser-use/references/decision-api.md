# Decision API

`localDecision({state, questions})` scores typed questions against one shared fact set.

## State

`state` may be text or JSON. It must contain explicit facts needed by the questions. Do not put
missing premises, hypotheses, unresolved ambiguity, or instructions to derive new facts into the
state. Compute or obtain derived values before making the request and add those values to `state`.

The interface performs direct scoring/classification only. Do not use it to explain causes, infer a
missing fact, execute a reasoning chain, choose intermediate planning steps, or predict an unstated
consequence. The host is responsible for supplying fact-complete content and for inspecting each
answer together with its probability distribution and confidence. Low confidence commonly indicates
incomplete or ambiguous state; the host may supplement facts and retry or explicitly accept the
result. The interface does not impose a confidence threshold or block a result.

### Category-selection example

Candidate names, domains, and URLs do not establish their category. This is not a valid request:

```js
state: {facts: ['the list contains GitHub and Hugging Face']}
instructions: 'Select the code repository.'
```

It requires outside knowledge about what each name represents. Supply the observed facts first and
make the criterion explicit:

```js
state: {facts: [
  'candidate GitHub is a source-code repository',
  'candidate Hugging Face is a model repository'
]}
questions: {
  repo: {
    type: 'choice',
    instructions: 'Select the candidate explicitly recorded as the source-code repository.',
    criteria: {github: 'GitHub', hf: 'Hugging Face'}
  }
}
```

This answer is `github` because the supplied facts state that directly. If a candidate's type is
not already known, resolve it outside the interface before submitting the question.

## Questions

`questions` is an object keyed by caller-defined ids. Related questions should be submitted in one
request so the runtime can share encoder work.

- `choice`: `criteria` is an object or list of named options. The answer contains `choice`,
  `probabilities`, and `confidence`.
- `score`: `criteria` is an ordered list of levels. The answer contains the expected numeric
  `score`, the probability distribution, and a `legend`.
- `noul`: `instructions` is the statement being evaluated. Optional `criteria.false` and
  `criteria.true` describe the two labels. The answer contains `noul` in `[0, 1]` and the
  false/true distribution.

## Direct module

```js
import {localDecision} from '/absolute/path/to/laya-browser-use/laya-local.mjs';

const result = await localDecision({
  state: {
    facts: [
      'candidate alpha is current',
      'condition flag is true',
      'level is medium'
    ]
  },
  questions: {
    pick: {
      type: 'choice',
      instructions: 'Select the current candidate.',
      criteria: {alpha: 'Alpha', beta: 'Beta'}
    },
    truth: {
      type: 'noul',
      instructions: 'The condition flag is true.'
    },
    level: {
      type: 'score',
      instructions: 'Return the stated level.',
      criteria: ['low', 'medium', 'high']
    }
  }
});
```

## JSONL CLI

Start one persistent process:

```sh
node /absolute/path/to/laya-browser-use/laya-cli.mjs jsonl
```

Warm it once, then send `score` requests:

```json
{"id":"1","op":"warm"}
{"id":"2","op":"score","payload":{"state":{"facts":["candidate alpha is current"]},"questions":{"pick":{"type":"choice","instructions":"Select the current candidate.","criteria":{"alpha":"Alpha","beta":"Beta"}}}}}
{"id":"3","op":"close"}
```

The response preserves each question id under `result.answers` and reports shared execution data
under `result.usage`.

## Persistent HTTP service

Start the service once and reuse it from any local client:

```sh
node /absolute/path/to/laya-browser-use/laya-service.mjs
```

It listens on `127.0.0.1:8767` by default. `POST /v1/warm` loads the model, `POST /v1/decision`
accepts the same `{state, questions}` payload as `localDecision`, and `POST /v1/close` stops the
service. `POST /v1/rpc` accepts `{id, op, payload}` with `warm`, `score`, `decide`, `refresh`, or
`close`. `GET /health` reports readiness and queue capacity. HTTP requests and the JSONL client share
one bounded FIFO queue, so concurrent callers are serialized by the same loaded runtime. A client
may exit without closing the service; the service stays available for reuse.

At startup and on `refresh`, the service checks the published runtime and model manifests. It stages
all changed files, verifies the complete sets, and switches all affected runtime/model directories
in one transaction. A failed update leaves the old set active.
