# Golden Kog risk debate module

A small, dependency free at runtime TypeScript module for adding two source bounded advocates to a structural token risk report: one argues for the more resilient reading, one argues for fragility, and a reviewer weighs the evidence. It is risk analysis only and never a trading view. The module never changes the caller supplied risk level or points.

This is an AI assisted independent implementation prepared for the public Kognai Golden Kog risk debate task. It is not endorsed or selected by Kognai. The task pattern adapts the multi agent debate idea from [TradingAgents](https://github.com/TauricResearch/TradingAgents), licensed Apache 2.0; this repository does not copy its trader or portfolio manager.

## Install and test

Requires Node 22 and npm. There are no runtime dependencies. TypeScript is a development dependency only.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Tests are deterministic and offline. The caller supplies `route`, so the module has no hidden network client or model credential. An application that chooses to use a model router is responsible for that router and its cost policy.

## Example

```ts
import { debate, type DebateInput, type DebateDeps } from './dist/debate.js';

const input: DebateInput = {
  facts_text: 'holders 120\nadmin_keys 1\nliquidity_lock_days 30\nsource_count 3',
  level: 'elevated',
  points: 42,
  flag_ids: ['ADMIN_KEY', 'LOCK'],
  unknown: ['owner history not supplied'],
};
const deps: DebateDeps = {
  mode: 'shadow',
  route: async args => {
    // Map the explicit args to your approved internal model route.
    // Return { content, model, cost_usd } from that route.
    throw new Error(`Route not configured for ${args.payload.role}`);
  },
};
const result = await debate(input, deps);
console.log(result.status, result.shown, result.rejected);
```

A production router implementation is intentionally not bundled. A missing route must be configured explicitly rather than silently connecting to an undocumented model service.

## Call flow and guarantees

1. The `sound` and `fragile` advocates are dispatched concurrently with `complexity: exec`.
2. Each part is checked against the measured `facts_text`: numeric tokens, refused trading language, Unicode digits, dash characters, word limits, and any caller guard. A rejected advocate becomes the exact safe fallback text and its reason is retained.
3. The reviewer runs with `complexity: apex`, both advocate texts, the same facts, and the original flag identifiers. Its response must parse as JSON containing `text`, `weight` and `unknown` arrays, and optionally `tension`.
4. Weight identifiers not in `flag_ids` are dropped. An invalid reviewer result rejects the full debate with empty text fields. Calls are bounded by `timeoutMs` and cost is the sum of reported nonnegative finite `cost_usd` values.
5. `off` makes no route call. `shadow` invokes and logs the result with `shown: false`. `on` returns `shown: true`. The result does not alter `level` or `points`.

Every model generated part is content rather than authority. The measured facts, existing flag identifiers and independent risk checker remain the source of truth. This module does not fetch prices, recommend transactions, or produce a security certificate. Model route costs are unknown until an application supplies a route and reports its actual usage.

## Acceptance test map

- A1: parallel advocates and reviewer context.
- A2: unsupported numeric claims fail closed.
- A3: refused terms, dash characters, non Latin digits, word limits and caller guards.
- A4: reviewer JSON and flag identifier filtering.
- A5: call timeouts.
- A6: off, shadow, and on behavior, logging, and measured cost aggregation.
- A7: invalid input handling and this documented call flow.

## License

Apache 2.0. The design pattern is credited to TradingAgents by TauricResearch under Apache 2.0. This repository is a separate implementation.
