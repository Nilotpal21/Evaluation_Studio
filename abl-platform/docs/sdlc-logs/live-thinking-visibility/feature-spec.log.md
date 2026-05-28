# SDLC Log: Live Thinking Visibility (B05) — Feature Spec

**Date**: 2026-04-05
**Phase**: FEATURE-SPEC
**Artifact**: `docs/features/live-thinking-visibility.md`

## Oracle Decisions

All 18 clarifying questions answered. Zero AMBIGUOUS — no user escalation needed.

| #   | Question                   | Classification | Key Decision                                                             |
| --- | -------------------------- | -------------- | ------------------------------------------------------------------------ |
| 1   | What problem?              | ANSWERED       | 15-30s dead time, zero visibility, all phases affected                   |
| 2   | Out of scope?              | ANSWERED       | Persistence, file upload activity, parallel build, verbosity settings    |
| 3   | New or enhancement?        | ANSWERED       | New capability on existing SSE infrastructure                            |
| 4   | Priority?                  | ANSWERED       | CRITICAL — affects how every feature feels                               |
| 5   | Prior attempts?            | ANSWERED       | 3 prior models (progress, step\_\*, status_update) — all superseded      |
| 6   | Personas?                  | INFERRED       | Solution architects (onboarding), developers (in-project)                |
| 7   | User journeys?             | ANSWERED       | 5 phases: Interview, Blueprint, Build, Create, In-Project                |
| 8   | Must-have vs nice-to-have? | INFERRED       | Phase 1 (Interview) is must-have; Build/Create/InProject in later phases |
| 9   | Performance?               | ANSWERED       | RAF batching, memoization, 1/sec SR debounce, no layout shift            |
| 10  | Interactions?              | ANSWERED       | SSE streaming, executor, useArchChat, IDE panel, journal (dedup)         |
| 11  | Packages?                  | ANSWERED       | arch-ai, apps/studio (2 packages)                                        |
| 12  | Data models?               | ANSWERED       | No DB changes. Zod schema + frontend types only                          |
| 13  | Security?                  | ANSWERED       | Label safety: field names not values. No new auth flows                  |
| 14  | Deployment?                | ANSWERED       | ARCH_ACTIVITY_ENABLED flag, 4-phase rollout                              |
| 15  | External deps?             | ANSWERED       | None                                                                     |
| 16  | Protocol plan?             | ANSWERED       | activity replaces step\_\*/status_update. progress kept for CREATE only  |
| 17  | Frontend targets?          | ANSWERED       | useArchChat + /arch + ArchOverlay (primary). Legacy secondary            |
| 18  | Message creation?          | ANSWERED       | Create on first activity event (option 2 of 3)                           |

## Files Created

- `docs/features/live-thinking-visibility.md` — Feature spec (17 sections)
- `docs/testing/live-thinking-visibility.md` — Testing guide (11 test cases)
- `docs/sdlc-logs/live-thinking-visibility/feature-spec.log.md` — This file

## Open Questions Carried Forward

1. Should journal_entry also render as info activity steps?
2. Should specialist event become activity group header?
3. Should correlationId be in v1?
