# LLD Log — Workflow Connector OAuth2 Dual-Auth

**Slug**: `workflow-connector-oauth2-dual-auth`
**Date**: 2026-04-20
**Ticket**: ABLP-155

---

## Oracle Decisions (Inline — agent spawning unavailable)

| Q                                                       | Decision                                                                                                                                                                                                  | Classification |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1: `connectorName` in ActionContext                    | `ActionContext` has no `connectorName` field — must add additive optional field. `ConnectorToolExecutor.execute()` has `connectorName` in scope; sets it when building ActionContext.                     | ANSWERED       |
| Q2: Where to call normalizeAuthForAP with connectorName | `translateActionContext()` (context-translator.ts) and `translateTriggerContext()` (runtime-adapter.ts) — both already call `normalizeAuthForAP(rawAuth)`. Update both to pass `ctx.connectorName ?? ''`. | ANSWERED       |
| Q3: api_key surfacing mechanism                         | No `zendesk-api-key`/`servicenow-api-key` Nango providers exist. Use `DIRECT_API_KEY_CONNECTORS` Set in `extract-entry.ts`, surfaced in `integration-provider-service.ts`.                                | DECIDED        |
| Q4: Error class for missing subdomain                   | No `ConnectorError` class exists. Use `throw new Error(...)`. Matches `ConnectionServiceError extends Error` pattern.                                                                                     | ANSWERED       |
| Q5: pnpm patch working directory                        | Must run `pnpm patch` from `packages/connectors/` — AP pieces are deps of that package.                                                                                                                   | DECIDED        |
| Q6: ServiceNow auth field names                         | Must verify actual field names after `pnpm install` (Phase 2 task 2.6 note). Feature spec assumed `username/password` — verify before patching.                                                           | DECIDED        |
| Q7: Implementation order                                | normalizeAuthForAP first (pure TS, testable without patches) → pnpm patches → catalog → integration tests → build verification                                                                            | DECIDED        |

---

## Files Created

- `docs/plans/2026-04-20-workflow-connector-oauth2-dual-auth-impl-plan.md`

## Audit Log

### Round 1 (Architecture compliance)

- Status: APPROVED
- All isolation, auth security, traceability, and stateless concerns verified
- `connectorName` propagation confirmed for both action and trigger paths

### Round 2 (Pattern consistency)

- Status: APPROVED after 1 CRITICAL fix
- CRITICAL (FIXED): `ConnectorError` does not exist in codebase — replaced with `throw new Error(...)` throughout LLD (matches `ConnectionServiceError extends Error` pattern)
- `DIRECT_API_KEY_CONNECTORS` naming and import path matches existing `NANGO_SECONDARY_PROVIDERS` convention
- `@agent-platform/connectors/catalog` import path confirmed active in Studio

### Round 3 (Completeness)

- Status: APPROVED
- All 10 FRs map to at least one implementation task
- All 8 modified file paths verified against actual source files
- All signatures (`normalizeAuthForAP`, `translateActionContext`, `ActionContext`, `TriggerContext`) verified against current source

### Round 4 (Cross-phase consistency)

- Status: APPROVED
- All HLD decisions implemented in LLD phases
- All 8 integration test scenarios (INT-1 through INT-7) map to Phase 4 tasks
- Trigger auth path gap (HIGH-1) explicitly implemented in Phase 1 tasks 1.3 + 1.5

### Round 5 (Final sweep)

- Status: APPROVED
- Each phase independently deployable without breaking production
- Wiring checklist: 14 items covered, 4 explicitly N/A
- All tasks concrete and completable in one session
- No TODO stubs, no mocked codebase components in tests
