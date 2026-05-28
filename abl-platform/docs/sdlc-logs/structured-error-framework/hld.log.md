# SDLC Log: Structured Error Framework — HLD

**Phase**: HLD (Phase 3)
**Date**: 2026-03-25
**Skill**: `/hld`

---

## Oracle Decisions

| #   | Question                                | Classification | Decision                                                                                                                                                      |
| --- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ErrorRegistry pattern?                  | ANSWERED       | Compile-time `as const` object — matches existing ErrorCodes and ErrorCatalog patterns. No Map, no JSON/YAML.                                                 |
| 2   | Error flow end-to-end?                  | ANSWERED       | throw AppError → asyncHandler catches → next(err) → global error handler → errorToResponse (duck-typing) → res.json + TraceEvent                              |
| 3   | Duck-typing bridging of 6 hierarchies?  | ANSWERED       | 4/6 reliably have code+statusCode. MongoAppError lacks statusCode, ToolExecutionError.statusCode optional → both fallback 500. No class modifications needed. |
| 4   | asyncHandler: standalone vs integrated? | DECIDED        | Standalone wrapper — separation of concerns, standard Express pattern, composable with other middleware.                                                      |
| 5   | Deployment topology?                    | ANSWERED       | shared-kernel + runtime + i18n primarily. SearchAI, Studio, Admin excluded (NG-1, NG-2).                                                                      |
| 6   | Package dependencies?                   | ANSWERED       | shared-kernel (primary), i18n (additive entries), shared-auth-profile/database/circuit-breaker (no changes).                                                  |
| 7   | i18n infrastructure?                    | ANSWERED       | Existing ErrorCatalog + formatErrorSync — no new infrastructure. Just add new message templates.                                                              |
| 8   | API contract backwards compat?          | ANSWERED       | Breaking for Shape A/B (error string→object). HTTP migrates immediately (internal). WS adds code alongside message (additive).                                |
| 9   | WS vs HTTP error paths?                 | ANSWERED       | HTTP: centralized via global handler. WS: distributed (30+ sends in sdk-handler), enhanced events.error() helper.                                             |
| 10  | Tracing integration?                    | ANSWERED       | Additive fields in TraceEvent.data bag. No TraceEvent interface changes. ClickHouse gains error_code column.                                                  |
| 11  | Biggest technical risk?                 | DECIDED        | 668 inline response migration (94 files, ~20 commits, SDK-breaking shape changes). Not the hierarchy bridging (~15 lines).                                    |
| 12  | Ratchet approach correct?               | ANSWERED       | Yes — established pattern (console.log ceiling=170, findById ceiling=48). Same infrastructure reused.                                                         |
| 13  | Rollback strategy?                      | DECIDED        | Per-route revert (remove asyncHandler). No feature flag needed. Each commit independently revertable.                                                         |
| 14  | Feature flags vs ratchet?               | DECIDED        | Ratchet only. Feature flags double code paths, spec's own flag is always-on (no value).                                                                       |
| 15  | Registry mapping blast radius?          | INFERRED       | Moderate and detectable. Compile-time `as const` catches typos. INT-4 test validates consistency. Single-file single-line fix.                                |

No AMBIGUOUS items — all resolved from feature spec, codebase patterns, and existing infrastructure.

---

## HLD Summary

| Section        | Content                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Alternatives   | 3 options: (A) Incremental enhancement, (B) Unified base class, (C) Error middleware service                                         |
| Recommendation | Option A — incremental enhancement with duck-typing and ratchet migration                                                            |
| Key components | ErrorRegistry (as const), StructuredError interface, asyncHandler wrapper, enhanced global error handler, enhanced WS events.error() |
| Data model     | No new collections. TraceEvent.data enriched. ClickHouse error_code column.                                                          |
| API changes    | 2 new endpoints (error docs). All 94 route files: error shape standardized.                                                          |
| Open questions | 5 (registry format, docs endpoint auth, SDK deprecation, code versioning, ClickHouse timing)                                         |

## Audit Rounds

| Round | Status         | Findings                                                                                                                                                                                   |
| ----- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | NEEDS_REVISION | 2 HIGH (AppError constructor signature, duck-typing 5/6→4/6), 4 MEDIUM (getW3CTraceId invented, SearchAI count 16→17, ClickHouse column spec, shared-observability dependency). All fixed. |
| 2     | NEEDS_REVISION | 1 HIGH (Recommendation section still said 5/6), 2 MEDIUM (traceId raw OTEL API→getCurrentTraceId, dependency table contradiction). All fixed.                                              |
| 3     | APPROVED       | 1 MEDIUM (non-blocking: import path note for LLD — use `@abl/compiler/platform/observability` not `@agent-platform/shared-observability` directly).                                        |

## Files Modified

| File                                                   | Action           |
| ------------------------------------------------------ | ---------------- |
| `docs/specs/structured-error-framework.hld.md`         | Created HLD      |
| `docs/sdlc-logs/structured-error-framework/hld.log.md` | Created this log |

## LLD Notes (from auditor)

1. Import path: Use `@abl/compiler/platform/observability` for `getCurrentTraceId` in runtime code
2. events.ts error helper: specify signature change from `error(message)` to `error(code, message)` and enumerate callsites
3. ErrorCodes count (28) should be re-verified at LLD time
4. MongoErrorCode → ErrorRegistry translation: LLD should decide the mapping strategy
5. Feature spec delivery plan (11 parent tasks) → map to LLD implementation phases with exit criteria

## Next Steps

- Commit HLD
- User runs `/lld structured-error-framework` next
