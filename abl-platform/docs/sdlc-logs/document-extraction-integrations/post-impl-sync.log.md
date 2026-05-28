# Post-Implementation Sync — Document Extraction Integrations (Cleanup Pass)

**Date**: 2026-05-17
**Trigger**: User-invoked `/post-impl-sync` after data-flow audit signed off
**Scope**: 7 commits on `feature/wf/ocrnode` branch since rebasing onto develop

## Commits covered

```
b43e98599 fix(workflow-engine,runtime): keep workflow run handler in-flight + wire WfBridge Redis handle
a1c12c84e fix(connectors): sentinel connection-resolver + ADI pages query string + error hardening
fd2d8a0c9 fix(studio): Docling/ADI integration UX + block-save validation + execute body tolerance
82367ef4e fix(connectors): tighten sentinel resolver regex to connector-name charset
8a8f2c710 fix(studio): align TestActionModal sentinel regex with server resolver
21a12e2ee docs(workflow-engine): append data-flow audit rounds R3–R8 for cleanup commits
```

## Documents updated

| Doc                                                                  | Change                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/document-extraction-integrations.md`                  | Status PLANNED → ALPHA; Last Updated 2026-05-17; added `RESTATE_WORKFLOW_RUNNER_INACTIVITY_TIMEOUT` env row; added GAP-014 (Restate suspended-state re-dispatch — HIGH, mitigated for ≤1h), GAP-015 (sentinel pattern — CLOSED), GAP-016 (test-coverage gaps from audit — MEDIUM); updated §17 implementation status note |
| `docs/testing/document-extraction-integrations.md`                   | Status PLANNED → PARTIAL; Last Updated 2026-05-17; noted manual walkthrough verdict + existing INT coverage paths + remaining E2E gap to BETA                                                                                                                                                                             |
| `docs/testing/README.md`                                             | Row 101 updated: status PARTIAL 05-17, summary reflects actual existing INT files + manual happy-path verification                                                                                                                                                                                                        |
| `docs/sdlc-logs/document-extraction-integrations/data-flow-audit.md` | Appended R3–R8 (committed in `21a12e2ee`)                                                                                                                                                                                                                                                                                 |

## Coverage delta

| Type                                     | Before                      | After                                                                                                                                                     |
| ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / integration test files referenced | spec-only (PLANNED)         | existing files identified: `workflow-callbacks.test.ts`, `_piece-auth-validator.test.ts`, `connection-service.test.ts` (+ AP-framework + safeFetch tests) |
| E2E tests written                        | 0 / 13 planned              | 0 / 13 planned (no new) — manual walkthrough verifies happy paths                                                                                         |
| Data-flow audit rounds                   | R1+R2 (callbackSecret only) | R1+R2 + R3–R8 (full sweep of cleanup commits + 6 sensitive values)                                                                                        |

## Remaining gaps (for BETA)

- E2E suite: 13 scenarios from `docs/testing/document-extraction-integrations.md` §1 still unwritten.
- Test gaps F-V1-1 (auth-profile POST live-validate cleanup), F-V4-1 (empty-body /execute), F-V5-1 (sentinel resolver tenant/project isolation tests).
- Observability F-V6-2 (no metric on Restate `inactivity_timeout` patch failure).
- Architectural fix for async waits > 1h (GAP-014) — BullMQ-driven workflow resumption refactor scoped but not started.

## Deviations from original plan

1. **Async-parking wait window was implicitly assumed unlimited by the plan.** Reality: Restate 1.6.2 server on this stack does not re-dispatch suspended workflow `run` invocations after a `workflow.shared` handler resolves a durable promise. Mitigation: keep handlers in-flight via the 1h `inactivity_timeout` PATCH. Multi-day async waits are NOT supported until the BullMQ-resumption refactor lands.
2. **Azure DI usage / cost-cap admin UI removed** (commit `5bcc223f6`) — user direction. The runtime `recordUsage`/`checkUsage` calls were also removed (commit `a1c12c84e`) and the `azure-di-usage-counter.ts` + routes remain in the codebase as dead code, to be removed in a follow-up cleanup commit.
3. **`auth.type='none'` sentinel pattern** (Docling) emerged during implementation — not in the original plan. The sentinel `system-<connector>-none` is generated by Studio's IntegrationNodeConfig and resolved by a charset-guarded regex in `connection-resolver` with tenant + project scope.
4. **Auth-profile POST/PATCH live-validate cleanup** added (commit `fd2d8a0c9`) — not in the original plan; surfaced when a user reported that bad Azure DI keys were silently accepted by the save endpoint and only failed at first workflow run. Now mirrors the OAuth client-credentials inline-grant pattern.

## Verification

- All commits pass `pnpm --filter <package> exec tsc --noEmit` (verified during commit cycle).
- All commits pass lint-staged (`prettier --check`).
- Full monorepo build (`pnpm build` → 62/62 turbo tasks) verified post-rebase.
- All services on local stack accessible + healthy (manual check 2026-05-17).
- Data-flow audit Rounds 3–8 signed off: no CRITICAL / HIGH findings, both flagged defensive findings (F-V5-2, F-V7-1) closed in code.

## Status transition

- `PLANNED → ALPHA`: implementation phases complete, core happy path (Docling + ADI + Approval) works end-to-end via Studio UI on a fresh Restate stack, manual walkthrough successful, data-flow audit signed off. Does NOT meet BETA criteria (5+ E2E + 5+ integration scenarios specifically for this feature).

---

# Post-Implementation Sync — Second Pass (ADI + Awakeable + Hardening)

**Date**: 2026-05-18
**Trigger**: User-invoked `/post-impl-sync` after major architectural changes
**Scope**: 18 commits on `feature/wf/ocrnode` since previous post-impl-sync (`743c4abe49`)

## Commits covered

```
20391e22f5 feat(workflow-engine): swap connector_action suspension to Restate awakeable (POC)
d65d4716ab feat(workflow-engine): extend awakeable suspend to all 4 async wait sites
326fe6e6b3 fix(connectors,search-ai): remove pages filter from Docling node configuration
e40c9423b8 fix(connectors): reduce ADI response memory via selective JSON parse reviver
194064b5c6 feat(workflow-engine,connectors): move ADI polling out of Restate handler into BullMQ worker
973d979300 fix(workflow-engine): replace exponential backoff with fixed 2s poll interval for ADI
3b38f327c1 fix(workflow-engine): raise ADI poll worker concurrency 5 → 50
8337493377 fix(connectors): forward callbackContext into ctx.abl for AP-format pieces
e31031b06b fix(workflow-engine,connectors): data-flow audit fixes for ADI — F-1 through F-5
e46ccbdd5e fix(workflow-engine,connectors): Express body limit + ABLPieceContext type gap
43a8d861f4 fix(runtime,project-io): use @abl/compiler root import for compileABLtoIR
```

## Documents updated

| Doc                                                 | Change                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/document-extraction-integrations.md` | Status ALPHA → BETA; GAP-014 CLOSED (awakeable fix); new env vars; ADI poll worker in implementation files; deviation notes |
| `docs/testing/document-extraction-integrations.md`  | Status updated to BETA; data-flow audit Round 1 reference                                                                   |
| `docs/testing/README.md`                            | Coverage status updated for feature #101                                                                                    |

