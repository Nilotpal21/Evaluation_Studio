# Test Scenarios Review -- Round 1: Coverage Completeness

**Reviewer:** Phase Auditor
**Artifact:** `docs/specs/sharepoint-connector-ux/testing/base-test-scenarios.md`
**Date:** 2026-03-24
**Round:** 1 of N

---

## Executive Summary

The base test scenarios document is well-structured with 45 E2E and 35 integration scenarios across 4 waves plus 5 cross-wave scenarios (80 total). The Edge Case Catalog is thorough and maps every edge case from all 12 capability notes. However, I found several gaps in coverage -- primarily around C-03 edge cases that have no dedicated scenarios, specific error states that are only "implied" rather than explicitly tested, and a handful of C-04 and C-08 edge cases that lack direct coverage.

---

## Findings

### Finding F-01: E2 (Discovery Timeout) has no dedicated E2E scenario

- **Severity:** HIGH
- **Source:** C-11 E2 -- Discovery Timeout (1000+ sites)
- **Issue:** Error state E2 is one of the 10 discriminated error types but has no dedicated E2E scenario. The Edge Case Catalog (line 1552) maps E2 to "CW-02 (implied), INT-W2-03" -- but CW-02 is a sync failure recovery journey (E3, not E2), and INT-W2-03 is about proposal generation orchestration. Neither explicitly tests the Discovery Timeout UI: the three-option numbered list (Continue with partial, Search specific sites, Re-run full discovery), the stats bar (sites discovered / profiled / drives found), or the timeout-specific actions.
- **Evidence:** C-11 E2 specifies: "Shows total sites discovered vs sites fully profiled. Three options presented as a numbered list: 1. Continue with partial data. 2. Inline search input to find specific sites. 3. Re-run full discovery with estimated time. Stats bar at bottom."
- **Recommendation:** Add `E2E-W3-XX: Error State E2 -- Discovery Timeout (1000+ Sites)` that opens a connector in discovery-timeout state, verifies the three options, the stats bar, and the "Continue with partial data" action flow.

### Finding F-02: E4 (Token Expired / Refresh Failed) has no dedicated E2E scenario

- **Severity:** HIGH
- **Source:** C-11 E4 -- Token Expired (Refresh Failed)
- **Issue:** E4 is mapped to "E2E-W3-02 (token expires during sync)" in the Edge Case Catalog (line 1554), but E2E-W3-02 is a sync progress scenario whose E4 coverage is a side-effect edge case ("Token expires during sync -- status becomes 'disconnected'"), not a dedicated test of the E4 error state UI. The E4 UI has unique elements: expiry date display, days remaining, auto-refresh failure details (last attempt timestamp, error code), "To fix: Someone with admin access needs to re-authenticate" guidance text, and the [Re-authenticate Now] button as the sole action (delegation excluded).
- **Evidence:** C-11 E4 specifies: "Shows expiry date (absolute), days remaining, and consequence description (delta syncs stop, content goes stale). Shows auto-refresh failure details: last attempt timestamp, error code. Displays 'To fix' guidance text."
- **Recommendation:** Add `E2E-W3-XX: Error State E4 -- Token Expired (Refresh Failed)` that opens a connector with an expired token (not during sync but standalone), verifies the expiry display, auto-refresh failure details, consequence text, and [Re-authenticate Now] action.

### Finding F-03: E5 (Permission Revoked) has no dedicated E2E scenario

- **Severity:** HIGH
- **Source:** C-11 E5 -- Permission Revoked
- **Issue:** E5 is mapped to "E2E-W4-05 (related to emergency revoke)" (line 1555), but E2E-W4-05 tests the emergency revoke flow (user-initiated), not the Permission Revoked error state (externally triggered). E5 has unique UI elements: names the exact revoked permission, bulleted impact list, auto-paused indicator, and three distinct actions ([Share Issue with IT Admin], [Re-authenticate], [Delete Connector]).
- **Evidence:** C-11 E5 specifies: "Names the exact permission that was removed (e.g., 'Sites.Read.All'). Shows bulleted impact list. States sync schedule was auto-paused. Actions: [Share Issue with IT Admin], [Re-authenticate], [Delete Connector]."
- **Recommendation:** Add `E2E-W3-XX: Error State E5 -- Permission Revoked` that opens a connector with a revoked permission, verifies the specific permission name, impact list, auto-pause indicator, and all three actions.

