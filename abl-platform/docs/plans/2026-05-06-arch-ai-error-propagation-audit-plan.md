# Arch AI Error Propagation Audit and Implementation Plan

**Status:** Draft  
**Date:** 2026-05-06  
**Scope:** Arch AI error propagation across Studio Arch UI, Arch engine, model invocation, chat templates, Knowledge/SearchAI, API routes, SSE, and database resume state.

## Goal

Make Arch AI failures observable, durable, and useful at the right surface:

- Studio Arch UI shows a stable, sanitized, actionable error with code, short message, recovery action, and copyable diagnostic context.
- Backend logs and traces keep full raw context for operators.
- Model, knowledge, API, SSE, and database layers preserve structured error codes instead of flattening into generic messages.
- Reconnect, resume, and session refresh do not erase the last meaningful failure.

## Non-Goals

- Do not expose tenant IDs, credential hints, raw model IDs, provider secrets, or internal remediation text in user-visible UI.
- Do not redesign all Arch UI status rendering.
- Do not migrate every runtime or SearchAI error route in one pass; this plan prioritizes Arch AI flows first.

## Root Cause Summary

Arch AI currently has multiple independent error contracts:

1. HTTP APIs return several error envelope shapes.
2. V4 turn events use nested `error`.
3. Legacy SSE events use top-level `code`, `message`, and `retryable`.
4. Studio Arch UI stores only a transient `ArchError`.
5. Session snapshots do not carry the last terminal error.
6. Some model and knowledge errors are intentionally downgraded or silently skipped.

The result is that failures may be correctly detected at the source but lose code, detail, or durability before reaching the user.

## Consolidated Issue List

