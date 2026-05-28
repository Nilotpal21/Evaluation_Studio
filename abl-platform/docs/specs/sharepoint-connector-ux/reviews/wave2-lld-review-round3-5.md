# Wave 2 LLD Review -- Rounds 3-5: Completeness, Cross-Phase, Final Sweep

**Reviewer:** phase-auditor (lld-reviewer)
**Date:** 2026-03-24
**LLD:** `docs/specs/sharepoint-connector-ux/wave2.lld.md`
**HLD:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md` (Section 8, T-13 to T-25)
**Wave 1 LLD:** `docs/specs/sharepoint-connector-ux/wave1.lld.md`
**Test Scenarios:** `docs/specs/sharepoint-connector-ux/testing/base-test-scenarios.md` (Wave 2)
**Prior Reviews:** Round 1 (3C+4H+6M+3L, all fixed), Round 2 (3H+4M+3L, all fixed)

---

## VERDICT: APPROVED

---

## Part A: Round 2 Fix Verification

| R2 ID   | Status | Notes                                                                                                                                                                          |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HIGH-01 | FIXED  | T-14 line 286 now reads import uuidv7 from base-document.js matching Wave 1 pattern from connector-audit-entry.model.ts.                                                       |
| HIGH-02 | FIXED  | T-14 lines 344-346 now include the hot-reload safe export pattern preventing Cannot overwrite model in dev.                                                                    |
| HIGH-03 | FIXED  | T-13 Files to Create no longer lists useConnectorProposal.ts. Line 34 explicitly notes T-16 ownership. File Overlap Check line 1970 confirms exclusive T-16 ownership.         |
| MED-01  | FIXED  | T-14 lines 285-288 now include full imports: mongoose, Schema, model, uuidv7, tenantIsolationPlugin, ModelRegistry.                                                            |
| MED-02  | FIXED  | T-17 Risk Notes (line 1260) documents the auth gap on connector-discovery.ts router.                                                                                           |
| MED-03  | FIXED  | T-16 API Functions section (lines 852-960) now shows full apiFetch calls for all 9 proposal API functions.                                                                     |
| MED-04  | FIXED  | The getConfigSummary endpoint is now in T-15 Route Definitions (line 671). The service function is in T-14 ST-14.7 (line 457-475). T-20 and T-21 consume it from the frontend. |
| LOW-01  | FIXED  | T-13 ST-13.4 now specifies the useConnectorList import path.                                                                                                                   |
| LOW-02  | FIXED  | T-16 Risk Notes (line 1045) specifies which components use useTranslations directly vs receive translated strings via props.                                                   |
| LOW-03  | ACK    | Existing coordination note for Batch 3 is sufficient.                                                                                                                          |

**Summary:** All 10 Round 2 findings have been addressed. No regressions introduced.

---

## Part B: Round 3 -- Completeness

### HLD Task Coverage

Every HLD Wave 2 task (T-13 through T-25) has a corresponding LLD section with subtasks and acceptance criteria:

| HLD Task | HLD Description                                                    | LLD Section | Subtasks | ACs |
| -------- | ------------------------------------------------------------------ | ----------- | -------- | --- |
| T-13     | Create Connect Tab (first-time + returning UX, auth method)        | Present     | 7        | 5   |
| T-14     | Create ProposalState model + proposal generation service           | Present     | 8        | 5   |
| T-15     | Create proposal routes (20 endpoints)                              | Present     | 4        | 4   |
| T-16     | Create Proposal Tab (generation progress, TOC, section review)     | Present     | 10       | 5   |
| T-17     | Create Scope+Filters split-pane (controls + preview panels)        | Present     | 7        | 5   |
| T-18     | Create CELExpressionEditor with autocomplete + validation          | Present     | 3        | 3   |
| T-19     | Create ConditionBuilder with 15 operators + AND/OR                 | Present     | 3        | 4   |
| T-20     | Create Preview Tab (dry-run, content type breakdown)               | Present     | 5        | 4   |
| T-21     | Create Approve & Start view (summary, 3 actions, confirmation)     | Present     | 4        | 4   |
| T-22     | Create Connection scopes display + disable flow (reuse refinement) | Present     | 3        | 2   |
| T-23     | Wire Flow A (SetupGuide opens dialog on Home tab)                  | Present     | 4        | 3   |
| T-24     | Wire Flow D (SourcesTable row click opens panel with correct tab)  | Present     | 5        | 4   |
| T-25     | Backend: name uniqueness check + admin email generation            | Present     | 4        | 5   |

### File Path Plausibility

All file paths follow established patterns:

- Frontend components: `apps/studio/src/components/search-ai/sharepoint/*.tsx` -- consistent with Wave 1 panel/tab structure
- Hooks: `apps/studio/src/hooks/*.ts` -- matches existing useConnector.ts, useConnectorList.ts
- API functions: `apps/studio/src/api/search-ai.ts` -- existing file, append-only
- Backend model: `packages/database/src/models/proposal-state.model.ts` -- matches connector-audit-entry.model.ts
- Backend service: `apps/search-ai/src/services/proposal.service.ts` -- matches connector.service.ts
- Backend routes: `apps/search-ai/src/routes/connector-proposal.ts` -- matches connector-audit.ts, connector-config-versions.ts

### Acceptance Criteria Testability

Every AC has a concrete verify mechanism (component test, unit test, integration test, or build command):

- All build ACs use pnpm build with exit code 0 expectation
- Component test ACs specify the setup condition and expected rendering outcome
- Unit test ACs specify the function call and expected return value
- Integration test ACs specify the HTTP route and expected response shape

### Orphaned References Check

No orphaned references found. Every component reference, hook import, and API function call traces to a task that creates or modifies the referenced artifact.

---

## Part C: Round 4 -- Cross-Phase Consistency

### LLD vs HLD Scope

**No scope creep detected.** The LLD implements exactly the 13 HLD tasks (T-13 through T-25). The LLD does not introduce new tasks or capabilities beyond what the HLD specifies.

**No missing scope detected.** All HLD capabilities for Wave 2 are addressed:

- Connect Tab (C-02): T-13, T-22, T-25
- Configuration Proposal (C-03): T-14, T-15, T-16
- Scope+Filters (C-04): T-17, T-18, T-19
- Preview and Approve (C-05): T-20, T-21
- Flow wiring: T-23 (Flow A), T-24 (Flow D)

### Test Scenarios vs LLD Acceptance Criteria Coverage

| LLD Task | Test Coverage                                                                          | Status |
| -------- | -------------------------------------------------------------------------------------- | ------ |
| T-13     | E2E-W2-01, E2E-W2-02, E2E-W2-03, E2E-W2-04, E2E-W2-14; INT-W2-01, INT-W2-02, INT-W2-10 | Full   |
| T-14     | E2E-W2-05, E2E-W2-06; INT-W2-03, INT-W2-04, INT-W2-09, INT-W2-11, INT-W2-12            | Full   |
| T-15     | INT-W2-03, INT-W2-04, INT-W2-08                                                        | Full   |
| T-16     | E2E-W2-05, E2E-W2-06, E2E-W2-11, E2E-W2-13                                             | Full   |
| T-17     | E2E-W2-07; INT-W2-05                                                                   | Full   |
| T-18     | E2E-W2-08                                                                              | Full   |
| T-19     | E2E-W2-16                                                                              | Full   |
| T-20     | E2E-W2-09; INT-W2-07                                                                   | Full   |
| T-21     | E2E-W2-10; INT-W2-08                                                                   | Full   |
| T-22     | E2E-W2-04, E2E-W2-14                                                                   | Full   |
| T-23     | E2E-W2-12                                                                              | Full   |
| T-24     | Implicit in E2E-W2-03 step 1 (row click), E2E-W2-01 step 1 (Flow D open)               | Full   |
| T-25     | INT-W2-01, INT-W2-10                                                                   | Full   |

All LLD tasks have corresponding test scenarios. Edge cases from test scenarios (E2E-W2-13 token expiry, E2E-W2-15 abandon flow, INT-W2-11 zero sites, INT-W2-12 rate limit) map to risk notes in the LLD.

### Wave 1 Infrastructure References

The LLD correctly references Wave 1 deliverables:

- T-08 (SWR hooks): useConnector, useConnectorList -- used by T-13, T-17
- T-09 (Zustand store): useConnectorStore -- used by T-17, T-23, T-24
- T-10 (SharePointDetailPanel): Panel shell -- used by T-13, T-16, T-17, T-20, T-23, T-24
- T-11 (TypeToConfirmInput): Reusable component -- used by T-13/ConnectionScopesDisplay, T-16/ProposalPermissionsSection
- T-06 (ConnectorAuditEntry): Audit logging -- used by T-14/approveProposal

---

## Part D: Round 5 -- Final Sweep

### Task Independence Validation

The Task Independence Matrix (lines 1916-1932) is accurate:

- **Batch 1** (T-14, T-18, T-19, T-25): No inter-dependencies. T-14 only depends on Wave 1 T-06. T-18, T-19, T-25 are fully independent. Correct.
- **Batch 2** (T-15): Depends on T-14. Correct.
- **Batch 3** (T-13, T-17, T-20, T-23, T-24): All depend on Wave 1 T-10. No Batch 3 internal dependencies. Correct.
- **Batch 4** (T-22): Depends on T-13. Correct.
- **Batch 5** (T-16): Depends on T-15 and T-10. Correct.
- **Batch 6** (T-21): Depends on T-20. Correct.

### Wiring Completeness

Every new file is imported/mounted/exported:

- **ProposalState model** (T-14): Exported from packages/database/src/index.ts (ST-14.1), registered with ModelRegistry
- **Proposal routes** (T-15): Mounted in server.ts at line ~185 (ST-15.3)
- **ProposalTab** (T-16): Rendered inside SharePointDetailPanel (T-10 shell provides tab routing)
- **ConnectTab** (T-13): Rendered inside SharePointDetailPanel
- **ScopeFiltersSplitPane** (T-17): Rendered inside SharePointDetailPanel
- **PreviewTab** (T-20): Rendered inside SharePointDetailPanel
- **ApproveAndStart** (T-21): Rendered inside PreviewTab or as a separate tab view
- **CELExpressionEditor** (T-18): Rendered inside ScopeControlsPanel (T-17 ST-17.4 advanced section)
- **ConditionBuilder** (T-19): Rendered inside ScopeControlsPanel (T-17 ST-17.4 advanced section)
- **SWR hooks** (T-16, T-17): Imported by corresponding tab components
- **API functions** (T-13, T-16, T-20): Added to search-ai.ts, consumed by components

### Domain Rules Compliance

| Rule                       | Status | Notes                                                                                                                    |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation           | PASS   | All service functions take tenantId. All DB queries include tenantId. Partial unique index leads with tenantId.          |
| Auth middleware            | PASS   | T-15 explicitly specifies router.use(authMiddleware). T-25 adds routes to existing connectors.ts which already has auth. |
| Zod validation             | PASS   | T-15 defines 6 Zod schemas with z.string().min(1) for IDs (correct pattern). T-25 defines 2 schemas.                     |
| i18n                       | PASS   | T-13, T-16, T-20 specify i18n keys under search_ai.sharepoint. Pattern matches Wave 1 approach.                          |
| Error handling             | PASS   | handleError pattern from connectors.ts used. err instanceof Error guard specified.                                       |
| Logger                     | PASS   | createLogger in T-14 and T-15.                                                                                           |
| Express route ordering     | PASS   | T-25 specifies exact insertion point before parameterized connectorId route with line references.                        |
| No any types               | PASS   | sections uses Record of string to unknown not any. data also uses Record of string to unknown in modifySection.          |
| Hot-reload model export    | PASS   | mongoose.models.ProposalState fallback pattern specified.                                                                |
| ModelRegistry registration | PASS   | registerModelDefinition with platform affinity specified.                                                                |

### Implementation Readiness Assessment

Could a developer pick up any task without questions?

| Task | Ready? | Minor Gaps (not blocking)                                                                                                      |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| T-13 | Yes    | GUID_VALIDATOR regex mentioned in Risk Notes for reuse -- developer can find it in existing EnterpriseConnectorWizard line 111 |
| T-14 | Yes    | Generation step logic is pseudocode-level but sufficient with existing endpoint references                                     |
| T-15 | Yes    | Clear route pattern with Zod schemas, authMiddleware, handleError all specified                                                |
| T-16 | Yes    | Largest task; advisory split into T-16a/T-16b documented                                                                       |
| T-17 | Yes    | FilterConfig type fully defined; preview hook debounce specified                                                               |
| T-18 | Yes    | v1 scope (textarea, not CodeMirror) is clear; autocomplete mechanics described                                                 |
| T-19 | Yes    | All 15 operators enumerated; max nesting and conditions specified                                                              |
| T-20 | Yes    | API functions fully specified with method/URL/body                                                                             |
| T-21 | Yes    | Dependencies on T-20 and T-16 API functions explicit                                                                           |
| T-22 | Yes    | Minimal task -- add compact prop to existing component                                                                         |
| T-23 | Yes    | Before/after code for both SetupGuide and AddSourceButton shown                                                                |
| T-24 | Yes    | Before/after conceptual code shown; store usage pattern clear                                                                  |
| T-25 | Yes    | Zod schemas, route placement, service function signatures all specified                                                        |

---

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM (informational -- not blocking)

- **[MED-01] T-14: Generation pipeline retry-from-failed-step not in service interface.** The risk note (line 632) says the UI can display a Retry button that re-runs from the failed step but no retryFromStep service function is defined. Acceptable for Wave 2 -- retry means full regeneration via startGeneration after abandonProposal. Per-step retry can be added as an enhancement.

- **[MED-02] T-17: Advanced section references T-18 (CEL) and T-19 (Condition Builder) which run in Batch 1, while T-17 runs in Batch 3 -- but T-17 does not list T-18/T-19 as dependencies.** This is correct behavior -- T-17 renders a placeholder for the Advanced section that accepts T-18/T-19 as children. Since Batch 1 runs before Batch 3, this resolves naturally.

- **[MED-03] T-21: Export Template button tooltip text not specified as an i18n key.** The button is correctly deferred to Wave 4 (disabled with tooltip). Add an i18n key for the tooltip text in a future pass. Non-blocking.

---

## Cross-Phase Consistency

- [XP-1] PASS -- Every LLD task traces to an HLD task (T-13 through T-25). Every service function references existing code with line numbers.
- [XP-2] PASS -- The LLD enables implementation: file paths, function signatures, component interfaces, Zod schemas, i18n keys, and subtask ordering are all specified.
- [XP-3] PASS -- No scope creep. The LLD does not introduce capabilities beyond the HLD Wave 2 specification.
- [XP-4] PASS -- Terminology is consistent: ProposalState (not ConfigurationProposal), ConnectTab (not ConnectionTab), ScopeFiltersSplitPane (not FilterEditor), matching HLD naming.
- [XP-5] N/A -- No package-level agents.md files exist yet for the affected packages. These will be created during implementation per SDLC pipeline.

---

## Verified

- [x] All 16 Round 1 findings fixed (verified in Round 2)
- [x] All 10 Round 2 findings fixed (verified above)
- [x] All 13 HLD Wave 2 tasks have LLD sections with subtasks and ACs
- [x] All file paths follow established codebase conventions
- [x] All acceptance criteria are testable with concrete verify commands
- [x] No orphaned references (every import/mount/export traced)
- [x] Test scenarios (16 E2E + 13 integration) cover all LLD tasks
- [x] Wave 1 infrastructure correctly referenced (T-06, T-08, T-09, T-10, T-11)
- [x] Task Independence Matrix is accurate with valid batch ordering
- [x] Wiring complete -- every new file imported, mounted, or exported
- [x] Tenant isolation in all service functions and DB queries
- [x] Auth middleware specified on all new route files
- [x] Zod validation with z.string().min(1) for IDs
- [x] Express route ordering: static before parameterized, with line references
- [x] i18n keys specified for all user-visible strings
- [x] Logger via createLogger in all new service and route files
- [x] Error handling via handleError pattern with err instanceof Error guard
- [x] Hot-reload safe model export pattern
- [x] ModelRegistry registration with platform affinity
- [x] File Overlap Check table covers all multi-task files with resolution strategy
- [x] getConfigSummary endpoint exists in both backend (T-15) and frontend (T-20)
- [x] useConnectorProposal ownership unambiguous (T-16 only)
- [x] uuidv7 import from base-document.js (not npm package)
- [x] ProposalState partial unique index excludes abandoned/failed statuses
- [x] Async generation: startGeneration returns immediately, HTTP 202, frontend polls

---

## Summary

The Wave 2 LLD has been through 5 rounds of review (3 CRITICAL + 4 HIGH + 6 MEDIUM + 3 LOW in Round 1, 3 HIGH + 4 MEDIUM + 3 LOW in Round 2). All findings have been resolved. The document is comprehensive, implementation-ready, and consistent with the HLD, test scenarios, and Wave 1 patterns.

The LLD is **APPROVED** for implementation.