### Finding F-04: E8 (Zero Sites Found) E2E coverage is missing

- **Severity:** HIGH
- **Source:** C-11 E8 -- Zero Sites Found
- **Issue:** E8 is mapped to "INT-W2-09 (Sites.Selected with 0 sites)" (line 1558), which is an integration test for the proposal's Sites.Selected variant. There is no E2E scenario that tests the E8 error state UI on the Scope tab: the 3 numbered possible reasons with inline fix guidance, the current permission scope display, the scope upgrade suggestion, and the three actions ([Retry Discovery], [Upgrade Scope], [Enter Site URL Manually]).
- **Evidence:** C-11 E8 specifies: "Shows 3 numbered possible reasons with inline fix guidance. Shows current permission scope. Suggests scope upgrade if on limited scope. Actions: [Retry Discovery], [Upgrade Scope], [Enter Site URL Manually]."
- **Recommendation:** Add `E2E-W3-XX: Error State E8 -- Zero Sites Found` as an E2E scenario that renders the E8 error state on the Scope tab and tests the three actions.

### Finding F-05: E10 (All Files Unsupported) E2E coverage is weak

- **Severity:** MEDIUM
- **Source:** C-11 E10 -- All Files Unsupported
- **Issue:** E10 is mapped to "E2E-W2-09 (implied via zero docs)" (line 1560), but E2E-W2-09 tests the Preview/Dry-Run tab and its zero-document edge case is about filter exclusion, not about all files being non-indexable. E10 has unique UI elements: total file count, discovered format types summary, supported file types with expandable list, contextual insight ("This site appears to contain media assets"), and three actions ([Select Different Sites], [Upload Files Instead], [Cancel Setup]).
- **Evidence:** C-11 E10 specifies: "Shows total file count and summary of discovered format types. Lists supported file types with [View all N types]. Contextual insight. Actions: [Select Different Sites], [Upload Files Instead], [Cancel Setup]."
- **Recommendation:** Add `E2E-W3-XX: Error State E10 -- All Files Unsupported` that tests the Preview tab with a connector whose discovered files are all non-indexable (PNG, MP4, etc.) and verifies the three actions.

### Finding F-06: C-03 edge case "Token expires during proposal review" not explicitly tested

- **Severity:** MEDIUM
- **Source:** C-03 Edge Cases -- "Token expires during proposal review"
- **Issue:** No scenario tests the specific case where a token expires while the user is mid-proposal-review. The expected behavior is: Connection section shows degraded state with [Re-authenticate], other sections remain viewable, "Approve All & Start Sync" is disabled until token is refreshed.
- **Evidence:** C-03 Edge Cases: "Token expires during proposal review: The Connection section should show a degraded state with a [Re-authenticate] action. Other sections remain viewable but 'Approve All & Start Sync' should be disabled until token is refreshed."
- **Recommendation:** Add a step to E2E-W2-06 or create a new scenario that simulates token expiry during proposal review and verifies the degraded Connection section and disabled Approve button.

### Finding F-07: C-03 edge case "Sensitive content detected + Public Access opt-in" not tested

- **Severity:** MEDIUM
- **Source:** C-03 Edge Cases -- "Sensitive content detected + Public Access opt-in"
- **Issue:** No scenario tests the case where sensitive content labels are detected and the user still opts into Public Access via the type-to-confirm flow. The expected behavior includes an additional "Sensitive Content Detected" box with label breakdown (Confidential, Internal Only, Restricted counts).
- **Evidence:** C-03 Edge Cases: "Sensitive content detected + Public Access opt-in: The disable flow shows an additional 'Sensitive Content Detected' box with label breakdown."
- **Recommendation:** Add a step to E2E-W2-04 (type-to-confirm disable) that tests with a connector whose discovery has found sensitive content labels, verifying the additional warning box.

### Finding F-08: C-03 edge case "Zero sites discovered (Sites.Read.All)" not tested

