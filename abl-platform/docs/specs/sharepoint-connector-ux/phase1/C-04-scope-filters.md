# C-04: Scope+Filters Split-Pane -- Capability Note

**Status:** Reviewed
**Design Sections:** 4c

## User Intent

Power users iterate on scope and filter configuration in a tight feedback loop: change a control on the left, instantly see the impact on the right. The goal is to refine which SharePoint documents will be synced -- selecting sites, constraining file types, applying metadata conditions -- while continuously seeing a live diff of what was added or removed and why.

## UI Behaviors

### Simplified View Interaction

When Simplified View is ON, the Scope+Filters tab is **hidden entirely** from the tab bar. Users configure scope and filters through the Proposal tab's inline Accept/Modify editors instead. The Scope+Filters tab only appears when Simplified View is OFF. This means:

- Tab is invisible in Simplified View -- users never see it.
- Tab only appears when Simplified View is toggled OFF.
- The Proposal tab's inline "Modify" editors serve as the simplified alternative for scope/filter configuration.

### Draft Mode (Pre-Auth) Degraded State

Before authentication and discovery complete (Draft Mode, per design section 5), the Scope+Filters tab operates in split-availability mode:

- **Sites section** -- disabled/placeholder: "Will be populated after authentication and discovery." An `[Enter Site URLs Manually]` button provides an escape hatch for users who know their site URLs.
- **Filters section** -- fully editable: file type checkboxes, template presets, folder exclude patterns, size limits.
- **Schedule section** -- fully editable: frequency dropdown.
- **Permissions section** -- fully editable: permission-aware search toggle with type-to-confirm disable flow.
- A persistence message at the bottom reads: "These settings will apply automatically when auth completes."

### Panel Expansion

- On Scope+Filters tab click, panel auto-expands from 720px to full viewport width (300ms ease-out animation).
- Split layout: 60% controls (left) / 40% preview (right).
- `[Back to panel view]` button at top-right returns to 720px.
- Clicking any other tab also returns to 720px automatically.
- The `[<>]` manual expand button remains available on all tabs but Scope+Filters is the only tab that auto-expands.

### Left Panel -- Controls

1. **Sites list**: Checkboxes per discovered site. Each row shows: site name, activity score (numeric), file count. Checking/unchecking a site immediately triggers a preview refresh.
2. **File type checkboxes**: One checkbox per discovered file type, each showing a count (e.g., "PDF (89)"). Non-indexable types (PNG, MP4) are unchecked by default.
3. **Date range pickers**: "Modified after" and "Modified before" date inputs. These translate to OData pre-fetch filters (server-side at Graph API level).
4. **Filter templates**: Preset buttons -- `Documents Only`, `Tech Docs`, `Everything`, `Custom...`. Selecting a template populates the controls accordingly.
5. **Folder rules**: Predefined exclude rules (`Archives`, `Backups`, `_private`) as toggle chips. A `[+ Custom glob pattern]` button for user-defined glob patterns. "Exclude always wins over include" rule displayed as an `i` tooltip/info text inline in the Folder Rules section.
6. **Size limits**: Min and max fields with unit selector dropdown (KB/MB/GB). Default: Min 0 KB, Max 100 MB.
7. **People & Metadata section**: Two subsections in the left panel:
   - **People fields**: "Created by" and "Modified by" fields using `[contains: ____]` inputs. These use OData pre-fetch (faster, server-side).
   - **Custom metadata columns**: Field/Operator/Value builder populated from discovery (e.g., `sensitivityLabel`, `department`, `contentType`, `region`). `[+ Add Condition]` button to add rows.
8. **Condition Builder**: Field/Operator/Value triplet with `[+ Add Condition]`. 15 operators (design lists 12 explicitly: equals, not equals, contains, starts with, ends with, greater than, less than, in list, not in list, exists, not exists, regex match -- 3 unspecified). AND/OR grouping with one level of nesting.

### Pre-Fetch vs Post-Fetch Filter Indicator

Each filter in the left panel displays a categorization indicator:

- `i` icon = runs server-side (OData pre-fetch, fast)
- No icon = runs locally (client-side post-fetch)

This helps users understand which filters are evaluated at the Graph API level vs. applied locally after content retrieval.

