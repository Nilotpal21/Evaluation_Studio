# Feature Spec Rewrite Log — Agent Assist Runtime Compat

**Date**: 2026-04-21
**Ticket**: ABLP-390
**Phase**: Feature Spec — Scope narrowing + rewrite
**Branch**: `KI081/feat/ABLP-390-agent-assist-runtime-compat`

## Trigger

User directive during `/feature-spec`:

> Generate a new spec just with existing "session + execute" pair without new APIs to work with different vendors, and one thin wrapper on top of that to support Kore.ai Agent Assist contract using the working docs `docs/poc/`. DO NOT commit anything — the user will review the doc.

## Scope change vs prior spec

The prior spec described a two-layer architecture:

- **Layer A** — new canonical "Agent Suggestions Service" public API at `/api/v1/projects/:projectId/agent-suggestions/...` with new `AgentSuggestion` typed contract in `shared-kernel`, new `agent_suggestions:execute` permission, new `agent_suggestions.*` trace family, and Studio binding CRUD.
- **Layer B** — Kore.ai Agent Assist V1 facade at `/api/v2/apps/:appId/environments/:envName/...` delegating to Layer A.

The rewrite drops **Layer A entirely** and keeps only the V1 facade (former Layer B) delegating directly in-process to ABL's existing primitives:

- `DeploymentResolver.resolve`
- `RuntimeExecutor.createSessionFromResolved`
- `RuntimeExecutor.executeMessage`
- `RuntimeExecutor.endSession`

No new public API, no new permission scope, no new typed contract, no new Studio panel. Other vendors either integrate against `POST /api/v1/chat/agent` directly or ship a peer facade (`apps/runtime/src/services/<vendor>-compat/`) mirroring this one.

## Product-oracle round — 15 questions, 0 AMBIGUOUS

The oracle reviewed the POC files in `docs/poc/`, the uncommitted POC implementation under `apps/runtime/src/{routes,services}/agent-assist*`, and the existing ABL primitives. All 15 clarifying questions returned non-ambiguous classifications — the rewrite proceeded without user round-trip.

### Decisions locked by the oracle

| #    | Decision                                                                              | Rationale                                                                                       | Evidence                                          |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| D-1  | MAJOR FEATURE, no parent                                                              | Has own lifecycle, API, data model, testing surface                                             | `AUTHORING_GUIDE.md:9`                            |
| D-2  | Retain Layer A as explicit Out-of-Scope bullets                                       | Reviewers need the decision trail                                                               | user directive                                    |
| D-3  | Status = PLANNED                                                                      | POC uncommitted; ALPHA gate requires committed + feature-gated code                             | `AUTHORING_GUIDE.md` lifecycle                    |
| D-4  | Lock in in-process delegation (not HTTP loopback)                                     | Zero overhead, proven in POC, matches `workflows-execute.ts`                                    | `execution-bridge.ts:116`, `chat.ts:1444`         |
| D-5  | Reuse `session:send_message` permission (no new scope)                                | Same op as `chat/agent`; existing keys work                                                     | `chat.ts:1444`, `platform-key-scopes.ts:29`       |
| D-6  | Single `agent_assist` feature gate                                                    | Layer A dropped; no producer for `agent_suggestions` gate                                       | prior spec FR-11 + FR-26                          |
| D-7  | Persist bindings to MongoDB (Phase Actual)                                            | Multi-binding, audit trail, isolation                                                           | POC §8.1, CLAUDE.md Core Invariant #1             |
| D-8  | Admin CRUD only; Studio panel deferred                                                | Operations concern; reduces Phase Actual scope                                                  | POC ref §11.2 step 8                              |
| D-9  | `/sessions` synthesize locally; `/sessions/terminate` → `RuntimeExecutor.endSession`  | Avoids orphan sessions; properly releases resources                                             | `agent-assist.ts:487`, `runtime-executor.ts:3968` |
| D-10 | Async-push stays in scope via BullMQ upgrade                                          | Primary transport for Kore.ai Agent Assist in production                                        | POC ref §5.1                                      |
| D-11 | Drop `agent_suggestions.*` trace family; keep only `agent_assist.*`                   | No canonical producer without Layer A                                                           | prior spec FR-12 + FR-27                          |
| D-12 | Change session-metadata `source` tag from `"agent_suggestions"` → `"agent_assist_v1"` | Consistency with single-layer narrative; breaks POC Observatory queries (documented in GAP-003) | `constants.ts:47`                                 |
| D-13 | Test split: 60% pure-function unit / 25% integration / 15% E2E                        | Facade's primary value is translation (pure)                                                    | CLAUDE.md Test Architecture                       |

