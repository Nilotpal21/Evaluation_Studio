# SDLC Log: Kore Adapter — HLD Phase

**Date**: 2026-03-30
**Phase**: HLD (Phase 3 of SDLC pipeline)
**Skill**: `/hld kore-adapter`

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Zero AMBIGUOUS — no user escalation.

### Key Decisions

| #   | Decision                                                                                   | Classification |
| --- | ------------------------------------------------------------------------------------------ | -------------- |
| D-1 | Follow Five9 HLD template structure with Kore-specific additions (lazy orgId, HMAC, tools) | DECIDED        |
| D-2 | SmartAssistClient dual transport pattern is final (undici Pool + native fetch)             | ANSWERED       |
| D-3 | Singleton adapter with per-execution config snapshot (Option A) recommended over clone (B) | DECIDED        |
| D-4 | OrgId resolution failure is non-blocking — transfer proceeds with degraded webhook routing | ANSWERED       |
| D-5 | GAP-008 singleton stale orgId is the biggest technical risk                                | ANSWERED       |

### Alternatives Analysis

- **Option A** (Enhanced Singleton): Recommended — minimal change, proven pattern, config snapshot in execute()
- **Option B** (Per-Execution Clone): Stronger isolation but deferred — concurrent multi-tenant scenario is rare
- **Option C** (Adapter-per-Connection Registry): Over-engineered for 2 adapters

## Files Created/Modified

| File                                         | Action   | Purpose                              |
| -------------------------------------------- | -------- | ------------------------------------ |
| `docs/specs/kore-adapter.hld.md`             | Created  | Full HLD with 12 sections            |
| `docs/features/sub-features/kore-adapter.md` | Modified | Fixed "8 ABL types" → "10" in FR-13  |
| `docs/testing/sub-features/kore-adapter.md`  | Modified | Fixed "8 ABL types" → "10" in matrix |
| `docs/sdlc-logs/kore-adapter/hld.log.md`     | Created  | This log file                        |

## Audit Rounds

### Round 1: NEEDS_REVISION (0 CRITICAL, 3 HIGH)

- HIGH: "8 distinct ABL event types" inaccurate — actual code has 10 (recurring cross-artifact error)
- HIGH: Test Strategy Concern #12 said "6 unit tests" — should say "6 unit test groups (~30 cases)"
- HIGH: Rollback plan missing active session handling details

**Fixes applied:**

- Updated "8 ABL types" → "10" across HLD, feature spec FR-13, and test spec coverage matrix
- Changed "6 unit tests" → "6 unit test groups (UT-1 through UT-6, ~30 individual cases)"
- Enhanced rollback plan with active session message loss, manual SmartAssist closure, Studio/runtime independence, backward compat E2E prerequisite

### Round 2: NEEDS_REVISION (0 CRITICAL, 2 HIGH)

- HIGH: metadata encryption column said "No" — actual code encrypts metadata
- HIGH: ConnectorConnection table mixed per-connection fields with env-only config fields

**Fixes applied:**

- Changed metadata Encrypted column from No to Yes
- Updated Concern #4(b) to mention metadata encryption alongside providerData
- Split ConnectorConnection table into per-connection (7 fields) and SmartAssistConfig env-only (3 fields)
- Fixed data flow Step 3 function signatures to match code (single-parameter with config comment)

### Round 3: APPROVED (0 CRITICAL, 0 HIGH, 1 MEDIUM)

- MEDIUM: Redis session field `lastActivityAt` vs actual code `lastHeartbeat` — deferred to post-impl-sync

## Final HLD Structure

- 12 sections: Overview, Problem Statement, Alternatives (3), Architecture (4 diagrams), 12 Concerns, Data Model, API Design (8+1 endpoints), Tools Integration, Cross-Cutting, Dependencies, Open Questions, References
- All 12 architectural concerns addressed substantively with code references
- 22 FRs traceable to design decisions
- 548 lines

## Next Phase

Run `/lld kore-adapter` to generate the Low-Level Design and implementation plan.
