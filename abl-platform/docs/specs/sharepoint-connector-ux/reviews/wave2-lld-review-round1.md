# Wave 2 LLD Review -- Round 1: Architecture Compliance

**Reviewer:** lld-reviewer
**Date:** 2026-03-24
**LLD:** `docs/specs/sharepoint-connector-ux/wave2.lld.md`
**HLD:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md` (Section 8, T-13 to T-25)

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

- **[CRITICAL-01] T-15: Missing authMiddleware specification on proposal router.**
  The LLD says to follow the connectors.ts pattern but does not explicitly specify `router.use(authMiddleware)` in the proposal routes. The Wave 1 routes (connector-audit.ts line 20, connector-config-versions.ts line 20) all apply `router.use(authMiddleware)` at the top. Without this, all 20 proposal endpoints would be unauthenticated.
  File: LLD T-15, ST-15.1
  Fix: Add explicit instruction: "Apply `router.use(authMiddleware)` at the top of the router, importing authMiddleware from '../middleware/auth.js'."

- **[CRITICAL-02] T-15: Missing createLogger specification on proposal routes.**
  The Wave 1 route files all create a logger (e.g., `const logger = createLogger('connector-audit-routes')`). The LLD T-15 specifies importing handleError from the connectors.ts pattern but does not specify creating a logger or the handleError function itself. The handleError pattern in connectors.ts (lines 22-37) uses a module-level logger instance.
  File: LLD T-15, ST-15.1
  Fix: Add: "Create `const logger = createLogger('connector-proposal-routes')` and implement the handleError pattern from connectors.ts lines 22-37 (which requires the logger)."

- **[CRITICAL-03] T-14: ProposalState unique index conflicts with lifecycle.**
  The LLD defines a unique index `{ tenantId: 1, connectorId: 1 }` meaning only one proposal per connector ever. But the LLD also defines abandonProposal which sets status to 'abandoned' (does NOT delete the document). This means after abandoning, a user cannot create a new proposal for the same connector because the unique index blocks the insert.
  File: LLD T-14, Model Schema indexes
  Fix: Either (a) make the unique index a partial unique index with `{ partialFilterExpression: { status: { $nin: ['abandoned', 'failed'] } } }`, or (b) change abandonProposal to delete the document, or (c) make the unique index `{ tenantId: 1, connectorId: 1, status: 1 }` (but this allows multiple active proposals). Option (a) is cleanest.

### HIGH

- **[HIGH-01] T-25: Route placement instruction is correct but underspecified.**
  The LLD correctly calls out that `GET /:indexId/connectors/check-name` and `POST /:indexId/connectors/generate-admin-email` must be registered BEFORE `/:indexId/connectors/:connectorId` (line 69 of connectors.ts). However, the LLD says to "add two new route handlers" without specifying the exact insertion point. Express route ordering is a known recurring issue in this codebase.
  File: LLD T-25, ST-25.3
  Fix: Add explicit instruction: "Insert these routes between line 51 (end of POST create handler) and line 69 (start of GET by ID handler). The routes MUST appear before any /:connectorId parameterized route."

- **[HIGH-02] T-14: startGeneration does synchronous multi-step orchestration with no timeout or failure isolation.**
  The generation logic (9 steps) runs sequentially in a single async function. Step 4 (Scope/Discovery) can take 10-30s per the risk notes. If any step hangs, the entire request hangs. There is no per-step timeout, no overall timeout, and no mechanism to resume from a failed step.
  File: LLD T-14, Generation Logic section
  Fix: Add per-step timeout (e.g., 30s per step, 3 minutes overall). Specify that startGeneration should return immediately with the 'generating' state and run the pipeline in the background (fire-and-forget with error handling). The frontend already assumes polling via useConnectorProposal with refreshInterval 2000ms, which implies the backend returns immediately.

- **[HIGH-03] T-25: Missing Zod validation for check-name query params.**
  The LLD specifies Zod validation schemas for T-15 (proposal routes) but T-25 does not define a Zod schema for the check-name query parameter (name). The existing connector route file (connectors.ts) does not use Zod at all, but the platform standard (per CLAUDE.md) requires Zod safeParse on every route parameter.
  File: LLD T-25, ST-25.3
  Fix: Add validation schema: `const checkNameQuery = z.object({ name: z.string().min(1).max(200) })` and `const generateEmailBody = z.object({ type: z.enum(['app_registration_setup']) })`. Apply safeParse in the route handlers.

- **[HIGH-04] T-14/T-15: No route to trigger proposal generation.**
  The T-15 route definitions list GET /proposal/status and GET /proposal but there is NO POST route to trigger startGeneration. The frontend (T-13 ConnectTab) says onAuthComplete triggers proposal generation, but there is no corresponding backend endpoint listed.
  File: LLD T-15, Route Definitions
  Fix: Add `POST /:indexId/connectors/:connectorId/proposal/generate` to the route definitions. It should call startGeneration, return 202 with the initial proposal state, and run the generation pipeline asynchronously.

### MEDIUM

- **[MEDIUM-01] T-13: ITAdminGuide mentions details/summary HTML pattern.**
  The LLD ST-13.3 mentions using details/summary HTML pattern. While there is no Accordion/Collapsible in the design system, the LLD also offers "or a controlled expand state" as an alternative. The second option is preferable for consistent styling.
  File: LLD T-13, ST-13.3
  Fix: Prefer the "controlled expand state" option with a Button variant="ghost" trigger plus conditional rendering, not native details/summary.

- **[MEDIUM-02] T-17: useConnectorDiscovery SWR key path may surprise implementers.**
  The LLD specifies SWR key `/api/search-ai/connectors/${connectorId}/discovery` which does NOT include indexId, unlike the useConnector hook which uses `/api/search-ai/indexes/${indexId}/connectors/${connectorId}`. The difference exists because the discovery endpoint is mounted at `app.use('/api', connectorDiscoveryRouter)` (server.ts line 187) not under `/api/indexes`. Document this inconsistency.
  File: LLD T-17, useConnectorDiscovery.ts
  Fix: Add an inline comment in the hook specification explaining the different mount path for discovery vs CRUD endpoints.

- **[MEDIUM-03] T-14: Model schema uses uuidv7 as default but does not specify import.**
  The schema references uuidv7 but does not specify the import source.
  File: LLD T-14, Model Schema
  Fix: Add import specification. Check Wave 1 models (connector-audit-entry.model.ts, connector-config-version.model.ts) for the established pattern and reference it.

- **[MEDIUM-04] T-16: 13 new files in a single task -- largest in the wave.**
  T-16 creates 13 new files (11 components + 1 hook + API functions). The HLD estimates 8-10 files. The subtask breakdown (10 steps) is reasonable but the task is large.
  File: LLD T-16
  Fix: Consider splitting into T-16a (hook + API + ProposalGenerationProgress + ProposalTableOfContents + ProposalTab shell) and T-16b (section-specific components). The LLD notes these are independent.

- **[MEDIUM-05] T-20: runPreview API function accepts indexId but URL does not use it.**
  The function `runPreview(indexId, connectorId)` builds URL `engineUrl('/connectors/${connectorId}/filters/preview')` which omits indexId. The parameter is unused.
  File: LLD T-20, API Function
  Fix: Either remove indexId from the signature or include it in the URL to match the backend mount pattern.

- **[MEDIUM-06] T-14: ProposalState model export path not fully specified.**
  ST-14.1 says "Export from packages/database/src/index.ts" but does not specify the types barrel export.
  File: LLD T-14, ST-14.1
  Fix: Specify: "Export IProposalState, ProposalStatus, GenerationStepStatus, SectionReviewStatus from packages/database/src/models/index.ts and re-export the model from packages/database/src/index.ts."

### LOW

- **[LOW-01] T-13: i18n namespace depth search_ai.sharepoint.connect -- verify nesting.**
  Three levels of nesting. This works with next-intl but verify the JSON structure in studio.json matches.
  File: LLD T-13, i18n Keys
  Fix: No code change. Implementation note only.

- **[LOW-02] T-15: 20 endpoints in one route file may become unwieldy.**
  Consider splitting into generation/lifecycle routes and section review routes if the file exceeds 300 lines.
  File: LLD T-15
  Fix: Optional.

- **[LOW-03] File overlap on search-ai.ts across T-13 and T-20 (Batch 3).**
  Both tasks append new API functions to apps/studio/src/api/search-ai.ts and run in the same batch.
  File: LLD File Overlap Check section
  Fix: Add coordination note for Batch 3 parallel execution.

---

## VERIFIED

- [x] **Resource isolation** -- T-14 service functions all take tenantId. ProposalState queries use { connectorId, tenantId }. tenantIsolationPlugin applied. T-25 includes tenantId in all queries. Verified against connectors.ts line 45, connector-discovery.ts line 55.
- [x] **Centralized auth** -- Routes use authMiddleware wrapping createUnifiedAuthMiddleware (verified apps/search-ai/src/middleware/auth.ts lines 104-189). No custom token verification. CRITICAL-01 notes T-15 must specify this explicitly.
- [x] **Stateless distributed** -- No pod-local state introduced. ProposalState in MongoDB. UI undo history in T-17 is component-local state (acceptable).
- [x] **Zod validation** -- T-15 defines proper schemas with z.string().min(1) for IDs (correct pattern). T-25 needs schemas added (HIGH-03).
- [x] **Error handling** -- handleError pattern referenced from connectors.ts lines 22-37. Uses `error instanceof Error ? err.message : String(err)`. Returns { success: false, error: { code, message } }.
- [x] **Logger usage** -- T-14 specifies createLogger('proposal-service'). T-15 needs logger added (CRITICAL-02).
- [x] **Express route ordering** -- T-25 explicitly flags the static-before-parameterized rule. HIGH-01 requests exact insertion point.
- [x] **i18n** -- All frontend tasks specify namespaces under search_ai.sharepoint.\*. Uses useTranslations('search_ai.sharepoint.connect') -- correct pattern per Wave 1 review learnings.
- [x] **Design system components** -- All referenced UI components verified to exist: Card, RadioGroup, Button, Badge, Toggle, Select, Input, Textarea, ConfirmDialog, DataTable, SlidePanel, Tabs, Tooltip, DropdownMenu in apps/studio/src/components/ui/.
- [x] **SWR/Zustand patterns** -- useConnectorProposal follows useConnector pattern. Zustand atomic selector advisory documented. useFilterPreview uses debounced POST-based fetcher.
- [x] **ModelRegistry registration** -- ProposalState registered with 'platform' affinity, matching ConnectorConfig and ConnectorAuditEntry.
- [x] **Mongoose patterns** -- tenantIsolationPlugin applied. Indexes lead with tenantId. Custom \_v field matches Wave 1 models.
- [x] **HLD coverage** -- All 13 HLD tasks (T-13 through T-25) have corresponding LLD tasks with subtasks and acceptance criteria.
- [x] **File paths verified** -- All referenced existing files confirmed at stated paths.
- [x] **Function signatures verified** -- useConnector, useConnectorStore, ConnectorFilterSection props, AddSourceButton props, SetupGuide handlers all match current code.
- [x] **Task independence** -- Dependency chains correctly ordered. Parallel batches have manageable overlap (LOW-03).
- [x] **Server.ts mount** -- Proposal router mount at line ~185 in server.ts, after existing connector mounts, is correct.
- [x] **Framer Motion available** -- Used by ProjectSidebar, AppShell, NodeDetailPanel. T-16 AnimatePresence usage valid.

---

## NOTES

1. **T-14 generation timing is the highest-risk architectural item.** The synchronous 9-step pipeline with external API calls needs to be async. The frontend already assumes polling (refreshInterval 2000ms), implying the backend returns immediately. But the service signatures suggest synchronous execution. Resolve CRITICAL-03, HIGH-02, and HIGH-04 together -- they form a coherent cluster around the proposal generation lifecycle.

2. **The unique index issue (CRITICAL-03) will cause a production bug** on the abandon-then-recreate flow. Must be resolved before implementation.

3. **Wave 1 completion is a prerequisite.** The LLD correctly lists Wave 1 dependencies (T-06, T-08, T-09, T-10, T-11). Verify Wave 1 is fully merged before starting Wave 2.

4. **The Export Template button in T-21 is correctly deferred** (disabled with tooltip) to Wave 4 T-51.

5. **Round 2 focus areas:** Pattern consistency (shared utilities, existing API client patterns, component composition), completeness of acceptance criteria, and i18n key coverage.