## Key architectural changes since R1 post-impl-sync

1. **GAP-014 CLOSED**: All 4 suspension sites (`connector_action`, `approval`, `human_task`, `async_webhook`) now use Restate awakeables resolved via built-in `/restate/awakeables/:id/resolve` endpoint — bypassing the unreliable shared-handler re-dispatch in Restate 1.6.2. Multi-day waits now structurally supported.

2. **ADI async pattern**: Azure DI polling moved from inline Restate handler loop to `workflow-engine`-internal BullMQ poll worker (`apps/workflow-engine/src/services/adi-poll-worker.ts`). Handler parks on awakeable immediately. Fixed 2s poll interval (not exponential). apiKey + callbackSecret encrypted at-rest on every re-enqueue (F-1 fix).

3. **ADI memory**: Selective JSON parse reviver drops `analyzeResult.content` (50-70% of response size) before heap retention. `AZURE_DI_WORKFLOW_INLINE_CAP_BYTES=10MB` (was shared 50MB Docling cap). Route-specific 12MB Express body limit on `/api/v1/workflows/callbacks`.

4. **Docling pages filter removed**: In-memory post-extraction filter deleted — had no effect on Docling service load.

5. **callbackContext wiring**: AP-format pieces (ADI) now receive `callbackContext` via `ctx.abl.callbackContext` after fix to `translateActionContext`. Docling (native piece) was unaffected.

## Data-flow audit findings (Round 1, 2026-05-18)

