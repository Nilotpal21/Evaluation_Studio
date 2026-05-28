# LLD Log: Attachment Settings UI

**Date**: 2026-03-22
**Phase**: LLD
**Feature**: Studio Attachment Settings UI (sub-feature of Attachments)

---

## Oracle Decisions

15 questions asked across 3 categories (Implementation Strategy, Technical Details, Risk & Dependencies). All answered.

| #   | Category  | Question Summary                       | Classification | Decision                                                                                                    |
| --- | --------- | -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Q1  | Strategy  | Implementation order                   | DECIDED        | Bottom-up: GAP-002 → proxy → nav wiring → component → i18n → tests                                          |
| Q2  | Strategy  | Existing override/inherited indicators | ANSWERED       | No existing settings tab has inherited/overridden UX — this is the first                                    |
| Q3  | Strategy  | Feature flag needed?                   | ANSWERED       | No. Zero existing settings tabs use feature flags                                                           |
| Q4  | Strategy  | Phase scope split                      | DECIDED        | GAP-002 as Phase 0 (runtime package). Remaining as Phases 1-4 (studio package)                              |
| Q5  | Strategy  | File size input UX                     | DECIDED        | Numeric input in MB with suffix label. Convert bytes ↔ MB transparently                                     |
| Q6  | Technical | Exact file modifications               | ANSWERED       | 2 new files, 5 modified files. Exact line numbers for each insertion point verified                         |
| Q7  | Technical | Test-first or test-after               | DECIDED        | Tests alongside each phase. Resolver test in Phase 0, proxy tests in Phase 1, unit tests in Phase 3         |
| Q8  | Technical | i18n key pattern                       | ANSWERED       | `nav.attachments`, `settings.tabs.attachments`, `settings.attachments.*` — snake_case pattern               |
| Q9  | Technical | apiFetch modifications                 | ANSWERED       | Zero modifications. Works as-is for GET/PUT with auto-injected auth headers                                 |
| Q10 | Technical | Sidebar icon                           | DECIDED        | `Paperclip` from lucide-react — already used for attachments in ChatInput.tsx, already mocked in test setup |
| Q11 | Risk      | Conflicting changes                    | ANSWERED       | None. Working tree clean, no recent changes to the 4 critical files                                         |
| Q12 | Risk      | Biggest implementation risk (GAP-002)  | ANSWERED       | Genuinely ~5 lines. Additive, backward-compatible. No downstream type breakage                              |
| Q13 | Risk      | Team dependencies                      | INFERRED       | Self-contained. All changes in Platform team packages. Merge-friendly additive patterns                     |
| Q14 | Risk      | Monitoring/alerting                    | ANSWERED       | None needed. Runtime route already logs. No new background jobs or async processes                          |
| Q15 | Risk      | Definition of done                     | ANSWERED       | FR-1–FR-10 functional, 23 unit + 8 integration + 8 E2E passing, GAP-002 resolved                            |

## Escalations

None — all questions resolved without user input.

## Audit Rounds

| Round | Auditor       | Verdict        | Findings                                                                                                |
| ----- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | lld-reviewer  | NEEDS_CHANGES  | 0 CRITICAL, 3 HIGH (response type comment, computeDiff pendingNulls, UT-6 bytes-vs-MB), 5 MEDIUM, 2 LOW |
| 2     | lld-reviewer  | NEEDS_CHANGES  | 0 CRITICAL, 3 HIGH (load deps [projectId], error label, phase count), 3 MEDIUM, 2 LOW                   |
| 3     | lld-reviewer  | APPROVED       | 0 CRITICAL, 0 HIGH, 2 MEDIUM (RuntimeApiHarness router note, Zustand atomic selector), 2 LOW            |
| 4     | phase-auditor | NEEDS_REVISION | 0 CRITICAL, 3 HIGH (UT-6 MB alignment, i18n ~38 count, E2E-1 defaultProcessingMode), 3 MEDIUM           |
| 5     | lld-reviewer  | APPROVED       | 0 CRITICAL, 0 HIGH, 0 MEDIUM. All prior findings resolved. Ready for implementation.                    |

## Key Design Decisions

1. **D-1: Bottom-up order** — GAP-002 resolver → proxy → nav+component+i18n → E2E tests
2. **D-2: GAP-002 as Phase 0** — separate runtime change, independently testable
3. **D-3: MB input (not bytes)** — matches wireframe, simpler UX, BYTES_PER_MB constant
4. **D-4: Paperclip icon** — already used in ChatInput.tsx, universally recognized
5. **D-5: Tests alongside phases** — catches integration errors early per phase
6. **D-6: No feature flag** — all 11 existing settings tabs ship unconditionally
7. **D-7: New inherited/override UX** — first settings tab with this pattern
8. **D-8: "Security & Observability" nav section** — alongside PII protection
9. **D-9: pendingNulls Set for reset tracking** — distinguishes "unchanged" from "reset to default"
10. **D-10: Merged nav wiring + component into Phase 2** — avoids broken placeholder deployment

## Files Created

- `docs/plans/2026-03-22-attachment-settings-ui-impl-plan.md` — LLD + implementation plan
- `docs/sdlc-logs/attachment-settings-ui/lld.log.md` — This log
