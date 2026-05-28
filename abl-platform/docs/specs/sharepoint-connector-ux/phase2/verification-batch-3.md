# Phase 2 Verification -- Batch 3 (C-07, C-08, C-09)

**Verified against:** `docs/design/SHAREPOINT-DESIGN-FINAL-v3.md`
**Date:** 2026-03-24

---

## C-07: Draft Mode (Configure-Before-Auth)

**Design reference:** Section 5 (lines 1968-2012)

### Missing UI Behaviors

1. **Tab lock icon rendering**: The design wireframe shows tabs `Proposal | Scope+Filters | Preview | Security | History` in the tab bar alongside `Connect*`. The capability note (item 7) lists which tabs are editable vs. locked but does NOT specify that locked tabs should display a lock icon overlay on their labels. The design banner says "Tabs marked with a lock icon will populate after auth completes" -- the note captures the banner text but the lock icon visual treatment on individual tab labels is not explicitly described as a UI behavior.

2. **"More Actions" menu**: The wireframe shows `[... More Actions]` in the panel header. The capability note does not mention this menu or what it contains in draft mode. This may be covered by another card, but the note should acknowledge it exists and state whether it is active or disabled in draft mode.

### Missing Data Fields

No gaps found. The data fields table is thorough and covers all wireframe-visible fields.

### API Gaps

No significant gaps. The note defines 6 API interactions (create, update, poll, get, schedule options, filter presets) which cover the wireframe flows.

### Invalid Assumptions

1. **Assumption 2** states "Draft mode applies to all auth methods, not just delegation." This is correct per the design ("When the user selects delegation or is waiting for authentication"), but the design's framing specifically mentions delegation as the primary trigger. The assumption is valid but could note that the design's primary scenario is delegation.

### Edge Cases Not Considered

1. **Auth method switching in draft mode**: The note covers "auth fails and user retries" (edge case 1) but does not address the scenario where the user starts with one auth method (e.g., device code), it stalls, and they want to switch to a different method (e.g., delegation) while preserving draft configuration. The design does not explicitly cover this either, so it is a legitimate gap for both.

### Open Questions Already Answered

1. **Open Question 3** ("Which tabs show the lock icon?"): This IS partially answered by the note itself in item 7 ("Locked/disabled: Proposal, Preview, Security, History"). The question about visual treatment (overlay vs. replace) is genuine, but the "which tabs" part is self-answered.

### Scope Issues

1. **Out of Scope item 1** incorrectly states "Delegation flow details -- covered in C-08." The delegation flow is NOT C-08. C-08 covers Monitoring & Sync Progress. Delegation is likely covered by a different card (e.g., C-06 or a dedicated delegation card). This is a referencing error.

### Verdict: NEEDS_FIXES (3 findings)

| #   | Severity | Finding                                                       |
| --- | -------- | ------------------------------------------------------------- |
| 1   | LOW      | Missing lock icon visual treatment on individual tab labels   |
| 2   | LOW      | Missing acknowledgment of "More Actions" menu in panel header |
| 3   | MEDIUM   | Out of Scope incorrectly attributes delegation flow to C-08   |

---

## C-08: Monitoring & Sync Progress

**Design reference:** Sections 7a (lines 2370-2467) and 7b (lines 2478-2510)

### Missing UI Behaviors

1. **"Crawl Now" and "Set Schedule" buttons** in the Permission Sync Status section: The design wireframe explicitly shows `[Crawl Now]  [Set Schedule]` buttons under Permission Sync Status. The note mentions these only implicitly through API endpoints (`POST /connectors/:connectorId/permission-crawl` and `PUT /connectors/:connectorId/permission-schedule`). They are NOT listed as UI elements in the UI Behaviors section. They should be explicit interactive elements under item 4 (Permission Sync Status).

2. **Permission Sync Status explanatory note**: The design wireframe includes a full paragraph: "Note: Search results respect the last-crawled permissions. If a user's access was revoked in SharePoint after the last crawl, they may still see that document in search until the next crawl." This informational text is not captured in the note's UI behaviors.

3. **Source attribution note context**: The design wireframe includes specific text about source attribution being "Not yet populated -- requires backend work" with a reference to "Backend Requirements section." The note (item 11) simplifies this to a generic "informational text explaining search results show connector origin" and misses the "not yet populated" caveat.

