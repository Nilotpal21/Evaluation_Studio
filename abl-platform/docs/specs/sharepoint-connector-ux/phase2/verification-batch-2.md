# Phase 2 Verification — Batch 2 (C-04, C-05, C-06)

**Verified against:** `docs/design/SHAREPOINT-DESIGN-FINAL-v3.md`
**Design sections:** §4c (lines 1606-1728), §4d (lines 1729-1783), §4e (lines 1785-1926), §4f (lines 1928-1965), §13 persona walkthroughs (lines 3121-3218)

---

## C-04: Scope+Filters Split-Pane

### Missing UI Behaviors

1. **Simplified View interaction not documented.** The design (§ Simplified View, lines 578-598) explicitly states that the Scope+Filters tab is **hidden entirely** when Simplified View is ON. Users must use the Accept/Modify inline editors in the Proposal tab instead. C-04 does not mention this at all — it should document: (a) the tab is invisible in Simplified View, (b) the tab only appears when Simplified View is OFF, and (c) the relationship to the Proposal inline Modify editors that serve as the simplified alternative.

2. **"People & Metadata" section from Proposal wireframe not referenced.** The design (lines 668-675) shows a "People & Metadata" subsection in the Proposal's inline Scope editor with "Created by" and "Modified by" fields using `[contains: ____]` inputs, with a note "Uses OData pre-fetch (faster)." C-04 captures the Metadata Conditions section (line 26-27) but does not distinguish between the "Created by / Modified by" people fields and the custom metadata columns. The design treats these as separate subsections.

3. **"Exclude always wins over include" rule from wireframe.** The design (line 666) explicitly states this rule as an inline info tooltip in the Folder Rules section. C-04 mentions it in passing (line 24: `"Exclude always wins over include" rule`) but does not specify it should display as an `ℹ` tooltip/info text in the UI, as the wireframe shows.

4. **Pre-fetch vs post-fetch categorization indicator.** The design (lines 689, 710-711) distinguishes between server-side (OData pre-fetch, marked with `ℹ`) and client-side (local post-fetch) filters. Line 689: `"ℹ = runs server-side (fast)  no icon = runs locally"`. C-04 does not capture this per-filter categorization indicator that appears in the left panel.

5. **[Apply Changes] and [Cancel] buttons.** The Proposal's inline Scope editor wireframe (line 691) shows `[Apply Changes]` and `[Cancel]` buttons. These are arguably in the Proposal card's scope, but C-04 should clarify the boundary: does editing in the Scope+Filters tab auto-save, or require explicit apply? The design shows auto-refresh on the right panel for every change (§4c), but the Proposal inline editor has explicit Apply/Cancel.

### Missing Data Fields

1. **`sites[].libraryCount`** — The wireframe (line 1634-1639) shows file counts per site, and the summary references "14 libraries." While `libraryCount` appears in the sites array type in C-04 (line 56), the wireframe does not show library count per site row — only at the summary level. This is correct as documented.

2. **`sites[].sizeBytes`** — Listed in C-04's data fields (line 56) but not shown in the wireframe's site list rows (which show name, score, file count only). However, the right panel diff shows size info (e.g., "-2.2 GB"), so having sizeBytes available is correct.

3. No missing data fields found beyond what is already captured.

### API Gaps

1. **Debounce behavior not specified in API contract.** C-04 mentions debouncing (line 127, "300-500ms after last input change") as an assumption but does not specify whether the API supports request cancellation (abort) for in-flight requests. The design mentions skeleton placeholders during loading but does not address concurrent/overlapping requests at the API level.

### Invalid Assumptions

1. **Assumption 7 (line 132): "15 operators ... remaining 3 may include operators like `between`, `is empty`, `matches glob`."** The design (lines 679-681) explicitly lists 12 operators and says "15 operators" in the section header (line 677). The assumption is valid in flagging the gap, but the phrasing implies uncertainty. The design itself is the source of the inconsistency — this is correctly flagged as an open question.

