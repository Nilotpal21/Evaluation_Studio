# C-01: Panel Shell & Navigation -- Capability Note

**Status:** Reviewed
**Design Sections:** S2, S3, S4 intro

## User Intent

The user wants to view or configure a SharePoint connector through a consistent slide-in panel that opens from multiple entry points across the KB Detail Page. The panel must route to the correct initial tab based on whether the connector is new (setup mode) or existing (monitoring mode), and must provide navigation between all configuration/monitoring tabs without leaving the current page context.

## UI Behaviors

- **Flow A (New KB, Home tab):** User clicks "Connect Source" on SetupGuide --> Add Source dialog opens on Home tab (no tab switch) --> user picks SharePoint --> dialog closes --> Detail Panel slides in from right at 720px with Connect tab active, other tabs locked.
- **Flow B (Mature KB, Home tab):** User clicks Sources stat card on OperationsDashboard --> navigates to Data tab > Sources segment --> user clicks [+ Add Source] or clicks existing SP row (same as Flow C or D from here).
- **Flow C (Data tab, new connector):** User clicks [+ Add Source] --> type picker dialog --> picks SharePoint --> dialog closes --> Detail Panel slides in with Connect tab active, other tabs locked.
- **Flow D (Data tab, existing connector):** User clicks an existing SharePoint row/card in SourcesTable --> Detail Panel slides in. Initial tab depends on connector status:
  - "Draft" or "Awaiting Auth" --> Connect tab active (resume setup).
  - "Active", "Syncing", or "Error" --> Overview tab active.
- **Post-creation navigation:** After setup completes and sync starts:
  - If arrived via Flow A (Home tab): app navigates to Data tab > Sources segment. New connector appears with "Syncing" status. Detail Panel auto-opens showing Overview tab.
  - If already on Data tab (Flows B/C): Detail Panel switches to Overview tab in place.
- **Expand/Collapse [<>]:** User clicks [<>] button on any tab --> panel expands to full viewport width. Clicking [<- Back to panel view] or switching to a non-Scope+Filters tab returns to 720px. Scope+Filters tab auto-expands to full viewport on activation with a `300ms ease-out` animation (design line 1614). The collapse animation (returning from full-width to 720px) should use the same `300ms ease-out` timing for consistency.
- **Close [x]:** User clicks close button --> panel slides out, returns to underlying page.
- **Simplified View toggle:** User toggles ON/OFF at top of panel. ON (default for first-time users): shows Connect, Proposal, Preview, Security tabs only. OFF: shows Connect, Proposal, Scope+Filters, Preview, Security, History tabs. Persisted per-user in localStorage. Default detection: absence of localStorage key = first-time = defaults ON (design line 580: "Defaults ON for first-time users. Toggle at top of panel. Persisted per-user via localStorage.").
- **Simplified View content filtering (delegated to tab cards):** When Simplified View is ON, the Security tab hides advanced details (ACL modes, CEL, OData), all instances of "pipeline" are replaced with "system", and CEL/OData/metadata conditions are not shown (design lines 553-555, 772-781). This filtering behavior is the responsibility of the Security tab card (C-07 or equivalent), but the shell drives the toggle state that those cards consume.
- **More Actions menu:** User clicks [...] overflow button --> dropdown with: Clone, Export JSON/YAML, Import Config, Run Health Check, Diagnostics, Delete.
- **Concurrent editing banner:** When another user is editing the same connector, a warning banner appears at the top of the panel with their email and a [Refresh to see latest] action.
- **Tab locking (setup mode):** For new connectors, only the Connect tab is interactive. Other tabs show as locked/disabled until the Connect step is completed. After auth completes, the system generates a Proposal, implying progressive unlock: Connect --> Proposal unlocks after auth --> Scope+Filters available after proposal generation. The exact unlock sequence is implied by the setup flow (design lines 303-304, 316-320).
- **Card/Table auto-switch in SourcesTable:** The design (lines 524-529) specifies SourcesTable switches from card view (1-6 sources) to table view (7+ sources) on page load, with user override persisted per-KB in localStorage. Adding a 7th source does NOT switch mid-interaction. This behavior is owned by the SourcesTable card, not C-01, but affects Flow B and Flow D entry points. Cross-reference: SourcesTable card.

