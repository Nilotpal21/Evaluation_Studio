# SDLC Log: SDK Chat UI Consolidation — Post-Impl Sync

**Feature**: sdk-chat-ui-consolidation
**Phase**: POST-IMPL-SYNC
**Date**: 2026-03-26

## Documents Updated

- Feature spec: `docs/features/sub-features/sdk-chat-ui-consolidation.md` — Status PLANNED→ALPHA, updated test table, added gaps
- Test spec: `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — Status PLANNED→IN PROGRESS, coverage matrix updated
- Testing index: `docs/testing/README.md` — Coverage column updated
- HLD: `docs/specs/sdk-chat-ui-consolidation.hld.md` — Status DRAFT→IMPLEMENTED
- LLD: `docs/plans/2026-03-25-sdk-chat-ui-consolidation-impl-plan.md` — Status→COMPLETE

## Coverage Delta

| Type              | Before | After                |
| ----------------- | ------ | -------------------- |
| Unit tests        | 0      | 8 files, 200+ tests  |
| Integration tests | 0      | 6 files, 180+ tests  |
| E2E tests         | 0      | 0 (deferred to BETA) |

## Deviations from Plan

- Turbopack cannot resolve .js→.ts extensions; required esbuild post-build script
- StreamingMessage activation deferred — users see typing indicator during streaming
- Attachment forwarding bug (PROD-2) found and fixed during review rounds 4-5
- 1 pre-existing Studio test failure (StudioChatHeader badge i18n)

## Remaining Gaps

- E2E tests (10 scenarios defined, 0 implemented)
- Security tests (5 scenarios defined, 0 implemented)
- Performance tests (4 scenarios defined, 0 implemented)
- MessageList auto-scroll UX (PROD-5)
- Streaming text display (PROD-12)

---

## Follow-Up Sync (2026-04-03)

### Documents Updated

- Feature spec: `docs/features/sub-features/sdk-chat-ui-consolidation.md` — status raised to BETA, stale "feature-branch only" language removed, gaps/testing updated to reflect merged browser and regression coverage
- Test spec: `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — coverage matrix updated, current-state note added, and file mapping corrected to the actual suites on this branch
- HLD: `docs/specs/sdk-chat-ui-consolidation.hld.md` — test-strategy section updated with real browser/perf suites
- LLD: `docs/plans/2026-03-25-sdk-chat-ui-consolidation-impl-plan.md` — post-implementation notes added, E2E placeholder filenames corrected

### Coverage Delta

| Area                     | 2026-03-26 log | 2026-04-03 sync                                                        |
| ------------------------ | -------------- | ---------------------------------------------------------------------- |
| Browser E2E              | 0 implemented  | `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` present           |
| Browser / perf           | 0 implemented  | `apps/studio/e2e/sdk-chat-performance.spec.ts` present                 |
| Post-cutover regressions | not documented | session-switch and nested-StringsProvider regression suites documented |

### Remaining Gaps

- Dedicated backwards-compat browser coverage is still lighter than the core browser matrix plus Path A integration coverage.
- `AuthChallengeMessage` remains Studio-only.
- Voice UI consolidation remains deferred.
- MessageList auto-scroll remains an open UX enhancement.