4. **Search Documents navigation detail**: The design specifies the Documents view "Shows document name, status, connector, and indexed date." The note (item 10) only says "pre-applied filter for connectorId" but omits the specific columns the user would see.

5. **Webhook payload description**: The design wireframe states "Payload: JSON with event type, connector ID, severity, timestamp." The note does not capture this payload schema description as a UI element (it would be displayed to the user to explain what the webhook sends).

6. **Notifications email detail**: The design wireframe specifies "Uses platform email service (AWS SES/Resend/SMTP)" as visible informational text. The note does not capture this.

7. **"sync complete" as a webhook event**: The design wireframe shows `[ ] Sync complete` as a third webhook event checkbox (unchecked by default). The note's Notifications Config data fields list `webhookEvents` with example `["sync_failure", "token_expiry"]` but the email events example includes only 3 events `["sync_failure", "token_expiry", "permission_crawl_fail"]`. The design shows 4 total events: sync failure, token expiry (7d warning), permission crawl fail (email), and sync complete (webhook). The note should ensure all 4 events are listed as available options for both email and webhook.

### Missing Data Fields

1. **`connectedDate`** and **`authenticatedBy`**: These are listed in the data fields table (good), and they match the wireframe line "Connected Mar 22 . Authenticated by sarah@contoso.com".

2. **Permission coverage fields**: The note has `coverageTotal` and `coverageMapped` which correctly models the design's "237 of 237 documents have permissions mapped." No gap here.

3. **Missing: `scheduledSyncInterval`** in Content Freshness: The design shows "Scheduled sync: Every 6 hours (last 3 attempts failed)." The note has `scheduledInterval` which maps to "Every 6 hours" -- good. But the note also has `recentFailedAttempts` -- good. No gap.

### API Gaps

1. **No API endpoint for "Configure Alerts" quick action**: The quick actions include `[Configure Alerts]` which presumably scrolls to or opens the Notifications section. If it navigates to a separate configuration view, an API endpoint may be needed. Currently it seems like an in-panel scroll, so this is minor.

### Invalid Assumptions

No invalid assumptions found. All 8 assumptions are reasonable and not contradicted by the design.

### Edge Cases Not Considered

1. **Permission crawl running concurrently with content sync**: The design shows Permission Sync Status and Sync Progress as independent. The note covers "Permission crawl in progress" (edge case 5) but not the scenario where BOTH are running simultaneously. How does the UI handle showing sync progress view while also needing to update permission status?

2. **Neo4j slowness**: The design explicitly mentions "Permission Sync Status may show 'Checking...' if Neo4j is slow." The note captures this in item 4 ("may show 'Checking...' spinner"), but the loading behavior section does not call out that Permission Sync Status has independent loading timing from the other sections. It should be listed in the progressive loading sequence.

### Open Questions Already Answered

1. **Open Question 4** ("Content freshness threshold -- is this configurable?"): The design states "3+ days" as a fixed value. The question is still valid because the design does not say whether it is configurable, so this remains a genuine open question.

2. **Open Question 8** ("Health check response -- what does it return?"): The design does not answer this, so this is genuine.

### Scope Issues

No scope creep detected. The note correctly excludes search result rendering, edit configuration flow, and multi-connector comparison.

### Verdict: NEEDS_FIXES (7 findings)

| #   | Severity | Finding                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | MEDIUM   | Missing "Crawl Now" and "Set Schedule" as explicit UI elements in behaviors list                                          |
| 2   | LOW      | Missing permission sync explanatory note (last-crawled caveat)                                                            |
| 3   | LOW      | Missing "not yet populated" caveat for source attribution                                                                 |
| 4   | LOW      | Missing specific columns for Search Documents view                                                                        |
| 5   | LOW      | Missing webhook payload schema description as UI text                                                                     |
| 6   | LOW      | Missing platform email service info text                                                                                  |
| 7   | MEDIUM   | Incomplete event list -- "sync complete" webhook event and "permission_crawl_fail" for both channels not fully enumerated |

---

## C-09: SourcesTable Enhancements

**Design reference:** Sections 3b-i through 3b-iv (lines 340-530)

### Missing UI Behaviors

1. **Summary row in card view**: The design wireframe (3b-i) shows a summary line: "696 docs . 6.1 GB . 6 sources (2 SharePoint, 1 Web, 1 File, 1 API)". The note mentions "A summary row below cards shows: total doc count, total size, source count breakdown by type" (good, captured).

