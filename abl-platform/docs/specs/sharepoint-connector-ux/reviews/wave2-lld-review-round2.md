# Wave 2 LLD Review -- Round 2: Pattern Consistency + Fix Verification

**Reviewer:** lld-reviewer
**Date:** 2026-03-24
**LLD:** `docs/specs/sharepoint-connector-ux/wave2.lld.md`
**Round 1:** `docs/specs/sharepoint-connector-ux/reviews/wave2-lld-review-round1.md`

---

## VERDICT: NEEDS_CHANGES

---

## Part A: Fix Verification (Round 1 Findings)

| R1 ID       | Status  | Notes                                                                                                                                                                                                                                       |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL-01 | FIXED   | T-15 ST-15.1 now explicitly specifies `router.use(authMiddleware)` and lists the import path `'../middleware/auth.js'`. Matches connectors.ts line 20, connector-config-versions.ts line 20.                                                |
| CRITICAL-02 | FIXED   | T-15 ST-15.1 now specifies `const logger = createLogger('connector-proposal-routes')` and the handleError pattern from connectors.ts lines 22-37.                                                                                           |
| CRITICAL-03 | FIXED   | T-14 now uses partial unique index with `partialFilterExpression: { status: { $nin: ['abandoned', 'failed'] } }`. The risk notes explain the lifecycle correctly. AC-05 tests the abandon-then-recreate flow.                               |
| HIGH-01     | FIXED   | T-25 ST-25.3 now specifies the exact insertion point: "Insert these routes between line 67 (end of POST create handler) and line 69 (start of GET by ID handler)."                                                                          |
| HIGH-02     | FIXED   | T-14 Generation Logic section now specifies: `startGeneration()` returns immediately, route handler responds with HTTP 202, pipeline runs via fire-and-forget with `.catch()`. Per-step 30s timeout and overall 3-minute timeout specified. |
| HIGH-03     | FIXED   | T-25 ST-25.3 now defines `checkNameQuery = z.object({ name: z.string().min(1).max(200) })` and `generateEmailBody = z.object({ type: z.enum(['app_registration_setup']) })` with safeParse.                                                 |
| HIGH-04     | FIXED   | T-15 Route Definitions now includes `POST /:indexId/connectors/:connectorId/proposal/generate` as the first route. Returns 202 with initial proposal state.                                                                                 |
| MEDIUM-01   | FIXED   | T-13 ST-13.3 now specifies "controlled expand state with a Button variant='ghost' trigger plus conditional rendering (NOT native details/summary)."                                                                                         |
| MEDIUM-02   | FIXED   | T-17 `useConnectorDiscovery.ts` now includes an inline comment explaining the mount path difference. Verified: `connectorDiscoveryRouter` is mounted at `app.use('/api', ...)` (server.ts line 187), not under `/api/indexes`.              |
| MEDIUM-03   | FIXED   | T-14 Model Schema now specifies `import { uuidv7 } from 'uuidv7'` and references Wave 1 models. **However, see NEW-HIGH-01 below -- the import path is wrong.**                                                                             |
| MEDIUM-04   | PARTIAL | T-16 Risk Notes recommend splitting into T-16a/T-16b. The recommendation is documented but the Task Independence Matrix and batch schedule still treat T-16 as a single task. Acceptable -- the split is advisory, not mandatory.           |
| MEDIUM-05   | FIXED   | T-20 `runPreview()` now takes only `connectorId` (no unused `indexId`). Comment explains the mount path.                                                                                                                                    |
| MEDIUM-06   | FIXED   | T-14 ST-14.1 now specifies: "Export types from `packages/database/src/models/index.ts` and re-export the model from `packages/database/src/index.ts`."                                                                                      |
| LOW-01      | ACK     | Implementation note only. No change needed.                                                                                                                                                                                                 |
| LOW-02      | ACK     | Optional. No change needed.                                                                                                                                                                                                                 |
| LOW-03      | FIXED   | File Overlap Check section now includes coordination note for Batch 3 parallel execution on `search-ai.ts`.                                                                                                                                 |

**Summary:** 15 of 16 findings addressed. MEDIUM-03 was partially fixed but introduced a new issue (wrong import path).

---

## Part B: Pattern Consistency

### ISSUES

#### HIGH

- **[HIGH-01] T-14: uuidv7 import path is wrong.**
  The LLD specifies `import { uuidv7 } from 'uuidv7'` (line 284 of LLD). The actual Wave 1 pattern in `connector-audit-entry.model.ts` line 10 is `import { uuidv7 } from '../mongo/base-document.js'`. The `uuidv7` npm package is not directly imported by any model in the database package.
  File: LLD T-14, Model Schema (line 284)
  Fix: Change to `import { uuidv7 } from '../mongo/base-document.js'` to match the established pattern.

