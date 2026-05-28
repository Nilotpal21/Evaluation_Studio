# LLD Review Rounds 4-5: Cross-Phase Consistency + Final Sweep

**Document:** `docs/specs/sharepoint-connector-ux/wave1.lld.md`
**HLD Reference:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md`
**Test Scenarios:** `docs/specs/sharepoint-connector-ux/testing/base-test-scenarios.md`
**Reviewer:** phase-auditor (lld-reviewer role)
**Date:** 2026-03-24
**Focus:** R3 fix verification, cross-phase consistency (HLD alignment), final sweep (implementation readiness)

---

## R3 Fix Verification

| Finding | Fixed? | Notes                                                                                                                                                                   |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3-01   | YES    | ST-06.5 (line 505) mounts connectorAuditRouter in server.ts. ST-07.5 (line 674) mounts connectorConfigVersionRouter. server.ts added to File Overlap table (line 1318). |
| F3-02   | YES    | Line 1134 now uses correct key without stale sharepoint prefix. Key list at line 1085 is consistent.                                                                    |
| F3-03   | NO     | diffQuery Zod schema still present at lines 651-654 in T-07 Validation Schemas. No route in Wave 1 uses it. No comment noting deferral to Wave 4.                       |
| F3-04   | YES    | ST-06.6 (line 506) and ST-07.6 (line 675) both specify exporting model AND interface type from packages/database/src/index.ts.                                          |

**R3 Summary:** 3 of 4 findings fixed. F3-03 remains unfixed (LOW severity, non-blocking).

---

## Round 4: Cross-Phase Findings

### Finding F4-01: HLD models include projectId but LLD omits it (deliberate -- VERIFIED OK)

- **Severity:** INFO (no action needed)
- **Location:** HLD section 4f (ConnectorAuditEntry, ConnectorConfigVersion both list projectId); LLD T-06 (line 382-395) and T-07 (line 557-570) omit it.
- **Analysis:** The LLD explicitly documents this deviation in Risk Notes at lines 532 and 701: "Connector scope is defined by tenantId + connectorId. Project-level scoping is not applicable as connectors are tenant-scoped resources accessed via indexId." This is a well-justified refinement of the HLD design during detailed implementation analysis. The existing ConnectorConfig model also scopes by tenantId + connectorId (not projectId), confirming the LLD approach is consistent with the codebase.
- **Verdict:** No change needed. The LLD correctly documents the deviation and its rationale.

### Finding F4-02: HLD version field type (string) differs from LLD (number)

- **Severity:** INFO (no action needed)
- **Location:** HLD section 4f: `version: string (e.g., "v5")`; LLD T-07 (line 561): `version: number`
- **Analysis:** The LLD numeric auto-increment approach is more implementation-sound -- it enables comparison operators, avoids string parsing, and the unique compound index works naturally with numbers for optimistic concurrency. The HLD "v5" format was a high-level sketch. This is a valid refinement.
- **Verdict:** No change needed.

### Finding F4-03: HLD useConnectorList signature has filters param, LLD omits it

- **Severity:** LOW
- **Location:** HLD section 4g: `useConnectorList(kbId, filters)` vs LLD T-08 (line 795): `useConnectorList(indexId)`
- **Issue:** The HLD specifies a filters parameter for the connector list hook, but the LLD omits it. For Wave 1, the list hook fetches all connectors for the index without filtering, which is reasonable since filtering is a Wave 3 SourcesTable enhancement (T-38). However, the omission should be noted to avoid future confusion.
- **Fix:** Add a brief comment to T-08 useConnectorList noting: "Filtering support (status, type) deferred to Wave 3 (T-38) when SourcesTable enhancements are built."

### Finding F4-04: HLD useConnector takes connectorId only, LLD adds indexId parameter

- **Severity:** INFO (no action needed)
- **Location:** HLD section 4g: `useConnector(connectorId)` vs LLD T-08 (line 772-775): `useConnector(indexId, connectorId)`
- **Analysis:** The LLD adds indexId because the backend route is `GET /:indexId/connectors/:connectorId` -- the index ID is required in the URL path. This is a necessary refinement based on actual API shape. The HLD shorthand was conceptual.
- **Verdict:** No change needed.

### Finding F4-05: LLD ConnectorAuditEntry has extra fields not in HLD

- **Severity:** INFO (no action needed)
- **Location:** LLD T-06 adds actorType, category, \_v, createdAt, updatedAt beyond HLD sketch.
- **Analysis:** These are standard model fields (audit trail categorization, schema versioning, timestamps) that are implementation-level details the HLD correctly left unspecified. The additions are consistent with existing model patterns in the codebase.
- **Verdict:** No change needed.

### Finding F4-06: Test scenario coverage for LLD acceptance criteria

- **Severity:** INFO (traceability verified)
- **Analysis:** Mapping LLD acceptance criteria to test scenarios:

| LLD Task | ACs | Test Coverage                                                             | Gap? |
| -------- | --- | ------------------------------------------------------------------------- | ---- |
| T-01     | 4   | INT-W1-02 (scopes), INT-W1-05 (permission modes)                          | No   |
| T-02     | 2   | INT-W1-03 (pause/resume)                                                  | No   |
| T-03     | 3   | INT-W1-01 (Redis state)                                                   | No   |
| T-04     | 3   | INT-W1-04 (model registration)                                            | No   |
| T-05     | 4   | INT-W1-05 (permission crawler)                                            | No   |
| T-06     | 4   | INT-W1-08 (audit model + routes)                                          | No   |
| T-07     | 4   | No dedicated integration scenario for version routes                      | YES  |
| T-08     | 3   | INT-W1-06 (SWR hooks)                                                     | No   |
| T-09     | 4   | INT-W1-07 (Zustand store)                                                 | No   |
| T-10     | 6   | E2E-W1-01 to E2E-W1-08 (panel shell, tabs, expand, actions)               | No   |
| T-11     | 4   | E2E-W2-04 covers type-to-confirm in use, but no dedicated Wave 1 scenario | Note |
| T-12     | 2   | No dedicated scenario (removal verified by build)                         | No   |

- **Gap:** T-07 (ConnectorConfigVersion routes) has no integration test scenario in the Wave 1 section. INT-W1-08 covers the audit model but there is no corresponding INT-W1-09 for version history routes. The version model auto-increment, pagination, and tenant isolation all need integration testing.
- **Fix:** This is a test spec gap, not an LLD gap. Flag for the test-spec skill to add an INT-W1-09 scenario for ConnectorConfigVersion routes.

---

## Round 5: Final Sweep Findings

### Finding F5-01: Orphaned diffQuery Zod schema still present (unfixed F3-03)

- **Severity:** LOW
- **Location:** LLD T-07 lines 651-654
- **Issue:** The diffQuery schema is defined but no Wave 1 route uses it. This was flagged in R3 as F3-03 and was not fixed.
- **Fix:** Remove diffQuery from T-07 Validation Schemas. Add a one-line comment noting deferral to Wave 4 (T-46).

### Finding F5-02: Task dependency graph is acyclic and correctly documented

- **Severity:** PASS
- **Analysis:** Verified the dependency graph:
  - T-01 then T-02 then T-03 (serial on connector.service.ts)
  - T-01 then T-05 (permission mode type)
  - T-08 and T-09 then T-10 (hooks + store then panel)
  - All others independent
  - No cycles. File serialization for connector.service.ts is documented in both the Task Independence Matrix (lines 1282-1297) and File Overlap Check (lines 1308-1331).

### Finding F5-03: Wiring completeness verified

- **Severity:** PASS
- **Analysis:**
  - T-06: model created, registered with ModelRegistry, exported from index.ts (ST-06.6), routes created, mounted in server.ts (ST-06.5). Full chain.
  - T-07: Same full chain via ST-07.5 and ST-07.6.
  - T-08: SWR hooks created, consumed by T-10 (panel shell). Documented dependency.
  - T-09: Zustand store created, consumed by T-10. Documented dependency.
  - T-10: Panel shell created, uses SlidePanel, Tabs, DropdownMenu from design system (all verified to exist in HLD section 3).
  - T-11: TypeToConfirmInput created in components/ui/, consumed by Wave 2+ components. No Wave 1 wiring needed (the component is a leaf).
  - T-12: Deletion. Verified no imports (subtask ST-12.1 includes grep check).

### Finding F5-04: Domain rules compliance verified

- **Severity:** PASS
- **Analysis:**
  - **Tenant isolation:** Every query in T-06 and T-07 services includes tenantId in the filter (explicitly stated in ST-06.2, line 502, and T-07 AC-03, line 686). Model schemas use tenantIsolationPlugin.
  - **Auth:** Routes use authMiddleware from parent router (ST-06.3, line 503).
  - **No console.log:** Not used anywhere in the LLD (services use createLogger pattern per CLAUDE.md).
  - **Zod validation:** All route params use min(1) string validation for IDs (lines 474, 647-648) -- correct per CLAUDE.md rules.
  - **i18n:** Keys properly namespaced under search_ai.sharepoint (line 1063) and search_ai.type_to_confirm (line 1202).
  - **Error handling:** Both T-06 and T-07 follow the handleError() pattern from connectors.ts (lines 503, 672).

### Finding F5-05: No TODOs or unresolved placeholders

- **Severity:** PASS
- **Analysis:** Searched the full LLD for TODO, TBD, FIXME, placeholder markers. The only "placeholder" usage is the intentional Wave 1 tab content placeholder (line 1100, 1134) -- which is a design decision, not an unfinished spec.

### Finding F5-06: Effort estimates are reasonable

- **Severity:** PASS
- **Analysis:** Cross-referencing HLD effort estimates with LLD file counts:

| Task | HLD Estimate | LLD Files           | Assessment                                              |
| ---- | ------------ | ------------------- | ------------------------------------------------------- |
| T-01 | 3-4 hours    | 4 modify            | Reasonable                                              |
| T-02 | 2-3 hours    | 2 modify            | Reasonable                                              |
| T-03 | 2-3 hours    | 1 modify            | Reduced (scope reclassified to hardening) -- reasonable |
| T-04 | 2 hours      | 2 modify            | Reasonable                                              |
| T-05 | 3-4 hours    | 3 modify            | Reasonable                                              |
| T-06 | 5-6 hours    | 1 modify + 3 create | Reasonable                                              |
| T-07 | 5-6 hours    | 1 modify + 3 create | Reasonable                                              |
| T-08 | 4-5 hours    | 3 create            | Reasonable                                              |
| T-09 | 2-3 hours    | 1 create            | Reasonable                                              |
| T-10 | 4-5 hours    | 1 create            | Reasonable (complex component but Wave 1 is shell only) |
| T-11 | 1-2 hours    | 1 create            | Reasonable                                              |
| T-12 | 1 hour       | 1 delete            | Reasonable                                              |

### Finding F5-07: Implementation readiness assessment

- **Severity:** PASS
- **Analysis:** Each task contains:
  - Problem statement with exact line references to existing code
  - Files to modify/create with specific paths
  - Function signatures (before/after for modifications)
  - Numbered subtasks in execution order
  - Acceptance criteria with concrete verify commands
  - Dependencies and risk notes
  - For new models: full schema, indexes, plugins, and registration code

A developer can pick up any task and begin implementation without asking clarifying questions. The LLD is implementation-ready.

---

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 0     |
| MEDIUM   | 0     |
| LOW      | 2     |

**VERDICT: PASS**

### LOW items (non-blocking, fix if convenient)

1. **F3-03 (carried from R3):** Remove orphaned diffQuery Zod schema from T-07 Validation Schemas (lines 651-654). Add a comment noting deferral to Wave 4 (T-46).
2. **F4-03:** Add a comment to T-08 useConnectorList noting that the filters parameter is deferred to Wave 3 (T-38).

### Noted for test spec (not an LLD issue)

- T-07 (ConnectorConfigVersion) has no dedicated integration scenario in the Wave 1 test spec. Recommend adding INT-W1-09 to the test spec covering version auto-increment, pagination, and tenant isolation.

### Verified complete

- [x] **R3 fix verification:** 3 of 4 fixed (F3-03 is LOW and non-blocking)
- [x] **HLD task mapping:** All 12 Wave 1 tasks (T-01 to T-12) present with 1:1 coverage
- [x] **HLD scope alignment:** No scope creep -- LLD stays within HLD Wave 1 boundaries
- [x] **HLD model alignment:** Deviations (no projectId, numeric version) are justified and documented
- [x] **HLD SWR alignment:** 3 of 7 hooks in Wave 1 matches HLD T-08 scope; remaining 4 deferred to later waves
- [x] **Test scenario coverage:** All tasks covered except T-07 (test spec gap, not LLD gap)
- [x] **Task independence:** Acyclic dependency graph, file serialization documented
- [x] **Wiring completeness:** All new files are imported/mounted/exported in the chain
- [x] **Domain rules:** Tenant isolation, auth, Zod validation, i18n, error handling all correct
- [x] **No TODOs/placeholders:** Clean (intentional tab placeholders excluded)
- [x] **Effort estimates:** All reasonable, T-03 reduced scope acknowledged
- [x] **Implementation readiness:** Every task has problem, files, signatures, subtasks, ACs, risks

### Notes for implementation

- The recommended batch execution (Batch 1: T-01, T-04, T-06, T-07, T-08, T-09, T-11, T-12 in parallel; Batch 2: T-02, T-05; Batch 3: T-03; Batch 4: T-10) is well-structured. T-10 is the integration point that brings together the panel shell with SWR hooks and store.
- The two LOW findings (orphaned diffQuery, missing filters comment) can be fixed during implementation as minor cleanup rather than requiring an LLD revision cycle.
