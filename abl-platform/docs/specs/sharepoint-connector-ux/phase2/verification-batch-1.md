# Phase 2 Verification -- Batch 1 (C-01, C-02, C-03)

**Verified by:** Verification Agent
**Date:** 2026-03-24
**Design source:** `docs/design/SHAREPOINT-DESIGN-FINAL-v3.md` (v3.1)

---

## C-01: Panel Shell & Navigation

### Missing UI Behaviors

- [FINDING-01] **Simplified View hides Security tab advanced details** -- The design (lines 553-555, 772-781) specifies that when Simplified View is ON, the Security tab hides advanced details (ACL modes, CEL, OData), all instances of "pipeline" are replaced with "system", and CEL/OData/metadata conditions are not shown. The capability note mentions the tab set changes (Connect/Proposal/Preview/Security vs full set) but does NOT capture the Security tab content filtering behavior under Simplified View. This is arguably a Security tab concern (C-07 or similar), but the shell drives the toggle so the filtering rule should be documented here or explicitly delegated.

- [FINDING-02] **Card vs Table auto-switch behavior** -- The design (lines 524-529) specifies that SourcesTable switches from card view (1-6 sources) to table view (7+ sources) on page load, with user override via toggle buttons persisted per-KB in localStorage. Adding a 7th source does NOT switch mid-interaction. The capability note's Out of Scope says "SourcesTable enhancements" are separate, but this auto-switch affects Flow B and Flow D entry points. This is acceptable as out-of-scope if a separate SourcesTable card exists, but should be explicitly referenced.

- [FINDING-03] **Scope+Filters auto-expand animation timing** -- The design (line 1614) specifies `300ms ease-out animation` for the Scope+Filters auto-expand. The capability note (line 21) mentions auto-expand behavior but does not capture this specific timing. Open Question #3 asks about animation specs generally, but the Scope+Filters timing IS specified in the design.

### Missing Data Fields

- [FINDING-04] **`authStatus` field** -- The API-1 output (line 51) mentions `authStatus` as a needed field from the connector detail endpoint, but `authStatus` is not listed in the Required Data Fields section. The `connectorStatus` enum includes "auth_failed" but `authStatus` is a separate concept (whether auth was completed, pending, failed) used for tab routing and Connect tab state.

### API Gaps

- [FINDING-05] **Diagnostics endpoint** -- The More Actions menu includes "Diagnostics" (line 24, 567 in design). Open Question #2 asks what this shows, but the design doc Section 12 capability matrix should be checked. The note correctly flags this as undefined but could reference S12 more specifically.

### Invalid Assumptions

- No invalid assumptions found. All 7 assumptions are consistent with the design.

### Edge Cases Not Considered

- [FINDING-06] **Scope+Filters tab collapse on tab switch** -- The design (line 1610) says "All OTHER tabs stay at the default 720px panel width." The capability note mentions "[<- Back to panel view] or switching to a non-Scope+Filters tab returns to 720px" which captures this. However, the timing of the collapse animation (returning from full-width to 720px) is not addressed.

### Open Questions Already Answered

- [FINDING-07] **Open Question #3 (Panel animation specs)** is PARTIALLY answered. The design specifies `300ms ease-out` for Scope+Filters auto-expand (line 1614). The initial slide-in and close animations are NOT specified, so the question remains valid for those. Recommend splitting: mark Scope+Filters timing as ANSWERED and keep the rest open.

- [FINDING-08] **Open Question #6 (Simplified View default detection)** is answered in the design. Line 580: "Defaults ON for first-time users. Toggle at top of panel. Persisted per-user via localStorage." This implies: absence of localStorage key = first-time = defaults ON. The question is answered by the localStorage persistence pattern.

- [FINDING-09] **Open Question #4 (Tab lock granularity)** is partially answered. The design (lines 303-304, 316-320) shows: setup mode has Connect tab active with other tabs locked. After auth completes, the system generates a Proposal, implying Proposal tab unlocks next. The flow is Connect -> Auth -> Proposal generation -> user reviews sections -> Scope+Filters available. Progressive unlock is implied by the setup flow sequence.