### AMBIGUOUS items

None. Zero user round-trip required for the rewrite.

## Files changed

| File                                           | Change                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docs/features/agent-assist-runtime-compat.md` | Full rewrite — single-layer (facade-only) architecture                                                  |
| `docs/testing/agent-assist-runtime-compat.md`  | Full rewrite — removed Layer A rows; added FR-1..FR-31 coverage matrix; 5 E2E + 5 integration scenarios |
| `docs/testing/README.md`                       | Row 98 planned counts `7/7` → `5/5` to match new mandatory minimums                                     |

## Files NOT changed

- `docs/features/README.md` — title "Agent Assist Runtime Compat" and packages list already match the rewritten spec
- `docs/poc/*` — POC docs describe the existing POC code and are left intact
- `apps/runtime/src/routes/agent-assist.ts` + `apps/runtime/src/services/agent-assist/*` — POC implementation unchanged; Phase Actual work is planned in §13 of the rewritten spec

## Deliberate deltas from POC that Phase Actual must implement

1. Mongo-backed `AgentAssistBinding` repo (POC uses env seed).
2. Admin CRUD routes with audit-log integration (POC has no CRUD).
3. `POST /sessions/terminate` wired to `RuntimeExecutor.endSession` (POC returns HTTP 400 stub).
4. BullMQ-backed async-push with HMAC + retry + DLQ (POC is fire-and-forget 10-second timeout).
5. `agent_assist.*` trace events registered in the shared-kernel registry (POC uses `log.info` only).
6. Per-tenant `agent_assist` feature gate (POC has only the global env kill switch).
7. Session metadata `source` tag change `"agent_suggestions"` → `"agent_assist_v1"` (breaks POC Observatory queries — documented in GAP-003).

## Commit instruction

User explicit: **do not commit**. The rewritten spec + testing guide + index row update are left uncommitted in the worktree for review.

## Phase-auditor rounds (skill-required)

### Round 1

- Verdict: **NEEDS_REVISION** — 2 CRITICAL, 3 HIGH, 3 MEDIUM, 1 LOW.
- Summary of resolutions:
  - F-C-1 Admin architecture — all Express-style `apps/admin/src/routes/...` and `server.ts` references rewritten to Next.js App Router paths under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/...`.
  - F-C-2 Invented PII service — `anonymizationOrchestrationService` replaced everywhere with the real `scrubPII` + `PIIVault` path (`runtime-executor.ts:108,2187`).
  - F-H-1 Audit mechanism — `auditLogStore.write` replaced with `logAdminAction` (`apps/admin/src/lib/audit-logger.ts:44`).
  - F-H-2 HMAC + callbackUrl clarification — explicit statement added in §9.1 that the HMAC secret is a single global env var and `callbackUrl` is per-request, neither stored on the binding.
  - F-H-3 README status column — confirmed false positive (README column is "Status | SDLC Pipeline", PLANNED + IN PROGRESS is internally consistent).
  - F-M-1 Load-test row reclassified from `manual` to `load (k6)`.
  - F-M-2 Exit criteria added per Phase Actual task in §13.
  - F-M-3 FR-22 split into FR-22a + FR-22b under a single list item (list ordinals preserved; downstream FRs unchanged).

### Round 2

- Verdict: **NEEDS_REVISION** — 0 CRITICAL, 0 HIGH, 4 MEDIUM, 0 LOW.
- All 4 MEDIUM findings were trivial string-replacement leftovers from round 1 (stale `auditLogStore.write` and stale `/api/admin/...` paths in the surface-semantics matrix, audit-logging row, technical-considerations section, security-compliance section, and the testing guide).
- All 4 findings resolved inline in the same editing pass; `grep` confirms zero remaining stale references in both docs.
- Per the skill workflow's "after round 2: proceed regardless" rule, the spec is ready for the next phase.

## Next steps

1. User reviews `docs/features/agent-assist-runtime-compat.md` and `docs/testing/agent-assist-runtime-compat.md`.
2. On acceptance, user runs the phase-auditor round explicitly or invokes `/test-spec` for the next phase.
3. No `/post-impl-sync` yet — nothing is implemented for Phase Actual beyond the POC.
