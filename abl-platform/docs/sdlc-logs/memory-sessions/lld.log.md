# SDLC Log: memory-sessions / LLD (Phase 4)

**Date**: 2026-03-22
**Phase**: LLD (Low-Level Design)
**Artifact**: `docs/plans/memory-sessions.lld.md`

---

## Clarifying Questions & Decisions

### Implementation Strategy

| #   | Question                        | Classification | Answer                                                                                                                                           |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Preferred implementation order? | DECIDED        | Security fixes first (GAP-007, GAP-008), then E2E gap closure, then debt cleanup. Rationale: HIGH severity security gaps should not remain open. |
| 2   | Feature flag needed?            | DECIDED        | No. Changes are surgical (single function fix, key format change, test additions, logger replacement). No new features being introduced.         |
| 3   | Acceptable scope for this LLD?  | DECIDED        | Gap closure and hardening only. Compaction enablement (GAP-004) deferred to separate LLD.                                                        |

### Technical Details

| #   | Question                                      | Classification | Answer                                                                                                                                      |
| --- | --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Which files need modification vs creation?    | ANSWERED       | Phase 1: 4 modified files. Phase 2: 2 new E2E test files. Phase 3: 1 modified file. Phase 4: 3 doc files updated.                           |
| 5   | Where is getAuthorizedRuntimeSession defined? | ANSWERED       | Need to trace via grep. Likely in `apps/runtime/src/services/identity/` or handler files. The fix point is wherever messageType is checked. |
| 6   | Where are Redis Pub/Sub channel keys defined? | ANSWERED       | Need to trace via grep. Likely in WebSocket handler or a session events module.                                                             |

### Risk & Dependencies

| #   | Question                                   | Classification | Answer                                                                                                                                                |
| --- | ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Other ongoing changes that could conflict? | INFERRED       | No known concurrent work on session ownership or Pub/Sub. The session subsystem is STABLE with low change velocity.                                   |
| 8   | Biggest implementation risk?               | DECIDED        | messageType fix could break a handler that intentionally omits it. Mitigation: search all call sites and use fallback-to-strict instead of rejection. |

---

## Self-Audit Checklist

- [x] Decision log with rationale and rejected alternatives
- [x] Key interfaces documented (no changes planned)
- [x] Module boundaries identified with specific change scope
- [x] File-level change map for all 4 phases
- [x] Exit criteria for each phase
- [x] Wiring checklist with specific integration points
- [x] Database migration plan (none needed)
- [x] Test implementation plan with assertions
- [x] Rollback strategy per phase
- [x] Risk assessment with likelihood/impact/mitigation
- [x] Implementation order with dependencies
- [x] Effort estimates
- [x] Success criteria checklist