| ID   | Priority | Area                        | Issue                                                                                        | Impact                                                                                                           | Evidence                                                                                                                                                                                 |
| ---- | -------- | --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-01 | P0       | Studio Arch UI              | `streamPost()` clears `error: null` before every request.                                    | A visible error can disappear immediately on retry, send, continue, or tool answer.                              | `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                                                                                 |
| E-02 | P0       | Studio Arch UI              | Session snapshot loading always sets `error: null`.                                          | `refreshSession()` or reconnect snapshot can erase a real terminal error.                                        | `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                                                                                 |
| E-03 | P0       | Studio Arch UI              | Non-OK `/api/arch-ai/message` responses do not parse JSON error bodies.                      | Specific backend codes become `Request failed: 500` or an empty status text.                                     | `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                                                                                 |
| E-04 | P0       | Studio Arch UI              | V4 and legacy error dispatchers drop `code`, request ID, status, and details.                | UI cannot show or copy useful diagnostics even when backend sent them.                                           | `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`, `apps/studio/src/lib/arch-ai/ui/types.ts`                                                                                          |
| E-05 | P0       | Studio Arch UI              | SSE reconnect failures are log-only.                                                         | Live stream failure, max retries, snapshot fallback failure, or non-OK reconnect can fail invisibly.             | `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                                                                                 |
| E-06 | P1       | Studio Arch UI              | Malformed SSE frames are silently skipped.                                                   | A malformed error event can vanish without a visible parse diagnostic.                                           | `apps/studio/src/lib/arch-ai/ui/event-parser.ts`, `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                               |
| E-07 | P1       | Studio Arch UI              | Error toast truncates message and auto-dismisses some recoverable errors after 8 seconds.    | User sees a brief banner with no details, then loses it.                                                         | `apps/studio/src/lib/arch-ai/components/arch/chat/ChatStatusMessage.tsx`                                                                                                                 |
| E-08 | P1       | Studio Arch UI              | Full-page and inline renderers show only `error.message`.                                    | `technicalDetails` is effectively unused; no code badge or details disclosure.                                   | `apps/studio/src/app/arch/page.tsx`                                                                                                                                                      |
| E-09 | P1       | Studio Arch UI              | Some direct Arch UI actions ignore non-OK responses.                                         | User actions can fail and then refresh the session as if they succeeded.                                         | `apps/studio/src/app/arch/page.tsx`                                                                                                                                                      |
| E-10 | P0       | Database / Resume           | Arch session schema has no durable `lastError` or terminal failure summary.                  | Reload/reconnect cannot reconstruct why the last turn failed.                                                    | `packages/arch-ai/src/models/arch-session.model.ts`                                                                                                                                      |
| E-11 | P0       | Engine / SSE                | Model stream creation and iteration failures are live-only except `turn_ended.reason`.       | Reconnect loses the error code/message/retryability.                                                             | `packages/arch-ai/src/engine/turn-engine.ts`                                                                                                                                             |
| E-12 | P0       | Engine / SSE                | `MODEL_TOOL_PROTOCOL_ERROR` is emitted live-only.                                            | Incompatible model/tool-call output is not durable.                                                              | `packages/arch-ai/src/engine/turn-engine.ts`                                                                                                                                             |
| E-13 | P1       | Event Contracts             | Legacy SSE and V4 turn events have different error shapes.                                   | Client reducers must handle two protocols and still lose fields.                                                 | `packages/arch-ai/src/types/sse-events.ts`, `packages/arch-ai/src/types/turn-events.ts`                                                                                                  |
| E-14 | P1       | Model Resolution            | Model resolution errors collapse to generic model config errors.                             | User cannot distinguish missing credential, unsupported model, disabled provider, quota, or policy denial.       | `apps/studio/src/lib/arch-ai/engine-factory.ts`                                                                                                                                          |
| E-15 | P1       | Model Invocation            | Provider stream errors are coarsely classified.                                              | Schema/tool incompatibility, invalid request, and response-format mismatch fall into unknown/generic buckets.    | `packages/arch-ai/src/engine/error-classifier.ts`                                                                                                                                        |
| E-16 | P1       | Model Output                | Misaligned model tool-call fields become tool validation errors.                             | Root cause is presented as a tool failure instead of model-output protocol failure.                              | `apps/studio/src/lib/arch-ai/engine-factory.ts`, `packages/arch-ai/src/engine/tool-invoker.ts`                                                                                           |
| E-17 | P1       | Chat Templates / Multimodal | Prompt/context builders do not receive resolved model capabilities.                          | Non-vision or small-context models can receive incompatible attachments/context without a clear preflight error. | `apps/studio/src/lib/arch-ai/helpers/build-llm-messages.ts`, `apps/studio/src/lib/arch-ai/processors/process-message.ts`, `apps/studio/src/lib/arch-ai/processors/process-in-project.ts` |
| E-18 | P2       | Chat Templates / Multimodal | Unsupported content blocks can be dropped or converted into prompt text.                     | Data loss appears as weak model output rather than explicit incompatibility.                                     | `apps/studio/src/lib/arch-ai/vercel-message-adapter.ts`, `packages/arch-ai/src/executor/content-block-resolver.ts`                                                                       |
| E-19 | P1       | Knowledge / SearchAI        | Query Intelligence model resolver degrades to static search and caches `NO_MODEL`.           | Knowledge answers may silently lose LLM behavior; UI sees only low-detail metrics.                               | `apps/search-ai-runtime/src/services/query-llm-resolver.ts`, `apps/search-ai-runtime/src/routes/shared-pipeline.ts`                                                                      |
| E-20 | P1       | Knowledge / SearchAI        | Knowledge health can report LLM configured while per-index resolution failed.                | Arch can claim health is fine while query/model failures continue.                                               | `apps/search-ai/src/routes/knowledge-bases.ts`                                                                                                                                           |
| E-21 | P1       | Knowledge / API             | KB health request uses `knowledgeBaseId`, but SearchAI admin errors route expects `indexId`. | Error lookup can be empty, wrong, or tenant-wide depending route behavior.                                       | `apps/studio/src/lib/arch-ai/tools/kb-health.ts`, `apps/search-ai/src/routes`                                                                                                            |
| E-22 | P1       | Cache Invalidation          | Runtime and query LLM model-cache invalidation failures are warning-only or fire-and-forget. | Successful config changes can still use stale model state.                                                       | `apps/studio/src/lib/runtime-model-cache-invalidation.ts`, `apps/search-ai/src/routes/indexes.ts`                                                                                        |
| E-23 | P1       | API Envelopes               | Error envelopes differ across Studio proxy, SearchAI, SearchAI Runtime, and Arch tools.      | Downstream consumers flatten or misclassify errors.                                                              | `apps/studio/src/lib/search-ai-proxy.ts`, `apps/search-ai/src/routes/indexes.ts`, `apps/search-ai-runtime/src/routes/query.ts`                                                           |
| E-24 | P2       | Build Flow                  | Build-agent errors are not restored from durable metadata.                                   | Build progress can resume without original errors/warnings.                                                      | `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`, `packages/arch-ai/src/session/session-service.ts`                                                                                   |

## Target Error Contract

Introduce one Arch-facing structured error shape and adapt every boundary into it.

```ts
interface ArchStructuredError {
  code: string;
  message: string;
  category:
    | 'model'
    | 'tool'
    | 'knowledge'
    | 'api'
    | 'session'
    | 'stream'
    | 'validation'
    | 'auth'
    | 'infra'
    | 'unknown';
  recoverable: boolean;
  userAction?:
    | 'retry'
    | 'configure_model'
    | 'configure_credentials'
    | 'start_fresh'
    | 'contact_support';
  details?: string;
  requestId?: string;
  traceId?: string;
  occurredAt: string;
  source: 'http' | 'sse' | 'engine' | 'model' | 'knowledge' | 'db' | 'ui';
}
```

User-visible rendering must use sanitized `message`, `code`, `category`, and `userAction`. Raw provider details, tenant IDs, credential hints, model IDs, and stack traces stay in logs/traces.

## Propagation Matrix

| Layer                          | Required Behavior                                                                                                            | Current Gap                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Model resolution               | Emit specific structured errors for auth, policy, unsupported model, quota, invalid provider, budget, and disabled provider. | Generic model config error.                                        |
| Model invocation               | Classify stream creation, stream iteration, bad request, tool protocol, response format, and provider-specific failures.     | Unknown/generic classification for many failures.                  |
| Chat template / prompt builder | Preflight model capabilities before content conversion.                                                                      | Capability defaults can mask incompatible attachments/context.     |
| Engine events                  | Emit and persist structured `error` event before terminal turn end.                                                          | Several failures are live-only.                                    |
| API routes                     | Return a single error envelope with code/message/recoverable/details/requestId.                                              | Multiple envelope shapes.                                          |
| SSE parser                     | Parse both V4 and compatibility shapes into `ArchStructuredError`; surface parse failures.                                   | Malformed frames silently skipped.                                 |
| Studio store                   | Keep `currentError` and `lastError` separate from transient status.                                                          | Single transient `error` field is cleared by stream and snapshots. |
| Studio UI                      | Render code badge, stable message, action, and details disclosure/copy.                                                      | Message-only, truncated, sometimes auto-dismissed.                 |
| Database                       | Persist last terminal error and last failed turn summary.                                                                    | No durable error field.                                            |
| Knowledge/SearchAI             | Preserve query LLM resolution failure and index-specific health errors.                                                      | Silent static fallback and ID mismatch.                            |

## Implementation Plan

### Phase 0: Test Harness and Fixtures

**Goal:** Capture the disappearing-error behavior before changing logic.

Files:

- `apps/studio/src/lib/arch-ai/ui/__tests__/hook-error-state.test.ts`
- `apps/studio/src/lib/arch-ai/ui/__tests__/event-dispatcher-error.test.ts`
- `apps/studio/src/lib/arch-ai/ui/__tests__/event-parser-error.test.ts`

Tasks:

- Add tests proving non-OK POST body details are currently lost.
- Add tests for error cleared by `streamPost()` and snapshot load.
- Add tests for V4 nested error and legacy top-level error normalization.
- Add test for malformed SSE frame producing a visible parse error or diagnostic counter.

Exit criteria:

- Tests fail on current behavior.
- Tests use local reducers/helpers where possible; browser E2E can be added after the contract lands.

### Phase 1: Studio Arch UI Structured Error Foundation

**Goal:** Stop dropping details in the Arch UI.

Files:

- `apps/studio/src/lib/arch-ai/ui/types.ts`
- `apps/studio/src/lib/arch-ai/ui/error-normalizer.ts` (new)
- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`
- `apps/studio/src/lib/arch-ai/ui/session-api.ts`
- `apps/studio/src/lib/arch-ai/ui/hook.ts`