### Scope Issues

- No scope issues found. The card correctly limits itself to the panel shell and navigation concerns.

### Verdict: NEEDS_FIXES (5 findings: FINDING-01, FINDING-03, FINDING-04, FINDING-07, FINDING-08)

FINDING-02 and FINDING-06 are minor/informational. FINDING-05 and FINDING-09 are correctly flagged as open.

---

## C-02: Connect Tab

### Missing UI Behaviors

- [FINDING-10] **Delegation auth method (third radio card) in first-time experience** -- The design wireframe (lines 829-836) shows THREE radio cards for the first-time experience: (1) Azure App Registration, (2) Sign in with Microsoft, and (3) "Someone else will authenticate (delegation)." The capability note (line 16-17) says "two radio card options (NOT three; delegation is out of scope)." However, the DESIGN WIREFRAME explicitly shows all three options in the first-time experience. The delegation FLOW is out of scope (correctly), but the radio card DISPLAY is part of the Connect tab UI. The card should show three options but disable/grey-out or defer the delegation option with a note like "Configure delegation after initial setup" -- OR the card must explicitly state it is intentionally removing the third option from the wireframe and justify why.

- [FINDING-11] **Delegation form within Connect tab** -- The design (lines 847-925) shows that after selecting "Someone else will authenticate" and clicking Continue, the Connect tab replaces the radio selection with a delegation setup form (Client ID, Tenant ID, Connection Scopes, "Continue to Generate Invite" button). This entire sub-flow happens WITHIN the Connect tab. The capability note's Out of Scope says "delegation flow UI" is separate, but the design places this squarely inside the Connect tab. Either the delegation sub-flow needs its own capability note that is explicitly a child of C-02, or C-02 needs to acknowledge the delegation form as a sub-state of the Connect tab.

- [FINDING-12] **"Back to auth method selection" link in delegation form** -- Design line 863 shows `[< Back to auth method selection]` in the delegation form. Not captured in capability note.

- [FINDING-13] **Returning user form shows THREE auth methods, not a restricted set** -- The design (lines 969-971) shows Device Code, Browser Login, AND App-Only (Client Credentials) for returning users. The capability note (lines 33-36) correctly captures all three. No gap here. (Verified -- no finding.)

- [FINDING-14] **"Don't have an app registration?" expandable in delegation form** -- The design (lines 874-899) shows the expandable guide appears in BOTH the delegation form AND the returning user form. The capability note only mentions it for the returning user experience (line 27-30). The delegation form variant includes a different intro: "Don't have the Client ID and Tenant ID? [Send Request to IT Admin] -- your admin can enter these details directly via the delegation link." This is a delegation-specific variant not captured.

- [FINDING-15] **"Delegate will be asked to consent to these scopes during sign-in"** -- Design line 916 shows this text in the delegation form's Connection Scopes section. Not captured (delegation out of scope, but this is Connect tab copy).

### Missing Data Fields

- [FINDING-16] **`delegationConfig` fields** -- If delegation is truly out of scope for C-02, the capability note should not need these. However, since the design places the delegation radio card in the first-time experience wireframe, at minimum a `delegationEnabled` boolean (whether to show the third radio card) would be needed. Not listed.

### API Gaps

- [FINDING-17] **No API for delegation invite generation** -- The design shows "Continue to Generate Invite" triggers inline invite generation within the Connect tab (line 923). If delegation is out of scope, the capability note should explicitly state which API handles the transition. Currently, the note's API list covers auth initiation but not the delegation invite path.

### Invalid Assumptions

- [FINDING-18] **Assumption #3: "Sign in with Microsoft maps to Browser Login"** -- The capability note says this option maps to Browser Login auth method. The design (Sarah's persona walkthrough, line 3123) says "She picks 'Sign in with Microsoft (quick setup)' because she just wants to try it. She signs in (this uses Sites.Read.All automatically -- no scope selector)." This confirms the mapping is correct AND adds that it uses Sites.Read.All automatically. The assumption is valid but incomplete -- it should note the automatic Sites.Read.All scope selection.

