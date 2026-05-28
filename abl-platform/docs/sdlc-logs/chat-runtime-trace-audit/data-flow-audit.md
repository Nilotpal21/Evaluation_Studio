# Chat Runtime Trace Audit

## Scope

- Jira: ABLP-1001
- Goal: close chat trace audit gaps where runtime events existed but were not consistently available in inline chat responses, runtime registry coverage, debug tooling types, or Studio trace presentation.
- Boundary path: runtime emitter -> inline REST callback -> trace registry -> MCP debug types -> Studio interaction grouping -> Studio event presentation.

## Findings Closed

| Finding                                                                                                                                                          | Risk                                                                                                                      | Fix                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RuntimeExecutor persisted canonical trace events but forwarded the narrower `{ type, data }` callback payload to inline REST chat.                               | Inline chat callers lost event id, timestamp, session id, agent/span/causal fields even though persisted traces had them. | Forward the canonical `TraceEventWithId` to the original callback. Existing WebSocket callbacks still read `type`/`data`; inline REST now receives the richer shape. |
| Synthetic chat failure events were appended inline before receiving the stored event identity.                                                                   | Queue-full and execution failure responses could not be correlated to stored trace events.                                | Build one canonical synthetic event first, push it inline, then persist/emit the same event shape.                                                                   |
| `step_thought`, `tool_thought`, `status_update`, and `status_clear` were emitted by chat runtime paths but not first-class in the runtime event registry subset. | Cross-package contract tests and debug tooling could drift from actual emitted chat events.                               | Added the event types to `RUNTIME_EVENT_TYPES` and made their runtime verbosity explicit.                                                                            |
| Studio grouped thought/status events as generic or invisible fallback events.                                                                                    | Developers could not quickly understand why an agent was thinking, waiting, or clearing status during chat execution.     | Added Studio interaction mappings, labels, colors, summaries, and event processor extraction for thought/status data.                                                |
| MCP debug local trace type union lagged the canonical event inventory.                                                                                           | Debug tools could reject or under-type valid runtime events.                                                              | Expanded the MCP debug trace event union for the current runtime event set touched by the audit.                                                                     |

## Parity Evidence

| Boundary                       | Coverage                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime callback parity        | `apps/runtime/src/__tests__/routes/runtime-read-surface-contract.test.ts` asserts canonical trace events are forwarded to inline REST callbacks.                           |
| Synthetic inline error parity  | `apps/runtime/src/__tests__/sessions/chat-routes.test.ts` asserts queue-full trace events include id, timestamp, session id, type, and data.                               |
| Registry and Studio map parity | `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` and `apps/studio/src/__tests__/interactions-contract.test.ts` assert runtime event inventory coverage. |
| Chat audit event UI parity     | `apps/studio/src/__tests__/chat-runtime-events-parity.test.ts` asserts thought/status runtime events are mapped, labelled, and summarized for Studio.                      |
| Interaction behavior           | `apps/studio/src/__tests__/interactions-event-processor.test.ts` asserts thought/status events become visible decision steps.                                              |

## Validation Run

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @koredotcom/agents-mcp-tools build`
- `pnpm exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/routes/runtime-read-surface-contract.test.ts src/__tests__/sessions/chat-routes.test.ts -t "inline REST chat|canonical runtime trace|trace events|adds trace context and synthetic trace events"` from `apps/runtime`
- `pnpm --filter @agent-platform/studio test -- src/__tests__/interactions-contract.test.ts src/__tests__/interactions-event-processor.test.ts`
- `pnpm --filter @agent-platform/shared-kernel test -- src/__tests__/trace-event-contract.test.ts`

## Residual Risk

- This closes the chat trace availability and Studio visibility gaps. Voice trace parity has separate work already committed under ABLP-1030 and should continue to be verified in dev after deployment.
- Historical sessions will only show the richer inline callback fields for events that were originally persisted with those fields. Older inline-only client payloads cannot be retroactively enriched unless the persisted trace source is re-read.