2. **Assumption 9 (line 134): Back to panel view behavior.** The assumption says it "returns to 720px AND switches focus to the previously active tab or stays on Scope+Filters at 720px." The design (line 1617) simply says `[← Back to panel view]` "shows at top-right to return to 720px" — it does not mention switching tabs. The assumption correctly identifies this ambiguity. However, line 1618 says "Switching to any other tab also returns to 720px automatically" — which is a separate trigger from the Back button. The Back button likely stays on Scope+Filters at 720px. Assumption is reasonable but worth confirming.

### Edge Cases Not Considered

1. **Draft mode (pre-auth) Scope+Filters.** The design (§5, lines 1968-2005) describes a "Draft Mode" where the Scope+Filters tab has degraded functionality: sites list is empty ("Will be populated after authentication and discovery"), but filters, templates, folder rules, size limits, schedule, and permissions are all configurable. C-04 does not address this pre-auth degraded state at all. This is a significant gap — the tab exists in draft mode with partial functionality.

2. **Sites.Selected with [Apply Changes] then discovery failure.** When the user enters site URLs manually (Sites.Selected mode, per Alex's walkthrough line 3201), what happens if validation fails for some sites? C-04 mentions "Sites.Selected mode" in edge case 7 (line 155) but does not capture the "Validate Sites" + "Send Access Request to Admin" flow from Alex's persona (line 3201).

### Open Questions Already Answered

1. **OQ 4 (line 141): Filter template definitions — client-side or API?** This is partially answered by the design itself. The Proposal wireframe (lines 1653-1655) shows templates as button labels in the left panel. Sarah's walkthrough confirms she sees "Documents Only" and "Technical Docs" as preset options. The design does not mention any API for template management, strongly implying they are client-side constants. The open question is still valid for admin customization, but the default behavior is clearly client-side.

### Scope Issues

1. **Minor scope creep: "Relationship to Proposal Tab" section (lines 47-51).** This documents behavior that overlaps with the Proposal card (C-03 or equivalent). While it is useful cross-reference context, the Proposal section sync API endpoints (lines 119-122) may belong in the Proposal card. Not a blocking issue — cross-references are helpful.

### Verdict: NEEDS_FIXES (4 findings)

- **HIGH:** Missing Simplified View behavior (tab hidden when ON) — F1
- **HIGH:** Missing Draft Mode / pre-auth degraded state — Edge Case F1
- **MEDIUM:** Missing pre-fetch vs post-fetch indicator in left panel — F4
- **LOW:** Missing "People & Metadata" (Created by / Modified by) distinction — F2

---

## C-05: Preview & Approve

### Missing UI Behaviors

1. **"Approve All & Start Sync" button from Proposal context.** The design (line 759, 1589) shows an "Approve All & Start Sync" button in the Proposal tab chrome that leads to the confirmation dialog. C-05 only documents the Approve & Start tab (§4f) with its three buttons. The Proposal-to-Approve flow via "Approve All & Start Sync" is a separate entry point to the same confirmation dialog. C-05 should note this alternative entry path, even if the Proposal card owns the button itself.

2. **"Accept All Remaining" interaction with permissions.** The design (line 1587) specifies that "Accept All Remaining" sets permissions to ENABLED (the safe default) and does NOT trigger Public Access. Sarah's walkthrough (line 3129) confirms she uses this flow. C-05 does not mention this — it belongs in the Proposal card but the post-approval transition behavior is the same regardless of entry point.

3. **Confirmation dialog text from §4f vs line 1589.** The design (line 1589) specifies the exact confirmation text: "This will sync ~3,801 documents (~4.2 GB) from 8 SharePoint sites. Sync begins immediately." C-05 captures this (line 40): "This will sync ~N documents (~X GB) from Y SharePoint sites. Sync begins immediately." — correctly parameterized. No gap.

4. **Button descriptions with help text.** The design wireframe (lines 1949-1952) shows descriptive help text BELOW each of the three buttons: "Begin full sync now. ~3,801 docs, ~20 min ETA." / "Save without syncing. Resume later." / "Save config as reusable template for future setups." C-05 lists the three buttons (lines 36-38) but does not capture these help text descriptions. This is a minor gap — the help text is part of the wireframe.

5. **Vector Embedding Cleanup note has a backend badge.** The design (line 1944) shows `[🏗 Requires backend: queued cleanup pipeline]` on the cleanup note. C-05 captures the cleanup note (line 34) as "static informational text" but does not note the backend dependency badge. This may or may not be a UI concern — the badge is a design-doc annotation, not necessarily rendered in the UI.

6. **"Source created in backend" step.** The design (line 1960) says "Source created in backend, sync begins" as step 1 of the post-approval transition. C-05's API section covers the `POST .../sync` endpoint (line 148-152) but does not explicitly note that the source/connector is created as part of this call (for new connectors). For existing connectors being re-synced, this may not apply.

### Missing Data Fields

1. **`sampleDocuments[].site` shown in wireframe but confirmed present.** The Preview tab wireframe (line 1753) shows a "Site" column. C-05 captures this (line 68). No gap.

2. **Preview summary shows "across N sites."** The design (line 1740) says "~523 documents across 8 sites." C-05's `totalDocCount` field does not include a site count in the preview response. The site count is available from the configuration summary but should also be in the preview response for the "across N sites" display.

### API Gaps

1. **Preview response missing site count.** The preview summary (line 1740) says "across 8 sites" but the C-05 preview response fields (lines 54-80) do not include a `siteCount` in the preview data. It is present in the configuration summary section (line 89) but is needed in the preview response too for the "~523 documents across 8 sites" display.

2. **No explicit "Refresh Preview" trigger endpoint.** C-05 says (line 128) "User navigates to Preview tab (or clicks 'Refresh Preview' after filter changes)" but does not define a Refresh Preview button in the UI behaviors section. The design wireframe for Preview (§4d) does not show a Refresh button either — the open question about staleness (OQ 1, line 216) is genuine.

### Invalid Assumptions

None found. All assumptions are consistent with the design.

### Edge Cases Not Considered

1. **"Approve All & Start Sync" from Proposal vs "Start Sync" from §4f.** Two entry points lead to the same confirmation dialog. C-05 does not clarify whether the Approve & Start tab (§4f) is a standalone tab or embedded at the bottom of the Proposal after all sections are reviewed. The design shows it as section 4f (separate wireframe) but the Proposal wireframe (line 759) also has "Approve All & Start Sync" inline.

2. **Sensitivity column with "WARN" prefix.** The design (line 1755) shows "WARN Confid." as a sensitivity value. C-05 captures `sensitivityLabel` as a string field (line 71) but does not specify the "WARN" prefix rendering behavior — when should a sensitivity label display with a warning indicator vs just the label text? The design shows some labels with "WARN" and others without ("Internal", "--").

### Open Questions Already Answered

1. **OQ 3 (line 218): Sensitivity label availability.** Partially answered by the design wireframe itself — the table shows "--" for documents without labels (lines 1756-1759), confirming the "show --" approach rather than hiding the column.

### Scope Issues

1. **Sync Progress (§7b) inclusion.** C-05 includes sync progress data fields and API endpoints (lines 102-118, 184-202). This is sync monitoring, not preview or approval. While it is the natural continuation of the Approve flow, it could be argued this belongs in a separate "Sync Progress" card. Currently it makes sense to include it since the transition is part of the approval UX, but the scope is larger than §4d + §4f alone.

### Verdict: NEEDS_FIXES (3 findings)

- **MEDIUM:** Preview response missing `siteCount` for "across N sites" display — API Gap F1
- **MEDIUM:** Button help text descriptions not captured from wireframe — Missing UI F4
- **LOW:** Sensitivity label "WARN" prefix rendering behavior not specified — Edge Case F2

---

## C-06: Security Tab

### Missing UI Behaviors

1. **Security Review Document "Document states" text block.** The design (lines 1883-1895) includes a "Document states:" section with 5 specific statements that appear in the exported security review document:
   - "Base scopes: Sites.Read.All + Files.Read.All + offline_access (always included)..."
   - "GroupMember.Read.All is included when permission-aware search is enabled..."
   - "We do NOT request Sites.FullControl.All, Sites.ReadWrite.All, or any write permissions."
   - "GroupMember.Read.All is targeted — it only reads group memberships..."
   - "Webhooks require a publicly accessible HTTPS notification endpoint..."

   C-06 does not capture these specific document statements. These define the exact content of the exportable security review artifact and are important for compliance teams.

2. **Simplified View behavior — detailed item list.** C-06 (lines 87-93) captures the Simplified View behavior well, including what is shown and what is hidden. However, the design doc's Simplified View section (lines 578-598) only mentions "NO Scope+Filters tab" and "NO History tab" — it does not enumerate what the Security tab shows in Simplified View. C-06's Simplified View content (lines 87-93) appears to be inferred rather than directly from the wireframe. The specific items shown/hidden should be flagged as an inference to verify.

3. **"Base capabilities" summary line.** The design (line 1802) shows "Base capabilities: Sync, discovery, delta sync, webhooks, read perms" as a summary line below the scopes. C-06 does not capture this summary line.

4. **Scope upgrade behavior for GroupMember.Read.All.** The design (line 1806) shows `[Request GroupMember.Read.All]  adds group resolution capability`. C-06 captures the button (line 16) but does not note the inline description "adds group resolution capability" that appears next to it in the wireframe.

### Missing Data Fields

1. **`indexedDocumentCount` for blast radius dialog.** The design's blast radius dialog (line 1849) shows "3,801 indexed documents will become stale." C-06 lists `activeSyncDocCount` (line 116) but not `indexedDocumentCount`. These may be the same value or different (active sync count vs total indexed count). The dialog text uses "indexed documents" specifically.

2. **Token encryption and data handling specifics.** The design (lines 1832-1837) lists specific details: "AES-256-GCM encrypted at rest, TLS 1.2+ in transit", "7-day TTL, auto-purged", "Retained until connector deleted", "Cleanup within 15 minutes of deletion." C-06's Data Handling section (line 41) lists these as categories but the Required Data Fields table (lines 118-124) only has `storageRegion`, `storageType`, `encryptionDetails` — it does not break out the data handling fields (token encryption, cache TTL, document retention, vector cleanup timing, audit logging). These might be static text rather than API-driven fields, but should be clarified.

### API Gaps

1. **Export formats: 3 buttons vs 4 formats.** The design wireframe (line 1878) shows three buttons: `[Download PDF]  [Export JSON/YAML]  [Copy as Markdown]`. C-06 (line 64) says "Four export actions: Download PDF, Export JSON, Export YAML, Copy as Markdown." The design combines JSON and YAML into one button `[Export JSON/YAML]`, suggesting a dropdown or sub-menu, not two separate buttons. C-06's API (lines 179-183) correctly models it as a single endpoint with a format parameter, but the UI description should match the wireframe's 3-button layout.

2. **Audit log `[Subscribe to Changes]` — notification channel details.** C-06's API (lines 174-177) mentions notification channel preference (email, webhook) but the design wireframe (line 1923) just shows `[Subscribe to Changes]` with no detail about channel selection. This is correctly flagged as an open question (OQ 5, line 210).

### Invalid Assumptions

1. **Known Limitations count: "7 items" (C-06 line 61) vs 5 in design wireframe.** The design wireframe (lines 1867-1875) explicitly lists **5** known limitations, not 7. Maria's persona walkthrough (line 3504) also references "5 known limitations." The review round note (line 3493) mentions "sequential 1-7 numbering" was fixed, suggesting a previous version had 7 items but the current v3 wireframe has 5. C-06 incorrectly states 7. **This is factually wrong against the current design.**

### Edge Cases Not Considered

1. **Permission-aware search re-enable flow.** C-06's edge case 8 (line 225) correctly flags this: "After typing 'public access' and confirming, can the user re-enable permission-aware search without friction?" The design shows the disable flow but NOT the re-enable path. This is well-captured.

2. **Emergency revoke with active sync in progress.** The design's revoke flow (lines 1841-1844) says "Pause all active and scheduled syncs immediately." C-06's edge cases do not specifically address: what does the UI show if a sync is actively running (e.g., 50% complete) when emergency revoke is triggered? The sync progress view would need to transition to a revoked/failed state.

3. **Token expired + Emergency Revoke interaction.** C-06's edge case 1 (line 218) correctly identifies that revoke is still relevant even with an expired token. The design does not address this specifically, making C-06's coverage actually better than the design for this case.

### Open Questions Already Answered

1. **OQ 9 (line 214): "What This Connector Does NOT Access" dynamic content.** C-06 asks if other bullets besides the scope-conditional one are dynamic. The design wireframe (lines 1818-1823) shows 5 bullets — the first 2 are scope-conditional ("Cannot write, modify, or delete any SharePoint content" is always true; "Cannot access sites outside the selected scope" depends on `Sites.Selected` vs `Sites.Read.All`). The remaining 3 are always static. This is partially answerable from the design but not fully resolved.

### Scope Issues

1. **Sync progress view controls ([Pause Sync], [Stop Sync]).** These are referenced in the design's §7b but C-06 does not include them. They belong in C-05 (which correctly includes them at lines 196-201). No scope issue in C-06.

2. **Delegation flow reference.** C-06 (line 234) correctly marks delegation as out of scope.

### Verdict: NEEDS_FIXES (4 findings)

- **HIGH:** Known Limitations count wrong — states "7 items" but design wireframe shows 5 — Invalid Assumption F1
- **MEDIUM:** Security Review Document "Document states" content not captured — Missing UI F1
- **MEDIUM:** Export format UI layout (3 buttons not 4) does not match wireframe — API Gap F1
- **LOW:** "Base capabilities" summary line missing — Missing UI F3

---

## Summary

| Card      | Verdict     | HIGH  | MEDIUM | LOW   |
| --------- | ----------- | ----- | ------ | ----- |
| C-04      | NEEDS_FIXES | 2     | 1      | 1     |
| C-05      | NEEDS_FIXES | 0     | 2      | 1     |
| C-06      | NEEDS_FIXES | 1     | 2      | 1     |
| **Total** |             | **3** | **5**  | **3** |

### Recommended Fix Priority

1. **C-06 Known Limitations count** — Change "7 items" to "5 items" to match the design wireframe. Simple text fix.
2. **C-04 Simplified View behavior** — Add a section documenting that the Scope+Filters tab is hidden when Simplified View is ON, and the relationship to Proposal inline Modify editors.
3. **C-04 Draft Mode / pre-auth state** — Add an edge case or section describing the degraded Scope+Filters behavior before auth/discovery completes (§5, lines 1968-2005).
4. **C-06 Security Review Document statements** — Add the 5 specific "Document states" text blocks that appear in the exported PDF/JSON/YAML.
5. **C-05 Preview `siteCount`** — Add `siteCount` to the preview response data fields.
6. **C-05 Button help text** — Add the descriptive text shown below each of the three action buttons in the wireframe.
7. **C-06 Export button layout** — Correct from "Four export actions" to "Three buttons: Download PDF, Export JSON/YAML (dropdown), Copy as Markdown."
8. **C-04 Pre-fetch/post-fetch indicator** — Document the `ℹ` icon convention distinguishing server-side from client-side filters.