Tasks:

- Extend `ArchError` with `code`, `category`, `requestId`, `traceId`, `details`, `source`, and `occurredAt`.
- Add `normalizeArchError(input, fallback)` for HTTP, V4 SSE, legacy SSE, unknown thrown errors, and parse failures.
- Parse JSON error bodies for non-OK `postMessage()`, `createSession()`, `fetchCurrentSession()`, and archive/session helpers.
- Preserve error code/details in both V4 and legacy dispatch paths.
- Return or throw structured errors from `streamPost()` so page-level callers do not immediately refresh over a failed send.

Exit criteria:

- A backend `MODEL_CONFIG_ERROR` arrives in Studio with code, message, recoverable flag, and source.
- Non-OK HTTP body details beat `statusText`.
- Legacy and V4 error events normalize to the same UI shape.

### Phase 2: Prevent Error Disappearing in Arch UI

**Goal:** Make Arch UI errors stable until superseded or dismissed.

Files:

- `apps/studio/src/lib/arch-ai/ui/store.ts`
- `apps/studio/src/lib/arch-ai/ui/hook.ts`
- `apps/studio/src/app/arch/page.tsx`
- `apps/studio/src/lib/arch-ai/components/arch/chat/ChatStatusMessage.tsx`

Tasks:

- Split UI state into `currentError` and `lastError`, or keep `error` plus explicit `errorDismissedAt`.
- Do not clear existing error at stream start until the first valid response event arrives.
- Do not clear terminal errors during snapshot load unless snapshot contains a newer successful turn.
- Prevent `refreshSession()` after failed sends/tool answers/create operations.
- Remove auto-dismiss for model/config/session terminal failures. Keep auto-dismiss only for explicitly transient connectivity warnings.
- Replace truncating toast text with a multi-line stable message and a details disclosure/copy control.
- Update `ArchErrorScreen` to accept the structured error, not just a string.

