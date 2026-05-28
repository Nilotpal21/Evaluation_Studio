# SDLC Log: Workflow App Triggers — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-04-14
**Status**: DRAFT (pending audit)

---

## Oracle Decisions

| #   | Question                                          | Classification | Decision                                                                                 |
| --- | ------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| Q1  | Problem vs existing webhook                       | INFERRED       | App Triggers automates webhook/polling registration; user doesn't manage URLs or secrets |
| Q2  | Which apps in v1                                  | **USER**       | Full Activepieces catalog import; priority e2e testing for Gmail, Jira, Slack, GitHub    |
| Q3  | New type or reuse 'connector'                     | INFERRED       | Reuse `type: 'connector'` — backend already supports it; UI relabels as "App Triggers"   |
| Q4  | Remove Polling/Event/Connector from UI or backend | DECIDED        | Hide in UI only; backend retains all types for backward compatibility                    |
| Q5  | Timeline/priority                                 | **USER**       | Blocking customer/demo — prioritize end-to-end for 2-3 apps                              |
| Q6  | Primary personas                                  | ANSWERED       | Both Studio users (UI) and developers (API), with Studio users primary for App Triggers  |
| Q7  | Critical user journey                             | INFERRED       | Pick app → OAuth → select event → save (guided flow reusing connection infrastructure)   |
| Q8  | Event filtering in v1                             | DECIDED        | No — rely on workflow condition nodes for post-arrival filtering                         |
| Q9  | Reuse existing connections                        | ANSWERED       | Yes — reuse ConnectionService and existing OAuth connections                             |
| Q10 | Feature interactions                              | ANSWERED       | Connectors, Auth Profiles, Workflows, Webhook System, Deployments                        |
| Q11 | Push vs polling mechanism                         | INFERRED       | Both — connector trigger engine routes to webhook/polling/cron based on strategy         |
| Q12 | Webhook receiver location                         | ANSWERED       | Workflow-engine (port 9080), proxied through runtime                                     |
| Q13 | Data model changes                                | INFERRED       | None — existing TriggerRegistration model sufficient                                     |
| Q14 | OAuth handling                                    | ANSWERED       | Reuse packages/connectors/ ConnectionService + Nango/Activepieces adapter                |
| Q15 | Catalog endpoint behavior                         | DECIDED        | Return real data from ConnectorListingService instead of static catalog                  |

## Files Created

- `docs/features/sub-features/workflow-app-triggers.md` — feature spec
- `docs/testing/sub-features/workflow-app-triggers.md` — testing placeholder
- `docs/sdlc-logs/workflow-app-triggers/feature-spec.log.md` — this log

## Files Updated

- `docs/features/README.md` — added to Focused Sub-Feature Modules table
- `docs/features/sub-features/README.md` — added to Current Sub-Features table
- `docs/testing/README.md` — added to testing index
- `docs/testing/sub-features/README.md` — added to sub-feature guides table

## Open Questions

1. OQ-1: Activepieces piece trigger quality — need audit of onEnable/onDisable for priority apps
2. OQ-2: Dynamic trigger props UX — how to render ConnectorTrigger.props in the picker
3. OQ-3: Connection status indicator in catalog — should cards show connected/not connected
4. OQ-4: Nango proxy vs direct API — verify adapter layer handles both transparently
