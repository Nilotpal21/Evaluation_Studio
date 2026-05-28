# SDLC Log: Omnichannel Session Continuity — LLD Phase

**Feature**: omnichannel-session-continuity
**Phase**: LLD (Phase 4)
**Started**: 2026-03-22
**Status**: IN PROGRESS

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items — no user escalation needed.

### Implementation Strategy

| #   | Question                     | Classification   | Decision                                                               |
| --- | ---------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Q1  | Implementation order         | ANSWERED         | Follow HLD rollout: Phase 0→1→2→3                                      |
| Q2  | Feature flags                | ANSWERED+DECIDED | Tenant-level `requireFeature()` + project YAML sub-capabilities        |
| Q3  | projectId on messages        | DECIDED          | Required field with migration backfill (precedent: `20260305_009`)     |
| Q4  | Identity verification wiring | ANSWERED         | Prerequisite dependency — separate LLD dated 2026-03-22 handles it     |
| Q5  | Phase 1 channel scope        | ANSWERED         | All three: web, mobile, voice (recall is channel-agnostic server-side) |

### Technical Details

| #   | Question                   | Classification | Decision                                                            |
| --- | -------------------------- | -------------- | ------------------------------------------------------------------- |
| Q6  | Multi-participant registry | DECIDED        | Separate Redis-backed service, not extension of pod-local registry  |
| Q7  | Sequence allocation        | DECIDED        | Redis INCR — atomic, O(1), fits per-session monotonic requirement   |
| Q8  | Message recall index       | DECIDED        | Direct compound index `{tenantId, projectId, contactId, createdAt}` |
| Q9  | Consent model              | DECIDED        | Separate Mongoose model (project-scoped, independent lifecycle)     |
| Q10 | Widget evolution           | DECIDED        | Evolve existing UnifiedWidget (feature spec says "must evolve")     |

### Risk & Dependencies

| #   | Question                 | Classification | Decision                                                                                                   |
| --- | ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------- |
| Q11 | Conflicting changes      | ANSWERED       | 3 active plans: identity-verification (prerequisite), cross-channel auth (watch), A2A sessions (low risk)  |
| Q12 | Recall cache strategy    | DECIDED        | No Redis cache initially — direct MongoDB with timeout (different access pattern vs ContactContextService) |
| Q13 | Studio settings pattern  | INFERRED       | Follow existing tab pattern in ProjectSettingsPage                                                         |
| Q14 | channelHistory alignment | DECIDED        | Keep separate — different purposes (session traversal vs contact lifetime)                                 |
| Q15 | Monitoring scope         | DECIDED        | Include metric emission in LLD; defer alerting configuration                                               |

---

## Audit Rounds

### Round 1: Architecture Compliance (lld-reviewer)

**Verdict**: NEEDS_CHANGES
**Findings**: 4 CRITICAL, 7 HIGH, 5 MEDIUM, 2 LOW
**Key fixes**:

- C-01: Studio route path `[projectId]` → `[id]`
- C-02: Feature gate uses PLAN_FEATURES in shared-kernel, not "register in feature-gate.ts"
- C-03: Use fail-closed feature gate for cross-session data access
- C-04: Use `requireProjectScope('projectId', { concealOutOfScope: true })` for 404 on cross-project
- H-01: Added Zod validation schemas for all routes
- H-02: Addressed both WebSocket registries (ConnectionRegistry + ConnectionManager)
- H-05: Added i18n specification
- H-06: Added payload size validation (64KB) for recall
- H-07: Specified Redis key TTLs (24h live session, 4h participants, configurable join token)

### Round 2: Pattern Consistency (lld-reviewer)

**Verdict**: NEEDS_CHANGES
**Findings**: 3 CRITICAL, 6 HIGH, 5 MEDIUM, 2 LOW
**Key fixes** (overlapping with R1, plus):

- PC-03: Backward-compatible connection registry evolution (keep `getConnectionForSession` for ChannelDispatcher)
- PC-04: Use `authMiddleware` not `requireAuth()` (matches existing runtime pattern)
- PC-05: Added Studio navigation sidebar registration
- PC-06: Studio API uses `withRouteHandler` pattern
- PC-08: Noted `projectId?` optional in MessageJobData for gradual migration
- PC-11: Rate limiting applied from Phase 1 (not deferred to Phase 4)

### Round 3: Completeness (lld-reviewer)

**Verdict**: NEEDS_CHANGES
**Findings**: 2 CRITICAL, 4 HIGH, 5 MEDIUM, 2 LOW
**Key fixes**:

- R3-01: Refactor `createModuleFeatureGate()` into generic `createFailClosedFeatureGate(featureName)` (current API accepts no params)
- R3-02: Fixed remaining Phase 4 `[projectId]` → `[id]`
- R3-04: Added GAP-010 task (compiler IR omnichannel block)
- R3-05: Added VoiceClient modification task
- R3-07: Specified message creation file paths (message-persistence-queue.ts, sdk-handler.ts, execution services)

### Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict**: NEEDS_REVISION
**Findings**: 2 CRITICAL, 5 HIGH, 3 MEDIUM
**Key fixes**:

- XP-1/GAP: Added GAP-009 task (voice adapter identity normalization) and GAP-010 task
- XP-5: Added full Studio 5-step wiring checklist (navigation-store.ts, settingsSubPages, settingsPageMap, ProjectSidebar, AppShell)
- XP-3: Added VoiceClient to modified files table and Phase 3 tasks
- XP-2: Added runtime audit endpoint (GET /api/projects/:projectId/omnichannel/audit)
- XP-1: Fixed OCS-E05 test reference mismatch in Phase 1 test strategy

### Round 5: Final Sweep (lld-reviewer)

**Verdict**: APPROVED
**Findings**: 1 MEDIUM (compiler IR path corrected), 1 LOW (task numbering cosmetic)
**All prior fixes verified present**:

- 30+ existing file paths verified
- Studio paths all use `[id]`
- Feature gate parameterization specified
- Connection registry backward compat confirmed
- All 10 feature spec gaps addressed
- Studio 5-step wiring complete
- VoiceClient task present
- Wiring checklist comprehensive (25+ items)

---

## Status: COMPLETE

**Date completed**: 2026-03-22
**Artifact**: `docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md`
**Next step**: Run `/implement omnichannel-session-continuity`
