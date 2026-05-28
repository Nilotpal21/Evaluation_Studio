# SDLC Log: Omnichannel Session Continuity — Post-Implementation Sync

**Feature**: omnichannel-session-continuity
**Phase**: POST-IMPL-SYNC
**Date**: 2026-03-23

---

## Documents Updated

- [x] Feature spec: `docs/features/omnichannel-session-continuity.md` — Status PLANNED → ALPHA, API table updated (5 Runtime + 2 Studio endpoints implemented, Studio join-links PLANNED), OmnichannelProjectSettings added to data model, gaps updated (7 mitigated, 3 new), test table updated with actual counts
- [x] Test spec: `docs/testing/omnichannel-session-continuity.md` — Status PLANNED → IN PROGRESS (ALPHA), health dashboard updated, test file inventory updated, coverage map checkboxes updated, current-state narrative rewritten for ALPHA, SDK filter names corrected
- [x] Testing index: `docs/testing/README.md` — Added omnichannel row with ALPHA status
- [x] LLD: `docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md` — Status DRAFT → DONE, exit criteria checkboxes updated to reflect actual completion
- [ ] HLD: `docs/specs/omnichannel-session-continuity.hld.md` — No changes needed (HLD is stable reference)

## Coverage Delta

| Type              | Before | After        |
| ----------------- | ------ | ------------ |
| E2E tests         | 0      | 28 (3 files) |
| Integration tests | 0      | 15 (2 files) |
| Unit tests (SDK)  | 0      | 44 (3 files) |
| **Total**         | **0**  | **87**       |

## Remaining Gaps

- GAP-003 (HIGH): Identity verification completion not fully wired to contact linking
- GAP-004 (HIGH): Session-to-contact linking inconsistent across paths
- GAP-005 (HIGH): SDK contact linking race condition with early message persistence
- GAP-011 (MEDIUM): Audit events in-memory only (lost on restart)
- GAP-012 (LOW): SDK WS handlers accept contactId from message payload as fallback
- GAP-013 (MEDIUM): Recovery E2E tests not yet implemented
- Deferred test files: omnichannel-recovery.e2e, omnichannel-sdk-handler.integration, Studio settings/smoke tests

## Deviations from Plan