### Edge Cases Not Considered

- [FINDING-19] **Delegation countdown and resume** -- The design (Chen persona, line 3187) shows: after sending delegation invite, Chen closes browser and returns later. He sees "Awaiting Auth" in SourcesTable, clicks it, and the Connect tab shows "delegation status tracker" with "invite countdown shows 6d 21h remaining." This resume-state within the Connect tab is not captured in C-02's edge cases (even if delegation is out of scope, the Connect tab DOES show this state for "Awaiting Auth" connectors).

- [FINDING-20] **Configurable delegation expiry window** -- Design (Chen persona, line 3185): "Link valid for: [48h | 24h | 7 days]." This is a Connect tab UI element not captured.

### Open Questions Already Answered

- [FINDING-21] **Open Question #1 ("Sign in with Microsoft" and Client ID)** -- Sarah's persona (line 3123) answers this: "She signs in (this uses Sites.Read.All automatically -- no scope selector)." The platform provides an implicit app registration for the quick-setup path. The answer is: no Client ID needed; the platform handles it. The design rationale (lines 1273-1291) also confirms Sites.Read.All as default for the simple path.

- [FINDING-22] **Open Question #2 (Connector name suggestion timing)** -- The design (line 801-802) says "the system will suggest a name after discovering your SharePoint sites." Discovery happens during proposal generation (post-auth). Sarah's persona (line 3123) says she leaves it blank and gets the suggestion during proposal. The answer is: the suggestion appears during/after Proposal generation, not on the Connect tab. This is answered in the design.

### Scope Issues

- [FINDING-23] **Delegation as "out of scope" contradicts design placement** -- The design places the delegation radio card, form, and invite generation all within the Connect tab (S4a). Declaring delegation entirely out of scope for C-02 creates a gap where no card owns the Connect tab's delegation sub-states. Recommend: either (a) include delegation display (radio card + greyed state) in C-02 and create C-02a for the delegation sub-flow, or (b) expand C-02 to include the full delegation path.

### Verdict: NEEDS_FIXES (9 findings: FINDING-10, FINDING-11, FINDING-12, FINDING-14, FINDING-15, FINDING-18, FINDING-19, FINDING-21, FINDING-22)

FINDING-10 and FINDING-23 are the most significant -- the delegation radio card is IN the design wireframe but EXCLUDED from the capability note without justification. FINDING-21 and FINDING-22 are open questions that the design already answers.

---

## C-03: Configuration Proposal

### Missing UI Behaviors

- [FINDING-24] **"Scopes" checklist item in generation progress** -- The design (line 1001) shows 9 checklist items during generation: Connection, **Scopes**, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate. The capability note (line 14) lists 9 items but says: "Connection, Scopes, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate." This matches. No gap. (Verified -- no finding.)

- [FINDING-25] **Sample Preview section buttons differ from design** -- The design wireframe (line 1535) shows FOUR buttons: `[Looks Good]`, `[Adjust Filters]`, `[Refresh Sample]`, and `[Abandon -- Do Not Sync]`. The capability note does not list the Sample Preview section's action buttons in the UI Behaviors section. The "Refresh Sample" is covered by API-9, and "Looks Good" maps to Accept, but `[Abandon -- Do Not Sync]` is a distinct action not mentioned anywhere in the capability note. This is a full connector abort/delete action that needs its own API handling.

- [FINDING-26] **Connection section buttons** -- The design (line 1075) shows `[Accept]`, `[Re-authenticate]`, and `[Skip]` for the Connection section. The capability note describes Accept/Modify/Skip generically but does not capture that the Connection section has `[Re-authenticate]` instead of `[Modify]`. This is section-specific button variance.

- [FINDING-27] **Health Check section buttons** -- The design (lines 1108, 1139) shows `[Accept with warnings]`, `[Re-run]`, and `[Skip]` -- NOT the generic Accept/Modify/Skip. The capability note does not capture this section-specific button variance. The "Re-run" action is covered by API-12 but the button label difference is not noted.