## Required Data Fields

- `connectorId` (string) -- unique identifier, used for all subsequent API calls
- `connectorName` (string) -- displayed in panel header (e.g., "SP: Marketing Hub")
- `connectorStatus` (enum: "draft" | "awaiting_auth" | "active" | "syncing" | "error" | "auth_failed") -- determines initial tab routing and tab lock state
- `authStatus` (enum: "pending" | "completed" | "failed" | "not_started") -- whether auth was completed, pending, or failed. Used for tab routing (e.g., "awaiting_auth" connectorStatus + "pending" authStatus = Connect tab) and Connect tab state display. Distinct from `connectorStatus` which reflects the overall connector lifecycle.
- `connectorType` (string, "sharepoint") -- used by SourcesTable routing logic to open this panel vs SourceDetailPanel
- `createdAt` (Date) -- informational display
- `updatedAt` (Date) -- informational display
- `activeEditors` (array of {email: string}) -- drives the concurrent editing banner; needs to include other users currently viewing/editing
- `simplifiedViewPreference` (boolean) -- per-user, stored in localStorage (key pattern: `sp-simplified-view-{userId}`)
- `expandedPreference` (boolean) -- per-user per-tab, stored in localStorage
- `hasProposal` (boolean) -- determines if Proposal tab is available vs locked
- `setupProgress` (object: {currentStep: string, completedSteps: string[]}) -- determines which tabs are unlocked in setup mode
- `knowledgeBaseId` (string) -- parent context for navigation and API scoping
- `projectId` (string) -- parent context for API scoping and URL construction
- `sourceId` (string) -- the source record ID in SourcesTable, linked via connectorMap

## API Requirements

### API-1: Get Connector Detail

- **Purpose:** Load all connector metadata needed to render the panel shell, determine tab routing, and display the header.
- **Input:** `connectorId` (path param), `projectId` (path param or context), `tenantId` (from auth context)
- **Output:** Connector object with at minimum: `_id`, `name`, `status`, `type`, `config`, `createdAt`, `updatedAt`, `authStatus`, `setupProgress` (which steps completed). The panel shell needs `name` for the header, `status` for tab routing, `authStatus` for Connect tab state, and `setupProgress` for tab lock states.
- **Filters/Pagination:** None (single resource fetch).
- **Polling/Real-time:** No polling needed for the shell itself. Individual tab contents may poll independently.
- **Existing endpoint:** `GET /api/connectors/:id` (exists per Section 12 capability matrix -- Connector CRUD is "Working").

### API-2: Get Active Editors (Concurrent Editing)

- **Purpose:** Determine if other users are currently editing this connector, to show/hide the concurrent editing warning banner.
- **Input:** `connectorId`
- **Output:** Array of `{userId, email, lastActiveAt}` for users with the panel open on this connector (excluding current user).
- **Filters/Pagination:** None.
- **Polling/Real-time:** The UI needs either: (a) polling every 30-60 seconds, or (b) a presence heartbeat mechanism where opening/closing the panel registers/deregisters the user. Polling is simpler for v1.
- **Note:** This endpoint does not exist yet. The design doc mentions the banner (S4 intro, line 569) but does not specify a backend mechanism. This is a NEW capability.

### API-3: Delete Connector

- **Purpose:** Triggered from "More Actions > Delete" menu item.
- **Input:** `connectorId`
- **Output:** Success/failure. On success, the panel closes and the SourcesTable refreshes.
- **Filters/Pagination:** None.
- **Polling/Real-time:** None.
- **Existing endpoint:** Part of Connector CRUD (exists).

### API-4: Clone Connector

