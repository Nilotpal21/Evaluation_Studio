# HLD Log: Attachments Gap Closure

**Date**: 2026-03-23
**Phase**: HLD
**Feature**: attachments-gap-closure (BETA → STABLE)

## Oracle Decisions

All 13 clarifying questions answered — 0 AMBIGUOUS.

| #   | Classification | Decision                                                                         |
| --- | -------------- | -------------------------------------------------------------------------------- |
| Q1  | ANSWERED       | AWAIT_ATTACHMENT follows GatherExecutor pattern (session suspension + resume)    |
| Q2  | DECIDED        | Tenant config UI goes in Admin portal (`apps/admin`), not Studio                 |
| Q3  | INFERRED       | Use `createLogger` from `@abl/compiler/platform` (codebase standard)             |
| Q4  | DECIDED        | Use test doubles (stub HTTP servers), not Docker Compose services                |
| Q5  | INFERRED       | All 5 gaps can be parallelized — zero file-level overlap                         |
| Q6  | ANSWERED       | Compiler needs new DSL parser section for AWAIT_ATTACHMENT                       |
| Q7  | INFERRED       | Admin RBAC: VIEWER for GET, ADMIN for PUT (existing pattern)                     |
| Q8  | ANSWERED       | GAP-002 is purely test harness fix — no production code changes                  |
| Q9  | INFERRED       | No special logging requirements beyond standard createLogger                     |
| Q10 | INFERRED       | GAP-005 (AWAIT_ATTACHMENT) is highest risk — most new code, flow execution path  |
| Q11 | INFERRED       | No production DSL uses AWAIT_ATTACHMENT — parser blocks it                       |
| Q12 | DECIDED        | Big-bang logging migration (all 61 calls, single commit)                         |
| Q13 | ANSWERED       | GAP-003/005 (Medium) must be resolved or accepted for STABLE; Low gaps can defer |

## Audit Rounds

| Round | Verdict        | CRITICAL | HIGH | MEDIUM | Key Fixes                                                                                     |
| ----- | -------------- | -------- | ---- | ------ | --------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 2        | 3    | 0      | IR schema mismatch (category/on_timeout), GatherExecutor reference, FFmpeg test double        |
| 2     | NEEDS_REVISION | 1        | 3    | 0      | Admin route paths, session Redis serialization, step type ternary ordering, VideoProcessor DI |
| 3     | APPROVED       | 0        | 2    | 2      | Removed stale "in-memory only" heading, resolved Open Question #1, SESSION_JSON_FIELDS fix    |

## Commit

- **Hash**: a48b50a82
- **Message**: `[ABLP-2] docs(compiler): add attachments-gap-closure HLD for BETA→STABLE promotion`
- **Artifact**: `docs/specs/attachments-gap-closure.hld.md` (464 lines)
