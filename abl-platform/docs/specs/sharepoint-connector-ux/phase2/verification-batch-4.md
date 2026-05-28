# Phase 2 Verification — Batch 4 (C-10, C-11, C-12)

**Verified by:** Verification Agent
**Date:** 2026-03-24
**Design source:** `docs/design/SHAREPOINT-DESIGN-FINAL-v3.md` §8, §9, §10, §11

---

## C-10: Multi-Connector Management

**Card file:** `docs/specs/sharepoint-connector-ux/phase1/C-10-multi-connector.md`
**Design section:** §8 (lines 2513-2594)

### Missing UI Behaviors

1. **"Round-trip" hint in Import section** — The design wireframe (§8, Import Configuration) includes the text: "Round-trip: export from UI -> modify in editor -> import via API". The card does not mention this round-trip workflow hint. This is a UI copy element that guides the user on the intended import workflow.

### Missing Data Fields

None found. All data fields from the wireframe are captured.

### API Gaps

1. **POST endpoint path differs** — The design wireframe shows `POST /api/connectors with JSON body` in the API/CLI pane. The card's API-7 section says this may be generated client-side from constants, which is reasonable. However, the card's API endpoint for clone uses `/api/connectors/:id/clone` while the wireframe's API/CLI pane shows the generic `POST /api/connectors` — these are different endpoints for different purposes (clone vs. create-from-scratch via API), and the card correctly distinguishes them. No actual gap here.

### Invalid Assumptions

1. **Assumption 4 (template scope)** — The card assumes templates are "scoped to the project level" but then lists this as Open Question #1 ("Are templates project-scoped, tenant-scoped, or global?"). This is contradictory — the assumption asserts project scope while the open question admits it is unknown. The design does not specify template scope. **Recommendation:** Remove the assertion from the assumption and keep it as an open question only.

### Edge Cases Not Considered

1. **Clone from a connector currently syncing** — The card restricts cloneable connectors to "active" or "syncing" status. However, cloning from a connector mid-sync could produce a configuration snapshot that reflects an incomplete setup (e.g., partial site selections still being refined). Consider whether "syncing" should require the connector to have completed at least one full sync.

2. **Import with permission-aware search** — The card's edge case #5 covers credentials in imports, but does not address what happens when an imported config has permission-aware search enabled. The card's API-6 Notes section mentions the security gate should be shown client-side, but this flow (import -> parse -> detect permission mode -> show security gate -> then call API) is not listed as an edge case. This multi-step flow is complex and warrants explicit edge case treatment.

### Open Questions Already Answered

None — all open questions are genuinely unanswered by the design.

### Scope Issues

1. **Out of Scope item #3** — The card says "Config version history and diff viewer (§9b) — covered by C-11 or similar". This is incorrect routing: §9b is covered by **C-12** (Config Management & History), not C-11. C-11 covers error/empty states. This is a documentation error, not a scope leak, but should be corrected to avoid confusion.

2. **Out of Scope item #4** — Similarly, "Config drift detection from template — covered by the version history card" should explicitly reference C-12.

### Verdict: NEEDS_FIXES (4 findings)

| #   | Severity | Finding                                                                                                            |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | LOW      | Missing "Round-trip" workflow hint from Import section wireframe                                                   |
| 2   | MEDIUM   | Assumption 4 contradicts Open Question 1 (template scope asserted and questioned simultaneously)                   |
| 3   | LOW      | Out of Scope items 3 and 4 incorrectly reference C-11 instead of C-12                                              |
| 4   | LOW      | Edge case gap: imported config with permission-aware search triggers a multi-step flow not documented as edge case |

---

## C-11: Error & Empty States

**Card file:** `docs/specs/sharepoint-connector-ux/phase1/C-11-error-empty-states.md`
**Design sections:** §10 (lines 2697-2911), §11 (lines 2913-2970)

### Missing UI Behaviors

1. **E1 — App registration name and secret creation date** — The design wireframe shows specific contextual details: "App Registrations > ABL Platform Prod" (app registration name) and "Check if the secret has expired (created: Jan 15, 2026)" (secret creation date). The card's data fields table includes `appRegistrationName` and `secretCreatedDate`, which is correct. However, the E1 UI behavior description says "Renders numbered how-to-fix steps referencing Azure Portal paths" without explicitly mentioning that the app registration name and secret creation date are interpolated into those steps. Minor but worth noting for implementers.

2. **E3 — Specific error code shown** — The design wireframe shows "Error: ENOSPC — Storage quota exceeded on upload destination." The card says "Shows connector name, status badge 'Sync Failed', docs processed vs total" but does not mention the specific error code/message display (ENOSPC). The `errorMessage` field is listed in the data table but the UI behavior description should mention that the raw error is displayed.

3. **E4 — "To fix" guidance text** — The design wireframe includes: "To fix: Someone with admin access needs to re-authenticate." The card's E4 description does not capture this guidance text. It lists the expiry date and auto-refresh failure details but omits the "To fix" guidance about who needs to act.