- **Purpose:** Triggered from "More Actions > Clone" menu item.
- **Input:** `connectorId`
- **Output:** New connector object (the clone). Panel should re-open on the cloned connector in setup mode (Connect tab, since re-auth is required).
- **Filters/Pagination:** None.
- **Polling/Real-time:** None.
- **New endpoint:** `POST /api/connectors/:id/clone` (listed in S12 API Changes Needed).

### API-5: Export Connector Config

- **Purpose:** Triggered from "More Actions > Export JSON/YAML" menu item.
- **Input:** `connectorId`, `format` ("json" | "yaml")
- **Output:** Serialized config as downloadable file (or blob).
- **Filters/Pagination:** None.
- **Polling/Real-time:** None.
- **New endpoint:** `POST /api/connectors/:id/export` (listed in S12 API Changes Needed).

### API-6: Import Connector Config

- **Purpose:** Triggered from "More Actions > Import Config" menu item.
- **Input:** Config file content (JSON or YAML), `knowledgeBaseId`
- **Output:** New connector object created from the imported config.
- **Filters/Pagination:** None.
- **Polling/Real-time:** None.
- **New endpoint:** `POST /api/connectors/import` (listed in S12 API Changes Needed).

### API-7: Run Health Check

- **Purpose:** Triggered from "More Actions > Run Health Check" menu item.
- **Input:** `connectorId`
- **Output:** Health check results (pass/fail per check, warnings). The design shows "6/7 passed" format.
- **Filters/Pagination:** None.
- **Polling/Real-time:** Health check may be async. UI may need to poll for results or receive them in the response if fast enough.
- **Note:** Health check exists as part of the quick-setup flow but may not have a standalone trigger endpoint.

## Assumptions

1. The panel shell component is shared between setup mode and monitoring mode -- the same React component renders with different tab configurations based on connector status.
2. The `connectorMap` lookup in SourcesTable (mapping `source._id` to `connectorId`) already exists in the codebase and does not need a new API.
3. localStorage is acceptable for Simplified View and expand/collapse preferences (no server-side persistence needed for UI preferences).
4. The "More Actions" menu items (Clone, Export, Import, Health Check, Diagnostics, Delete) trigger API calls but their result handling (success toasts, error modals) follows existing platform patterns.
5. Tab locking in setup mode is purely a frontend concern -- the backend does not enforce tab ordering, but returns connector status that the frontend uses to compute lock states.
6. The 720px panel width and full-viewport expand are CSS concerns handled in the component. The auto-expand behavior on Scope+Filters tab is triggered by a tab change event, not by an API.
7. Only SharePoint-type connectors use this panel. Other source types continue to use the existing SourceDetailPanel (routing based on `connectorMap` presence).

## Open Questions

1. **Concurrent editing mechanism:** The design shows a banner with another user's email, but does not specify the backend mechanism. Is this a heartbeat/presence API, a WebSocket channel, or polling? What is the acceptable staleness window?
2. **Diagnostics action:** "More Actions > Diagnostics" is listed but not detailed in the design doc. What does this show? Is it a separate API or a client-side log dump? Section 12 capability matrix should be checked for details.
3. **Panel slide-in/close animation specs:** The Scope+Filters auto-expand timing IS specified: `300ms ease-out` (design line 1614). The initial slide-in and close animations are NOT specified in the design. Recommend using the same `300ms ease-out` for consistency unless design provides different values.
4. **Tab lock granularity:** PARTIALLY ANSWERED. The design (lines 303-304, 316-320) implies progressive unlock: Connect (auth) --> Proposal (generation) --> Scope+Filters (after proposal). The exact sequence is: auth completes --> system generates Proposal --> Proposal tab unlocks --> user reviews sections --> Scope+Filters becomes available. Remaining question: does the unlock happen per-tab as generation proceeds, or all-at-once when generation finishes?
5. **Post-creation "auto-open" timing:** After Flow A navigates to Data tab > Sources, the panel auto-opens on the new connector. Is there a delay, or does the navigation carry a parameter that triggers immediate panel open?

## Edge Cases

