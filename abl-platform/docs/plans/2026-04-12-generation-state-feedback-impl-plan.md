# LLD: Generation State Feedback

**Design Doc**: `docs/arch/design/2026-04-12-generation-state-feedback-design.md` (v4, 3 review rounds)
**Parent Feature Spec**: `docs/features/live-thinking-visibility.md` (B05 — BETA)
**Parent Test Spec**: `docs/testing/live-thinking-visibility.md`
**Status**: DRAFT
**Date**: 2026-04-12

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                        | Rationale                                                                                     | Alternatives Rejected                                                  |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D-1 | Use `onFinish` for Calls #2/#3, `try/finally` + `result.totalUsage` for Call #1 | Call #1 is a generator consumed by `executeMultiTurn` — `onFinish` never fires on early break | Single `onFinish` approach everywhere — unreliable for generators      |
| D-2 | Use SDK `totalUsage` (aggregate), not `usage` (last-step)                       | Multi-step tool loops (BUILD agent, onboarding) undercount with last-step only                | `usage` field — only valid for single-step calls                       |
| D-3 | Turn-scoped accumulator on `VercelLLMStreamClient`                              | `executeMultiTurn` re-invokes LLM N times; need sum not snapshot                              | Per-invocation snapshot — loses prior calls                            |
| D-4 | Message-scoped `completion?` on `ChatMessage`                                   | Stable across widget turns, resume/refresh, multi-message sessions                            | Top-level singleton state — brittle, loses context on widget interrupt |
| D-5 | Normalize usage with `?? 0` everywhere                                          | SDK models `inputTokens`/`outputTokens` as `number \| undefined`; `NaN` breaks Zod parse      | Loosen Zod schema — would propagate bad data                           |
| D-6 | BUILD tokens via `BuildProgressCard` + store, not `BuildCompleteCard` widget    | Widget schema chain is 4+ files deep; `BuildProgressCard` already reads store                 | Extend `BuildCompleteInput` — too much churn for v1                    |
| D-7 | Sanitized model display label                                                   | Raw IDs could leak tenant deployment names                                                    | Raw model ID — privacy risk                                            |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/types/sse-events.ts — NEW schema
export const CompletionMetaSchema = z.object({
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }),
  finishReason: z.string(),
  stepCount: z.number(),
  latencyMs: z.number(),
  model: z.string(), // sanitized display label
});
export type CompletionMeta = z.infer<typeof CompletionMetaSchema>;