4. **E6 — "will resume at doc #79" detail** — The design wireframe shows "Progress: 78 of 252 documents (31%) — will resume at doc #79". The card mentions `syncProgressPercent` and doc counts but does not mention the "will resume at doc #N" detail in the E6 UI behavior. The `resumeFromDoc` field is in the data table under E3/E6 but the UI behavior for E6 does not reference it.

5. **E6 — No user action required** — The card correctly notes E6 is "Informational/passive — no user action required" and "Sync resumes automatically." This matches the design which shows no action buttons for the throttle state. Good.

### Missing Data Fields

1. **E3 — Specific error code** — The card includes `errorMessage` for E3 but the design shows a specific technical error code ("ENOSPC"). Consider adding `technicalErrorCode` to distinguish the raw error code from the human-readable message, or clarify that `errorMessage` includes the full "ENOSPC — Storage quota exceeded..." string.

### API Gaps

1. **E7 per-site actions (Request Access, Remove from Scope)** — The design wireframe shows per-site action buttons: `[Request Access]` and `[Remove from Scope]` for failed sites. The card mentions these in the E7 UI behavior, but the API section does not define endpoints for these per-site actions. `[Remove from Scope]` would likely modify the connector's scope configuration, and `[Request Access]` would need a mechanism (email generation, etc.). These should be cross-referenced to other cards or noted as needing API support.

2. **E8 — "Enter Site URL Manually" inline input** — The card captures the `[Enter Site URL Manually]` action but the API section uses `POST .../check-site-access` which is listed under EM3. The E8 behavior also needs this endpoint (or a separate one). The card should explicitly note that E8's manual URL entry reuses the EM3 endpoint or define it separately.

### Invalid Assumptions

None found. All assumptions are reasonable and consistent with the design.

### Edge Cases Not Considered

1. **E4 — Already expired vs. expiring soon** — The card's edge case #4 covers this well ("Token expiry in the past"). Good.

2. **E7 — All sites failed** — If every site in the connector fails (5/5 failed), the "Partial Site Failure" label is misleading — it is a total failure. The UI might need to promote this to a full sync failure (E3-like) rather than showing partial success.

3. **E1 — Multiple AADSTS error codes** — Different AADSTS codes (7000215 vs. 700016 vs. 50012) have different remediation steps. The card's how-to-fix steps reference a single flow. Should the fix steps vary by AADSTS code, or is a single generic flow sufficient?

### Open Questions Already Answered

1. **OQ #6 (Azure Portal deep link)** — The card asks whether the backend provides the `appId`. Looking at the design, the Connect tab flow (§4) would have collected the app registration details during setup, so `appId` should already be stored in the connector config. This question is partially answered by the design's auth flow. **Recommendation:** Downgrade to assumption: "appId is available from the connector's auth configuration stored during initial setup."

### Scope Issues

1. **E4 — Delegation invite** — The card correctly notes: "Design shows [Send Delegation Invite] but delegation is out of scope for phase 1." The Out of Scope section also lists this. Correctly handled.

### Verdict: NEEDS_FIXES (7 findings)

| #   | Severity | Finding                                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM   | E3 UI behavior does not mention displaying the specific error code/message (ENOSPC) shown in wireframe       |
| 2   | MEDIUM   | E4 UI behavior missing "To fix: Someone with admin access needs to re-authenticate" guidance text            |
| 3   | LOW      | E1 UI behavior should clarify app registration name and secret date are interpolated into fix steps          |
| 4   | LOW      | E6 UI behavior does not mention "will resume at doc #N" detail despite having the data field                 |
| 5   | MEDIUM   | E7 per-site actions (Request Access, Remove from Scope) have no corresponding API endpoints defined          |
| 6   | LOW      | E8 manual URL entry should cross-reference the check-site-access endpoint defined under EM3                  |
| 7   | LOW      | OQ #6 (appId availability) is partially answered by the auth flow design — could be downgraded to assumption |

---

## C-12: Config Management & History

**Card file:** `docs/specs/sharepoint-connector-ux/phase1/C-12-config-management.md`
**Design section:** §9 (lines 2596-2694)

### Missing UI Behaviors

1. **Export filename convention** — The card specifies the download filename as `<connector-name>-config-v<N>.<json|yaml>`. The design does not specify the filename. This is a reasonable addition by the card but should be marked as an inference/decision, not a design requirement.

2. **Version selection UX for diff** — The card says "user selects any two versions (default: previous vs current)." The design wireframe (§9b) shows `[View Diff: v4 --> v5] [Restore v4]` which implies comparing the selected version against current, not arbitrary two-version selection. The card's interpretation is more flexible than what the wireframe shows. The wireframe suggests a single-version selection model where you compare that version vs. current, with buttons contextual to the selected row. **This is an over-generalization** — the design appears to show one-click diff against current, not a two-version picker.