- **Panel already open, user clicks different connector row:** Panel should close current connector and reopen with the new one (or swap in place with a transition).
- **Connector deleted by another user while panel is open:** The GET connector API returns 404. Panel should show an error state and close gracefully.
- **Network failure during panel load:** Show error state with retry option inside the panel shell.
- **User toggles Simplified View while on a hidden tab (Scope+Filters or History):** If currently viewing Scope+Filters or History and user toggles Simplified ON, the active tab disappears. UI must redirect to the nearest available tab (e.g., Proposal or Connect).
- **Browser back/forward with panel open:** Panel state is not URL-routed (no new pages). Back button should not close the panel unless the panel open/close state is tracked in URL params.
- **Rapid tab switching:** Debounce tab change handlers to avoid triggering multiple API calls and auto-expand flicker.
- **Mobile/narrow viewport:** 720px panel may exceed viewport width. Need a breakpoint behavior (full-screen panel on small screens?).
- **Connector in "syncing" state opened via Flow D:** Overview tab shows live sync progress. If sync completes while panel is open, the Overview tab should auto-refresh (handled by Overview tab card, not the shell).
- **Scope+Filters collapse animation timing:** When switching from Scope+Filters to another tab, the panel collapses from full viewport to 720px. The collapse should use the same `300ms ease-out` timing as the expand for consistency.

## Out of Scope

- **Tab content rendering:** Each tab's internal content (Connect form, Proposal review, Scope+Filters split-pane, Preview, Security, History) is covered by separate cards (C-02 through C-08).
- **SourcesTable enhancements:** Card/table view, bulk actions, type badges, tenant grouping are covered by a separate SourcesTable card. Note: the card/table auto-switch behavior (1-6 sources = cards, 7+ = table) is owned by that card but affects Flow B/D entry points.
- **Add Source dialog / type picker:** The dialog that appears before the panel opens is an existing component. This card covers only what happens after SharePoint is selected.
- **Delegation flow UI:** The delegation invite generation and tracking within the Connect tab is a separate card.
- **Notification/webhook configuration:** Covered by monitoring tab cards.
- **API authentication and authorization:** Standard platform auth middleware applies. Not specific to this card.

## Resolution Log

| Finding                                                 | Disposition                | Action Taken                                                                                                                                                       |
| ------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FINDING-01 (Simplified View hides Security tab details) | VALID — fixed              | Added "Simplified View content filtering" bullet to UI Behaviors, noting the shell drives the toggle but filtering is delegated to tab cards (C-07).               |
| FINDING-02 (Card vs Table auto-switch)                  | VALID — informational      | Added cross-reference bullet in UI Behaviors and updated Out of Scope to explicitly mention the auto-switch behavior.                                              |
| FINDING-03 (Scope+Filters 300ms ease-out timing)        | VALID — fixed              | Added `300ms ease-out` timing to the Expand/Collapse behavior description. Added collapse animation to Edge Cases.                                                 |
| FINDING-04 (authStatus field missing)                   | VALID — fixed              | Added `authStatus` to Required Data Fields with description distinguishing it from `connectorStatus`. Updated API-1 output to include `authStatus`.                |
| FINDING-05 (Diagnostics endpoint)                       | VALID — kept open          | Updated Open Question #2 to reference S12 more specifically. Diagnostics remains undefined in the design.                                                          |
| FINDING-06 (Collapse animation timing)                  | VALID — fixed              | Added Edge Case entry for collapse animation and recommended matching the expand timing.                                                                           |
| FINDING-07 (Open Question #3 — animation specs)         | VALID — split              | Rewrote Open Question #3: Scope+Filters timing marked as ANSWERED (300ms ease-out), slide-in/close animations remain open.                                         |
| FINDING-08 (Open Question #6 — Simplified View default) | VALID — answered           | Removed Open Question #6 (was #6, now answered). Incorporated answer into Simplified View toggle bullet: "absence of localStorage key = first-time = defaults ON." |
| FINDING-09 (Open Question #4 — tab lock granularity)    | VALID — partially answered | Updated Open Question #4 with the implied progressive unlock sequence from the design, leaving only the timing granularity as open.                                |