2. **Summary row in table view**: The design wireframe (3b-ii) also shows a summary line at the bottom: "3,847 docs total . 18.9 GB . 15 sources (8 SP, 3 Web, 2 File, 2 API)". The note does NOT explicitly list this as a separate element from the "Aggregate summary bar above the table." The design shows BOTH: an aggregate summary bar at the top (with status breakdown and tokens expiring) AND a summary line at the bottom (with totals by type). The note only describes the top aggregate bar.

3. **Header status line**: The design wireframe shows a status line at the very top of the section: "6 active . 1 warning . 0 errors" (card view) and "15 active . 2 warnings . 1 error" (table view), alongside the `[Card] [Table] [+ Add]` buttons. The note does not explicitly capture this status line as a distinct UI element (it is separate from the aggregate summary bar).

4. **"+ Add" button in header**: The design shows `[+ Add]` in the header area (alongside Card/Table toggle). The note mentions a dashed-border "+ Add Source" card in card view but does not mention the `[+ Add]` button that appears in the header toolbar area for both views.

5. **Database source type**: The design (3b-i secondary info list) includes Database as a source type with "connection string, last query." The note captures this in data fields, but the card view wireframe in the design does not show a Database example card. The note correctly extrapolates the Database type from the text description.

### Missing Data Fields

1. **Card view: Token health display format**: The design wireframe shows token health as "Token: \* 28d" (healthy) and "Token: ! 3d left" (warning). The note's SharePoint-specific fields have `tokenHealthDaysRemaining` and `tokenStatus` which can render this. However, the card view does not list "token health" in the "Per-Source" common fields -- it is only in the SharePoint-specific section. This is correct (it is SP-specific), so no gap.

2. **"Partial" status**: The design table view wireframe (3b-ii) shows a row with status "! Partial" for Engineering Wiki. The note's status badges list does NOT include "Partial" as a status. The 6 statuses listed are: Active, Awaiting Auth, Draft, Syncing, Error, Auth Failed. "Partial" is missing. This could be an alias for a warning state or a distinct status.

### API Gaps

No significant API gaps. The list endpoint with filtering, sorting, grouping, pagination, and aggregates covers the wireframe requirements.

### Invalid Assumptions

No invalid assumptions found.

### Edge Cases Not Considered

1. **Database source type in card view**: The note's card view description lists source types but the edge case of how a Database source card renders (what icon, what secondary info layout) is not explicitly described as a UI behavior. The data fields cover it, but the card rendering behavior should mention all 5 types.

2. **"! Partial" status mapping**: As noted above, the "Partial" status from the design wireframe is not accounted for. If "Partial" means "some sub-sources healthy, some not" (like a SharePoint connector with some sites synced and others failed), this is a distinct status not covered by the 6 listed badges.

### Open Questions Already Answered

1. **Open Question 1** ("Should SourcesTable poll for status changes?"): The design does not explicitly answer this. Genuine open question.

All other open questions are genuine.

### Scope Issues

No scope creep detected. The note correctly excludes Detail Panel content, Add Source dialog, and backend implementation.

### Verdict: NEEDS_FIXES (4 findings)

| #   | Severity | Finding                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | MEDIUM   | Missing bottom summary row in table view (design shows both top aggregate bar AND bottom summary)          |
| 2   | LOW      | Missing header status line as distinct UI element ("N active . N warnings . N errors")                     |
| 3   | MEDIUM   | Missing "Partial" status badge -- design wireframe shows "! Partial" which is not in the 6 listed statuses |
| 4   | LOW      | Missing [+ Add] button in header toolbar (both views)                                                      |

---

## Summary

| Card      | Verdict         | Critical | Medium | Low   |
| --------- | --------------- | -------- | ------ | ----- |
| C-07      | NEEDS_FIXES (3) | 0        | 1      | 2     |
| C-08      | NEEDS_FIXES (7) | 0        | 2      | 5     |
| C-09      | NEEDS_FIXES (4) | 0        | 2      | 2     |
| **Total** | **14 findings** | **0**    | **5**  | **9** |

No critical findings. All cards capture the major design intent accurately. The gaps are primarily in secondary UI elements (informational text, button placement, status variants) and completeness of event/status enums. C-08 has the most findings due to the density of the Overview tab wireframe.