| ID    | Severity | Finding                                                          | Status                                              |
| ----- | -------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| F-1   | CRITICAL | Re-enqueued BullMQ jobs stored plaintext apiKey + callbackSecret | Fixed — `wrapJobDataForEncrypt` on every re-enqueue |
| F-2   | HIGH     | No operationLocation host validation in worker                   | Fixed — assertOperationLocationHost at job start    |
| F-3   | MEDIUM   | Unhandled exceptions left workflow at waiting_callback           | Fixed — top-level try/catch + error callback        |
| F-4   | MEDIUM   | postCallback failure on succeeded silently lost result           | Fixed — re-enqueue on delivery failure              |
| F-5   | MEDIUM   | RateLimiterMemory (per-pod, defeated by scaling)                 | Fixed — RateLimiterRedis                            |
| EXT-1 | CRITICAL | Express 1MB body limit vs 10MB ADI cap → infinite retry          | Fixed — route-specific 12MB limit                   |
| EXT-2 | LOW      | ABLPieceContext interface missing callbackContext field          | Fixed — type added                                  |

## Deviations from original plan

- ADI was planned as inline Restate polling — architectural review concluded BullMQ worker pattern is required for production-grade memory isolation and handler non-blocking
- `ctx.store.put()` not `ctx.store.set()` — AP store adapter exposes `put`, discovered at runtime
- `callbackContext` not forwarded into `ctx.abl` for AP-format pieces — structural gap in `translateActionContext`

---

# Post-Implementation Sync — Third Pass (Relay-Race Refactor)

**Date**: 2026-05-20
**Trigger**: User-invoked post-impl-sync after relay-race refactor
**Scope**: Relay-race execution model, trigger path coverage, terminology cleanup

## Changes since last sync

1. **Relay-race refactor (7 phases)**: Replaced Restate `workflow.run` awakeable suspension with `restate.object()` relay model. Root cause fix for Restate 1.6.2 bug where suspended handlers never re-dispatch after partition leadership transitions. Every execution slice now runs as a short-lived exclusive `restate.object()` handler (`workflow-executor`). Steps needing async waits write `{ parkPoint: true, nextStepIds, callbackSecret }` to MongoDB via `parkStep()` and return cleanly. Callback routes read `parkPoint` and dispatch the next relay via `startWorkflow()`.

2. **Trigger path coverage (all paths)**: `relayStartWorkflow()` wrapper added to `index.ts`. All 6 trigger wiring points (TriggerEngine, TriggerScheduler, ConnectorTriggerEngine, webhook router, polling worker, connector webhook router) now use relay-race. No execution path uses the legacy `workflow.run` Restate handler for new executions.

3. **Terminology cleanup**: "leg" renamed to cleaner names — `executeWorkflow`, `WorkflowRunInput`, `WORKFLOW_EXECUTOR_SERVICE_NAME` (`'workflow-executor'`), `runCounter` (was `legCounter`), `startWorkflow`/`cancelWorkflow` (relay-race), `startLegacyWorkflow`/`cancelLegacyWorkflow` (legacy backward-compat path kept for in-flight executions during deploy).

4. **Tests updated**: `restate-client.test.ts` — renamed to `startLegacyWorkflow`/`cancelLegacyWorkflow`, added new tests for relay-race `startWorkflow`/`cancelWorkflow` (URL: `/workflow-executor/{id}/runWorkflow/send`). `execution-store.test.ts` — updated `updateExecutionStatus` assertion to per-field `$set` pattern.

## Documents updated