- **Severity:** MEDIUM
- **Source:** C-03 Edge Cases -- "Zero sites discovered (Sites.Read.All)"
- **Issue:** INT-W2-09 covers Sites.Selected (Variant B), but there is no test for the case where Sites.Read.All is granted yet zero sites are discovered. The proposal cannot be approved without at least one site. This is distinct from E8 (which is about the Scope tab error state) -- this is about the proposal Scope section behavior.
- **Evidence:** C-03 Edge Cases: "Zero sites discovered (Sites.Read.All): Scope section shows 'No SharePoint sites found' with troubleshooting guidance. The proposal cannot be approved without at least one site."
- **Recommendation:** Add an integration test `INT-W2-XX: Proposal Scope with Zero Discovered Sites (Sites.Read.All)` to verify the proposal section behavior and Approve button being disabled.

### Finding F-09: C-03 edge case "All sites excluded by recommendation" not tested

- **Severity:** LOW
- **Source:** C-03 Edge Cases -- "All sites excluded by recommendation"
- **Issue:** No scenario tests the case where all sites are placed in the "Excluded" list by the recommendation engine, requiring the user to re-include at least one.
- **Evidence:** C-03 Edge Cases: "All sites excluded by recommendation: Scope section shows all sites in the 'Excluded' list with a prompt to re-include at least one."
- **Recommendation:** Add an integration scenario or step that verifies proposal behavior when all discovered sites are excluded.

### Finding F-10: C-03 edge case "Browser refresh mid-review" not explicitly tested

- **Severity:** LOW
- **Source:** C-03 Edge Cases -- "Browser refresh mid-review"
- **Issue:** No scenario explicitly tests that browser refresh during proposal review restores the exact review state from the server. INT-W2-04 tests section review API operations but does not test the UI rehydration after refresh.
- **Evidence:** C-03 Edge Cases: "Browser refresh mid-review: Since proposal state is server-side, refreshing the page should restore the exact review state."
- **Recommendation:** Add a step to E2E-W2-06 that refreshes the browser mid-review and verifies state preservation.

### Finding F-11: C-03 "Rate limit exhausted during generation" not tested

- **Severity:** LOW
- **Source:** C-03 Edge Cases -- "Rate limit exhausted during generation"
- **Issue:** No scenario tests the behavior when rate limits cause the Health Check step to surface a WARN during generation and generation takes longer than 90 seconds.
- **Evidence:** C-03 Edge Cases: "Rate limit exhausted during generation: The Health Check step surfaces a WARN. Generation continues but may be slower. The UI should not time out."
- **Recommendation:** Add an integration test that simulates slow generation (>90s) to verify the UI continues polling and does not time out.

### Finding F-12: C-03 "Overlapping webhook subscriptions" edge case not tested

- **Severity:** LOW
- **Source:** C-03 Edge Cases -- "Overlapping webhook subscriptions"
- **Issue:** No scenario tests the Schedule section note about 409 conflicts when multiple connectors share overlapping webhook subscriptions.
- **Evidence:** C-03 Edge Cases: "When multiple connectors share the same Azure AD app and sync overlapping libraries, the Schedule section shows a note about 409 conflicts."
- **Recommendation:** Add an integration scenario for proposal generation with overlapping webhook subscriptions, verifying the Schedule section note.

### Finding F-13: C-03 "Abandon -- Do Not Sync" confirmation dialog not tested end-to-end

- **Severity:** MEDIUM
- **Source:** C-03 Per-Section Action Buttons -- Sample Preview section
- **Issue:** E2E-W2-06 lists "Abandon -- Do Not Sync" in the edge cases reference but its steps do not actually exercise this action. The confirmation dialog (which states what will be lost: discovery results, configuration, review progress), the connector deletion/cancellation, and panel close are not tested.
- **Evidence:** C-03 specifies: "Abandon -- Do Not Sync: Cancels the entire connector setup. Requires confirmation dialog before executing." The Edge Case Catalog (line 1420) lists it as covered by E2E-W2-06 but the scenario steps do not include these actions.
- **Recommendation:** Either add steps to E2E-W2-06 that exercise the Abandon flow (click Abandon on Sample Preview, verify confirmation dialog content, confirm, verify connector deleted and panel closes), or create a dedicated E2E scenario for this destructive action.

