# Feature Test Guide: Observatory Session Debugger

**Feature**: Studio Observatory session debugging — live/replay ingestion, span lifecycle, selection, trace tree, and detail rendering
**Owner**: Studio team / Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/sub-features/observatory-session-debugger.md](../../features/sub-features/observatory-session-debugger.md)
**First tested**: 2026-03-22
**Last updated**: 2026-03-22
**Overall status**: PARTIAL

---

## Current State (as of 2026-03-22 — Iteration 1)

The Observatory groundwork is materially stronger than it was on 2026-03-18, but the full redesign is not implemented yet. The current passing coverage proves the boundary normalization seam, live ingestion correctness, and core span lifecycle behavior. The broader UI cleanup still needs dedicated coverage for unified selection, shared metrics, single-detail rendering, and visible-only keyboard navigation.

The current verified baseline is **41 passing Observatory-path tests**:

- 18 tests: live ingestion + canonical trace event adaptation + span end handling
- 6 tests: Observatory span lifecycle store invariants
- 17 tests: end-to-end Observatory trace flow

### Quick Health Dashboard

| Area                                           | Status     | Last Verified | Notes                                                                                    |
| ---------------------------------------------- | ---------- | ------------- | ---------------------------------------------------------------------------------------- |
| Canonical top-level trace ID normalization     | PASS       | 2026-03-22    | Live and replay ingestion prefer top-level `traceId` / `spanId` / `parentSpanId`         |
| Live Observatory ingestion seam                | PASS       | 2026-03-22    | `live-trace-event-ingestion.ts` routes live trace events through the shared adapter      |
| Replay normalization parity                    | PASS       | 2026-03-22    | Replay path uses the same adapter as live ingestion                                      |
| Span end handling                              | PASS       | 2026-03-22    | Explicit `span_end` path verified                                                        |
| Span lifecycle store invariants                | PASS       | 2026-03-22    | Node-config suite proves basic agent/step lifecycle behavior                             |
| End-to-end Observatory trace flow              | PASS       | 2026-03-22    | Node-config integration suite passes                                                     |
| Studio split test runner for pure logic suites | PASS       | 2026-03-22    | Default `test` path no longer routes these suites through the flaky full `happy-dom` run |
| Unified selection model                        | NOT TESTED | —             | Redesign not implemented yet                                                             |
| Shared metric selector parity                  | NOT TESTED | —             | Redesign not implemented yet                                                             |
| Single detail surface behavior                 | NOT TESTED | —             | Current UI still renders dual detail surfaces                                            |
| Visible-only keyboard navigation               | NOT TESTED | —             | Current tree still flattens collapsed descendants                                        |

---

## Audit Scope

This guide covers the Studio-side Observatory session debugger:

- trace event normalization at the UI boundary
- live trace ingestion through WebSocket handling
- replay hydration into Observatory state
- span lifecycle bookkeeping and parent/child hierarchy correctness
- Traces tab interaction model and the planned redesign coverage needed to make it trustworthy

It does not attempt to re-audit the entire platform tracing pipeline; that remains covered by the parent tracing guide.

---

## Coverage Goals

This sub-feature is meaningfully covered when the repo proves all of the following:

- live and replay ingestion produce the same normalized event model for the same trace payload
- deterministic span lifecycle indexes close the correct agent and step spans under concurrency
- one feature store owns Observatory events, spans, and selection without duplicated state drift
- tree, summary bar, and detail panel all read the same selector-derived metrics
- keyboard navigation and detail rendering match what is visible on screen

---

## Test Coverage Map

### Current Automated Coverage

- [x] `apps/studio/src/__tests__/trace-event-adapter.test.ts`
  - canonical top-level IDs win over mirrored payload fields
  - fallback fields remain supported for older payload shapes
  - replay hierarchy preserves parent/child span relationships

- [x] `apps/studio/src/__tests__/live-trace-event-ingestion.test.ts`
  - live ingestion preserves canonical top-level IDs
  - live path and Observatory path stay aligned

- [x] `apps/studio/src/__tests__/observatory-span-end.test.ts`
  - explicit `span_end` events close the intended span

- [x] `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts`
  - current store lifecycle invariants for agent and step spans
  - executed with `vitest.node.config.ts`

- [x] `apps/studio/src/__tests__/e2e/observatory-trace-flow.test.ts`
  - end-to-end Observatory trace flow
  - executed with `vitest.node.config.ts`

- [x] `apps/studio/src/__tests__/run-tests-plan.test.ts`
  - split test runner routes pure logic/store suites away from the flaky full browser harness

