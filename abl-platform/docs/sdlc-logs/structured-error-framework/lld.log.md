# SDLC Log: Structured Error Framework — LLD

**Phase**: LLD (Phase 4)
**Date**: 2026-03-25
**Skill**: `/lld`

---

## Oracle Decisions

| #   | Question                                | Classification | Decision                                                                                                                                                                       |
| --- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Implementation order?                   | DECIDED        | Foundation → Security P0 → Middleware → Enforcement → Route migration → Client-side → Classifiers → Docs. Security before middleware because P0 fixes only need ErrorRegistry. |
| 2   | Route migration granularity?            | DECIDED        | Group by domain, 2-4 files per commit (~25 batches). Domain grouping reduces context-switching. Stays within 40-file commit limit.                                             |
| 3   | Studio/Admin parallel track?            | DECIDED        | Separate phases. Admin is trivial (1-2 files). Studio builds parser → ErrorBadge → ErrorCard → ErrorPage.                                                                      |
| 4   | i18n phasing?                           | DECIDED        | Infrastructure in Phase 1, locale files deferred. English-only initial release. G13 is a stretch goal.                                                                         |
| 5   | Test-first or test-after?               | DECIDED        | Enforcement (fitness tests + hooks) BEFORE migration. Phase tests written alongside. Security tests with P0 fixes.                                                             |
| 6   | ErrorRegistry vs ErrorCodes?            | DECIDED        | ErrorRegistry EXTENDS ErrorCodes (coexist). Zero consumer breakage — 152 usages across 34 files unchanged.                                                                     |
| 7   | ErrorCatalog key alignment?             | DECIDED        | Keep ErrorCatalog keys as-is. messageKey field in ErrorRegistry provides the mapping. Many-to-one relationship.                                                                |
| 8   | MongoErrorCode → ErrorRegistry mapping? | DECIDED        | classifyDbError() function maps 10 codes. DUPLICATE_KEY→CONFLICT, TIMEOUT→SERVICE_UNAVAILABLE, etc. No MongoAppError modification.                                             |
| 9   | ServerMessages.error() signature?       | DECIDED        | Overload: error(msg) defaults code='INTERNAL_ERROR', error(code, msg) uses provided code. Migrate 60+ callsites incrementally.                                                 |
| 10  | asyncHandler scope?                     | ANSWERED       | Simple try/catch → next(err). Classification in global error handler per HLD. ~10 lines.                                                                                       |
| 11  | Biggest per-phase risk?                 | DECIDED        | Phase 5 (route migration) is HIGHEST — 668 responses, 94 files, status code changes, client dependency on specific strings.                                                    |
| 12  | Concurrent work conflicts?              | ANSWERED       | feature/five9-adapter branch modifying handler.ts/sdk-handler.ts. server.ts and chat.ts recently modified. Foundation phases (1-2) safe.                                       |
| 13  | Build verification strategy?            | DECIDED        | `pnpm build --filter=<pkg>` per commit, full build per phase. Dependency order: shared-kernel → i18n → database → runtime → studio/admin.                                      |
| 14  | ToolErrorCode alignment?                | DECIDED        | All 16 ToolErrorCodes in ErrorRegistry. Coarser mapping for HTTP (~8 codes). Full granularity in tool results for AI agent self-recovery.                                      |
| 15  | Rollback safety?                        | ANSWERED       | Safe — rolled-back routes use inline res.json() (never reach global handler). Global handler has res.headersSent guard.                                                        |

No AMBIGUOUS items — all resolved from codebase, feature spec, HLD, and architectural principles.

---

## LLD Summary

| Section        | Content                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phases         | 8 phases: Foundation, Security P0, Middleware, Enforcement, Route Migration, Client-side, Classifiers, Docs/Cleanup       |
| New files      | 21 (async-handler, classify-db-error, 2 lint hooks, 3 Studio components, 5 E2E test files, 9 integration test files)      |
| Modified files | 18+ (shared-kernel errors, i18n, server.ts, events.ts, handler.ts, sdk-handler.ts, 94 route files, fitness tests, Studio) |
| Key decisions  | 13 (ErrorRegistry extends ErrorCodes, overloaded events.error, classifyDbError, headersSent guard, Prometheus deferred)   |
| Open questions | 5 (docs auth, ClickHouse migration, Studio component library, Prometheus, Five9 conflict)                                 |

## Audit Rounds

| Round | Auditor       | Status         | Findings                                                                                                                                                                                                                                                                                                              |
| ----- | ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | lld-reviewer  | NEEDS_REVISION | 2C (ServerMessage type missing, overload syntax invalid for plain object), 4H (statusCode injection, kms-admin description), 5M. All fixed.                                                                                                                                                                           |
| 2     | lld-reviewer  | NEEDS_REVISION | 2C (ErrorRegistry type annotation erases literals, hook registration wrong file), 4H. All fixed.                                                                                                                                                                                                                      |
| 3     | lld-reviewer  | NEEDS_REVISION | 5C (5 file path errors: trace-store, clickhouse-audit-store, agent-registry-adapter, redis-client, tool-executor-adapter), 6H (missing delivery tasks, wrong INT refs, incomplete wiring), 4M. All fixed.                                                                                                             |
| 4     | phase-auditor | NEEDS_REVISION | 2C (test file names mismatch test spec Section 8, INT-5 reference wrong), 5H (phase mapping missing, task 1.5 deviation, D-13 Prometheus, WS handler count, deferred work for G13). All fixed.                                                                                                                        |
| 5     | lld-reviewer  | APPROVED       | 0C, 0H, 6M (SEC-5/6/7 phase assignment clarified, ClickHouse wiring contradiction fixed, Studio i18n note logged, deprecated tool-executor-adapter.ts noted, error-handler-router.ts noted, UT-3 getRegistryEntry API mismatch noted), 1L (duplicate path fixed). 3 MEDIUM fixed, 3 MEDIUM logged for implementation. |

## Files Modified

| File                                                            | Action           |
| --------------------------------------------------------------- | ---------------- |
| `docs/plans/2026-03-25-structured-error-framework-impl-plan.md` | Created LLD      |
| `docs/sdlc-logs/structured-error-framework/lld.log.md`          | Created this log |

## Next Steps

- Run 5 audit rounds (lld-reviewer x3, phase-auditor x1, lld-reviewer x1)
- Commit LLD after audits pass
- User runs `/implement structured-error-framework` next
