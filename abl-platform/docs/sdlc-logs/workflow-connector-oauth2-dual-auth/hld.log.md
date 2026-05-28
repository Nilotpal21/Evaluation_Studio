# HLD Log — Workflow Connector OAuth2 Dual-Auth

**Slug**: `workflow-connector-oauth2-dual-auth`
**Date**: 2026-04-20
**Ticket**: ABLP-155

---

## Oracle Decisions (Inline — agent spawning unavailable)

| Q                               | Decision                                                                                                                                                                                                            | Classification       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Q1: Architecture pattern        | Additive changes within `packages/connectors` only — no new services. pnpm patch + `normalizeAuthForAP()` extension. Confirmed: no new REST endpoints.                                                              | ANSWERED             |
| Q2: Breaking changes            | `normalizeAuthForAP(auth)` → `normalizeAuthForAP(connectorName, auth)` signature change. Two call sites: `translateActionContext()` and `processPollingJob()`. Default branch preserves backward compat.            | ANSWERED             |
| Q3: Trigger path gap            | `processPollingJob()` lines 141–148 resolve raw auth but do NOT call `normalizeAuthForAP()` before `trigger.run()`. This is HIGH-1 from feature spec — confirmed in source. Must add normalization to trigger path. | ANSWERED             |
| Q4: Rollback strategy           | Remove `patchedDependencies` from `packages/connectors/package.json` + `pnpm install` reverts all patches. ServiceNow registration removable by commenting `loader.ts` entry. No DB changes.                        | ANSWERED             |
| Q5: pnpm patch placement        | `patchedDependencies` in `packages/connectors/package.json` + patch files in `packages/connectors/patches/`. pnpm resolves patches relative to the declaring package.                                               | DECIDED              |
| Q6: Data migration              | None — `connectionConfig.subdomain` is existing Mixed field. No schema changes.                                                                                                                                     | ANSWERED             |
| Q7: Jira instanceUrl legacy     | Legacy `instanceUrl` on Jira connections is ignored post-patch (cloudId resolved at runtime). No migration needed — gracefully ignored.                                                                             | DECIDED              |
| Q8: api_key surfacing mechanism | Left as Open Question 1 — requires deciding between virtual provider config in providers.json vs catalog-level constant. Not blocked for OAuth2 delivery.                                                           | AMBIGUOUS → deferred |

---

## Files Created

- `docs/specs/workflow-connector-oauth2-dual-auth.hld.md`

## Audit Log

### Round 1 (Full audit — 12 concerns + alternatives)

- Status: APPROVED with 1 MEDIUM fix
- MEDIUM: Error responses in §6 lacked HTTP status codes — FIXED: added error table with HTTP status + error.code + message
- All 12 concerns addressed, 3 alternatives with real trade-offs, architecture diagrams present

### Round 2 (Data model + API deep dive)

- Status: APPROVED
- Data model confirmed: no new collections, `connectionConfig.subdomain` is existing field
- API contract: internal signature change fully documented with both call sites
- Error table complete with HTTP status codes

### Round 3 (Cross-phase consistency)

- Status: APPROVED
- All 10 FRs traceable to HLD sections
- Test spec scenarios (E2E-1 through E2E-7, INT-1 through INT-7) map to HLD data flows
- Trigger path gap (HIGH-1) explicitly addressed in §3 and §6
