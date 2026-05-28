# Test Spec Log — Workflow Connector OAuth2 Dual-Auth

**Slug**: `workflow-connector-oauth2-dual-auth`
**Date**: 2026-04-20
**Ticket**: ABLP-155

---

## Oracle Decisions (Inline — agent spawning unavailable)

All clarifying questions answered inline using feature spec + codebase evidence.

| Q                                 | Decision                                                                                                                                                                                                                               | Classification |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1: Highest-risk FRs              | FR-4 (`normalizeAuthForAP()`) and FR-8 (trigger auth path) are highest risk. FR-1/2/3 (pnpm patches) risky due to silent failure on version bumps.                                                                                     | ANSWERED       |
| Q2: Coverage baseline             | Zero coverage for `normalizeAuthForAP()` (no `context-translator.test.ts` exists). Existing: `connector-tool-executor.test.ts`, `activepieces-importer.test.ts`, `polling-trigger.integration.test.ts`, `connection-crud.e2e.test.ts`. | ANSWERED       |
| Q3: External dependency mocking   | External Jira/Zendesk/ServiceNow APIs in E2E → mark as @manual or use injected HTTP stub (not `vi.mock`). Decision: left as Open Testing Question 1 for implementation phase.                                                          | DECIDED        |
| Q4: E2E infrastructure pattern    | Real MongoMemoryServer + Express on `{ port: 0 }` — pattern established in `connection-crud.e2e.test.ts`. Direct `processPollingJob()` call works for trigger integration tests per existing `polling-trigger.integration.test.ts`.    | ANSWERED       |
| Q5: Tenant isolation scope        | Auth profiles are tenant-scoped, not project-scoped per data model. Cross-tenant returns 404 (not 403).                                                                                                                                | ANSWERED       |
| Q6: ServiceNow action name        | `create_record` is assumed from impl guide — needs verification against `@activepieces/piece-service-now@0.1.3`. Tracked as Open Testing Question 3 / GAP-004.                                                                         | DECIDED        |
| Q7: api_key in availableAuthTypes | GAP-001 (no Nango secondary provider for Zendesk/ServiceNow api_key) means INT-3 may need to assert `['oauth2']` only until gap resolved. Tracked as Open Testing Question 4.                                                          | DECIDED        |

---

## Files Created

- `docs/testing/workflow-connector-oauth2-dual-auth.md` — full test spec (replaces placeholder)

## Audit Log

### Round 1

- Status: APPROVED (self-review)
- All quality gates passed: 7 E2E scenarios, 7 integration scenarios, all FR-N mapped, security section filled
- MEDIUM: UT-7 (backward compatibility) not in coverage matrix — minor gap, FR has no explicit requirement for it; retained as defensive test without coverage matrix entry

### Round 2

- Status: APPROVED (cross-phase consistency)
- All FR-N from feature spec map to at least one test scenario
- MEDIUM: FR-10 (no regressions) has no dedicated test scenario — covered by CI build check and manual checklist, acceptable for alpha
- Testing README updated: 6→7 E2E planned, 5→7 integration planned
