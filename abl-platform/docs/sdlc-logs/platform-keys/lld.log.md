# SDLC Log: Platform Keys LLD

**Feature**: Platform Keys Management UI
**Phase**: LLD (Phase 4 of SDLC)
**Date**: 2026-04-11
**Branch**: `KI081/feat/workflows-node-changes`

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items escalated.

### Key Decisions

| #   | Question                           | Classification | Answer Summary                                                                   |
| --- | ---------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| Q1  | Implementation order               | ANSWERED       | API-first per feature spec §13: routes → UI → trigger migration → tests          |
| Q2  | Existing route patterns            | ANSWERED       | SDK keys has both `route.ts` and `[keyId]/route.ts`; follow same Next.js pattern |
| Q3  | Feature flag needed?               | DECIDED        | No — additive feature, low risk, rollback = file deletion                        |
| Q4  | Phase scope                        | DECIDED        | All FRs in single delivery, split by commits not deployment phases               |
| Q5  | Key generation utilities           | ANSWERED       | Extract as pure functions (SDK keys inlines; test spec requires unit tests)      |
| Q6  | File paths accuracy                | ANSWERED       | Feature spec §10 paths verified against filesystem                               |
| Q7  | Testing strategy                   | DECIDED        | Unit tests with utilities; E2E/integration as dedicated phase                    |
| Q8  | validateQuery existence            | ANSWERED       | No — manual searchParams extraction, same as SDK keys pattern                    |
| Q9  | WebhookQuickStart field mapping    | ANSWERED       | keyPrefix→prefix, isActive→derived from revokedAt/expiresAt                      |
| Q10 | WorkflowTriggersTab changes needed | ANSWERED       | Yes — 6+ locations with keyPrefix/isActive field references                      |
| Q11 | Branch conflicts                   | ANSWERED       | No conflicts — branch is clean, files restored to develop state                  |
| Q12 | Biggest implementation risk        | INFERRED       | WorkflowTriggersTab migration (6+ locations, 3-level data threading)             |
| Q13 | Monitoring needs                   | ANSWERED       | createLogger + auditTrailPlugin. No new infrastructure.                          |
| Q14 | Definition of done                 | INFERRED       | All 16 FRs, all 24 tests passing, type checks clean                              |
| Q15 | withOpenAPI error handling         | ANSWERED       | Not automatic — manual validateBody + searchParams extraction                    |

## Audit Results

### Round 1 — NEEDS_REVISION (lld-reviewer)

- **CRITICAL**: tenantIsolationPlugin ALS gap — Studio routes don't configure AsyncLocalStorage, so plugin can't auto-inject tenantId. Fixed: explicit `tenantId: user.tenantId` required in ALL queries.
- **CRITICAL**: Multi-project privilege escalation — POST only checking first projectId allows adding projects user doesn't have access to. Fixed: loop ALL projectIds for access validation.
- **HIGH**: Missing `ensureDb()` — Studio routes need explicit MongoDB connection on cold start. Added to all handlers.
- **HIGH**: Missing `CreateKeyResponseSchema` — POST response lacked `key` field for one-time raw key. Added `CreateKeyResponseSchema = KeyResponseSchema.extend({ key: z.string() })`.
- **HIGH**: Missing `DeleteQuerySchema` — DELETE needed `projectId` query param validation. Added Zod schema.
- **MEDIUM**: i18n translation keys not specified. Added full key list under `settings.api_keys.*` and `settings.platform_keys.*`.

### Round 2 — NEEDS_REVISION (lld-reviewer)

- **HIGH**: `apiFetch` calling convention wrong — LLD used `apiFetch('GET', path)` but actual signature is `apiFetch(path, init?)`. Fixed GET and POST usages.
- **MEDIUM**: Error response format inconsistency — documented hybrid format matching SDK keys pattern (Zod failures vs manual 400s).

### Round 3 — APPROVED (lld-reviewer)

- **HIGH**: `apiFetch` PATCH/DELETE calling convention still wrong. Fixed to use `apiFetch(url, { method: 'PATCH', ... })`.
- **HIGH**: Missing test harness extension — no task to mount new routes in `studio-api-harness.ts`. Added Task 4.0.
- **MEDIUM**: Test spec E2E-6 and INT-3 PATCH payloads missing required `projectId` field. Documented in Open Questions.
- **MEDIUM**: Error response format bare `{ error: string }` vs HLD structured codes. Documented as conscious deviation.
- **LOW**: i18n key namespace inconsistency (intentional — tabs=page-level, content=feature-level).