- [FINDING-28] **Health Check scope detection row** -- The design (lines 1082, 1093-1098) specifies that the Health Check includes a "Scopes detected" row showing exactly which capabilities are available based on granted scopes. This is detailed per-variant (Sites.Read.All vs Sites.Selected). The capability note's Health Check data fields include `checks` array but do not specifically call out the scope detection row or its variants.

- [FINDING-29] **Token health display variants** -- The design (lines 1148-1151) specifies two display variants for the token status row: (a) with refresh token: "Connected (auto-renewing) / Refresh token valid until Apr 21", (b) without (client_credentials): "Expires in 59 min -- no auto-refresh / Re-authenticate before expiry." The capability note has `tokenExpiresAt` and `refreshTokenExpiresAt` fields but does not capture these specific display variants.

- [FINDING-30] **Scope section Variant B action buttons** -- The design (line 1268) shows `[Accept]`, `[Add More Sites]`, `[Skip]` for the Sites.Selected variant. The generic Accept/Modify/Skip does not capture `[Add More Sites]` as a distinct action.

- [FINDING-31] **"Send Access Request to Admin" in Scope Variant B** -- The design (lines 1244-1246) shows a `[Send Access Request to Admin]` button with "Pre-written email listing the specific site URLs and the PowerShell command to grant Sites.Selected access." This is not captured as a UI behavior or API requirement in the capability note.

- [FINDING-32] **"Download Admin Commands (PowerShell)" in Scope Variant B** -- Design line 1264 shows this action. The capability note mentions it in Open Question #5 but does not list it as a UI behavior or API requirement.

- [FINDING-33] **"Download Permission Request Document" in Permissions section** -- Design line 1423 shows `[Download Permission Request Document]` and line 1427 shows `[Send Request to Security Team]`. These are UI actions in the Permissions section not captured in C-03's UI behaviors. Open Question #6 mentions the document but does not capture the "Send Request to Security Team" email action.

- [FINDING-34] **"Upgrade to Permission-Aware" button in Permission Accuracy section** -- Design line 1500 shows `[Upgrade to Permission-Aware]` and line 1502 shows `[Test Permissions]`. These are action buttons in the Permissions section not listed in C-03's UI behaviors.

- [FINDING-35] **TRUST NOTE** -- Design (lines 1506-1510) shows a TRUST NOTE at the bottom of the Permissions section: "We request Sites.Read.All and Files.Read.All -- both read-only... No write permissions are ever requested." This is a display element not captured in C-03.

- [FINDING-36] **Permissions section has `[Accept]`, `[Change Mode]`, `[Skip]`** -- Design line 1512 shows these three buttons. `[Change Mode]` is different from generic `[Modify]`. Not captured.

- [FINDING-37] **"Need Help Getting GroupMember.Read.All?" subsection** -- Design lines 1418-1431 show a subsection within Permissions with two action buttons. Not captured as a distinct UI element.

- [FINDING-38] **"Or upgrade to discover sites automatically" box in Scope Variant B** -- Design lines 1250-1258 show a prominent box with `[Upgrade to Sites.Read.All]` button. Not captured as a UI behavior in C-03.

- [FINDING-39] **Sites.Selected information box** -- Design lines 1282-1300 show a 6-point information box explaining Sites.Selected limitations. Not captured as a UI element in C-03 data fields or behaviors.

- [FINDING-40] **Security Gate "Export PDF for Review" button** -- Design line 1569 shows `[Export PDF for Review]` alongside `[Request Security Review]` in the Security Gate section. The capability note has API-13 for Request Security Review but does not capture the section-specific export button (separate from the global Export buttons).

- [FINDING-41] **Inline editor details for Scope (Simplified View)** -- The design (lines 620-627) shows the Simplified View inline editor for Scope: checkboxes for sites, file type dropdown, size dropdown, Apply Changes / Cancel buttons. The capability note's Scope data fields capture site selection but miss the inline editor's file type and size controls (these are filter-adjacent but appear in the Scope inline editor).

