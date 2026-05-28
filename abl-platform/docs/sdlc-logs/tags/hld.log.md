# HLD Log: Tags & Eval Tags

**Feature**: Tags & Eval Tags
**Phase**: HLD
**Date**: 2026-03-23

---

## Oracle Decisions

### Architecture & Data Flow

| #   | Question                              | Answer                                                                                                           | Classification |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Preferred architecture pattern?       | In-route TagService class with extracted service layer. Matches existing runtime patterns (services dir).        | DECIDED        |
| 2   | Data flow -- request or event-driven? | Both. API requests for CRUD/apply/remove; synchronous event for auto-apply on session lifecycle.                 | DECIDED        |
| 3   | Expected scale?                       | < 100 tag rules/project, < 50 tags/session, < 10 concurrent tag ops/sec/project. Low scale, no scaling concerns. | INFERRED       |
| 4   | Existing patterns to follow?          | Lazy-import pattern for models (existing in tags.ts), OpenAPI router (existing), tenant-scoped queries.          | ANSWERED       |
| 5   | Deployment topology?                  | Single runtime service, no workers. All logic runs in the existing Express process.                              | DECIDED        |

### Integration & Dependencies

| #   | Question                          | Answer                                                                                                                  | Classification |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Existing service dependencies?    | pipeline-engine (TagRuleModel), database (Session, EvalScenario), shared-auth (requireProjectScope), clickhouse client. | ANSWERED       |
| 2   | New external dependencies?        | None. All infrastructure already provisioned.                                                                           | ANSWERED       |
| 3   | API contract with consumers?      | Standard { success, data?, error? } envelope. Studio proxies to runtime. No SDK/channel consumers.                      | ANSWERED       |
| 4   | Breaking changes?                 | None. POST /apply gains MongoDB write (additive). PUT /rules gains validation (tightening, not breaking).               | DECIDED        |
| 5   | Compile-deploy-execute lifecycle? | No interaction. Tags are runtime/analytics concern, no DSL/IR integration.                                              | ANSWERED       |

### Risk & Migration

| #   | Question                | Answer                                                                                                                              | Classification |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Biggest technical risk? | Dual-write consistency between MongoDB and ClickHouse. Mitigated by making ClickHouse write non-blocking with logged failures.      | DECIDED        |
| 2   | Data migration needed?  | None. All schemas exist. Existing Session.tags arrays are empty (never written by API) -- no backfill needed.                       | ANSWERED       |
| 3   | Rollback strategy?      | All changes additive. Remove Studio UI by reverting nav. Disable auto-apply via runtime config flag. New endpoints are independent. | DECIDED        |
| 4   | Feature flags?          | tags.autoApply.enabled runtime config flag for auto-apply. No flags for other features (they're independently deployable).          | DECIDED        |
| 5   | Blast radius?           | Very low. Tag operations don't affect core session lifecycle or agent execution. Auto-apply failure is caught and logged.           | DECIDED        |

---

## Design Decisions Made

1. **Option A chosen**: In-route TagService (synchronous) over BullMQ workers or ClickHouse-native evaluation
2. **Dual-write strategy**: MongoDB is source of truth, ClickHouse is analytics mirror. ClickHouse failures logged but not blocking.
3. **Auto-apply**: Synchronous call from session lifecycle, < 10ms expected. BullMQ deferred unless latency becomes measurable.
4. **Tag removal in ClickHouse**: ALTER TABLE DELETE (async mutation, eventually consistent).
5. **Batch size**: 500 sessions max per bulk operation.
6. **Color validation**: Freeform hex with regex.
7. **New index**: Recommend `{ tenantId, projectId, tags }` multikey index on sessions (deferred pending index count review).

## Files Created

- `docs/specs/tags.hld.md` -- High-Level Design document
- `docs/sdlc-logs/tags/hld.log.md` -- This file