- **[HIGH-02] T-14: ProposalState model export missing hot-reload safety pattern.**
  The LLD's model schema does not show the model export statement. The Wave 1 pattern in `connector-audit-entry.model.ts` (lines 89-90) is:

  ```ts
  (mongoose.models.ConnectorAuditEntry as mongoose.Model<IConnectorAuditEntry>) ||
    model<IConnectorAuditEntry>('ConnectorAuditEntry', ConnectorAuditEntrySchema);
  ```

  This prevents the "Cannot overwrite model" error during hot-reload in development. The LLD must specify this pattern for ProposalState.
  File: LLD T-14, Model Schema
  Fix: Add explicit export statement: `export const ProposalState = (mongoose.models.ProposalState as mongoose.Model<IProposalState>) || model<IProposalState>('ProposalState', ProposalStateSchema);`

- **[HIGH-03] T-13/T-16: useConnectorProposal.ts listed in Files to Create for BOTH T-13 and T-16.**
  T-13 "Files to Create" lists `apps/studio/src/hooks/useConnectorProposal.ts`. T-16 "Files to Create" also lists this same file. The File Overlap Check table at the bottom does NOT list this conflict. If T-13 and T-16 run in different batches (they do -- Batch 3 and Batch 5), the second task will overwrite or conflict with the first.
  File: LLD T-13 Files to Create, T-16 Files to Create, File Overlap Check table
  Fix: Remove `useConnectorProposal.ts` from T-13's Files to Create (T-13 does not need it -- it uses `useConnector` and `useConnectorList`). Keep it in T-16 where the hook is fully defined. Add a note to T-13 that the hook file is owned by T-16. Update the File Overlap Check to remove the ambiguity.

#### MEDIUM

- **[MEDIUM-01] T-14: Model schema missing Mongoose and Schema imports.**
  The LLD schema code block shows `new Schema<IProposalState>(...)` but does not import `mongoose`, `Schema`, or `model` from mongoose. The Wave 1 pattern (connector-audit-entry.model.ts line 9) imports `import mongoose, { Schema, model } from 'mongoose'`. Similarly, `tenantIsolationPlugin` and `ModelRegistry` imports are not shown.
  File: LLD T-14, Model Schema code block
  Fix: Add imports at the top of the code block: `import mongoose, { Schema, model } from 'mongoose'; import { uuidv7 } from '../mongo/base-document.js'; import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js'; import { ModelRegistry } from '../model-registry.js';`

- **[MEDIUM-02] T-17: connector-discovery.ts has NO authMiddleware.**
  The LLD's `useConnectorDiscovery` SWR hook calls `GET /connectors/:connectorId/discovery`. The connector-discovery router (at `apps/search-ai/src/routes/connector-discovery.ts` line 29) does NOT apply `router.use(authMiddleware)`. While this is a pre-existing issue (not introduced by this LLD), any new frontend hooks hitting these endpoints should be aware that the endpoints may be unauthenticated. The LLD should note this to avoid surprises during testing.
  File: LLD T-17, useConnectorDiscovery section
  Fix: Add a risk note: "The connector-discovery router does not currently apply authMiddleware at the router level. Verify auth is handled by the global middleware or add it before Wave 2 implementation."

- **[MEDIUM-03] T-16: API functions in search-ai.ts missing request body details.**
  The LLD defines `startProposalGeneration()`, `acceptProposalSection()`, etc. but several do not show the HTTP method or URL construction. For example, `acceptProposalSection` needs `method: 'POST'` and `body: JSON.stringify({})`. The Wave 1 API functions in `search-ai.ts` consistently show method, headers, and body. The LLD should be explicit to avoid implementer guesswork.
  File: LLD T-16, API Functions section
  Fix: Add full `apiFetch(engineUrl(...), { method, headers, body })` calls for each API function, matching the pattern shown in T-13's `checkConnectorName()` and `generateAdminEmail()`.

- **[MEDIUM-04] T-20/T-21: getConfigSummary endpoint does not exist in backend.**
  T-20 defines `getConfigSummary(indexId, connectorId)` calling `GET /indexes/${indexId}/connectors/${connectorId}/summary`. No backend task creates this endpoint. T-25 adds `check-name` and `generate-admin-email` to connectors.ts. The `/summary` endpoint is not in T-15 (proposal routes) either. The frontend will get 404.
  File: LLD T-20 API Functions, T-21 ST-21.1
  Fix: Either (a) add a `GET /:indexId/connectors/:connectorId/summary` route to T-25 or T-15, or (b) compose the summary from existing data (proposal sections + connector config) on the frontend without a dedicated backend endpoint.

#### LOW