### Right Panel -- Live Preview

1. **Summary counts**: Document count matching, excluded count, estimated sync time.
2. **Filter diff**: `+N newly included`, `-N newly excluded`, with reason text and net change (e.g., "Net: 252 -> 218 (-34)").
3. **Action buttons**: `[Undo]` (reverts last change) and `[Reset Recommended]` (returns to system recommendation).
4. **Sample documents**: Table showing up to 20 sample matching documents with name, type, and size.
5. **Excluded documents**: List of excluded documents with per-document exclusion reason.
6. **Exclusion summary by category**: Grouped counts (e.g., "Non-indexable: 15", "Site not selected: 5", "Metadata filter: 3").

### Advanced Section (Expandable)

1. **CEL Expression Editor**: Syntax-highlighted text editor. Autocomplete on `resource.[field]`. Field VALUE autocomplete from discovery data (e.g., typing `resource.department == "` suggests `"Engineering" (234 docs)`, `"Marketing" (89 docs)`). `[Validate Expression]` button triggers inline validation with error position, description, and fix suggestion. `[CEL Reference]` link.
2. **OData Pre-Filter display**: Read-only display of the generated OData `$filter` and `$select` query. Collapsed by default on first visit; remembers expanded/collapsed state via localStorage.
3. **Filter Audit table**: Per-rule impact table with columns: Rule, Include count, Exclude count, Net count. One row per active filter rule.

### Loading Behavior

- Right panel shows "Calculating..." spinner during filter evaluation (expected 1-3 seconds for large scopes).
- Per-rule impact counts load incrementally as each rule is evaluated.
- Skeleton placeholders fill the preview panel until data arrives.

### Relationship to Proposal Tab

- Proposal and Scope+Filters show the SAME underlying scope/filter configuration.
- Accepting Scope in the Proposal applies the system recommendation.
- Editing in Scope+Filters overrides the Proposal's Scope section (badge changes to `[Modified]`).
- They are two views of one configuration, not independent settings.

## Required Data Fields

### From Discovery (read-only, populated after auth)

- `sites[]`: Array of `{ siteId, name, activityScore, fileCount, libraryCount, sizeBytes, lastModified, recommended: boolean, excludeReason?: string }`
- `fileTypeProfile[]`: Array of `{ mimeType, extension, displayName, count, indexable: boolean }`
- `metadataFields[]`: Array of `{ fieldName, type, sampleValues[]? }` -- discovered custom columns
- `fieldValueDistribution`: Map of `fieldName -> { value, documentCount }[]` -- for CEL autocomplete

### Filter Configuration (read-write, user edits)

- `selectedSiteIds[]`: Array of site IDs (checkboxes)
- `selectedFileTypes[]`: Array of MIME types or extensions
- `dateRange`: `{ modifiedAfter?: ISO8601, modifiedBefore?: ISO8601 }`
- `filterTemplate`: `'documents-only' | 'tech-docs' | 'everything' | 'custom'`
- `folderRules`: `{ include?: string[], exclude?: string[] }` -- glob patterns
- `sizeLimits`: `{ minBytes?: number, maxBytes?: number }`
- `metadataConditions[]`: Array of `{ field, operator, value }`
- `conditionGroups[]`: Array of `{ logic: 'AND' | 'OR', conditions: { field, operator, value }[] }` -- one nesting level
- `celExpression?: string` -- overrides above conditions when set

### Preview Response (read-only, returned from preview API)

- `matchCount`: Number of documents matching all filters
- `excludedCount`: Number of documents excluded
- `estimatedSyncMinutes`: Estimated sync duration
- `diff`: `{ newlyIncluded: number, newlyExcluded: number, reasons: { description, count, sizeBytes }[] }`
- `sampleDocuments[]`: Array of `{ name, type, sizeBytes }` (up to 20)
- `excludedDocuments[]`: Array of `{ name, reason }` (paginated subset)
- `exclusionSummary[]`: Array of `{ category, count }` (e.g., "Non-indexable", "Site not selected")
- `perRuleImpact[]`: Array of `{ ruleName, includeCount, excludeCount, netCount }` -- for Filter Audit table
- `generatedODataFilter`: String -- the `$filter` clause for display
- `generatedODataSelect`: String -- the `$select` clause for display