### Required Redesign Coverage

- [ ] `apps/studio/src/features/observatory/__tests__/selection-state.test.ts`
  - prove spans, events, and execution-tree node selection do not share one overloaded ID field

- [ ] `apps/studio/src/features/observatory/__tests__/metric-selectors.test.ts`
  - prove summary bar, tree rows, and detail panel use identical selector-derived LLM metrics

- [ ] `apps/studio/src/features/observatory/__tests__/span-registry.test.ts`
  - prove concurrent agents and repeated step names close the correct spans

- [ ] `apps/studio/src/components/observatory/__tests__/traces-tab-layout.test.tsx`
  - prove only one detail surface appears for a span selection

- [ ] `apps/studio/src/components/observatory/__tests__/span-tree-keyboard.test.tsx`
  - prove keyboard navigation skips collapsed descendants and re-homes hidden selections

- [ ] `apps/studio/src/components/session/__tests__/session-debug-selection-bridge.test.tsx`
  - prove overview/execution-tree selection no longer opens wrong or blank span detail

---

## Verification Commands

Run build before tests. Turbo enforces build order, and Studio tests are more reliable against fresh compiled output.

```bash
pnpm build --filter=@agent-platform/studio
pnpm --filter @agent-platform/studio test -- --run src/__tests__/live-trace-event-ingestion.test.ts src/__tests__/trace-event-adapter.test.ts src/__tests__/observatory-span-end.test.ts
pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/store/__tests__/observatory-span-lifecycle.test.ts
pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/__tests__/e2e/observatory-trace-flow.test.ts
```

### Why These Commands

- `pnpm --filter @agent-platform/studio test` uses the split runner, which keeps pure logic/store suites out of the flaky default full `happy-dom` path.
- `vitest.node.config.ts` is the correct harness for store and end-to-end logic suites that do not need a browser DOM.
- `test:full` remains useful for intentional component/browser coverage, but it is not the right default for pure Observatory state tests.

---

## Open Gaps

- **GAP-001**: Unified selection behavior is still untested
  - **Severity**: High
  - **Reason**: redesign not implemented yet

- **GAP-002**: Metric parity across summary/tree/detail is still untested
  - **Severity**: High
  - **Reason**: current UI still has duplicated aggregation logic

- **GAP-003**: Single-detail-surface UX is still untested
  - **Severity**: Medium
  - **Reason**: current Traces tab still renders both inline and docked detail surfaces

- **GAP-004**: Keyboard navigation on collapsed nodes is still untested
  - **Severity**: Medium
  - **Reason**: current tree behavior is known-bad and redesign work is pending

---

## Recommended Test Checklist For The Redesign

1. Add or update node/light tests first for normalization, span registry, selection state, and metric selectors.
2. Add focused component tests for tree navigation and detail-panel behavior after the new selector layer lands.
3. Keep live and replay fixture parity tests so the same event stream proves the same tree and metrics.
4. Verify `clearSession` or equivalent reset behavior clears spans, events, selection, and lifecycle indexes together.
5. Run one manual smoke pass in Studio with:
   - nested agent spans
   - repeated step names
   - collapsed tree branches
   - both live and replay views of the same session

---

## Iteration Log

### Iteration 1 — 2026-03-22

**Scope**: Verify the normalization groundwork and current Observatory lifecycle seams before the larger UI/state refactor
**Branch**: develop
**Tested by**: Codex

#### Results

| Command                                                                                                                                                                                    | Result       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `pnpm build --filter=@agent-platform/studio`                                                                                                                                               | PASS         |
| `pnpm --filter @agent-platform/studio test -- --run src/__tests__/live-trace-event-ingestion.test.ts src/__tests__/trace-event-adapter.test.ts src/__tests__/observatory-span-end.test.ts` | PASS (18/18) |
| `pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/store/__tests__/observatory-span-lifecycle.test.ts`                                                                | PASS (6/6)   |
| `pnpm -C apps/studio exec vitest run --config vitest.node.config.ts src/__tests__/e2e/observatory-trace-flow.test.ts`                                                                      | PASS (17/17) |

#### Key Findings

- Canonical top-level IDs are now preserved in both live and replay paths.
- The current Observatory lifecycle seams are testable through node/light harnesses.
- The remaining risk is no longer the normalization boundary; it is the UI architecture above it.

#### Next Coverage Step

Add the selector and component interaction suites described in the "Required Redesign Coverage" section as the architectural refactor lands.
