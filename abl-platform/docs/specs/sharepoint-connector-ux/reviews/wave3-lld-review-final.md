# Wave 3 LLD Review -- Final (Rounds 1-5 Consolidated)

**Reviewer:** LLD Reviewer Agent
**Date:** 2026-03-24
**LLD:** `docs/specs/sharepoint-connector-ux/wave3.lld.md`

---

## VERDICT: APPROVED

---

## Round 1 Findings -- ALL RESOLVED

### HIGH (3/3 resolved)

- **[HIGH-01] server.ts insertion point:** Added explicit "before line 202 (before the 404 handler comment)" notes to ST-28.5, ST-31.5, ST-36.4, ST-37.5. Each mount subtask now specifies the line range (between 187 and 202).
- **[HIGH-02] any type in classifyError:** Changed `classifyError(connector: any)` to `classifyError(connector: IConnectorConfig)`. Added import of IConnectorConfig from the database package to the service imports.
- **[HIGH-03] Wrong handleError reference:** Changed all 4 references from "Follow the pattern from connector-audit.ts" to "Follow the handleError pattern from connectors.ts (lines 23-37) which handles ConnectorError with proper status codes." Affected: ST-28.4, ST-31.3, ST-36.3, ST-37.4.

### MEDIUM (5/5 resolved)

- **[MEDIUM-01] useConnectorSync route asymmetry:** Added note to ST-27.3 documenting that useConnectorSync uses the old route pattern (no indexId in path) vs. new overview/monitoring routes that include indexId.
- **[MEDIUM-02] Per-site progress storage:** Changed ST-29.2 from storing all runtime fields in MongoDB to recommending Redis for ephemeral sync runtime data (sizeProcessed, currentDocument, perSiteProgress). Key: `sync:progress:${connectorId}` with 1-hour TTL. MongoDB syncState retains only persistent fields.
- **[MEDIUM-03] SSRF in webhook test:** Added SSRF mitigation to ST-31.2: DNS resolution check against private/loopback/link-local IP ranges before HTTP request. Updated risk notes to reflect mitigation is implemented.
- **[MEDIUM-04] SWR optimistic update:** Specified SWR optimistic update strategy in ST-30.1: mutate with revalidate false for instant UI, then PUT, then mutate on success/failure.
- **[MEDIUM-05] Zod cronExpression validation:** Added refine to permissionScheduleBody schema enforcing cronExpression is present and non-empty when schedule is custom.

### LOW (3/3 resolved)

- **[LOW-01] ThrottledError cleanup:** Added explicit useEffect cleanup pattern with clearInterval to ST-34.7. Also: clear interval and re-fetch when countdown reaches 0.
- **[LOW-02] Batch 1 server.ts serialization:** Added exception note to Batch 1 execution order: server.ts mount edits must be serialized or consolidated into a final step.
- **[LOW-03] SWR key / route prefix verification:** Added note to SWR hook signatures documenting the Studio proxy mapping (/api/search-ai/ to /api/), verified against existing useConnector.ts line 65.

---

## Self-Review Findings (Rounds 2-5)

### Additional fixes applied during self-review

- **[SELF-01] Missing Zod params schema for T-31:** Added notificationParams schema (indexId and connectorId with z.string().min(1)) to T-31 Zod Validation Schemas section.
- **[SELF-02] Missing Zod params schema for T-36:** Added errorRecoveryParams schema to T-36 Zod Validation section.

### Verification checklist

- [x] **HLD coverage:** All 12 tasks (T-26 through T-37) from HLD section 8 have corresponding LLD sections.
- [x] **File paths plausible:** All paths under apps/studio/src/, apps/search-ai/src/, packages/database/src/, packages/i18n/locales/en/ match existing directory structure.
- [x] **ACs testable:** Every AC specifies a verify method (component test, integration test, build check, or code review) and expected outcome.
- [x] **Task independence matrix correct:** Dependencies match actual data/file dependencies. Batch ordering is sound (backend first, then T-26 foundation, then dependent frontend tasks).
- [x] **No orphaned references:** All component references (Progress, DataTable, EmptyState, ConfirmDialog, Button, Badge, Input, Toggle, Checkbox) verified to exist. All service function references (getSyncStatus, findConnectorByIdAndTenantLean, etc.) verified.
- [x] **i18n pattern correct:** All frontend tasks specify namespace under search_ai.sharepoint.\*. T-34 explicitly shows the useTranslations pattern.
- [x] **Zod validation on all new routes:** T-28 (monitoringParams, syncHistoryQuery), T-31 (notificationParams, notificationBody, testWebhookBody), T-33 (permissionScheduleBody with refine), T-36 (errorRecoveryParams, retryBody), T-37 (utilityParams, checkSiteAccessBody). All use z.string().min(1) for IDs.
- [x] **Wiring complete:** Every new route file has a mount subtask in server.ts. Every new frontend component has an integration subtask into its parent (OverviewTab, SharePointDetailPanel, or tab-specific). Every new SWR hook has a corresponding backend route.
- [x] **handleError pattern consistent:** All 4 route files now reference connectors.ts lines 23-37 (ConnectorError-aware), not connector-audit.ts.
- [x] **server.ts mounts before 404:** All 4 mount subtasks specify "before line 202."
- [x] **No any types in new code:** classifyError uses IConnectorConfig.

---

## Summary

| Round     | Findings | Resolved |
| --------- | -------- | -------- |
| 1         | 11       | 11       |
| 2-5       | 2        | 2        |
| **Total** | **13**   | **13**   |

All findings resolved. LLD is ready for implementation.
