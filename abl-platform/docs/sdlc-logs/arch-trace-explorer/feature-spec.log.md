# Feature Spec — SDLC Log

**Feature**: arch-trace-explorer
**Phase**: Feature Spec (SDLC Phase 1)
**Date**: 2026-04-14
**Branch**: arch/stability

---

## Source Material

- Brainstorm design: `docs/superpowers/specs/2026-04-14-arch-trace-explorer-design.md`
- Predecessor feature spec: `docs/features/arch-audit-logs.md` (ALPHA)
- Predecessor HLD: `docs/specs/arch-audit-logs.hld.md`
- Predecessor testing: `docs/testing/arch-audit-logs.md`

---

## Product Oracle Decisions

Oracle resolved all 15 clarifying questions with 0 AMBIGUOUS items.

### Section 1: Scope & Problem

| Q                           | Classification | Answer                                                                                               |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| 1.1 Replacement vs parallel | ANSWERED       | REPLACEMENT — old `arch_audit_logs` kept for historical data, new sessions write only to trace spans |
| 1.2 Feature status          | DECIDED        | PLANNED — greenfield rewrite despite conceptual lineage with arch-audit-logs                         |
| 1.3 Migration strategy      | ANSWERED       | Option (a): leave old data, TTL expires at 90 days, no backfill                                      |
| 1.4 Deprecate old UI        | DECIDED        | Yes — deprecate `ArchAuditLogsTab`. Historical data accessible via direct DB during transition       |
| 1.5 Priority driver         | INFERRED       | Stability/architectural cleanup + debugging UX gap (MEDIUM confidence)                               |

### Section 2: User Stories & Requirements

| Q                            | Classification | Answer                                                                                                          |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| 2.1 Primary persona          | ANSWERED       | Developer/operator diagnosing Arch AI issues (shifted from admin-first)                                         |
| 2.2 Must-have FRs            | INFERRED       | All brainstorm features + carry tenant-deletion cascade from arch-audit-logs; export deferred                   |
| 2.3 Cross-session comparison | DECIDED        | Out of scope v1                                                                                                 |
| 2.4 Scale target             | ANSWERED       | Typical <500 spans, upper bound 2000, poll response cap 500                                                     |
| 2.5 Feature interactions     | INFERRED       | Arch AI Assistant, Model Hub, Audit Logging, Arch Journal, ArchSession, Model Resolution, scrubbers in compiler |

### Section 3: Technical & Architecture

| Q                          | Classification | Answer                                                                       |
| -------------------------- | -------------- | ---------------------------------------------------------------------------- |
| 3.1 Event type governance  | INFERRED       | Coordinated add — pure additive, PR review, version bump (MEDIUM confidence) |
| 3.2 Packages affected      | ANSWERED       | arch-ai, observatory, database, studio, shared-observability (consumer)      |
| 3.3 EventStore integration | ANSWERED       | Pure MongoDB in v1, ClickHouse future swap                                   |
| 3.4 Scoping                | ANSWERED       | Project-scoped + onboarding-scoped routes (not admin-unified)                |
| 3.5 Infra config           | INFERRED       | 6 env vars, new indexes, new collections, feature flag, new permission       |

---

## DECIDED Items (flag for review)

1. **Feature status = PLANNED** — despite predecessor existing as ALPHA, the tracing package is a greenfield rewrite. No `packages/arch-ai/src/tracing/` exists yet.
2. **Deprecate `ArchAuditLogsTab` during transition** — historical data remains accessible via direct DB query during the 90-day TTL window. Optionally add a short-lived "Legacy Audit Logs" link if customer need emerges.
3. **Cross-session comparison out of scope for v1** — documented in Future Compatibility section.

---

## Key References

- Design doc (canonical): `docs/superpowers/specs/2026-04-14-arch-trace-explorer-design.md` (4 rounds of P1 review feedback addressed)
- Observatory contracts: `packages/observatory/src/schema/trace-events.ts`, `packages/observatory/src/schema/spans.ts`
- Shared tracing: `packages/shared-observability/src/tracing/`
- Scrubbers: `packages/compiler/.../trace-scrubber.ts`, `packages/compiler/.../scrub-patterns.ts`
- CLAUDE.md: Core Invariants §1 (Resource Isolation), §5 (Compliance)

