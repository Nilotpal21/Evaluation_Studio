# Feature Spec Log: Tags & Eval Tags

**Feature**: Tags & Eval Tags
**Phase**: FEATURE-SPEC
**Date**: 2026-03-23

---

## Oracle Decisions

### Scope & Problem

| #   | Question                                                 | Answer                                                                                                                                                                                                                                                                                                  | Classification |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | What specific problem does this solve?                   | Conversation sessions and eval scenarios need categorization for filtering, analytics, and operational workflows. The backend exists (TagRuleModel, conversation_tags ClickHouse table, Session.tags field, runtime /tags API) but there is no Studio UI, no auto-apply engine, and no tag removal API. | ANSWERED       |
| 2   | What is the boundary -- what is explicitly OUT of scope? | ML-based auto-tagging, tag inheritance across tenant/project hierarchy, tag-based routing/escalation in runtime execution.                                                                                                                                                                              | DECIDED        |
| 3   | Is this a new capability or an enhancement?              | Enhancement -- significant backend infrastructure already exists (runtime routes, DB models, ClickHouse schema). This feature closes the gaps: Studio UI, auto-apply engine, removal, bulk ops, analytics.                                                                                              | ANSWERED       |
| 4   | What's the priority/timeline driver?                     | Backlog item #66. Required for operational visibility into conversation categorization and eval scenario organization.                                                                                                                                                                                  | INFERRED       |
| 5   | Are there competing approaches?                          | No. The existing architecture is well-established (MongoDB for rules + Session.tags, ClickHouse for analytics).                                                                                                                                                                                         | ANSWERED       |

### User Stories & Requirements

| #   | Question                                        | Answer                                                                                                                                                 | Classification |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | Who are the primary personas?                   | Project admins (manage tag rules), operators (manually tag conversations), eval engineers (tag eval scenarios).                                        | DECIDED        |
| 2   | What are the critical user journeys?            | Create/edit tag rules, manually apply/remove tags on sessions, filter sessions by tags, auto-apply tags based on rules, filter eval scenarios by tags. | DECIDED        |
| 3   | Must-have vs nice-to-have?                      | Must-have: CRUD rules, manual apply/remove, filter by tags, Studio UI. Nice-to-have: auto-apply engine, tag analytics dashboard, bulk operations.      | DECIDED        |
| 4   | Performance/scale requirements?                 | Tag rules: <100 per project. Tags per session: <50. Conversation_tags ClickHouse queries must complete <2s for up to 1M rows per tenant.               | INFERRED       |
| 5   | What existing features does this interact with? | Sessions (Session.tags field), Evals (EvalScenario.tags), Analytics Pipeline (conversation_tags ClickHouse table), Observatory (semantic layer).       | ANSWERED       |

### Technical & Architecture

| #   | Question                              | Answer                                                                                                                                                      | Classification |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Which packages/services are affected? | packages/pipeline-engine (TagRuleModel), packages/database (Session.tags, EvalScenario.tags), apps/runtime (tags routes), apps/studio (new UI + API proxy). | ANSWERED       |
| 2   | What data models need to change?      | No schema changes needed -- all models already exist. Need: tag removal endpoint, auto-apply service, Studio API proxy routes.                              | ANSWERED       |
| 3   | Security/isolation implications?      | Tags are project-scoped. All existing routes enforce tenantId + projectId. Tag rules require project:write, tag application requires session:write.         | ANSWERED       |
| 4   | Deployment/migration strategy?        | No migrations -- all DB schemas exist. New routes + UI are additive. Feature can be rolled out incrementally.                                               | ANSWERED       |
| 5   | External dependencies?                | None. All infrastructure (MongoDB, ClickHouse) is already provisioned.                                                                                      | ANSWERED       |

---

## Files Created

- `docs/features/tags.md` -- Feature specification
- `docs/testing/tags.md` -- Testing guide placeholder
- `docs/sdlc-logs/tags/feature-spec.log.md` -- This file

## Open Questions

1. Should the auto-apply engine run synchronously during session lifecycle events or asynchronously via BullMQ?
2. Should tag names be globally unique per project or allow duplicates across rules?
3. Should tag removal cascade to ClickHouse analytics or keep historical records?