- OmnichannelProjectSettings created as separate model (not embedded in ProjectSettings) for cleaner separation
- Used CONNECTION_WRITE permission in Studio PATCH handler (PROJECT_WRITE doesn't exist)
- Package name is `@anthropic/agent-sdk` (not `@agent-platform/web-sdk` as in some docs)
- In-memory ring buffer for audit (not persistent TraceStore query) — suitable for ALPHA
- Server uses `state.callerContext?.contactId` as primary contactId source, message payload as fallback

---

## Gap Closure Phase 2 — Post-Implementation Sync (2026-03-24)

### Documents Updated

- [x] Feature spec: `docs/features/omnichannel-session-continuity.md` — GAP-003 → Mitigated, added GAP-014 through GAP-019 as Mitigated, new implementation files (configurable-oauth-provider-adapter.ts, identity-tier.ts, cascade-delete.ts), OAuth env vars (6 new), retention field in data model, test counts updated (40 E2E + 15 integration + 54 unit), env var name corrected (IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT)
- [x] Test spec: `docs/testing/omnichannel-session-continuity.md` — Current state updated (109 tests), health dashboard (identity verification → PASS ALPHA), 2 new test files added, coverage map checkboxes updated (OTP, email_link, HMAC verification), known gaps updated
- [x] Testing index: `docs/testing/README.md` — Added omnichannel-session-continuity row (IN PROGRESS, 2 iterations, 4 gaps)
- [x] LLD: `docs/plans/2026-03-24-omnichannel-gap-closure-2-impl-plan.md` — Status DRAFT → DONE
- [x] Studio agents.md: `apps/studio/agents.md` — Added omnichannel learnings (settings panel pattern, API proxy pattern)

### Coverage Delta

| Type              | Before       | After        |
| ----------------- | ------------ | ------------ |
| E2E tests         | 28 (3 files) | 40 (4 files) |
| Integration tests | 15 (2 files) | 15 (2 files) |
| Unit tests        | 44 (3 files) | 54 (4 files) |
| **Total**         | **87**       | **109**      |

### Remaining Gaps

- GAP-004 (HIGH): Session-to-contact linking inconsistent across paths
- GAP-005 (HIGH): SDK contact linking race condition with early message persistence
- GAP-011 (MEDIUM): Audit events in-memory only (lost on restart)
- GAP-012 (LOW): SDK WS handlers accept contactId from message payload as fallback
- GAP-013 (MEDIUM): Recovery E2E tests not yet implemented

### Deviations from Plan

- OmnichannelAuditEvent confirmed as in-memory ring buffer (not Mongoose model) — LLD incorrectly referenced it for GDPR cascade; no cascade needed
- Env var `IDENTITY_OAUTH_AUTH_ENDPOINT` in LLD was incorrect — actual is `IDENTITY_OAUTH_AUTHORIZATION_ENDPOINT`

### Audit Findings

| Round | Verdict        | Critical | High | Medium | Low |
| ----- | -------------- | -------- | ---- | ------ | --- |
| 1     | NEEDS_REVISION | 0        | 1    | 2      | 0   |

- HIGH: Env var name mismatch (AUTH vs AUTHORIZATION) — fixed
- MEDIUM: HLD has no status field — accepted (HLD is stable reference doc)
- MEDIUM: Studio agents.md missing omnichannel learnings — fixed

---

## Cross-Channel E2E + Production Wiring Audit (2026-03-24)

### Documents Updated

- [x] Feature spec: `docs/features/omnichannel-session-continuity.md` — Added "Wired" column to both API tables (systemic convention for distinguishing code-exists from production-reachable), added `server.ts` to Key Implementation Files, added GAP-020 through GAP-024 (production wiring gaps), updated cross-channel E2E rows 8-13 from PLANNED to PASS, updated test counts (46 E2E, 115 total)
- [x] Test spec: `docs/testing/omnichannel-session-continuity.md` — Added "Production Wiring Verification" section (OCS-W01 through OCS-W06) as a new test category, added regression risks OCS-R13/R14 for server.ts registration and recall pipeline wiring, updated cross-channel test file from PLANNED to PASS (6), updated coverage map checkboxes (cross-channel recall, allowedChannels filter, identity tier gating), updated total test count to 115
- [x] HLD: `docs/specs/omnichannel-session-continuity.hld.md` — Added "Activation and Enablement Chain" section documenting 4-gate enablement (plan tier, project settings, consent, identity tier), lazy settings initialization, agent IR opt-in, and production wiring requirement
- [x] LLD: `docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md` — Unchecked 3 falsely-done wiring items: router mount (GAP-020), recall integration caller (GAP-021), widget discovery population (GAP-022). Added detailed annotations explaining what was done vs what remains.

### Coverage Delta

| Type              | Before       | After        |
| ----------------- | ------------ | ------------ |
| E2E tests         | 40 (4 files) | 46 (5 files) |
| Integration tests | 15 (2 files) | 15 (2 files) |
| Unit tests        | 54 (4 files) | 54 (4 files) |
| **Total**         | **109**      | **115**      |

### New Gaps Documented

- GAP-020 (CRITICAL): Omnichannel HTTP router not mounted in production `server.ts`
- GAP-021 (HIGH): `executeOmnichannelRecall()` exported but never called from production code
- GAP-022 (HIGH): SDK `UnifiedWidget.discoveredSession` never populated in production
- GAP-023 (MEDIUM): Studio audit BFF route has no rendering component
- GAP-024 (HIGH): Settings unreachable in production due to GAP-020

### Systemic Issues Addressed

Three systemic documentation issues were identified and fixed at the convention level:

1. **Feature spec API tables now include a "Wired" column** — distinguishes "code exists" from "reachable in production". Convention note added below the table explaining YES/NO/PARTIAL semantics.
2. **Test spec now has a "Production Wiring Verification" category** — separate from E2E and integration tests. Checks that implemented code is reachable from production entry points, not just testable in isolated harnesses.
3. **LLD wiring checklist items annotated with verification evidence** — falsely-checked items now include explanatory annotations. Future LLD wiring verification should include `grep` commands or import traces proving callability, not just file existence.

---

## Runtime / Channel Alignment Refresh (2026-04-03)

### Documents Updated

- Feature spec: `docs/features/omnichannel-session-continuity.md` — corrected the `/ws/sdk` contract to the actual subprotocol-based auth shape
- Test spec: `docs/testing/omnichannel-session-continuity.md` — refreshed current-state narrative and SDK authentication health note so it matches the channel/runtime hardening completed after 2026-03-30
- Testing index: `docs/testing/README.md` — last-updated/status row refreshed

### Notes

- This refresh does **not** change the counted 115 omnichannel tests or the tracked GAP-020 through GAP-024 wiring issues.
- The point of the sync was to keep omnichannel docs aligned with the runtime/channel hardening that now underpins it: subprotocol auth on `/ws/sdk` and channel-side provider-verification policy normalization.