Exit criteria:

- Reproduced model invocation failure remains visible after failed send, reconnect, and refresh.
- User can copy sanitized details containing code, source, timestamp, requestId/traceId when available.
- Error can be manually dismissed without losing `lastError` diagnostics.

### Phase 3: Durable Engine and Database Error State

**Goal:** Reconnect and resume show why the last turn failed.

Files:

- `packages/arch-ai/src/models/arch-session.model.ts`
- `packages/arch-ai/src/session/session-service.ts`
- `packages/arch-ai/src/engine/turn-engine.ts`
- `packages/arch-ai/src/engine/turn-buffer.ts`
- `packages/arch-ai/src/types/turn-events.ts`

Tasks:

- Add durable `metadata.lastError` or first-class `lastError` field to Arch session.
- Persist structured error before `turn_ended(reason: 'error')`.
- Include error summary in resume snapshots.
- Persist `MODEL_TOOL_PROTOCOL_ERROR`, model stream creation errors, model stream iteration errors, pre-engine failures, and build terminal errors.
- Keep raw context in trace events; persist sanitized summary for UI.

Exit criteria:

- Reloading an errored session restores the last error in Studio.
- Reconnecting after ring-buffer loss restores terminal failure from snapshot.
- `turn_ended.reason` is no longer the only durable failure signal.

### Phase 4: Model Error Classification and Compatibility Preflight

**Goal:** Distinguish model misconfiguration, invocation failure, incompatible output, and content incompatibility.

Files:

- `apps/studio/src/lib/arch-ai/engine-factory.ts`
- `apps/studio/src/lib/arch-ai/helpers/build-llm-messages.ts`
- `apps/studio/src/lib/arch-ai/processors/process-message.ts`
- `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`
- `apps/studio/src/lib/arch-ai/vercel-message-adapter.ts`
- `packages/arch-ai/src/engine/error-classifier.ts`
- `packages/arch-ai/src/engine/tool-invoker.ts`
- `packages/arch-ai/src/executor/content-block-resolver.ts`

Tasks:

- Add model-resolution error subcodes: `MODEL_CREDENTIAL_MISSING`, `MODEL_POLICY_DENIED`, `MODEL_UNSUPPORTED`, `MODEL_PROVIDER_DISABLED`, `MODEL_QUOTA_EXCEEDED`, `MODEL_BUDGET_EXCEEDED`.
- Validate provider stream `tool-call` chunks before forwarding to `ToolInvoker`.
- Convert malformed model tool-call output into `MODEL_OUTPUT_PROTOCOL_ERROR`.
- Pass resolved model capabilities into message/history/content builders.
- Preflight attachments and content blocks against resolved model capabilities.
- Surface unsupported content as structured errors or explicit warnings, not silent drops.

Exit criteria:

- Incompatible model output is not reported as a tool argument failure.
- Non-vision model with image attachment fails before invocation with a clear code.
- Provider bad-request/schema failures classify separately from unknown model errors.

### Phase 5: API and SSE Contract Consolidation

**Goal:** One Arch error envelope across HTTP and SSE.

Files:

- `apps/studio/src/app/api/arch-ai/message/route.ts`
- `apps/studio/src/app/api/arch-ai/sessions/**/route.ts`
- `packages/arch-ai/src/types/sse-events.ts`
- `packages/arch-ai/src/types/turn-events.ts`
- `apps/studio/src/lib/arch-ai/message-handler.ts`
- `apps/studio/src/lib/arch-ai/processors/process-message.ts`
- `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`

Tasks:

- Define a canonical `ArchErrorEnvelope`.
- Add compatibility adapters for legacy SSE shape while moving new emissions to canonical shape.
- Ensure route catches return canonical JSON errors.
- Include `requestId` or `traceId` in every route error response.
- Remove or quarantine duplicate ad hoc error builders.