- **[LOW-01] T-13 ST-13.4: useConnectorList is referenced but hook location not specified.**
  The LLD says ConnectTab uses `useConnectorList(indexId)` to determine first-time vs returning, but the "Files to Modify" section does not reference the hook file. The hook exists at `apps/studio/src/hooks/useConnectorList.ts` (verified). This is just an informational gap -- the implementer will find it.
  File: LLD T-13 ST-13.4
  Fix: Add a note: "Import `useConnectorList` from `'../../../hooks/useConnectorList'`."

- **[LOW-02] T-16: 11 new component files create risk of inconsistent i18n patterns.**
  With 11 new components, some may use `useTranslations('search_ai.sharepoint.proposal')` and others may receive translated strings as props. The LLD does not specify which sub-components use their own `useTranslations` vs receive strings via props.
  File: LLD T-16
  Fix: Add guidance: "ProposalTab.tsx and ProposalGenerationProgress.tsx use `useTranslations('search_ai.sharepoint.proposal')` directly. Section-specific components receive translated strings via props from ProposalTab to avoid redundant hook calls."

- **[LOW-03] Batch 3 has 5 parallel tasks, some sharing search-ai.ts writes.**
  Batch 3 includes T-13, T-17, T-20, T-23, T-24. T-13 and T-20 both write to `search-ai.ts`. The File Overlap Check notes this and suggests assigning distinct line ranges. This is adequate but consider serializing T-13 before T-20 within Batch 3 to avoid merge conflicts.
  File: LLD File Overlap Check, Batch 3
  Fix: Optional. Existing coordination note is sufficient.

---

## VERIFIED

- [x] **R1 fix verification** -- 15/16 findings fixed correctly. One partial fix (MEDIUM-03 uuidv7 import path) promoted to HIGH.
- [x] **Backend route pattern** -- T-15 now matches connectors.ts pattern: `authMiddleware` at router level, `createLogger`, `handleError` with ConnectorError, Zod `.safeParse()`, `req.tenantContext!.tenantId`.
- [x] **SWR hook pattern** -- `useConnectorProposal` follows `useConnector` pattern: conditional SWR key, `useMemo` for data extraction, same return shape `{ data, isLoading, error, mutate }`. `useConnectorDiscovery` and `useFilterPreview` also follow the pattern with appropriate variations (POST fetcher for preview, no-index path for discovery).
- [x] **Design system components** -- All UI components referenced verified to exist: Card, RadioGroup, Button, Badge, Toggle, Select, Input, Textarea, ConfirmDialog, DataTable, SlidePanel, Tabs, Tooltip, DropdownMenu, AnimatePresence (framer-motion).
- [x] **Zustand store usage** -- T-23 and T-24 use `useConnectorStore.getState().openPanel()` for imperative access (correct for event handlers). T-17 uses `useConnectorStore(s => s.setExpandedPanel)` for reactive access.
- [x] **Async generation flow** -- T-14 startGeneration() creates doc + returns immediately. Route handler returns 202. Frontend polls via SWR refreshInterval 2000ms. Pipeline errors caught and written to ProposalState.status = 'failed'. Flow is coherent.
- [x] **Express route ordering** -- T-25 correctly specifies insertion before `/:connectorId` parameterized route with exact line references.
- [x] **Tenant isolation** -- All service functions take `tenantId`. Partial unique index leads with `tenantId`. All route handlers extract from `req.tenantContext!.tenantId`.
- [x] **i18n pattern** -- All frontend tasks use `useTranslations('search_ai.sharepoint.FEATURE')` pattern. Correct nesting under `search_ai` in studio.json. Keys specified for all user-visible strings including aria-labels and status values.
- [x] **ModelRegistry registration** -- ProposalState registered with `'platform'` affinity via `ModelRegistry.registerModelDefinition()`.
- [x] **Task independence matrix** -- Dependency chains are correctly ordered. Batch execution order is valid. One undocumented file overlap found (HIGH-03).

---

## NOTES

1. **The uuidv7 import path (HIGH-01) will cause a build failure** if the implementer follows the LLD literally. The `uuidv7` package may or may not be in `node_modules`, but the established pattern imports from `../mongo/base-document.js`.

2. **The missing getConfigSummary backend endpoint (MEDIUM-04) will cause a 404** in the Preview Tab and Approve & Start view. This needs either a new backend endpoint or a frontend composition strategy.

3. **The useConnectorProposal.ts file ownership conflict (HIGH-03) must be resolved** before implementation starts. Assigning it to one task prevents parallel workers from colliding.

4. **connector-discovery.ts auth gap (MEDIUM-02)** is a pre-existing issue but worth tracking. If auth is provided by global middleware in server.ts, this is fine. If not, any new frontend code relying on these endpoints will work in dev (no auth required) but may behave differently in production.

5. **Round 3 focus areas:** Completeness of acceptance criteria (verify commands should be runnable), i18n key exhaustiveness, and any remaining task overlap issues.