- [FINDING-42] **Inline editor details for Filters (Simplified View)** -- The design (lines 640-692) shows an extensive inline editor with: Quick templates, File Types (allowlist/blocklist), Content Categories, Date Range (4 date fields: modified after/before, created after/before), Size Limits (min/max with units), Folder Rules (include/exclude globs), People & Metadata, Condition Builder (15 operators), CEL Expression (advanced), and Impact preview. The capability note's filter fields (lines 184-197) capture most of these but miss: (a) Created before/after date fields (only `modifiedAfter` is listed), (b) the "People & Metadata" subsection (Created by, Modified by) as distinct from custom metadata conditions, (c) the Condition Builder with 15 operators and AND/OR grouping, (d) the CEL Expression field with autocomplete.

- [FINDING-43] **Inline editor details for Schedule (Simplified View)** -- The design (lines 701-711) shows sync frequency dropdown with specific options and webhook toggle. The capability note captures `frequencyOptions` and `webhookToggleable` but misses that webhooks show as "Automatically enabled -- your scopes support it" rather than a user toggle.

### Missing Data Fields

- [FINDING-44] **Created before/after date fields in Filters** -- Design line 656-657 shows `Created after` and `Created before` date fields. The capability note's `dateRange` field only has `modifiedAfter`. Missing: `modifiedBefore`, `createdAfter`, `createdBefore`.

- [FINDING-45] **Condition Builder fields** -- Design lines 677-682 show a condition builder with 15 operators (equals, not equals, contains, starts with, ends with, greater than, less than, in list, not in list, exists, not exists, regex match + 3 more implied), AND/OR grouping with one level of nesting. The capability note's `metadataConditions` captures `field/operator/value` but does not include: (a) the full operator list, (b) AND/OR grouping support, (c) nesting level.

- [FINDING-46] **CEL expression field** -- Design line 684-686 shows a CEL expression field with autocomplete that "overrides above conditions when set." Not captured in data fields.

- [FINDING-47] **People & Metadata fields** -- Design lines 668-675 show "Created by" and "Modified by" text filters plus custom column conditions from discovery. These are partially captured via `metadataConditions` but the `createdBy`/`modifiedBy` built-in fields are distinct from custom metadata.

- [FINDING-48] **"No document library" sites in Scope Variant A** -- Design lines 1194-1198 show sites with no document libraries as a distinct display element with explanations. The capability note has `noLibrarySites` field which captures this. No gap. (Verified -- no finding.)

