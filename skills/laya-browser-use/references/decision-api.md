# Decision API

`localDecision({state, questions})` scores typed questions against one shared state.

## State

`state` may be text or JSON. It must contain explicit facts needed by the questions. Do not put
missing premises, hypotheses, unresolved ambiguity, or instructions to derive new facts into the
state. Compute or obtain derived values before making the request.

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