### Finding F-14: C-08 "Search Documents" navigation not tested

- **Severity:** LOW
- **Source:** C-08 UI Behaviors item 10 -- [Search Documents]
- **Issue:** No scenario tests the [Search Documents] quick action which navigates to Data tab > Documents segment with a pre-applied filter for connectorId. The Documents view columns (document name, status, connector, indexed date) are also not verified.
- **Evidence:** C-08 item 10: "[Search Documents] navigates to Data tab > Documents segment with a pre-applied filter for connectorId."
- **Recommendation:** Add a step to E2E-W3-01 that clicks [Search Documents] and verifies navigation to Documents view with the connector filter applied.

### Finding F-15: C-08 "Source attribution note" with backend caveat not tested

- **Severity:** LOW
- **Source:** C-08 UI Behaviors item 11 -- Source attribution note
- **Issue:** No scenario tests the "Not yet populated -- requires backend work" caveat that should be displayed until backend work is complete.
- **Evidence:** C-08 item 11: "The design wireframe includes a 'Not yet populated -- requires backend work' caveat."
- **Recommendation:** Add verification to E2E-W3-01 that the source attribution note with the backend caveat is displayed.

### Finding F-16: C-04 "Condition Builder" with AND/OR grouping not explicitly tested

- **Severity:** MEDIUM
- **Source:** C-04 UI Behaviors -- Condition Builder
- **Issue:** E2E-W2-07 tests the Scope+Filters split-pane broadly but does not explicitly test the Condition Builder with its 15 operators, AND/OR grouping, and one level of nesting. E2E-W2-08 tests the CEL editor but these are separate features.
- **Evidence:** C-04 item 8: "Condition Builder: Field/Operator/Value triplet with [+ Add Condition]. 15 operators. AND/OR grouping with one level of nesting."
- **Recommendation:** Add an E2E scenario or extend E2E-W2-07 to explicitly test: adding conditions via the Condition Builder, switching between AND/OR logic, and verifying that filter preview updates based on condition builder changes.

### Finding F-17: C-06 "Request GroupMember.Read.All" scope upgrade flow not tested

- **Severity:** MEDIUM
- **Source:** C-06 UI Behaviors -- "Request GroupMember.Read.All" button
- **Issue:** No scenario tests the [Request GroupMember.Read.All] button on the Security tab, which triggers a re-auth flow or admin consent request. E2E-W4-04 verifies that the GroupMember.Read.All status is displayed, but does not test the request upgrade action.
- **Evidence:** C-06: "Show a 'Request GroupMember.Read.All' button when that scope is not yet granted. Inline description: 'adds group resolution capability.'"
- **Recommendation:** Add a step to E2E-W4-04 or create a separate scenario where GroupMember.Read.All is NOT granted, verify the request button appears, and test the scope upgrade flow.

### Finding F-18: C-06 Simplified View behavior on Security tab not tested

- **Severity:** MEDIUM
- **Source:** C-06 Simplified View Behavior
- **Issue:** No scenario tests that when Simplified View is ON, the Security tab shows only the 4 essentials (permission mode, required scopes in plain language, security gate status, known limitations) and hides advanced content (ACL mode, CEL/OData, blast radius, data handling, audit log, export, emergency revoke).
- **Evidence:** C-06 Simplified View: "When ON, shows only: 1. Permission mode. 2. Required scopes in plain language. 3. Security Gate status. 4. Known limitations summary. Hides: ACL mode details, CEL/OData references, blast radius, data handling, audit log, export, emergency revoke."
- **Recommendation:** Add a step to E2E-W4-04 or a new scenario that verifies the Security tab content in Simplified View vs Full View, checking that advanced sections are hidden and "pipeline" is replaced with "system."

### Finding F-19: API Coverage Matrix "Available" and "Partial" endpoints lack systematic integration test mapping