### Round 4 — APPROVED (phase-auditor, cross-phase consistency)

- **HIGH**: DELETE test scenarios also missing `projectId` query param (E2E-2, E2E-3, INT-4, INT-9). Added to Open Question #2.
- **HIGH**: INT-6 error format expects `{ error: { code, message } }` but actual uses different shapes. Added to Open Question #2.
- **MEDIUM**: HLD tenant isolation claim contradicts LLD (LLD is correct). Added Open Question #4 for post-impl-sync.
- All 16 FRs mapped to implementation tasks. All 24 test scenarios covered in Phase 4.

### Round 5 — APPROVED (lld-reviewer, final sweep)

- **MEDIUM**: INT numbering in LLD Phase 4 doesn't match test spec ordering (cosmetic — implementation references test spec directly).
- **MEDIUM**: HLD error format correction already captured in Open Question #4.
- **LOW**: Next.js 15 async params pattern implicit via "follow SDK keys pattern" — sufficient for implementer.
- All prior fixes verified stuck. Task independence confirmed. Wiring checklist complete. Domain rules compliant.

## Files Created

- `docs/plans/2026-04-11-platform-keys-impl-plan.md`
- `docs/sdlc-logs/platform-keys/lld.log.md`

## Files Updated

- `docs/features/sub-features/platform-keys.md` (pre-LLD corrections — already committed)
- `docs/testing/sub-features/platform-keys.md` (pre-LLD corrections — already committed)

---

# Phase 2 LLD Log

**Date**: 2026-04-12
**Artifact**: `docs/plans/2026-04-12-platform-keys-phase2-impl-plan.md`

## Oracle Decisions

All 15 clarifying questions answered (ANSWERED/INFERRED/DECIDED — zero AMBIGUOUS).

### Key Decisions

1. **Implementation order**: Registry (shared-auth) → Studio routes → Runtime expansion → UI
2. **Registry type**: `Record<string, ScopeEntry>` constant, Zod-free in shared-auth
3. **D-3 (dot-only at creation)**: Only dot-separated scopes at POST/PATCH; legacy colon-separated handled by runtime expansion only
4. **Ceiling check source**: `user.role` from `requireAuth` — no new middleware
5. **UI scope fetch**: `GET /api/keys/scopes` via SWR (can't import shared-auth in browser)
6. **Expansion location**: Inside each app's `resolveApiKey` before returning ApiKeyRecord

## Audit Results

### Round 1: NEEDS_CHANGES (lld-reviewer — Architecture Compliance)

- CRITICAL: `user.role` undefined guard needed before `getPermissionCeiling`
- CRITICAL: `shared-auth` dependency missing in search-ai-runtime and workflow-engine
- HIGH: search-ai/search-ai-runtime missing prefix/expiresAt checks (parity gap)
- HIGH: `denied` array must contain scope names, not RBAC permission strings

### Round 2: NEEDS_CHANGES (lld-reviewer — Pattern Consistency)

- HIGH: Error envelope third shape — documented as intentional
- HIGH: Scopes endpoint missing `withOpenAPI` wrapper — added
- MEDIUM: Mixed import sources documented; test file added to Files Touched; Dockerfile verified

### Round 3: NEEDS_CHANGES (lld-reviewer — Completeness)

- CRITICAL: WebhookKeyCreationModal + PlatformKeysTab send colon-separated scopes — break after Zod change. Added to Phase 2 migration.
- HIGH: E2E-15 rewrote to use DB seeding for legacy keys (D-3 conflict)
- HIGH: Error response shape aligned across LLD, E2E-11, INT-12 to `{ error, code, denied }`

### Round 4: APPROVED (phase-auditor — Cross-Phase Consistency)

- HIGH: Added task 1.6 to create unit test file for UT-5..8
- HIGH: FR-23 ceiling disabling deferral note added

### Round 5: APPROVED (lld-reviewer — Final Sweep)

- MEDIUM: E2E-15 test strategy text fixed; swallowed catch in search-ai-runtime noted; GAP-012 UT-7 note added
- All 18 prior findings verified resolved

## Files Created/Modified

- `docs/plans/2026-04-12-platform-keys-phase2-impl-plan.md` — Full Phase 2 LLD (4 phases, 22 tasks)
- `docs/testing/sub-features/platform-keys.md` — E2E-15 rewrite, error shape alignment, UT-7 discriminated union fix
- `docs/sdlc-logs/platform-keys/lld.log.md` — This section

## Next Phase

Proceed to `/implement platform-keys`.