// apps/studio/src/hooks/useArchChat.ts — EXTENDED
export interface ChatMessage {
  // ... existing fields ...
  completion?: CompletionMeta;
}
```

### Module Boundaries

| Module                                                            | Responsibility                           | Depends On                              |
| ----------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| `packages/arch-ai/src/types/sse-events.ts`                        | Zod schemas for SSE events               | zod                                     |
| `packages/arch-ai/src/streaming/activity-emitter.ts`              | Emit structured activity SSE events      | sse-events types                        |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                | 3 `streamText()` calls + SSE emission    | arch-ai types, activity-emitter, ai SDK |
| `apps/studio/src/hooks/useArchChat.ts`                            | Parse SSE stream, manage chat state      | arch-ai types                           |
| `apps/studio/src/store/arch-ai-store.ts`                          | Store per-agent build stages + usage     | —                                       |
| `apps/studio/src/components/arch-v3/chat/CompletionIndicator.tsx` | Render completion telemetry              | —                                       |
| `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`   | Render per-agent build progress + tokens | arch-ai-store                           |

---

## 2. File-Level Change Map

### New Files

| File                                                              | Purpose                                                           | LOC Estimate |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| `apps/studio/src/components/arch-v3/chat/CompletionIndicator.tsx` | Renders `{latency} · {tokens} · {model}` below assistant messages | ~40          |

### Modified Files

| File                                                            | Change Description                                                                                                                                                    | Risk |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/arch-ai/src/types/sse-events.ts`                      | Add `CompletionMetaSchema`, extend `DoneEventSchema`, extend `BuildAgentCompiledEventSchema`                                                                          | Low  |
| `packages/arch-ai/src/types/index.ts`                           | Export `CompletionMeta`, `CompletionMetaSchema`                                                                                                                       | Low  |
| `packages/arch-ai/src/streaming/activity-emitter.ts`            | Add `step()` method                                                                                                                                                   | Low  |
| `apps/studio/src/app/api/arch-ai/message/route.ts`              | Add `onFinish`/`onStepFinish` to 3 `streamText()` calls; turn accumulator on `VercelLLMStreamClient`; `sanitizeModelId`; enrich `done` + `build_agent_compiled` emits | High |
| `apps/studio/src/hooks/useArchChat.ts`                          | Add `completion?` to `ChatMessage`; parse enriched `done` and `build_agent_compiled`                                                                                  | Med  |
| `apps/studio/src/store/arch-ai-store.ts`                        | Add per-agent `usage` to build state                                                                                                                                  | Low  |
| `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx` | Read per-agent `usage` from store, display token counts                                                                                                               | Low  |
| `apps/studio/src/app/arch/page.tsx`                             | Render `CompletionIndicator` per assistant message                                                                                                                    | Low  |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`    | Render `CompletionIndicator` per assistant message (in-project surface)                                                                                               | Low  |

---

## 3. Implementation Phases

### Phase 1: Schema + ActivityEmitter (types layer)

**Goal**: Define the `CompletionMeta` Zod schema, extend `DoneEventSchema` and `BuildAgentCompiledEventSchema`, add `step()` to `ActivityEmitter`. No runtime behavior change.

**Tasks**:

1.1. Add `CompletionMetaSchema` to `packages/arch-ai/src/types/sse-events.ts`
1.2. Extend `DoneEventSchema` with optional `completion: CompletionMetaSchema.optional()`
1.3. Extend `BuildAgentCompiledEventSchema` with optional `usage`, `finishReason`, `stepCount` fields
1.4. Export `CompletionMeta` type and `CompletionMetaSchema` from `packages/arch-ai/src/types/index.ts`
1.5. Add `step()` method to `ActivityEmitter` in `packages/arch-ai/src/streaming/activity-emitter.ts`

**Files Touched**:

- `packages/arch-ai/src/types/sse-events.ts` — add schemas
- `packages/arch-ai/src/types/index.ts` — add exports
- `packages/arch-ai/src/streaming/activity-emitter.ts` — add `step()` method

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] `CompletionMetaSchema.parse({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop', stepCount: 1, latencyMs: 100, model: 'test' })` succeeds
- [ ] `DoneEventSchema.parse({ type: 'done', completion: { ... } })` succeeds
- [ ] `DoneEventSchema.parse({ type: 'done' })` still succeeds (backward compat)
- [ ] `BuildAgentCompiledEventSchema.parse({ ..., usage: undefined })` still succeeds
- [ ] `ActivityEmitter` has `step()` method callable without error
- [ ] Existing tests in `packages/arch-ai` still pass

**Test Strategy**:

- Unit: Zod schema parse/reject tests for new fields, `ActivityEmitter.step()` emits correct event shape

**Rollback**: Revert the 3 files — no runtime impact, no consumers yet.

---

### Phase 2: Server — `onFinish`/`onStepFinish` on Calls #2 and #3

**Goal**: Add completion capture to the two direct-loop `streamText()` calls (build agent + onboarding). Enrich their `done` and `build_agent_compiled` emits. Add `sanitizeModelId()`.

**Tasks**:

2.1. Add `sanitizeModelId()` helper function at top of `route.ts` (or in a small utility)
2.2. Add `onFinish` with `totalUsage` + `?? 0` normalization to build agent `streamText()` (~L3642). Capture into local `completionMeta`. Include `usage`/`finishReason`/`stepCount` in the `build_agent_compiled` emit.
2.3. Add `onFinish` with `totalUsage` + `?? 0` normalization to onboarding `startStream()` (~L5015). Capture into local `completionMeta`. Reset `completionMeta = null` before each retry attempt in the retry loop.
2.4. Enrich the two LLM-following `emit({ type: 'done' })` sites (~L5439, ~L3350) with `completion: completionMeta ?? undefined`.
2.5. Add `onStepFinish` to onboarding `startStream()` — emit `activity.step()` per step using `stepNumber`, `toolCalls`, `finishReason`.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — modify 2 `streamText()` calls, modify 2 `done` emits, add helper

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Server logs show `LLM generation complete` with `inputTokens`, `outputTokens`, `finishReason`, `latencyMs` on every INTERVIEW/BLUEPRINT/BUILD turn
- [ ] `done` SSE events from onboarding turns include `completion` object in stream output
- [ ] `build_agent_compiled` SSE events include `usage` object
- [ ] `completionMeta` is null after an aborted/failed stream (no `NaN`)
- [ ] Retry loop resets `completionMeta` before each attempt

**Test Strategy**:

- Integration: Send a test message to onboarding session, parse SSE stream, verify `done` event includes `completion` with valid numbers
- Manual: Trigger BUILD, check server logs for per-agent `LLM generation complete`

**Rollback**: Remove callbacks from the 2 `streamText()` calls, remove `completion` from `done` emits. Zero behavioral change to existing flow.

---

### Phase 3: Server — Turn accumulator on `VercelLLMStreamClient` (Call #1)

**Goal**: Add turn-scoped completion accumulation to Call #1 (`VercelLLMStreamClient`). Handle early-break via `try/finally` + stream drain. Enrich the route-owned `done` for in-project turns.

**Tasks**:

3.1. Add private turn-level accumulators to `VercelLLMStreamClient`: `_turnUsage`, `_turnStepCount`, `_turnStartMs`, `_turnFinishReason`, `_invocationCount`.
3.2. Add `resetTurn()` method (resets all accumulators, sets `_turnStartMs = Date.now()`).
3.3. Add `get turnCompletionMeta(): CompletionMeta` getter (returns accumulated snapshot with `sanitizeModelId`).
3.4. Wrap the `for await (... of result.fullStream)` in `try/finally`. In `finally`: drain `result.totalUsage`/`result.finishReason`/`result.steps`, normalize with `?? 0`, accumulate into turn counters. Catch `AbortError` in `finally` to avoid crash on abort.
3.5. In `processInProjectMessage()` (or wherever `executeMultiTurn` is called for in-project): call `llmClient.resetTurn()` before, read `llmClient.turnCompletionMeta` after, include in the route-owned `done` emit.

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — modify `VercelLLMStreamClient` class, modify in-project `done` emit

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] In-project `done` SSE events include `completion` object with accumulated usage
- [ ] A 2-invocation server-side-tool loop produces `turnCompletionMeta.usage` that is the sum of both invocations
- [ ] When `executeSpecialistTurn` returns `awaiting_tool_result`, the `finally` block still drains and accumulates (no crash, no `NaN`)
- [ ] Aborting mid-stream does not crash — `finally` catches `AbortError`
- [ ] Server logs show per-invocation accumulation

**Test Strategy**:

- Integration: Simulate a multi-tool in-project turn, verify `done` event's `completion.usage.totalTokens` > any single invocation's tokens
- Integration: Simulate a client-side tool break, verify `finally` completes without error

**Rollback**: Remove accumulator fields and `try/finally` from `VercelLLMStreamClient`, remove `completion` from in-project `done` emit. Reverts to current behavior.

---

### Phase 4: Client — Parse completion + CompletionIndicator

**Goal**: Parse enriched SSE events in `useArchChat`, attach to `ChatMessage`, render `CompletionIndicator` in both onboarding and in-project surfaces.

**Tasks**:

4.1. Add `completion?: CompletionMeta` to `ChatMessage` interface in `useArchChat.ts`.
4.2. In the `done` SSE handler: extract `doneData.completion`, attach to last streaming assistant message alongside `isStreaming: false`.
4.3. In the `build_agent_compiled` SSE handler: extract `usage` from event, call `useArchAIStore.getState().setAgentUsage(event.agent, event.usage)` (new store action — see 4.5).
4.4. Create `CompletionIndicator.tsx` component — renders `{latency} · {tokens} · {model}` right-aligned, muted, below message content. Handles missing/zero fields. Hidden when `completion` is undefined.
4.5. Add `agentUsage: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }>` to `arch-ai-store.ts` with `setAgentUsage()` action. Reset in `clearBuildStages()`.
4.6. In `BuildProgressCard.tsx`: read `agentUsage[agentName]` from store, display token count next to elapsed time.
4.7. In `arch/page.tsx`: render `<CompletionIndicator completion={msg.completion} />` for each assistant message.
4.8. In `ArchOverlay.tsx`: render `<CompletionIndicator completion={msg.completion} />` for each assistant message (in-project surface).

**Files Touched**:

- `apps/studio/src/hooks/useArchChat.ts` — extend `ChatMessage`, modify `done`/`build_agent_compiled` handlers
- `apps/studio/src/components/arch-v3/chat/CompletionIndicator.tsx` — **NEW**
- `apps/studio/src/store/arch-ai-store.ts` — add `agentUsage` + `setAgentUsage()`
- `apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx` — display tokens
- `apps/studio/src/app/arch/page.tsx` — wire CompletionIndicator
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — wire CompletionIndicator

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] After an INTERVIEW turn, the assistant message shows `CompletionIndicator` with latency + tokens + model
- [ ] After a BUILD phase, `BuildProgressCard` shows per-agent token counts
- [ ] In-project overlay shows `CompletionIndicator` on assistant messages
- [ ] Widget-pending turns show no `CompletionIndicator` (completion is undefined)
- [ ] Aborted turns show no `CompletionIndicator`
- [ ] Missing usage (all zeros) hides the indicator gracefully