3. **Restore confirmation dialog text** — The card includes: "Restore configuration to version N? This creates a new version (vN+1) with the restored settings." The design shows `[Restore v4]` but does not show a confirmation dialog. The card's addition of a confirmation dialog is a reasonable safety measure but is not in the wireframe. Should be noted as an inference.

### Missing Data Fields

1. **OAuth credentials warning text** — The card captures the OAuth checkbox warning well. The design shows "OAuth credentials (NEVER included by default)" which the card captures as "NEVER pre-checked" with an inline warning. Complete.

2. **Cleanup confirmation — document count** — The design shows: "This will permanently delete 237 documents, their chunks, and vector embeddings." The card captures the doc count, chunks, and vectors. Complete.

### API Gaps

1. **Import & Replace two-step flow** — The card defines a two-step import: `POST .../config/import` returns a diff preview with `requiresConfirmation: true`, then `POST .../config/import/confirm` applies it. The design wireframe simply shows `[Import & Replace]` with no detail on the API flow. The two-step approach is a sensible design decision but should be flagged as an inference beyond the wireframe. The design does not show a diff preview step for Import & Replace.

### Invalid Assumptions

1. **Type-to-confirm for Delete All Synced Content** — The card (UI Behavior #7) states: "Requires typing the connector name or a confirmation phrase to enable [Confirm Delete]." The design wireframe shows a simple confirmation dialog with `[Confirm Delete] [Cancel]` and descriptive text, but does NOT show a type-to-confirm interaction. This is an addition not present in the design. While it is a good UX safety practice, it should be flagged as an inference/decision, not a design requirement.

### Edge Cases Not Considered

1. **Cleanup with active sync** — What happens if the user clicks [Delete All Synced Content] while a sync is currently running? The cleanup and sync would conflict. The card does not address whether sync must be paused/stopped before cleanup can begin.

2. **Export during cleanup** — If content is being purged, can the user still export the configuration? The config should be exportable since it is preserved during cleanup, but this interaction is not addressed.

3. **Version history during active sync** — Each sync completion may create a new config version (e.g., "Discovery complete" in the wireframe). If a sync is running, the version list may update while the user is viewing it. Consider optimistic updates or refresh behavior.

### Open Questions Already Answered

1. **OQ #3 (Drift ignore scope)** — The card asks whether "Ignore Drift" persists across sessions. Looking at the design, `[Ignore Drift]` is listed as a simple action alongside `[Re-apply Template]` and `[Update Template to Match]`. Given that the other two actions create permanent changes, it is reasonable to infer that Ignore is also persistent (server-side). The card's API defines `POST .../drift/ignore` which returns acknowledgment, suggesting server-side persistence. This open question is partially self-answered by the card's own API design. **Recommendation:** Convert to assumption: "Ignore Drift is persisted server-side (via the drift/ignore endpoint) and suppressed until the next config change."

### Scope Issues

None found. The card correctly scopes to §9 behaviors and defers template CRUD, backend implementation, audit log integration, and bulk operations.

### Verdict: NEEDS_FIXES (6 findings)

| #   | Severity | Finding                                                                                                                  |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM   | Version diff UX over-generalized — design shows one-click diff against current version, not arbitrary two-version picker |
| 2   | MEDIUM   | Type-to-confirm for Delete All Synced Content is not in the design wireframe — should be flagged as inference            |
| 3   | MEDIUM   | Import & Replace diff preview step is an inference — design wireframe does not show a preview/confirm flow               |
| 4   | LOW      | Restore confirmation dialog is an inference not shown in wireframe — should be noted as a decision                       |
| 5   | LOW      | Edge case gap: cleanup while sync is running (conflict not addressed)                                                    |
| 6   | LOW      | OQ #3 (Drift ignore scope) is partially self-answered by the card's own API definition                                   |

---

## Summary

| Card      | Verdict     | Findings | Critical | Medium | Low    |
| --------- | ----------- | -------- | -------- | ------ | ------ |
| C-10      | NEEDS_FIXES | 4        | 0        | 1      | 3      |
| C-11      | NEEDS_FIXES | 7        | 0        | 3      | 4      |
| C-12      | NEEDS_FIXES | 6        | 0        | 3      | 3      |
| **Total** |             | **17**   | **0**    | **7**  | **10** |

### Recommended Fix Priority

**MEDIUM (fix before implementation):**

1. C-10: Resolve assumption/open-question contradiction on template scope
2. C-11: Add ENOSPC error code display to E3 UI behavior
3. C-11: Add "To fix" admin guidance to E4 UI behavior
4. C-11: Define API endpoints for E7 per-site actions (Request Access, Remove from Scope) or cross-reference to another card
5. C-12: Clarify version diff UX — one-click against current vs. arbitrary picker
6. C-12: Mark type-to-confirm as a design decision (inference), not a captured requirement
7. C-12: Mark Import & Replace diff preview as a design decision (inference)

**LOW (fix or acknowledge before implementation):**
All 10 LOW findings are documentation precision issues or minor edge case gaps. They can be resolved during implementation planning without blocking card approval.