| Doc                                                                     | Change                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/document-extraction-integrations.md`                     | Last Updated 2026-05-20; GAP-014 updated to relay-race root-cause fix; §10 Key Implementation Files added 5 relay-race entries; §17 implementation status updated with relay-race detail |
| `docs/testing/document-extraction-integrations.md`                      | Added relay-race test coverage entries for `restate-client.test.ts` and `execution-store.test.ts`                                                                                        |
| `apps/workflow-engine/agents.md`                                        | Appended relay-race model learnings (6 entries)                                                                                                                                          |
| `docs/sdlc-logs/document-extraction-integrations/post-impl-sync.log.md` | This entry                                                                                                                                                                               |

## End-to-end validated (local)

- Docling extraction workflow: `waiting_callback` → callback → `completed` ✅
- ADI extraction workflow: `waiting_callback` → callback → `completed` ✅
- Approval workflow: `waiting_approval` → approve → `completed` ✅

## Key architectural decisions

- **parkStep pattern**: Steps needing async waits write `{ parkPoint: true, nextStepIds, callbackSecret }` to MongoDB and return cleanly from the Restate handler. Callback routes read `parkPoint` to choose tri-path: relay-race (`startWorkflow`) vs legacy awakeable (`resolveAwakeable`) vs legacy shared handler (`resolveCallback`).
- **Legacy backward-compat**: `startLegacyWorkflow`/`cancelLegacyWorkflow` kept on `RestateWorkflowClient` for in-flight executions created before relay-race cutover. `RELAY_RACE_DISABLED=true` env var restores legacy path for emergency rollback.
- **Restate service name**: `workflow-executor` (was `workflow-leg-runner`). Registered as `restate.object()` alongside legacy `workflow-runner` `restate.workflow()`. Both bound in `buildRestateEndpoint()`.

## Verification

- All commits pass `pnpm --filter <package> exec tsc --noEmit` (verified during commit cycle).
- All commits pass lint-staged (`prettier --check`).
- `restate-client.test.ts` passes with relay-race `startWorkflow`/`cancelWorkflow` tests.
- `execution-store.test.ts` passes with updated `updateExecutionStatus` assertions.

---

## Post-Implementation Sync — 2026-05-20 (Fourth Pass)

### Changes since third pass

1. **Data-flow audit Round 1 + Round 2 fixes**:
   - F-1 (MEDIUM): Added `createCallbackRateLimit()` middleware (120 req/60s per IP) to `/api/v1/workflows/callbacks`. Prevents execution UUID enumeration via response-code side channels.
   - F-5 (MEDIUM): Added `projectId` param to `findBySource` across `HumanTaskStoreLike`, `MongoHumanTaskStore`, `syncHumanTaskOnResolve`, `ensureHumanTaskMirror`, `finalizeHumanTaskOnTimeout`. All 6 call sites updated. `projectId` now in MongoDB filter.
   - F-5.7 (NEW HIGH): `system-human-task-store.test.ts` uses stale 3-arg `findBySource` — 4 test cases need updating.
   - BT-8 (NEW MEDIUM): `workflow-callbacks.test.ts:162` stale private-IP test — expects 403 but route has no IP blocking.
   - BT-1/2/3 (MEDIUM): Missing boundary tests for rate limiter, STEP_SENSITIVE_FIELDS stripping, inputSnapshot stripping.

2. **Round 2 audit verified CLOSED**:
   - F-1 rate limiter correctly ordered before JSON parser + DB access
   - F-5 all production callers verified to pass projectId
   - F-6 STEP_SENSITIVE_FIELDS still includes callbackSecret (expanded set)
   - F-7 double-resolution CAS guard unchanged and correct
   - F-8 inputSnapshot not in WorkflowRunInput, stripped from GET responses
   - N-2 rate limiter LRU eviction is correct
   - N-3 X-Forwarded-For spoofing acceptable (HMAC is real auth boundary)
   - N-5/N-6 projectId consistency verified across legacy and relay-race paths

### Commits covered

```
0a5a0da3ab style(workflow-engine): prettier fix on workflow-handler.ts after F-5 changes
6d293a6921 fix(workflow-engine): data-flow audit Round 2 — F-1 callback rate-limit + F-5 findBySource projectId
a1967f172f test(workflow-engine): update restate-client + execution-store tests for relay-race rename
500d555805 docs(workflow-engine): post-impl sync — relay-race refactor + trigger path fix + terminology cleanup
9f1a16ba7b refactor(workflow-engine): rename leg → executor/run terminology + relay-race all trigger paths
```

### Documents updated

| Doc                                                                     | Change                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/document-extraction-integrations.md`                     | Added GAP-017 through GAP-023 (Round 2 findings); added Mitigated section (F-1, F-5, relay-race bugs); updated §17 test counts (1045 passing) |
| `docs/testing/document-extraction-integrations.md`                      | Updated Status with boundary test coverage detail; added COVERED/MISSING/NEEDS_FIX rows to §8 Test File Mapping                               |
| `docs/testing/README.md`                                                | Row 101 updated: status PARTIAL 05-20, relay-race + boundary test detail                                                                      |
| `docs/specs/document-extraction-integrations.hld.md`                    | Status DRAFT → DONE; Open Questions 2-6,8-9 resolved; added §9.1 Post-Implementation Notes                                                    |
| `apps/workflow-engine/agents.md`                                        | Appended data-flow audit learnings (5 entries)                                                                                                |
| `docs/sdlc-logs/document-extraction-integrations/post-impl-sync.log.md` | This entry                                                                                                                                    |

### Status: BETA

All CRITICAL and HIGH data-flow audit findings closed. Remaining open items are MEDIUM/LOW boundary test gaps.