Exit criteria:

- Every Arch AI HTTP route returns the canonical error shape.
- Every Arch SSE error event normalizes without field loss.
- Compatibility tests cover both legacy and V4 shapes.

### Phase 6: Knowledge and SearchAI Error Propagation

**Goal:** Preserve LLM/query failures and index-specific health failures.

Files:

- `apps/studio/src/lib/arch-ai/tools/kb-health.ts`
- `apps/studio/src/lib/arch-ai/tools/kb-search.ts`
- `apps/studio/src/lib/arch-ai/tools/kb-ingest.ts`
- `apps/studio/src/lib/search-ai-proxy.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`
- `apps/search-ai/src/routes/indexes.ts`
- `apps/search-ai-runtime/src/services/query-llm-resolver.ts`
- `apps/search-ai-runtime/src/services/query/query-pipeline.ts`
- `apps/search-ai-runtime/src/routes/query.ts`
- `apps/search-ai-runtime/src/routes/shared-pipeline.ts`

Tasks:

- Fix `knowledgeBaseId` vs `indexId` mismatch in health/error lookup.
- Return per-index query LLM resolution status in health responses.
- Surface static-search fallback as structured warning/error metadata, not only metrics.
- Make cache invalidation failures visible when config changes would otherwise appear successful.
- Normalize SearchAI and SearchAI Runtime error envelopes before Arch tools return them.

Exit criteria:

- KB health reports model/query LLM degradation accurately.
- Arch tool responses preserve SearchAI error code and source.
- Model config updates do not report success while invalidation fails silently.

### Phase 7: Build Flow and Long-Running Operation Errors

**Goal:** Preserve build-agent and long-running workflow errors through resume.

Files:

- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/build-completion.ts`
- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`
- `packages/arch-ai/src/session/session-service.ts`

Tasks:

- Persist build-agent errors/warnings in session metadata with structured code/message/source.
- Restore build errors into UI build state on snapshot load.
- Render build errors as stable per-agent diagnostics.

Exit criteria:

- Reload during or after a build failure restores the failed agent and error reason.
- Build completion failures appear in both trace and UI state.

## Verification Plan

Run in this order:

1. `pnpm build`
2. `pnpm --filter @agent-platform/studio test:fast`
3. `pnpm --filter @agent-platform/runtime test:fast`
4. `pnpm --filter @agent-platform/search-ai test:fast`
5. `pnpm --filter @agent-platform/search-ai-runtime test:fast`
6. Targeted Studio Arch UI E2E for:
   - Model config error remains visible after failed send.
   - SSE reconnect failure shows stable connectivity diagnostic.
   - Reload of errored session restores last error.
   - Knowledge query LLM degradation appears in Arch tool result.

Before commit, run:

```bash
npx prettier --write <changed-files>
```

## Rollout Plan

1. Ship Studio normalization and non-disappearing UI first behind additive fields.
2. Add durable session `lastError` as backward-compatible optional metadata.
3. Migrate engine/model emissions to canonical error shape.
4. Migrate API/SSE routes while keeping legacy parser compatibility.
5. Migrate Knowledge/SearchAI routes and tool wrappers.
6. Remove compatibility shims only after old event producers are gone.

## Open Decisions

| Decision                            | Options                                               | Recommendation                                                                                   |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Durable error location              | `session.lastError` top-level vs `metadata.lastError` | Use `metadata.lastError` first for additive rollout, then promote if needed.                     |
| UI behavior on new send after error | Clear immediately vs keep until first response event  | Keep until first valid response event or manual dismissal.                                       |
| Details visibility                  | Always visible vs disclosure                          | Use disclosure plus copy button to avoid leaking noisy internals.                                |
| Knowledge fallback severity         | Warning vs error                                      | Warning when query succeeds with static fallback; error when requested LLM behavior is required. |
| Legacy SSE support                  | Normalize indefinitely vs remove later                | Normalize now; remove only after event producer inventory is complete.                           |

## Definition of Done

- No Arch UI error is lost solely because a session refresh, reconnect, or snapshot load occurred.
- Every model invocation failure has a stable code and category in Studio, trace, and durable session state.
- Every Arch AI route and SSE error can be normalized into `ArchStructuredError`.
- Knowledge/SearchAI failures preserve source codes through Arch tools.
- User-visible messages are sanitized; raw diagnostic context remains in logs/traces.
- Regression tests cover disappearing-error paths, model protocol errors, non-OK HTTP bodies, reconnect failure, and resume restoration.