- [FINDING-49] **Scope Variant B: "Send Access Request to Admin" email data** -- The design shows a pre-written email with PowerShell commands. No API requirement listed for generating this email (similar to C-02's admin email but for site access rather than app registration).

### API Gaps

- [FINDING-50] **No API for "Abandon -- Do Not Sync"** -- The design (line 1536) shows this as a Sample Preview action. This would delete/cancel the connector and proposal. No API listed in C-03.

- [FINDING-51] **No API for "Send Access Request to Admin" (Sites.Selected)** -- Design line 1244. Generates a pre-written email with PowerShell commands for granting Sites.Selected access. Not listed in C-03's APIs.

- [FINDING-52] **No API for "Download Admin Commands (PowerShell)"** -- Design line 1264. Generates PowerShell commands for Sites.Selected grants. Not listed.

- [FINDING-53] **No API for "Download Permission Request Document"** -- Design line 1423. Generates a document for security team about GroupMember.Read.All. Open Question #6 asks about this but no API is listed.

- [FINDING-54] **No API for "Send Request to Security Team" email** -- Design line 1427. Generates email with permission request document attached. Not listed.

- [FINDING-55] **No API for "Upgrade to Sites.Read.All"** -- Design line 1257. Triggers re-consent with broader scope. Not listed.

- [FINDING-56] **No API for "Upgrade to Permission-Aware"** -- Design line 1500. Not listed. May redirect to re-auth.

- [FINDING-57] **No API for "Test Permissions"** -- Design line 1502. Allows searching as a specific user to verify permissions. Not listed.

### Invalid Assumptions

- [FINDING-58] **Assumption #6: "Simplified View toggle does not affect API response"** -- The capability note says "the UI filters display fields based on the toggle." However, API-2 lists a `?simplified=true` query param that changes the API response. These are contradictory. Either the API returns different data (which contradicts the assumption) or the query param is unnecessary. The assumption should be revised.

### Edge Cases Not Considered

- [FINDING-59] **"Abandon -- Do Not Sync" consequences** -- The design shows this as a Sample Preview action (line 1536). What happens? Is the connector deleted? Moved to "Cancelled" status? Does draft config persist? Not captured in C-03's edge cases.

- [FINDING-60] **Health Check variant for Sites.Selected** -- The design (lines 1116-1141) shows a distinct Health Check wireframe for Sites.Selected with different check results (4/7 passed, FAIL on Sites.Read.All, INFO on scopes). The capability note's Health Check data model supports this via the generic `checks` array, but the variant is not called out as an edge case or display variant.

### Open Questions Already Answered

- [FINDING-61] **Open Question #5 ("Download Admin Commands")** asks if this is static or dynamic. The design (lines 1260-1264) says "We can generate the exact commands" implying dynamic generation with the correct client ID and site URLs filled in. This is answered.

### Scope Issues

- [FINDING-62] **Filter inline editor complexity may belong to Scope+Filters card** -- The inline filter editor in Simplified View (design lines 640-692) is extremely detailed (15 operators, CEL, OData, People & Metadata). The capability note includes this under C-03 which is correct for Simplified View (since Scope+Filters tab is hidden). However, the data model should be shared with whatever card covers the Scope+Filters tab to avoid duplication. Recommend an explicit cross-reference.

### Verdict: NEEDS_FIXES (28 findings)

**Critical findings (must fix):**

- FINDING-25: "Abandon -- Do Not Sync" button and its API (FINDING-50) are completely missing
- FINDING-42: Filter inline editor is significantly under-specified (missing date fields, condition builder, CEL)
- FINDING-44, FINDING-45, FINDING-46: Missing data fields for date range, condition builder, CEL
- FINDING-58: Assumption contradicts the API design (`?simplified=true` query param)

**High findings (should fix):**

- FINDING-26, FINDING-27, FINDING-30, FINDING-36: Per-section button variants not captured
- FINDING-31, FINDING-32, FINDING-33, FINDING-34: Action buttons in specific sections not listed
- FINDING-51 through FINDING-57: 7 missing API endpoints for section-specific actions

**Medium findings (informational):**

- FINDING-28, FINDING-29, FINDING-38, FINDING-39, FINDING-60: Display variants not fully captured
- FINDING-61: Open question already answered in design
- FINDING-62: Cross-reference recommendation

---

## Summary

| Card | Verdict     | Critical | High | Medium | Info |
| ---- | ----------- | -------- | ---- | ------ | ---- |
| C-01 | NEEDS_FIXES | 0        | 3    | 2      | 2    |
| C-02 | NEEDS_FIXES | 2        | 4    | 3      | 2    |
| C-03 | NEEDS_FIXES | 6        | 11   | 6      | 5    |

**Biggest cross-cutting theme:** The capability notes describe generic Accept/Modify/Skip behavior but the design wireframes show section-specific button labels and actions (Re-authenticate, Re-run, Accept with warnings, Change Mode, Add More Sites, Looks Good, Adjust Filters, Abandon). Each section has its own button set that deviates from the generic pattern.

**Second theme:** C-02's delegation scoping decision needs resolution. The design wireframe places the delegation radio card and sub-flow inside the Connect tab, but C-02 excludes it without a replacement card owning that UI surface.

**Third theme:** C-03 is significantly under-specified for section-specific actions. Many design wireframe buttons (Download PDF, Send Email, Upgrade Scope, Test Permissions, Abandon) have no corresponding API requirements in the capability note.
