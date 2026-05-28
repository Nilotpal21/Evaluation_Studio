# Feature Spec Log — Workflow Connector OAuth2 Dual-Auth

**Slug**: `workflow-connector-oauth2-dual-auth`
**Date**: 2026-04-20
**Ticket**: ABLP-155

---

## Oracle Decisions

All 15 clarifying questions resolved without user escalation.

| Q                         | Decision                                                                                                                                                                                | Classification |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1: Problem               | All 3 connectors show "Unsupported" badge — `authType: 'custom'` excluded from `availableAuthTypes` in integration-provider-service.ts (line 269–280), blocking all workflow automation | ANSWERED       |
| Q2: Scope boundary        | SearchAI sync connectors out of scope (just removed). Scope = workflow AP piece actions + triggers for Jira, Zendesk, ServiceNow only                                                   | ANSWERED       |
| Q3: Delta                 | Zendesk + Jira already installed/registered; need patching. ServiceNow NOT installed — must add dep + register + patch                                                                  | ANSWERED       |
| Q4: Priority              | Feature-completeness / enterprise enablement. Connectors are in catalog but unusable                                                                                                    | INFERRED       |
| Q5: Prior design          | Impl guides in Downloads/activepieces-main/ (jira/zendesk/servicenow-oauth2-implementation.md) are the design input                                                                     | ANSWERED       |
| Q6: Personas              | Both workflow builder and platform admin                                                                                                                                                | INFERRED       |
| Q7: Both journeys         | OAuth2 + API key required for all 3, matching GitHub dual-auth pattern user explicitly requested                                                                                        | DECIDED        |
| Q8: ServiceNow AP piece   | `@activepieces/piece-service-now@0.1.3` exists on npm, NOT installed                                                                                                                    | ANSWERED       |
| Q9: Subdomain/instanceUrl | Stored in `connectionConfig.subdomain` / `connectionConfig.instanceUrl` — existing Nango pattern                                                                                        | ANSWERED       |
| Q10: API key path         | No `zendesk-api-key`/`servicenow-api-key` Nango providers exist. Use direct catalog `authType: 'api_key'` fallback path in integration-provider-service.ts line 256                     | ANSWERED       |
| Q11: Packages             | connectors/package.json, loader.ts, context-translator.ts, extract-entry.ts, connector-catalog.json, pnpm patch files                                                                   | ANSWERED       |
| Q12: ServiceNow AP exists | `@activepieces/piece-service-now@0.1.3` on npm, uninstalled                                                                                                                             | ANSWERED       |
| Q13: pnpm patches         | No existing patches — this is first use of patchedDependencies in this repo                                                                                                             | ANSWERED       |
| Q14: Auth shapes          | Zendesk: `{ props: { subdomain, accessToken } }`; Jira: `{ access_token }` top-level (PieceAuth.OAuth2); ServiceNow: `{ props: { instanceUrl, accessToken } }`                          | ANSWERED       |
| Q15: Data model           | No new collections. subdomain/instanceUrl in existing Connection.connectionConfig                                                                                                       | ANSWERED       |

---

## Files Created

- `docs/features/workflow-connector-oauth2-dual-auth.md`
- `docs/testing/workflow-connector-oauth2-dual-auth.md`

## Audit Log

- Round 1: pending
- Round 2: pending