---

---

## Audit Round 1 (2026-04-15)

**Verdict**: NEEDS_REVISION

**CRITICAL findings fixed:**

1. ✅ Replaced `requireProjectPermission(req, res, ...)` (Express runtime middleware) with `withRouteHandler({ requireProject: true, permissions: 'arch:traces:read' }, handler)` from `apps/studio/src/lib/route-handler.ts`. Updated FR-12, FR-13, FR-20, §8, §12.
2. ✅ Replaced `PhaseMachine.transition()` (does not exist) with `transitionPhase(session, targetPhase)` free function from `packages/arch-ai/src/coordinator/phase-machine.ts:95`. Updated §7 and §13.5.6.
3. ✅ Added `arch_system_event` to FR-7's additive event type list. Updated FR-22 to emit `arch_system_event` instead of the non-existent `system_event`.

**HIGH findings fixed:** 4. ✅ TTL mechanism clarified: single TTL index on pre-computed `expiresAt` field (MongoDB pattern for per-doc variable expiry). Default `now + 90d`, raw mode `now + 7d`. 5. ✅ Fate of legacy `/api/arch-ai/audit-logs/*` routes and `packages/arch-ai/src/audit/` source specified in §8 and GAP-004. Kept until feature flag is globally on, then deleted in a single post-BETA cleanup PR. 6. ✅ Dual-write question resolved: per-session-era strategy documented in §7. Each session writes to exactly one store for its entire lifetime based on the flag value at session creation. 7. ✅ Removed local `pricing.ts` proposal — FR-15 and Key Implementation Files table now reuse `estimateCost()` and `MODEL_PRICING` from `@agent-platform/shared-kernel`. 8. ✅ Studio ALS caveat reflected in §12 isolation table — explicit `tenantId` filter required in every query because Studio does not register an ALS tenant-context provider. 9. ✅ Route convention corrected to Next.js App Router `[id]` style matching the repo (`apps/studio/src/app/api/projects/[id]/...`).

Round 2 audit pending.

---

## Audit Round 2 (2026-04-15)

**Verdict**: NEEDS_REVISION (all findings were string-level regressions from Round 1 fixes)

**CRITICAL findings fixed:**

1. ✅ §12 Security & Compliance — replaced stale `requireProjectPermission` with `withRouteHandler` wording (Round 1 missed this bullet under the isolation table)
2. ✅ Key Implementation Files table — corrected `[projectId]` → `[id]` to match repo convention and `withRouteHandler`'s `params.id` lookup

**HIGH findings fixed:** 3. ✅ FR-14 and §12 Data Lifecycle — corrected TTL field from `createdAt` to pre-computed `expiresAt` with `expireAfterSeconds: 0` 4. ✅ Span-cap status reconciled — all three references (FR-22, §12 Reliability, Plan 5.8) now consistently specify `arch_system_event` with `status: 'error'` and `arch.systemEvent = 'span_cap_exceeded'` attribute 5. ✅ Canonical design doc citation downgraded in §18 — noted that feature spec is authoritative, brainstorm doc retains earlier stale refs for historical context

**MEDIUM findings fixed:** 6. ✅ `SessionRevisionModel` → `ArchTraceSessionModel` in §7 code snippet (matches §10 file name) 7. ✅ `pii-detector.ts` path corrected to `packages/compiler/src/platform/security/pii-detector.ts` 8. ✅ Status Visual Design — removed ambiguous `warning` status row; added explanation that amber UI affordance is render-time derived, not persisted

**LOW findings left as-is (below NEEDS_REVISION threshold):**

- None.

**Final verdict (post-fix)**: All CRITICAL and HIGH findings resolved. Per feature-spec skill policy "After round 2: proceed regardless", proceeding to commit.