**Test Strategy**:

- Unit: `CompletionIndicator` renders correctly with various props (full data, missing fields, zeros, undefined)
- Manual: Full smoke test across INTERVIEW, BUILD, in-project, abort

**Rollback**: Remove `completion` from `ChatMessage`, remove `CompletionIndicator` imports and renders. Revert store changes. UI returns to current state.

---

## 4. Wiring Checklist

- [ ] `CompletionMetaSchema` exported from `packages/arch-ai/src/types/sse-events.ts`
- [ ] `CompletionMeta` type exported from `packages/arch-ai/src/types/index.ts`
- [ ] `CompletionMetaSchema` used in `DoneEventSchema` and `BuildAgentCompiledEventSchema`
- [ ] `ActivityEmitter.step()` callable from `onStepFinish` callbacks in route
- [ ] `sanitizeModelId()` used in all 3 completion capture paths
- [ ] `VercelLLMStreamClient.resetTurn()` called before `executeMultiTurn`
- [ ] `VercelLLMStreamClient.turnCompletionMeta` read after `executeMultiTurn`
- [ ] `completion` field included in all LLM-following `done` emits (2 sites)
- [ ] `usage`/`finishReason`/`stepCount` fields included in `build_agent_compiled` emits
- [ ] `CompletionIndicator` imported and rendered in `arch/page.tsx`
- [ ] `CompletionIndicator` imported and rendered in `ArchOverlay.tsx`
- [ ] `setAgentUsage()` action added to `arch-ai-store` and called from `useArchChat` `build_agent_compiled` handler
- [ ] `agentUsage` read in `BuildProgressCard` and displayed

---

## 5. Cross-Phase Concerns

### Database Migrations

None. All data is ephemeral — flows through SSE events and client-side state. No persistence.

### Feature Flags

None. All changes are additive and backward-compatible (optional Zod fields, new component only renders when data exists).

### Configuration Changes

None. No new env vars.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] INTERVIEW turn shows completion indicator (latency + tokens + model)
- [ ] BUILD phase shows per-agent token counts in BuildProgressCard
- [ ] In-project turns show completion indicator in ArchOverlay
- [ ] Aborted/failed turns show no indicator (no NaN, no crash)
- [ ] Provider that omits usage produces zeros, not NaN
- [ ] Widget-pending turns show no indicator
- [ ] `pnpm build` succeeds across all affected packages
- [ ] No regressions in existing `packages/arch-ai` tests
- [ ] Smoke tests pass (5 checks from design doc §8)

---

## 7. Open Questions

None remaining — all 19 findings from 3 review rounds resolved in design doc v4.