- **Severity:** MEDIUM
- **Source:** Phase 3 API Coverage Matrix
- **Issue:** The API Coverage Matrix identifies 24 "Available" and 14 "Partial" endpoints. While many are tested indirectly through E2E scenarios, there is no systematic mapping between the API matrix and integration tests. Several "Partial" endpoints -- which may need enhancement -- lack explicit integration tests verifying the enhanced response shape. For example:
  - C-01 API-7 (Health Check standalone trigger) -- Partial, no dedicated integration test
  - C-05 Sync Progress (Partial -- missing per-site breakdown, current document, ETA) -- covered by INT-W3-02 but enhancement verification not explicit
  - C-08 Overview KPIs (Partial -- missing content freshness, permission sync status) -- covered by INT-W3-01 but partial gap verification not explicit
- **Evidence:** API Coverage Matrix shows 14 Partial endpoints, many of which need response shape enhancements that should be explicitly verified.
- **Recommendation:** Add a traceability column to the test document mapping each "Available" and "Partial" API to its integration test, and add explicit assertions for the enhanced fields in Partial endpoints.

---

## Cross-Phase Consistency

- **[XP-1] Backward traceability:** PASS -- Every scenario references capability notes and HLD design sections.
- **[XP-2] Forward compatibility:** PASS -- Scenarios are structured to directly inform test implementation with preconditions, steps, and assertions.
- **[XP-3] Scope lock:** PASS -- No scenarios test delegation flow or email notifications (correctly excluded per scope).
- **[XP-4] Terminology consistency:** PASS -- Consistent use of "Detail Panel," "Simplified View," "Proposal," "Scope+Filters," status badge names.

---

## Verified

- [x] Traceability matrix counts match (45 E2E + 35 INT + 5 CW = 85 total, though matrix says 80 -- the 5 CW are listed separately)
- [x] Each wave has 5+ E2E scenarios (W1: 8, W2: 12, W3: 10, W4: 10)
- [x] Each wave has 5+ integration scenarios (W1: 8, W2: 10, W3: 8, W4: 9)
- [x] All 10 backend bugs (B1-B10) have regression tests (B6 correctly marked out of scope for Phase 2)
- [x] All 3 empty states (EM1-EM3) have scenarios
- [x] All 7 status badges tested
- [x] Cross-wave scenarios exist (5 covering setup-to-monitor, error-recovery, draft-to-proposal, clone-to-security, drift-detection)
- [x] C-01 edge cases: 9 of 9 covered
- [x] C-02 edge cases: 8 of 8 covered
- [x] C-04 edge cases: 12 of 12 mapped (though C-04 Condition Builder depth is light -- see F-16)
- [x] C-05 edge cases: 11 of 11 covered
- [x] C-07 edge cases: 7 of 7 covered
- [x] C-08 edge cases: 12 of 12 covered
- [x] C-09 edge cases: 10 of 10 covered
- [x] C-10 edge cases: 9 of 9 covered
- [x] C-11 edge cases: 8 of 8 mapped in catalog
- [x] C-12 edge cases: 10 of 10 covered
- [x] HLD tasks T-01 through T-57 are exercised across the 4 waves

---

## Summary

- **CRITICAL:** 0
- **HIGH:** 4 (F-01, F-02, F-03, F-04)
- **MEDIUM:** 7 (F-05, F-06, F-07, F-08, F-13, F-16, F-17, F-18, F-19)
- **LOW:** 5 (F-09, F-10, F-11, F-12, F-14, F-15)
- **VERDICT:** NEEDS_FIXES

The 4 HIGH findings are all about missing dedicated E2E scenarios for error states E2, E4, E5, and E8. These error states have unique UI elements and user flows that are only "implied" by other scenarios rather than directly tested. The MEDIUM findings are about C-03 edge cases that need either new scenarios or additional steps in existing ones, plus some Security tab and Condition Builder gaps.

---

## Notes for Next Round

- Focus area for re-audit: Verify that dedicated E2E scenarios for E2, E4, E5, E8, and E10 are added
- Verify C-03 edge cases (token expiry during review, abandon confirmation, sensitive content + public access) are covered
- Verify Condition Builder, Security tab Simplified View, and GroupMember.Read.All scope upgrade scenarios are added
- Verify API Coverage Matrix traceability is improved
