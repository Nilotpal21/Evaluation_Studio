# Data-Flow Audit: Runtime Trace Causality

**Date**: 2026-05-12  
**Ticket**: ABLP-989  
**Scope**: Runtime causal trace envelope and Studio trace visibility.

## Values Audited

| Value                              | Class                      | Source                                                                       | Sinks                                                                       | Status |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| `turnId`                           | Operational trace metadata | Runtime trace event top level or `data.causal`                               | TraceStore, EventStore `data.causal`, Studio live/historical traces         | Wired  |
| `executionId`, `parentExecutionId` | Operational trace metadata | Runtime trace event top level or payload mirror                              | TraceStore, ClickHouse replay, Studio adapters                              | Wired  |
| `agentRunId`                       | Operational trace metadata | Runtime causal tracker on `agent_enter`; explicit emitter field overrides    | Studio ledger, Observatory chips, Analytics trace detail                    | Wired  |
| `decisionId`, `parentDecisionId`   | Operational trace metadata | Runtime causal tracker for decision events; explicit emitter field overrides | Studio ledger, metadata tab, Analytics waterfall                            | Wired  |
| `causeEventId`                     | Operational trace metadata | Runtime causal tracker linear cause fallback or explicit emitter field       | EventStore metadata/data, ClickHouse replay, Studio missing-cause detection | Wired  |
| `phase`, `reasonCode`              | Operational trace metadata | Runtime phase/reason derivation or explicit emitter field                    | Studio phase counts, chips, raw event metadata                              | Wired  |

## Boundary Map

| Boundary                   | Implementation                                                                                                                             | Evidence                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Runtime canonical type     | `packages/shared-kernel/src/types/trace-event.ts` exposes optional causal fields                                                           | Runtime build passed                                             |
| Runtime live storage       | `apps/runtime/src/services/runtime-executor.ts` attaches causal fields to TraceStore records and live callback payloads                    | `trace-causal-envelope.test.ts`                                  |
| Runtime historical storage | `emit-to-eventstore.ts` writes causal fields into `metadata.causal` and durable `data.causal`                                              | `known-source-platform-events.test.ts`                           |
| Historical replay          | `clickhouse-session-trace-events.ts` rehydrates causal fields from `data.causal` before returning trace events                             | `clickhouse-session-trace-events.test.ts`                        |
| Studio normalization       | `useSessionDetail`, `WebSocketContext`, and `useSessionTraces` preserve causal fields from camelCase, snake_case, and `data.causal` shapes | `trace-causality-parity.test.ts`                                 |
| Studio Observatory adapter | `trace-event-adapter.ts` promotes causal fields to `ExtendedTraceEvent` and keeps `data.causal` intact                                     | `trace-event-adapter.test.ts`                                    |
| Studio UI                  | `TraceCausalityLedger` and `TraceCausalChips` render live and historical causal metadata                                                   | `trace-causality.test.ts`, `components/trace-causality.test.tsx` |

## Gaps Closed

| Previous Gap                                                                             | Closure                                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Live traces had richer runtime context than historical ClickHouse replay.                | Causal fields are now persisted in EventStore data and rehydrated from ClickHouse rows.        |
| Trace UI listed events but did not expose why a step happened.                           | Studio now shows phase, reason, agent run, decision ID, cause event, and missing-cause status. |
| Selected event metadata favored payload-only fields and missed top-level runtime fields. | Metadata tab now reads top-level trace fields before payload mirrors.                          |
| Analytics trace explorer normalized span fields but dropped causal fields.               | `normalizeSessionTrace()` preserves every causal field for historical traces.                  |

## Residual Risk

| Risk                                                                            | Current Mitigation                                                                                         | Follow-Up                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Older sessions do not have causal fields.                                       | Studio components render nothing when causal metadata is absent and continue showing raw traces.           | Optional backfill is not required for correctness.                             |
| `causeEventId` fallback is linear when emitters do not provide explicit causes. | Explicit emitter fields win; missing cause links are surfaced in Studio instead of hidden.                 | Add emitter-specific causes for high-value decisions as runtime logic matures. |
| Causal fields are operational metadata and may be copied into raw JSON views.   | Values are IDs/reason codes only; tenant IDs are not added to live callback payloads by the causal helper. | Keep user-message content out of `reasonCode`.                                 |

## Verification

| Command                                                                                                                                                                                                                                                                         | Result                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @agent-platform/runtime build`                                                                                                                                                                                                                                   | Passed                                                   |
| `pnpm exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/services/trace-causal-envelope.test.ts src/__tests__/services/clickhouse-session-trace-events.test.ts src/__tests__/observability/known-source-platform-events.test.ts`                       | Passed, 15 tests                                         |
| `pnpm --filter @agent-platform/studio build`                                                                                                                                                                                                                                    | Passed with existing dependency dynamic-require warnings |
| `pnpm exec vitest run --config vitest.config.ts src/__tests__/trace-causality-parity.test.ts src/__tests__/trace-causality.test.ts src/__tests__/trace-event-adapter.test.ts src/__tests__/components/trace-causality.test.tsx src/__tests__/components/session-pages.test.tsx` | Passed, 40 tests                                         |