## API Requirements

### Existing Endpoints (confirmed working in design doc section 12)

| Endpoint                              | Method | UI Usage                                                                                               |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `/api/connectors/:id/discovery`       | GET    | Fetch discovered sites, file type profile, metadata fields, field value distributions                  |
| `/api/connectors/:id/filters/preview` | POST   | Send current filter config, receive preview with counts, diff, samples, per-rule impact, OData display |

### Capabilities the UI Needs from These Endpoints

1. **Discovery GET** must return:
   - Full site list with scores, file counts, sizes, recommendation status
   - File type profile with counts and indexable flag
   - Discovered metadata field names and types
   - Field value distribution with document counts (for CEL autocomplete)

2. **Filter Preview POST** must accept the full filter configuration (sites, types, dates, templates, folder rules, size limits, metadata conditions, condition groups, CEL expression) and return:
   - Match/exclude counts
   - Estimated sync time
   - Diff from previous state (+N/-N with reasons)
   - Sample matching documents (up to 20)
   - Sample excluded documents with reasons
   - Exclusion summary grouped by category
   - Per-rule impact breakdown (Filter Audit data)
   - Generated OData `$filter` and `$select` strings

3. **CEL Validation**: The preview endpoint (or a sub-endpoint) must validate CEL expressions and return:
   - `valid: boolean`
   - `error?: { position: number, message: string, fixSuggestion?: string }`

4. **Incremental loading**: The preview response should support streaming or chunked delivery so per-rule impact counts can render incrementally (design specifies 1-3 second evaluation window with progressive display).

### Proposal Section Sync

| Endpoint                                      | Method | UI Usage                                                                                         |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `/api/connectors/:id/proposal`                | GET    | Read current proposal state to determine if Scope section is Accepted/Modified/Skipped           |
| `/api/connectors/:id/proposal/sections/:name` | PATCH  | When user edits in Scope+Filters, the Proposal's Scope section badge must update to `[Modified]` |

## Assumptions

1. Discovery has already completed before the Scope+Filters tab is accessible (sites, file types, metadata fields are available) -- EXCEPT in Draft Mode where the tab is partially available (see Draft Mode section above).
2. The filter preview endpoint is fast enough for near-real-time feedback (1-3 seconds). Debouncing on the UI side (300-500ms after last input change) before calling preview.
3. Filter templates are predefined constants on the client side (not fetched from an API). Each template maps to a known set of file types, folder rules, and size limits.
4. The "Undo" button tracks a local history stack of filter states (client-side). "Reset Recommended" re-fetches or restores the original discovery recommendation.
5. CEL expressions override the GUI-built conditions when set. The UI should warn users that setting a CEL expression disables the visual condition builder.
6. localStorage is available for persisting the OData section expanded/collapsed preference.
7. The 15 operators referenced in the design are a superset of the 12 explicitly listed; the remaining 3 may include operators like `between`, `is empty`, `matches glob` or similar -- needs confirmation.
8. `activityScore` is a 0-100 numeric value computed during discovery.
9. The `[Back to panel view]` returns to 720px AND switches focus to the previously active tab or stays on Scope+Filters at 720px -- the design implies it just resizes, but any other tab click also collapses.

## Open Questions

1. **Missing operators**: The design references "15 operators" in the Condition Builder but only lists 12. What are the remaining 3?
2. **CEL validation latency**: Should CEL validation happen on every keystroke (debounced), only on `[Validate Expression]` click, or both (lightweight syntax check on type, full semantic validation on click)?
3. **Preview pagination**: For large exclusion lists, does the UI paginate excluded documents? The design shows "first 10" in the Preview tab (section 4d) but the Scope+Filters right panel shows "Excluded (23)" without explicit pagination.
4. **Filter template definitions**: Are the filter template presets (Documents Only, Tech Docs, Everything, Custom) purely client-side constants, or should they be fetched from the API to allow admin customization?
5. **Incremental loading protocol**: Should per-rule impact use SSE (Server-Sent Events), chunked HTTP response, or polling for incremental display?
6. **Undo depth**: How many undo levels should the client-side filter history stack support?
7. **CEL vs Condition Builder conflict**: When a CEL expression is active, should the visual Condition Builder be disabled/hidden, or shown in read-only mode reflecting the CEL semantics?
8. **Glob pattern validation**: Should glob patterns be validated client-side only, or also server-side with feedback on invalid patterns?

