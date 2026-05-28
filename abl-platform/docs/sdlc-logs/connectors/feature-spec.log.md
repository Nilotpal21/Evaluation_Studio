# SDLC Log: Connectors Feature Spec

**Feature:** connectors
**Phase:** Feature Spec (Phase 1)
**Date:** 2026-03-22

## Summary

Re-generated the connectors feature spec via SDLC pipeline with code-grounded analysis across all 18 sections.

## Source Artifacts Read

- `docs/rfcs/RFC-006-connectors-platform.md` (existing 5-level RFC)
- `packages/connectors/src/types.ts` (canonical SDK types)
- `packages/connectors/src/registry.ts` (ConnectorRegistry)
- `packages/connectors/src/index.ts` (public API surface)
- `packages/connectors/src/loader.ts` (boot-time loading, 25 AP pieces)
- `packages/connectors/src/properties.ts` (property builder)
- `packages/connectors/src/auth/connection-resolver.ts` (OAuth2 refresh, distributed lock)
- `packages/connectors/src/auth/provider-config-registry.ts` (600+ Nango providers)
- `packages/connectors/src/executor/connector-tool-executor.ts` (action execution)
- `packages/connectors/src/executor/workflow-tool-executor.ts` (workflow invocation)
- `packages/connectors/src/triggers/trigger-engine.ts` (webhook/polling/cron)
- `packages/connectors/src/triggers/webhook-handler.ts` (HMAC, replay, dedup)
- `packages/connectors/src/services/connection-service.ts` (CRUD, OAuth complete)
- `packages/connectors/src/services/connector-listing-service.ts` (catalog API)
- `packages/connectors/src/compiler/connector-to-tool.ts` (ABL bridge)
- `packages/connectors/src/connectors/http/index.ts` (native HTTP connector)
- `packages/connectors/src/adapters/activepieces/runtime-adapter.ts` (AP wrapper)
- `packages/connectors/base/src/interfaces/connector.interface.ts` (IConnector)
- `packages/connectors/IMPLEMENTATION_STATUS.md` (18/18 tasks done)
- `apps/search-ai/src/repos/connector.repository.ts` (data access layer)
- `apps/search-ai/src/scheduler/connector-delta-sync.ts` (hourly delta scheduler)
- `docs/plans/2026-03-10-connector-catalog-redesign-design.md` (static catalog)
- Studio UI components (20+ files in `apps/studio/src/`)
- Runtime channel-oauth service (providers for Slack, MS Teams, Meta)
- 15+ database models across `packages/database/src/models/`

## Decisions

| ID  | Classification | Decision                                                                                                                  |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | ANSWERED       | Two connector tracks exist: SDK (lightweight) + Enterprise (IConnector)                                                   |
| D2  | ANSWERED       | 25 AP pieces loaded at boot; static catalog for Studio display                                                            |
| D3  | ANSWERED       | OAuth2 refresh uses Redis distributed lock (SET NX PX)                                                                    |
| D4  | ANSWERED       | Webhook handler has HMAC-SHA256 + connector-specific verify()                                                             |
| D5  | INFERRED       | Feature status is BETA based on implementation completeness (18/18 tasks, 34 test files) but incomplete E2E test coverage |

## Template Restructure (2026-03-25)

Restructured feature spec to match `docs/features/TEMPLATE.md`. Added: header fields, Goal/Summary subsections, Feature Classification & Integration Matrix, How to Consume, Key Implementation Files, Configuration, Non-Functional Concerns, Delivery Plan, Success Metrics, Open Questions, Gaps, Dependencies, Risks, Decision Log, Glossary, References.

### Audit Round 1: NEEDS_REVISION

| Severity | Count | Key Findings                                                                                 |
| -------- | ----- | -------------------------------------------------------------------------------------------- |
| HIGH     | 4     | FRs not testable, data model missing indexes, package structure diagram errors, scope naming |
| MEDIUM   | 3     | Subsection numbering, section reordering, duplicate Security section                         |

**Resolutions:** All 4 HIGH and 3 MEDIUM fixed. FRs rewritten as "The system must..." statements. Indexes added. Package diagram corrected. Scope renamed to Goals/Non-Goals. Duplicate §12 consolidated into §11.

### Audit Round 2: APPROVED

| Severity | Count | Key Findings                                                                    |
| -------- | ----- | ------------------------------------------------------------------------------- |
| HIGH     | 1     | permissionConfig.mode enum stale (full/simplified → enabled/disabled)           |
| MEDIUM   | 2     | FR-21 pipe chars breaking table, CLI commands not implemented with no GAP entry |

**Resolutions:** All 3 fixed. permissionConfig corrected, FR-21 pipes replaced with slashes, GAP-009 added for CLI.

## Output

- `docs/features/connectors.md` -- 21-section feature spec, template-compliant, code-grounded
- Commit: `275b975fa` (format feature spec after post-impl sync)