## Edge Cases

1. **Zero sites selected**: All site checkboxes unchecked. Preview should show 0 documents, 0 sync time, and a prompt to select at least one site.
2. **All documents excluded**: Filter combination results in 0 matching documents. Show a warning: "No documents match your current filters" with a `[Reset Recommended]` call-to-action.
3. **CEL syntax error**: User enters invalid CEL. Inline error displays at the exact position with fix suggestion. Preview should either show last valid state or a "Cannot preview -- fix expression errors" message.
4. **Very large site count**: Discovery returns 50+ sites. The sites list needs virtualized scrolling or a search/filter input above the checkbox list.
5. **Discovery returned no metadata fields**: The Metadata Conditions section and CEL field autocomplete should gracefully degrade -- show "No custom metadata discovered" instead of empty dropdowns.
6. **Stale preview**: User makes rapid changes faster than the API responds. The UI must debounce requests and discard stale responses (use request sequence numbers or abort controllers).
7. **Sites.Selected mode (no discovery)**: User authenticated with Sites.Selected. Sites list shows only manually entered sites with no scores or file counts (those require discovery). File type profile and metadata fields may be unavailable or partial.
8. **Filter template + manual edits**: User selects "Documents Only" template then manually unchecks PDF. Template badge should change to "Custom" or show a "modified" indicator.
9. **OData display with CEL override**: When a CEL expression is active, the OData display may not reflect the full filtering since CEL runs post-fetch. The UI should clarify which filters run server-side (OData) vs. client-side (CEL, folder globs, metadata).
10. **localStorage unavailable**: If localStorage is blocked (private browsing in some browsers), OData collapsed state defaults to collapsed without persistence. No error shown.

## Out of Scope

- Backend implementation of discovery, filter preview, or CEL validation endpoints.
- Database schema for filter configuration or discovery results.
- OData query construction logic (that is backend concern; UI only displays the generated string).
- The Preview/Dry-Run tab (section 4d) -- that is a separate card (C-05 or similar).
- The Proposal tab's Accept/Modify/Skip interaction (section 4b) -- that is a separate card.
- Sync execution triggered from this tab -- Scope+Filters is configuration only, not sync initiation.
- Permission configuration (Security tab, section 4e).
- Schedule configuration (section within Proposal).
- Multi-connector bulk filter operations (section 8).
- Config export/import/clone (section 9).

## Resolution Log

**Resolved from verification-batch-2 findings:**

| #   | Finding                                                            | Severity | Resolution                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Missing Simplified View behavior (tab hidden when ON)              | HIGH     | **Fixed.** Added new "Simplified View Interaction" section at top of UI Behaviors documenting tab hidden when ON, only visible when OFF, and relationship to Proposal inline Modify editors. Verified against design lines 578-598.                                                                  |
| F2  | Missing Draft Mode / pre-auth degraded state                       | HIGH     | **Fixed.** Added new "Draft Mode (Pre-Auth) Degraded State" section documenting split-availability mode: sites disabled, filters/schedule/permissions editable, persistence message. Verified against design section 5 (lines 1968-2012). Updated Assumption 1 to note the exception for Draft Mode. |
| F3  | Missing pre-fetch vs post-fetch indicator in left panel            | MEDIUM   | **Fixed.** Added new "Pre-Fetch vs Post-Fetch Filter Indicator" section documenting the `i` icon convention: icon = server-side (fast), no icon = local. Verified against design lines 689, 710-711.                                                                                                 |
| F4  | Missing "People & Metadata" (Created by / Modified by) distinction | LOW      | **Fixed.** Rewrote item 7 in Left Panel Controls to distinguish People fields (Created by / Modified by with OData pre-fetch) from Custom metadata columns. Verified against design lines 668-675.                                                                                                   |
| --  | "Exclude always wins" tooltip rendering                            | --       | **Fixed.** Updated item 5 (Folder rules) to specify the rule displays as an `i` tooltip/info text inline, matching the wireframe.                                                                                                                                                                    |
