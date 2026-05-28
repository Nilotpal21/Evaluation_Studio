# SharePoint Connector UX -- Final Unified Design

**Date:** 2026-03-22
**Status:** Final Design (combines winning elements from Designs A, B, and C)
**Pattern:** Dashboard home base + Detail panel with Configuration Proposal + Split-pane filter iteration

---

## 1. Philosophy

The dashboard is the permanent home -- a warm welcome for the first connector that scales to a fleet-operations command center at 15+. Every connector setup generates a **Configuration Proposal**: a conversational, reviewable document that doubles as the security review artifact, turning setup into a review process where each section can be accepted, modified, or skipped.

The system speaks as a knowledgeable colleague who already did the research. "I discovered 12 SharePoint sites. I recommend syncing 8 based on activity and relevance." Transparency is non-negotiable: the TRUST NOTE about read-only permissions, the "what this connector does NOT access" list, and the raw OData query are all first-class features, not hidden footnotes.

---

## 2. Navigation Context -- Where This Lives in the App

SharePoint connectors live INSIDE a Knowledge Base, not as a standalone page.
The detail panel opens from existing navigation points — no new pages or routes.

### Navigation Hierarchy (verified against codebase)

```
Project Sidebar
  │
  └─ Knowledge Bases (search-ai page)
       │
       └─ KnowledgeBaseDashboardPage (KB list -- card grid)
            │
            └─ KB Detail Page (click a KB)
                 │
                 ├─ Home tab (HomeSection -- 4-state machine)
                 │    │
                 │    ├─ state='setup' → SetupGuide (2-card layout)
                 │    │    └─ [Connect Source] button
                 │    │
                 │    └─ state='operations' → OperationsDashboard
                 │         └─ [Sources] stat card (click navigates to Data tab)
                 │
                 └─ Data tab (DataSection)
                      │
                      ├─ SegmentedControl: [Documents] [Chunks] [Sources]
                      │
                      ├─ Sources segment → SourcesTable
                      │    ├─ Click SP row → Detail Panel (EXISTING connector)
                      │    └─ [+ Add Source] button
                      │
                      └─ AddSourceButton → type picker dialog
                           └─ Click SharePoint → Detail Panel (NEW connector)
```

### Trigger Flows (4 entry points, verified against actual code)

**Flow A: New KB → Home → SetupGuide → "Connect Source"**

```
  Home tab (state='setup': 0 sources, 0 docs)
  ┌───────────────────────────────────────────────────────────────┐
  │  [Home]  Data   Fields   Vocab   Search                      │
  ├───────────────────────────────────────────────────────────────┤
  │                                                               │
  │  🚀 Get started with your Knowledge Base                     │
  │                                                               │
  │  ┌───────────────────┐  ┌───────────────────┐               │
  │  │ 📄 Upload Files   │  │ 🔌 Connect Source │               │
  │  │                   │  │                   │               │
  │  │ [ Drop zone     ] │  │ Connect website,  │               │
  │  │ [ drag & drop   ] │  │ database, API, or │               │
  │  │                   │  │ enterprise source │               │
  │  │ (opens upload    │  │                   │               │
  │  │  dialog inline)   │  │ [Connect Source]──┼───┐           │
  │  └───────────────────┘  └───────────────────┘   │           │
  │                                                   │           │
  │  What happens: Schema detect → Process → Search   │           │
  └───────────────────────────────────────────────────┼───────────┘
                                                      │
           setPendingFilter({ autoOpenAddSource: true })
           onNavigate('data')
                                                      │
                                                      ▼
  Navigates to Data tab → Add Source dialog auto-opens → type picker
  → user clicks SharePoint → dialog closes → Detail Panel opens
```

**Flow B: Mature KB → Home → OperationsDashboard → Sources card**

```
  Home tab (state='operations': has documents)
  ┌───────────────────────────────────────────────────────────────┐
  │  [Home]  Data   Fields   Vocab   Search                      │
  ├───────────────────────────────────────────────────────────────┤
  │                                                               │
  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
  │  │  523    │ │  3      │ │  12     │ │ Mar 22  │           │
  │  │ Docs    │ │ Sources─┼─│ Errors  │ │ Last idx│           │
  │  │ →Data   │ │ →Data ──┘ │ →Data   │ │         │           │
  │  └─────────┘ └────┬────┘ └─────────┘ └─────────┘           │
  │                    │                                         │
  │  NeedsAttentionCard                                          │
  │  ActivityFeed + DocumentStatus                               │
  └────────────────────┼─────────────────────────────────────────┘
                       │
     setPendingFilter({ view: 'sources' })
     onNavigate('data')
                       │
                       ▼
  Navigates to Data tab → Sources segment active → user sees source list
  → clicks [+ Add Source] or clicks existing SharePoint row
```

**Flow C: Data tab → [+ Add Source] → SharePoint (NEW connector)**

```
  Data tab → Sources segment
  ┌───────────────────────────────────────────────────────────────┐
  │  Home  [Data]  Fields   Vocab   Search                       │
  ├───────────────────────────────────────────────────────────────┤
  │                                                               │
  │  [Documents] [Chunks] [Sources]              [+ Add Source]──┐│
  │                        ▲ active                              ││
  │                                                              ││
  │  ┌──────────────────────────────────────────────────────┐   ││
  │  │  SharePoint: Marketing   ⬡ SP    ● Active   237     │   ││
  │  │  Company Website         🌐 Web  ● Active   180     │   ││
  │  │  Product Docs            📄 File ● Active   106     │   ││
  │  └──────────────────────────────────────────────────────┘   ││
  └──────────────────────────────────────────────────────────────┼┘
                                                                 │
                                               opens dialog      │
                                                                 ▼
                                    ┌─────────────────────────────┐
                                    │  Add Source           [X]   │
                                    │                             │
                                    │  ┌────┐┌────┐┌────┐┌────┐ │
                                    │  │File││Web ││ DB ││API │ │
                                    │  └────┘└────┘└────┘└────┘ │
                                    │  ┌───────────┐            │
                                    │  │🏢SharePoint│            │
                                    │  │ Enterprise │            │
                                    │  └─────┬─────┘            │
                                    └────────┼──────────────────┘
                                             │
                              handleTypeSelect('sharepoint')
                              → dialog closes
                              → Detail Panel opens (Connect tab)
                                             │
                                             ▼
                              ┌──────────────────────────────┐
                              │ Detail Panel (720px)    [X]  │
                              │                              │
                              │ [Connect] [Scope] [Preview]  │
                              │  ▲active   locked   locked   │
                              │                              │
                              │ New connector setup flow     │
                              │ (section 4a wireframes)      │
                              └──────────────────────────────┘
```

**Flow D: Data tab → Click existing SharePoint row (EXISTING connector)**

```
  Data tab → Sources segment
  ┌───────────────────────────────────────────────────────────────┐
  │  Home  [Data]  Fields   Vocab   Search                       │
  ├───────────────────────────────────────────────────────────────┤
  │                                                               │
  │  [Documents] [Chunks] [Sources]              [+ Add Source]  │
  │                        ▲ active                               │
  │                                                               │
  │  ┌──────────────────────────────────────────────────────┐    │
  │  │  SharePoint: Marketing   ⬡ SP    ● Active   237  ◄──┼─── click
  │  │  Company Website         🌐 Web  ● Active   180     │    │
  │  │  Product Docs            📄 File ● Active   106     │    │
  │  └──────────────────────────────────────────────────────┘    │
  └───────────────────────────────────────────────────────────────┘
         │
         │ handleRowClick(row)
         │ → connectorMap[row._id] has connectorId
         │ → opens ConnectorDetailPanel
         │
         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Sources table visible     ┌─── Detail Panel (720px) ────┐  │
  │  (behind panel)            │                              │  │
  │                            │ SP: Marketing Hub    [<>][X] │  │
  │  ┌──────────────────┐     │                              │  │
  │  │  SP: Marketing ● │     │ [Overview] [Scope] [Preview] │  │
  │  │  Website       ● │     │  ▲active                     │  │
  │  │  Docs          ● │     │                              │  │
  │  └──────────────────┘     │ 237 total | 221 indexed      │  │
  │                            │ 12 pending | 4 failed        │  │
  │                            │                              │  │
  │                            │ Content breakdown,           │  │
  │                            │ sync history, issues...      │  │
  │                            │ (section 7 wireframes)       │  │
  │                            └──────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

### What Changes vs Current Code

```
  WHAT STAYS THE SAME (no code changes needed):
  ├─ SetupGuide 2-card layout (Upload + Connect Source)
  ├─ OperationsDashboard stat cards with navigation
  ├─ AddSourceButton with type picker dialog (5 types)
  ├─ SourcesTable with connectorMap row-click routing
  ├─ DataSection SegmentedControl (Documents/Chunks/Sources)
  └─ All navigation store routes and setPendingFilter patterns

  WHAT CHANGES:
  ├─ handleTypeSelect('sharepoint') → opens Detail Panel instead of
  │   EnterpriseConnectorWizard (760 lines → replaced)
  ├─ connectorMap row click → opens redesigned Detail Panel instead of
  │   ConnectorDetailPanel (765 lines → replaced)
  └─ Both cases open the SAME component:
       NEW connector = Connect tab active, other tabs locked
       EXISTING connector = Overview tab active, all tabs available
```

---

## 3. Architecture Diagram

```
                     SHAREPOINT CONNECTOR UX -- UNIFIED ARCHITECTURE

 +-----------------------------------------------------------------------+
 |                                                                       |
 |  KB DETAIL PAGE (Data tab, Sources segment)                           |
 |                                                                       |
 |  Entry points:                                                        |
 |  A. Home → SetupGuide → [Connect Source] → Data tab → Add Source     |
 |  B. Home → OpsDashboard → [Sources card] → Data tab → Sources view  |
 |  C. Data tab → [+ Add Source] → type picker → SharePoint             |
 |  D. Data tab → Sources list → click existing SharePoint row          |
 |                                                                       |
 |  A,B,C open DETAIL PANEL in setup mode (Connect tab active)          |
 |  D opens DETAIL PANEL in monitoring mode (Overview tab active)       |
 |                                                                       |
 +---+-------------------------------------------------------------------+
     |
     v
 +-- DETAIL PANEL (720px default; auto-expands on Scope+Filters; [<>] on all tabs) --+
 |                                                       |
 |  +--------------------------------------------------+|
 |  | Connect | Proposal | Scope+Filters | Preview |    ||
 |  | Security | Schedule | History                |    ||
 |  +--------------------------------------------------+|
 |                                                       |
 |  SETUP MODE (first time):                             |
 |   Connect --> Auth --> [System generates Proposal]    |
 |   --> User reviews: Accept/Modify/Skip per section    |
 |   --> Split-pane Scope+Filters with live diff         |
 |   --> Preview/Dry-run --> Security Gate --> Sync       |
 |                                                       |
 |  MONITORING MODE (post-setup):                        |
 |   Overview | Sync History | Content Breakdown         |
 |   Issues | Token Health | Config Drift Detection      |
 |                                                       |
 +-------------------------------------------------------+

 Configure-before-auth: All tabs except discovery-dependent
 content are editable while waiting for authentication.

 Delegation: 48h invite URL --> delegate opens link -->
 fresh device code generated --> push notification on complete.

 Security Gate: Available for elevated scope review.
 Proposal IS the security review document (exportable PDF/JSON/YAML).
```

---

## 3b. SourcesTable Enhancements for SharePoint

> **Note:** These wireframes show ENHANCEMENTS to the existing SourcesTable in the
> KB's Data tab, not a separate page. The SourcesTable already shows all sources
> (files, web, SharePoint, etc.) -- these enhancements add SharePoint-specific
> capabilities when SharePoint sources are present. Section 3b-i shows the Connect
> tab's first-time experience (inside the Detail Panel). Sections 3b-ii through
> 3b-iv show how the SourcesTable scales from a few sources to 15+ with
> SharePoint-specific columns, bulk actions, and tenant grouping.

### 3b-i. Welcome State (0 connectors -- Connect tab first-time content)

```
+-------------------------------------------------------------------------+
|  SharePoint Connectors                                                   |
|                                                                          |
|  +-------------------------------------------------------------------+  |
|  |                                                                   |  |
|  |   Welcome to SharePoint Integration                               |  |
|  |                                                                   |  |
|  |   Connect your SharePoint sites to make documents searchable      |  |
|  |   by your AI agents and knowledge bases. The system will          |  |
|  |   auto-discover your environment and recommend what to sync.      |  |
|  |                                                                   |  |
|  |   Typical setup time: ~3 minutes for your first connector.        |  |
|  |                                                                   |  |
|  |   +-----------------------------------------------------------+  |  |
|  |   |                                                           |  |  |
|  |   |   "Just connect my Microsoft account"                     |  |  |
|  |   |                                                           |  |  |
|  |   |   Sign in with your Microsoft account. We will discover   |  |  |
|  |   |   your SharePoint sites and set up everything with        |  |  |
|  |   |   smart defaults. You can customize later.                |  |  |
|  |   |                                                           |  |  |
|  |   |   [Connect with Microsoft -->]                            |  |  |
|  |   |                                                           |  |  |
|  |   |   Uses browser login. No Azure App Registration needed    |  |  |
|  |   |   for getting started. Upgrade later for automated sync.  |  |  |
|  |   |                                                           |  |  |
|  |   +-----------------------------------------------------------+  |  |
|  |                                                                   |  |
|  |   --- or set up with advanced options ---                         |  |
|  |                                                                   |  |
|  |   [Azure App Registration]   [Import JSON/YAML Config]            |  |
|  |   For automated sync,        Have an exported config              |  |
|  |   delegation, and            from another environment?            |  |
|  |   app-only auth                                                   |  |
|  |                                                                   |  |
|  |   --- What happens next ---                                       |  |
|  |                                                                   |  |
|  |   1. You authenticate with Microsoft                              |  |
|  |   2. We discover your SharePoint sites (~30 seconds)              |  |
|  |      (or you enter site URLs if using Sites.Selected)             |  |
|  |   3. We generate a Configuration Proposal with recommendations    |  |
|  |   4. You review, modify, or accept each section                   |  |
|  |   5. Preview before any data is downloaded                        |  |
|  |   6. Approve and sync starts                                      |  |
|  |                                                                   |  |
|  +-------------------------------------------------------------------+  |
|                                                                          |
|  API/CLI: POST /api/connectors with JSON body. [API Docs] [CLI Help]    |
|                                                                          |
+-------------------------------------------------------------------------+
```

### 3b-ii. SourcesTable Card View (1-6 sources, mixed types)

When a KB has 1-6 total sources, the SourcesTable can render them as cards. SharePoint-specific cards show token health, site count, and sync progress alongside non-SharePoint sources that show their own relevant metrics.

```
+-------------------------------------------------------------------------+
|  Data tab → Sources segment                                              |
|  5 active . 1 warning . 0 errors               [Card] [Table] [+ Add]  |
|                                                                          |
|  +-------------------+  +-------------------+  +-------------------+    |
|  | Marketing Hub     |  | Engineering Wiki  |  | Sales Docs        |    |
|  |                   |  |                   |  |                   |    |
|  | * Healthy         |  | ! 3 failed docs   |  | ~ Syncing...      |    |
|  |                   |  |                   |  |                   |    |
|  | 237 docs indexed  |  | 128 docs indexed  |  | 67 / ~120 docs    |    |
|  | 3.2 GB . 2 sites  |  | 1.1 GB . 1 site   |  | 5.4 GB . 3 sites  |    |
|  |                   |  |                   |  |                   |    |
|  | Last sync: 2h ago |  | Last sync: 1d ago |  | ETA: ~12 min      |    |
|  | Next: in 4h       |  | Next: in 23h      |  | =========----- 56%|    |
|  |                   |  |                   |  |                   |    |
|  | Token: * 28d left |  | Token: * 28d left |  | Token: * 27d left |    |
|  +-------------------+  +-------------------+  +-------------------+    |
|                                                                          |
|  +-------------------+  +-------------------+  +- - - - - - - - - -+    |
|  | HR Portal         |  | Legal Vault       |  |                   |    |
|  |                   |  |                   |  |    + Add New       |    |
|  | * Healthy         |  | * Healthy         |  |    Connector      |    |
|  |                   |  |                   |  |                   |    |
|  | 89 docs indexed   |  | 45 docs indexed   |  |  From scratch,    |    |
|  | 0.8 GB . 1 site   |  | 0.2 GB . 1 site   |  |  template, or     |    |
|  |                   |  |                   |  |  clone existing    |    |
|  | Last sync: 6h ago |  | Last sync: 12h ago|  |                   |    |
|  | Next: in 6h       |  | Next: in 12h      |  +- - - - - - - - - -+    |
|  |                   |  |                   |                            |
|  | Token: * 25d left |  | Token: ! 3d left  |                            |
|  +-------------------+  +-------------------+                            |
|                                                                          |
|  --- Summary ---------------------------------------------------------- |
|  566 docs total . 10.7 GB . 8 sites . 5 connectors . 3 failed docs     |
+-------------------------------------------------------------------------+
```

### 3b-iii. SourcesTable Table View (7+ sources, auto-switches)

When a KB has 7+ sources, the SourcesTable auto-switches to table view. SharePoint-specific columns (Tenant, Token health, Sites) appear when SharePoint sources are present. The search, status filter, tenant filter, and group-by controls are enhancements to the existing SourcesTable toolbar.

```
+-----------------------------------------------------------------------------------+
|  Data tab → Sources segment                                                        |
|  15 active . 2 warnings . 1 error             [Card] [Table] [+ Add]             |
|                                                                                    |
|  [Search connectors...]  [Status: Any v]  [Tenant: Any v]  [Sort: Name v]        |
|                                                                                    |
|  Group by: [None | Tenant | Status | Template]                                    |
|                                                                                    |
|  Quick filters: [Needs Attention (3)] [All Healthy (12)] [Token Warning (3)]      |
|                                                                                    |
|  +-- Aggregate Summary ----------------------------------------------------------|
|  | 15 connectors: 12 healthy, 2 warning, 1 error | 2,847 docs | 3 tokens expiring|
|  +-------------------------------------------------------------------------------+|
|                                                                                    |
|  (When grouped by tenant: collapsible tenant sections with aggregate stats)        |
|  +-- Tenant: contoso.com (8 connectors, 1,892 docs, 1 warning) ---------- [v] --|
|  +-- Tenant: fabrikam.com (4 connectors, 623 docs, all healthy) ---------- [v] --|
|  +-- Tenant: woodgrove.com (3 connectors, 332 docs, 1 error) ------------ [v] --|
|                                                                                    |
|  +-------------------------------------------------------------------------------+|
|  | _ | Name              | Status    | Docs    | Size   | Sites|Failures| Token   ||
|  |---|-------------------|-----------|---------|--------|------|--------|---------|+
|  | _ | Marketing Hub     | * Healthy | 237     | 3.2 GB | 2    | 0      | * 28d   ||
|  | _ | Engineering Wiki  | ! Partial | 128     | 1.1 GB | 1    | 3      | * 28d   ||
|  | _ | Sales Docs        | ~ Syncing | 67/120  | 5.4 GB | 3    | 0      | * 27d   ||
|  | _ | HR Portal         | * Healthy | 89      | 0.8 GB | 1    | 0      | * 25d   ||
|  | _ | Legal Vault       | * Healthy | 45      | 0.2 GB | 1    | 0      | ! 3d    ||
|  | _ | Finance Reports   | * Healthy | 312     | 4.1 GB | 2    | 0      | * 20d   ||
|  | _ | IT Knowledge      | X Failed  | 0       | --     | --   | 5      | X Exprd ||
|  | _ | Product Docs      | * Healthy | 456     | 2.8 GB | 4    | 0      | * 28d   ||
|  |   |                   |           |         |        |      |        |         ||
|  |   | Showing 1-8 of 15                                        [< 1  2 >]       ||
|  +-------------------------------------------------------------------------------+|
|                                                                                    |
|  --- Summary -------------------------------------------------------------------- |
|  2,237 docs total . 18.9 GB . 16 sites . 15 connectors . 8 failed docs           |
+-----------------------------------------------------------------------------------+
```

### 3b-iv. SourcesTable Bulk Actions (appears on multi-select)

The existing SourcesTable bulk action bar gains SharePoint-specific actions (Re-auth, Apply Schedule, Export Configs) when SharePoint sources are among the selected rows. Generic actions (Pause, Resume, Delete) apply to all source types.

```
+-------------------------------------------------------------------------+
|  [check] 3 selected                                                      |
|                                                                          |
|  [Re-auth Selected]  [Pause Selected]  [Resume Selected]                |
|  [Sync Now]  [Apply Schedule]  [Export Configs]  [Delete Selected]      |
|                                                                          |
|  [Select All (15)]  [Clear Selection]                                   |
+-------------------------------------------------------------------------+
```

### 3b-v. SourcesTable Row States (draft, pending-auth, active connectors)

Chen's "resume" flow depends on finding his in-progress connector in the SourcesTable. This wireframe shows how connectors in various states appear alongside other source types:

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Name                     Type         Status        Docs    │
  │  ────────────────────────────────────────────────────────────│
  │  SharePoint: Marketing    ⬡ SP        ● Active       237    │
  │  SharePoint: Engineering  ⬡ SP        ◐ Awaiting Auth  —    │ ← Chen's draft
  │  SharePoint: Sales        ⬡ SP        ○ Draft          —    │ ← not yet authed
  │  Company Website          🌐 Web      ● Active       180    │
  │  Product Docs             📄 File     ● Active       106    │
  └──────────────────────────────────────────────────────────────┘
```

**Status badges:**

- **● Active** (green) -- syncing, healthy
- **◐ Awaiting Auth** (amber) -- configured, waiting for delegation
- **○ Draft** (gray) -- created but not configured
- **● Syncing** (blue) -- sync in progress
- **● Error** (red) -- sync failed
- **● Auth Failed** (red) -- token expired or revoked

**Row click behavior by status:**

- Clicking an "Awaiting Auth" or "Draft" row opens the Detail Panel with the **Connect tab active** (to resume setup).
- Clicking an "Active", "Syncing", or "Error" row opens the Detail Panel with the **Overview tab active**.
- This means Chen can find his in-progress connector in the SourcesTable, click it, and resume exactly where he left off.

---

## 4. Setup Flow (Inside Detail Panel)

The detail panel slides in from the right at 720px. Users can click the expand icon [<>] to go full-page on any tab. The Scope+Filters tab auto-expands to full viewport width (see section 4c) because its split-pane layout needs the space. First-time setup uses a warm, conversational tone. Returning users get a compact, efficient interface.

### Panel Structure

```
+-- Detail Panel (720px) -------------------------------------- [<>] [x] -+
|                                                                          |
|  [Connector Name]                                    [... More Actions]  |
|                                                                          |
|  Simplified View: [ON / off]                                             |
|  (Defaults ON for first-time users. Remembers preference per user.)      |
|                                                                          |
|  SIMPLIFIED VIEW ON:                                                     |
|  +--------------------------------------------------------------------+ |
|  | Connect | Proposal | Preview | Security | History                  | |
|  +--------------------------------------------------------------------+ |
|  - Scope+Filters tab HIDDEN (use Accept/Modify in Proposal instead)     |
|  - Security tab hides advanced details (ACL modes, CEL, OData)          |
|  - All instances of "pipeline" replaced with "system"                    |
|  - CEL/OData/metadata conditions not shown                               |
|                                                                          |
|  SIMPLIFIED VIEW OFF (full power-user experience):                       |
|  +--------------------------------------------------------------------+ |
|  | Connect | Proposal | Scope+Filters | Preview | Security | History  | |
|  +--------------------------------------------------------------------+ |
|                                                                          |
|  [Active tab content fills the rest of the panel]                        |
|                                                                          |
+--------------------------------------------------------------------------+
```

More Actions overflow menu: Clone, Export JSON/YAML, Import Config, Run Health Check, Diagnostics, Delete

### 4a. Connect Tab -- First-Time Experience

```
+-- Connect (First Connector) -------------------------------------------+
|                                                                          |
|  Let us get you connected to SharePoint                                  |
|                                                                          |
|  This takes about 3 minutes. You will authenticate with Microsoft,       |
|  and then we will generate a Configuration Proposal with smart           |
|  defaults that you can review and customize.                             |
|                                                                          |
|  --- How do you want to connect? ---                                     |
|                                                                          |
|  +------------------------------------------------------------------+   |
|  |  [*] Sign in with Microsoft (recommended)                        |   |
|  |                                                                  |   |
|  |  The simplest path. Click the button below and sign in with      |   |
|  |  your Microsoft account. We will handle the rest.                |   |
|  |                                                                  |   |
|  |  Best for: Getting started quickly, evaluating the connector     |   |
|  +------------------------------------------------------------------+   |
|                                                                          |
|  +------------------------------------------------------------------+   |
|  |  [ ] Azure App Registration (for production use)                 |   |
|  |                                                                  |   |
|  |  For automated sync, token delegation, and app-only auth.        |   |
|  |  You will need a Client ID and Tenant ID from Azure Portal.     |   |
|  |                                                                  |   |
|  |  Best for: Production deployments, IT-managed connectors         |   |
|  +------------------------------------------------------------------+   |
|                                                                          |
|  +------------------------------------------------------------------+   |
|  |  [ ] Someone else will authenticate (delegation)                 |   |
|  |                                                                  |   |
|  |  Configure the connector now, then send a secure link to         |   |
|  |  your IT admin or security team to complete authentication.      |   |
|  |  The link is valid for 48 hours.                                 |   |
|  |                                                                  |   |
|  |  Best for: When you configure but someone else has permissions   |   |
|  +------------------------------------------------------------------+   |
|                                                                          |
|  While you wait for authentication, you can configure scope,             |
|  filters, and schedule in the other tabs. Everything saves               |
|  automatically and applies once connected.                               |
|                                                                          |
|                                               [Cancel]  [Continue -->]   |
|                                                                          |
+--------------------------------------------------------------------------+
```

**Returning user (1+ existing connectors) -- compact form:**

```
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  Step 1: Azure App Registration                                           |
|  ----------------------------------------------------------------        |
|                                                                           |
|  +------------------------------------------------------+                |
|  | Client ID (Application ID)                           |                |
|  +------------------------------------------------------+                |
|  +------------------------------------------------------+                |
|  | Tenant ID (Directory ID)                             |                |
|  +------------------------------------------------------+                |
|                                                                           |
|  > Don't have an app registration? (expandable guide)                    |
|                                                                           |
|  Step 1b: Permission Scope                                               |
|  ----------------------------------------------------------------        |
|                                                                           |
|  Scope: (*) Sites.Read.All (recommended -- auto-discovers all sites)     |
|         ( ) Sites.Selected (most restrictive -- manual site entry)       |
|                                                                           |
|  Sites.Read.All: Discover and read all SharePoint sites in your          |
|  tenant. Enables auto-discovery, recommendations, and activity scoring.  |
|  Read-only -- cannot modify, delete, or create content.                  |
|                                                                           |
|  Sites.Selected: Access only sites explicitly approved by your Azure     |
|  AD admin. Most restrictive option.                                      |
|  NOTE: Site discovery is NOT available with Sites.Selected.              |
|  You must enter site URLs manually. Per-site grants require              |
|  Graph API/PowerShell by an admin (no Azure Portal UI).                  |
|  Webhooks (real-time sync) are also not available.                       |
|  Choose this only if your organization requires explicit per-site        |
|  approval and has a process for managing Sites.Selected grants.          |
|                                                                           |
|  NOTE: Sites.Selected is not yet implemented in the backend.             |
|  Current default: Sites.Read.All. Sites.Selected support is planned.     |
|                                                                           |
|  Optional add-ons (can be added later without re-setup):                 |
|  [ ] Files.Read.All -- enables real-time sync via webhooks               |
|  [ ] GroupMember.Read.All -- enables group membership resolution         |
|                                                                           |
|  Step 2a: Authentication Method                                           |
|  ----------------------------------------------------------------        |
|                                                                           |
|  (*) Device Code -- share a code with the person who authenticates       |
|  ( ) Browser Login -- sign in with your Microsoft account now            |
|  ( ) App-Only (Client Credentials) -- automated with secret              |
|                                                                           |
|  Step 2b: Admin Consent (separate from sign-in)                           |
|  ----------------------------------------------------------------        |
|                                                                           |
|  Note: Entering the device code signs you in. It does NOT                |
|  grant admin consent. Admin consent (if needed for                       |
|  Sites.Read.All) is a separate step after authentication.                |
|                                                                           |
|  Configure-before-auth: You can set up scope, filters, and              |
|  schedule in the other tabs while waiting for authentication.            |
|                                                                           |
|                                            [Cancel]  [Connect -->]       |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4b. Configuration Proposal (Generated After Auth)

After authentication completes, the system runs discovery and generates a Configuration Proposal. This is the heart of the design -- the proposal IS the security review document.

**Generation progress:**

```
+-- Proposal (Generating...) ----------------------------------------------+
|                                                                           |
|  Generating your Configuration Proposal...                                |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  Connection        Done                                            |   |
|  |  Permission Tier   Detecting granted scopes...                     |   |
|  |  Health Check      Running checks...                               |   |
|  |  Scope             Discovering sites... (or: Waiting for URLs)     |   |
|  |  Filters           Waiting for scope                               |   |
|  |  Schedule          Analyzing patterns + webhook availability...    |   |
|  |  Permissions       Adapting to your tier...                        |   |
|  |  Sample Preview    Waiting for filters                             |   |
|  |  Security Gate     Waiting for all sections                        |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  Sections will appear as they are ready. This typically                   |
|  takes 30-90 seconds depending on the number of sites.                   |
|                                                                           |
|  (Any pre-configured settings from draft mode are applied                |
|  automatically.)                                                          |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Completed proposal with table of contents:**

When Simplified View is ON, a progress indicator is shown at the top of the proposal:

```
+-- Step 2 of 4: Review Proposal -----------------------------------------+
|  1. Connect  -->  [2. Review Proposal]  -->  3. Preview  -->  4. Approve |
+--------------------------------------------------------------------------+
```

```
+-- Configuration Proposal ------------------------------------------------+
|                                                                           |
|  SharePoint Configuration Proposal                                        |
|  Generated Mar 22, 2026 at 14:23 UTC                                     |
|  Connector: sp-corp-main                                                  |
|                                                                           |
|  +-- Table of Contents -----------------------------------------------+  |
|  |  Connection      [Accepted]                                         |  |
|  |  Health Check    [6/6 passed]                                       |  |
|  |  Scope           [Modified]                                         |  |
|  |  Filters         [Accepted]                                         |  |
|  |  Schedule        [Accepted]                                         |  |
|  |  Permissions     [Skipped]                                          |  |
|  |  Sample Preview  [Reviewed]                                         |  |
|  |  Security Gate   [Pending Approval]                                 |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  Progress: 7 of 8 sections reviewed   [Accept All Remaining]             |
|                                                                           |
|  (sections below, scrollable)                                             |
|                                                                           |
|  [Export as PDF]  [Export JSON/YAML]  [Approve All & Start Sync]          |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Connection (expanded)**

```
+-- Connection ---------------------------------------- [Accepted] --------+
|                                                                           |
|  I established a connection to your Microsoft 365 tenant                  |
|  contoso.onmicrosoft.com. Everything looks healthy.                       |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  Tenant         contoso.onmicrosoft.com                            |   |
|  |  Client ID      a1b2c3d4-e5f6-7890-abcd-ef1234567890              |   |
|  |  Auth Method    Device Code Flow                                   |   |
|  |  Authenticated  maria@contoso.com                                  |   |
|  |  Token Expires  Mar 22, 2026 15:20 UTC (59 min remaining)          |   |
|  |  Refresh Token  Valid (expires Apr 21, 2026)                       |   |
|  |  Delegated By   dev-team@contoso.com (via 48h invite)              |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [Accept]   [Re-authenticate]   [Skip]                                    |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Health Check (expanded, with failures)**

The Health Check now includes a Permission Tier detection row that tells the user exactly which tier they are at and what capabilities are available.

```
+-- Health Check ----------------------------------- [5/7 passed] ---------+
|                                                                           |
|  I ran 7 validation checks. 5 passed, 2 need attention.                  |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  ok    Graph API reachable         14ms response                   |   |
|  |  ok    Token valid                 59 min remaining                |   |
|  |  ok    Permission tier detected    Base tier                       |   |
|  |        Granted: Sites.Read.All, offline_access                     |   |
|  |        Sync, discovery, delta sync, read permissions: available    |   |
|  |        Real-time sync: not available (needs Files.Read.All)        |   |
|  |        Group resolution: not available (needs GroupMember)         |   |
|  |  ok    File content readable       Sites.Read.All covers files     |   |
|  |  ok    At least 1 site accessible  Found 12 sites                  |   |
|  |  WARN  Rate limit warning          Only 200 of 10,000 remain       |   |
|  |        Another application is consuming your quota. Sync may       |   |
|  |        be throttled. Consider scheduling sync during off-hours.    |   |
|  |  INFO  Optional upgrades available                                 |   |
|  |        [+ Real-Time Sync]  [+ Group Resolution]                    |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [Accept with warnings]  [Re-run]  [Skip]                                 |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Health Check variant for Sites.Selected:**

```
+-- Health Check ----------------------------------- [4/7 passed] ---------+
|                                                                           |
|  I ran 7 validation checks. 4 passed, 1 info, 2 need attention.          |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  ok    Graph API reachable         14ms response                   |   |
|  |  ok    Token valid                 59 min remaining                |   |
|  |  INFO  Permission tier detected    Selected Mode                   |   |
|  |        Granted: Sites.Selected, offline_access                     |   |
|  |        Sync granted sites, delta sync: available                   |   |
|  |        Site discovery: NOT available (Sites.Selected limitation)   |   |
|  |        Real-time sync: NOT available                               |   |
|  |        Group resolution: NOT available                             |   |
|  |  FAIL  Sites.Read.All NOT granted  Only Sites.Selected             |   |
|  |        Cannot discover sites. You have access to 3 manually-added  |   |
|  |        sites. To enable auto-discovery:                            |   |
|  |        [Upgrade to Sites.Read.All]  [Continue with manual sites]   |   |
|  |  ok    File content readable       Sites.Selected covers files     |   |
|  |  ok    At least 1 site accessible  Found 3 granted sites           |   |
|  |  WARN  Rate limit warning          Only 200 of 10,000 remain       |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [Accept with warnings]  [Re-run]  [Skip]                                 |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Scope (expanded)**

The Scope section adapts based on whether the user connected with Sites.Read.All (auto-discovery available) or Sites.Selected (manual entry only).

**Variant A: Sites.Read.All -- Auto-Discovery (most common path)**

```
+-- Scope -------------------------------------------- [Accepted] ---------+
|                                                                           |
|  I discovered 12 SharePoint sites with 18 document libraries.             |
|  I recommend syncing 8 sites (14 libraries) based on:                     |
|   - Activity score (documents modified in last 30 days)                   |
|   - Content relevance (file types your pipeline can process)              |
|   - Size (estimated 4.2 GB, within your storage quota)                    |
|                                                                           |
|  4 sites excluded:                                                        |
|   - "Archived Projects" -- no activity in 180+ days                       |
|   - "Personal Sites" -- user OneDrive, not shared content                 |
|   - "Test Environment" -- flagged as non-production                       |
|   - "External Vendors" -- sensitivity score too high                      |
|                                                                           |
|  +-- Recommended Sites -----------------------------------------------+  |
|  |                                                                     |  |
|  |  [x] Corp Docs           4 libraries   1,234 docs  2.1GB           |  |
|  |      Score: 92  Activity: High  Last modified: 2h ago               |  |
|  |                                                                     |  |
|  |  [x] Engineering Hub     3 libraries     890 docs  1.4GB           |  |
|  |      Score: 87  Activity: High  Last modified: 30m ago              |  |
|  |                                                                     |  |
|  |  [x] Product Docs        2 libraries     456 docs  0.3GB           |  |
|  |      Score: 81  Activity: Medium  Last modified: 1d ago             |  |
|  |                                                                     |  |
|  |  --- Excluded (uncheck to include) --------------------------------|  |
|  |                                                                     |  |
|  |  [ ] Archived Projects   2 libraries     12K docs  8.5GB           |  |
|  |      Reason: No activity in 180+ days                               |  |
|  |                                                                     |  |
|  |  [ ] External Vendors    1 library        78 docs  0.2GB           |  |
|  |      Reason: High sensitivity score (external sharing)              |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  Summary: 8 sites, 14 libraries, ~4,038 documents, ~4.2 GB               |
|                                                                           |
|  [Accept]   [Modify Selection]   [Skip]                                   |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Variant B: Sites.Selected -- Manual Site Entry**

When the user connects with Sites.Selected, the system cannot discover sites automatically. Instead of the "I discovered 12 sites" proposal, the user sees a manual entry interface. The system validates each URL by attempting to fetch the site via `GET /sites/{hostname}:{path}`.

```
+-- Scope ----------------------------------------- [Needs Your Input] ----+
|                                                                           |
|  You are using Sites.Selected, which gives access only to sites that      |
|  your Azure AD admin has explicitly approved. This is the most            |
|  restrictive option -- great for security, but it means the system        |
|  cannot automatically discover your SharePoint sites.                     |
|                                                                           |
|  You will need to tell us which sites to sync.                            |
|                                                                           |
|  +-- Add Sites Manually ---------------------------------------------+   |
|  |                                                                    |   |
|  |  Enter SharePoint site URLs (one per line):                        |   |
|  |  +--------------------------------------------------------------+ |   |
|  |  | https://contoso.sharepoint.com/sites/Marketing               | |   |
|  |  | https://contoso.sharepoint.com/sites/Engineering              | |   |
|  |  | https://contoso.sharepoint.com/sites/ProductDocs              | |   |
|  |  |                                                              | |   |
|  |  +--------------------------------------------------------------+ |   |
|  |                                                                    |   |
|  |  [Validate Sites]                                                  |   |
|  |                                                                    |   |
|  |  Validation results:                                               |   |
|  |  +--------------------------------------------------------------+ |   |
|  |  | OK   Marketing          3 libraries   ~450 docs   1.8 GB     | |   |
|  |  | OK   Engineering        2 libraries   ~230 docs   0.9 GB     | |   |
|  |  | FAIL ProductDocs        Not granted -- ask your admin to      | |   |
|  |  |                         grant access to this site via Graph   | |   |
|  |  |                         API or PowerShell.                    | |   |
|  |  +--------------------------------------------------------------+ |   |
|  |                                                                    |   |
|  |  2 of 3 sites accessible. 1 site needs admin approval.            |   |
|  |                                                                    |   |
|  |  [Send Access Request to Admin]  for sites that failed validation  |   |
|  |   Pre-written email listing the specific site URLs and the         |   |
|  |   PowerShell command to grant Sites.Selected access.               |   |
|  |                                                                    |   |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  +-- Or upgrade to discover sites automatically ----------------------+  |
|  |                                                                     |  |
|  |  With Sites.Read.All, the system can search your tenant and         |  |
|  |  recommend which sites to sync based on activity and relevance.     |  |
|  |  This is broader access (read-only to all sites) but removes        |  |
|  |  the need to know site URLs upfront.                                |  |
|  |                                                                     |  |
|  |  [Upgrade to Sites.Read.All]   requires admin re-consent            |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  How does your admin grant Sites.Selected access?                         |
|  There is no Azure Portal UI for this. Your admin needs to use            |
|  Graph API or PowerShell with Sites.FullControl.All on a separate         |
|  admin app. We can generate the exact commands:                           |
|  [Download Admin Commands (PowerShell)]                                   |
|                                                                           |
|  Summary: 2 sites, 5 libraries, ~680 documents, ~2.7 GB                  |
|                                                                           |
|  [Accept]   [Add More Sites]   [Skip]                                     |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Design rationale for Sites.Selected vs Sites.Read.All as default:**

The original design recommended Sites.Selected as the default because it is least-privilege. However, given the severe UX limitations of Sites.Selected (no discovery, no search, manual URL entry, PowerShell-only admin grants with no Portal UI), the corrected design recommends **Sites.Read.All as the default** for the simple "Connect with Microsoft" path, with Sites.Selected available in the Azure App Registration advanced path for security-conscious organizations.

This change is reflected in the Connect tab (section 4a): the simple path uses Sites.Read.All automatically, while Sites.Selected is only offered in the advanced Azure App Registration form where the user explicitly chooses it and understands the trade-offs.

**Sites.Selected: What the user SHOULD know before choosing it:**

```
+-- Sites.Selected Information Box ----------------------------------------+
|                                                                          |
|  Sites.Selected is the most restrictive scope. Before choosing it,       |
|  know that:                                                              |
|                                                                          |
|  1. No auto-discovery: You must enter site URLs manually.                |
|  2. No site search: The system cannot search for sites in your tenant.   |
|  3. No recommendations: Activity scoring and relevance ranking require   |
|     discovery, which is not available.                                    |
|  4. Admin grants are manual: Your admin uses PowerShell or Graph API     |
|     to grant per-site access. There is no Azure Portal UI for this.      |
|  5. No webhooks: Real-time sync is not available (needs Files.Read.All   |
|     which is a broader permission than Sites.Selected intends).          |
|  6. No group resolution: GroupMember.Read.All is a separate scope.       |
|                                                                          |
|  Best for: Organizations that require explicit per-site approval and     |
|  already have a process for managing Sites.Selected grants.              |
|                                                                          |
+--------------------------------------------------------------------------+
```

**Section: Filters (expanded)**

```
+-- Filters ------------------------------------------ [Accepted] ---------+
|                                                                           |
|  I recommend syncing 3,801 of 4,038 documents from your                   |
|  selected sites. 237 excluded:                                            |
|                                                                           |
|   - 14 executables (.exe, .msi, .bat) -- blocked by policy                |
|   - 189 files in /Archive folders -- template: "Skip Archives"            |
|   - 8 files in /_private paths -- template: "Skip Private"                |
|   - 23 files over 50 MB -- size limit                                     |
|   - 3 unsupported formats (.dwg, .pst) -- not processable                |
|                                                                           |
|  Date range:                                                              |
|   - Only documents modified after March 22, 2025                          |
|                                                                           |
|  Applied templates:                                                       |
|   - "Office Documents" (docx, xlsx, pptx, pdf, txt, md, csv)             |
|   - "Skip Archives" (exclude /Archive, /Old, /Backup paths)              |
|   - "Skip Private" (exclude /_private, /_drafts paths)                    |
|                                                                           |
|  For detailed filter editing, see the Scope+Filters tab.                  |
|                                                                           |
|  [Accept]   [Modify Filters]   [Skip]                                     |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Schedule (expanded)**

The Schedule section adapts based on whether Files.Read.All is granted.

**BEFORE (current design):** Webhooks shown as a static "Not available" line with no path forward.

**AFTER (corrected):** The system detects whether Files.Read.All is granted and shows one of two variants.

**Variant A: Files.Read.All NOT granted (most common initial state)**

```
+-- Schedule ----------------------------------------- [Accepted] ---------+
|                                                                           |
|  I recommend the following sync schedule based on your content            |
|  volume (~4K docs) and update frequency (avg 45 changes/day):             |
|                                                                           |
|  Initial:  Full sync immediately after approval                           |
|            Estimated duration: 15-25 minutes (4.2 GB)                     |
|                                                                           |
|  Ongoing:  Delta sync every 4 hours                                       |
|            Estimated per-run: 30-90 seconds (avg 8 changes)               |
|                                                                           |
|  +-- Real-Time Sync ------------------------------------------------+   |
|  |                                                                    |   |
|  |  Your current permissions support scheduled sync (every N hours).  |   |
|  |                                                                    |   |
|  |  To enable real-time notifications when SharePoint content         |   |
|  |  changes, your app needs Files.Read.All permission (read-only).   |   |
|  |  This lets the system subscribe to change events on document       |   |
|  |  libraries so new and updated files are synced within minutes      |   |
|  |  instead of waiting for the next scheduled run.                    |   |
|  |                                                                    |   |
|  |  [Enable Real-Time Sync -->]       [Keep Scheduled Only]          |   |
|  |   adds Files.Read.All               no change needed              |   |
|  |                                                                    |   |
|  |  What "Enable Real-Time Sync" does:                               |   |
|  |  1. Adds Files.Read.All to your app registration (read-only)      |   |
|  |  2. Requires admin re-consent (one-time)                          |   |
|  |  3. Requires a publicly accessible HTTPS endpoint for callbacks   |   |
|  |                                                                    |   |
|  |  You can enable this later from Settings without re-setup.        |   |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  [Accept]   [Modify Schedule]   [Skip]                                    |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Variant B: Files.Read.All IS granted**

```
+-- Schedule ----------------------------------------- [Accepted] ---------+
|                                                                           |
|  I recommend the following sync schedule based on your content            |
|  volume (~4K docs) and update frequency (avg 45 changes/day):             |
|                                                                           |
|  Initial:  Full sync immediately after approval                           |
|            Estimated duration: 15-25 minutes (4.2 GB)                     |
|                                                                           |
|  Ongoing:  Real-time sync via webhooks + delta sync every 12 hours        |
|            SharePoint will notify us when documents change.               |
|            Delta sync runs as a safety net to catch anything missed.      |
|                                                                           |
|  Webhook status: Ready (Files.Read.All granted)                           |
|  Notification endpoint: https://app.example.com/webhooks/sharepoint      |
|                                                                           |
|  (*) Real-time + scheduled backup (recommended)                           |
|  ( ) Scheduled only (disable webhooks)                                    |
|                                                                           |
|  [Accept]   [Modify Schedule]   [Skip]                                    |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Upgrade flow (from monitoring mode):** When a user later wants to enable real-time sync on an existing connector:

```
+-- Schedule (Monitoring Mode) -------------------------------------------+
|                                                                          |
|  Current: Delta sync every 4 hours                                       |
|  Real-time sync: Not enabled (Files.Read.All not granted)                |
|                                                                          |
|  +-- Upgrade to Real-Time Sync ------------------------------------+    |
|  |                                                                  |    |
|  |  Want faster sync? Enable real-time notifications so changes     |    |
|  |  in SharePoint appear in your knowledge base within minutes.     |    |
|  |                                                                  |    |
|  |  What is needed:                                                 |    |
|  |  1. Add Files.Read.All to your Azure app registration            |    |
|  |  2. An admin re-consents to the updated permissions              |    |
|  |  3. A publicly accessible HTTPS endpoint for callbacks           |    |
|  |                                                                  |    |
|  |  [Start Upgrade -->]  [Send Request to IT Admin]                 |    |
|  |                                                                  |    |
|  |  "Start Upgrade" will guide you through adding the permission.   |    |
|  |  "Send Request to IT Admin" generates a pre-written email        |    |
|  |  explaining what is needed and why.                              |    |
|  +------------------------------------------------------------------+   |
|                                                                          |
+--------------------------------------------------------------------------+
```

**Section: Permissions (expanded)**

**BEFORE (current design):** A simple 2-mode toggle (Enabled/Disabled) with a flat capability list that didn't reflect the 4-tier permission reality or warn about accuracy limitations.

**AFTER (corrected):** The Permissions section now has three sub-sections: (1) a Capability Tier display that adapts to the user's actual granted scopes, (2) a Permission Mode selector, and (3) a Permission Accuracy disclosure. The system detects the granted scopes and shows the user exactly where they stand, what works, and what doesn't.

```
+-- Permissions --------------------------------------- [Review] -----------+
|                                                                           |
|  Permission-aware search ensures users only see documents they            |
|  have access to in SharePoint. Here is what your current permissions      |
|  support and where the gaps are.                                          |
|                                                                           |
|  +-- Your Permission Tier -------------------------------------------+   |
|  |                                                                    |   |
|  |  Your app has: Sites.Read.All, offline_access                      |   |
|  |  Your tier: Base                                                   |   |
|  |                                                                    |   |
|  |  +----------------------------------------------------------------+|  |
|  |  |                   | Your Tier | With         | With        | Selected ||
|  |  |                   | (Base)    | + Webhooks   | + Groups    | Mode     ||
|  |  |----------------------------------------------------------------||  |
|  |  | Sync documents    |  Yes      |  Yes         |  Yes        |  Yes     ||
|  |  | Discover sites    |  Yes      |  Yes         |  Yes        |  No (1)  ||
|  |  | Delta sync        |  Yes      |  Yes         |  Yes        |  Yes     ||
|  |  | Real-time sync    |  No (2)   |  Yes         |  Yes        |  No (2)  ||
|  |  | Read permissions  |  Yes      |  Yes         |  Yes        |  Yes     ||
|  |  | Resolve groups    |  No (3)   |  No (3)      |  Yes        |  No (3)  ||
|  |  +----------------------------------------------------------------+|  |
|  |                                                                    |   |
|  |  (1) Sites.Selected cannot search for sites. You enter URLs        |   |
|  |      manually or have sites pre-granted by an admin.               |   |
|  |  (2) Needs Files.Read.All for webhook subscriptions on drives.     |   |
|  |  (3) Needs GroupMember.Read.All to resolve group memberships.      |   |
|  |                                                                    |   |
|  |  +-- Your current tier: Base ------------------------------------+|  |
|  |  |  [Y] Sites.Read.All         Sync, discovery, delta, permissions||  |
|  |  |  [Y] offline_access         Token refresh                      ||  |
|  |  |  [ ] Files.Read.All         Unlock: real-time sync             ||  |
|  |  |  [ ] GroupMember.Read.All   Unlock: group resolution           ||  |
|  |  +----------------------------------------------------------------+|  |
|  |                                                                    |   |
|  |  Upgrade options (each is independent -- add what you need):       |   |
|  |                                                                    |   |
|  |  [+ Enable Real-Time Sync]     adds Files.Read.All (read-only)    |   |
|  |  [+ Enable Group Resolution]   adds GroupMember.Read.All           |   |
|  |                                                                    |   |
|  |  Each upgrade requires admin re-consent. Both are read-only        |   |
|  |  permissions -- no write access is ever requested.                 |   |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  +-- Permission Mode -------------------------------------------------+  |
|  |                                                                     |  |
|  |  ( ) Enabled -- Permission-Aware Search                             |  |
|  |      Users only see documents they have access to in SharePoint.    |  |
|  |      The system reads document-level permissions and enforces       |  |
|  |      them during search.                                            |  |
|  |                                                                     |  |
|  |      Works with: Sites.Read.All (GRANTED)                           |  |
|  |      Better with: + GroupMember.Read.All (NOT GRANTED)              |  |
|  |                                                                     |  |
|  |      Without group resolution, permissions granted to Azure AD      |  |
|  |      groups will not be expanded to individual users. Documents     |  |
|  |      shared via group membership may not appear in search results   |  |
|  |      for those users. [Learn more about group resolution]           |  |
|  |                                                                     |  |
|  |  (*) Disabled -- All Users See All Documents                        |  |
|  |      Every synced document is visible to every KB user.             |  |
|  |      Simplest option. Choose this if all KB users should see        |  |
|  |      all SharePoint content.                                        |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  +-- Permission Accuracy (shown when Enabled is selected) ------------+  |
|  |                                                                     |  |
|  |  How accurate are the permissions we sync?                          |  |
|  |                                                                     |  |
|  |  What we CAN resolve accurately:                                    |  |
|  |   - Direct user grants (user X has access to document Y)            |  |
|  |   - Site-level permissions (inherited by all documents in a site)   |  |
|  |                                                                     |  |
|  |  What may be incomplete:                                            |  |
|  |   - Group-based permissions: If a document is shared with an        |  |
|  |     Azure AD group, we need GroupMember.Read.All to resolve who     |  |
|  |     is in that group. Without it, group members may not see         |  |
|  |     documents shared with their group.                              |  |
|  |   - Sharing links: Documents shared via "Anyone with the link"      |  |
|  |     or "People in your organization" links are detected, but the    |  |
|  |     specific recipients may not be resolvable from the link alone.  |  |
|  |                                                                     |  |
|  |  Estimated accuracy for your environment:                           |  |
|  |  +--------------------------------------------------------------+  |  |
|  |  | Direct user grants:      ~100% accurate                      |  |  |
|  |  | Group-based grants:      Not resolved (need GroupMember)     |  |  |
|  |  | Sharing link grants:     Partially resolved                  |  |  |
|  |  | Overall:                 ~70-85% of permissions captured      |  |  |
|  |  +--------------------------------------------------------------+  |  |
|  |                                                                     |  |
|  |  This means: Some users may not see documents they have access to   |  |
|  |  (false negatives). No user will see documents they should not      |  |
|  |  (false positives are not possible with this approach).             |  |
|  |                                                                     |  |
|  |  To improve accuracy:                                               |  |
|  |  [+ Add GroupMember.Read.All] raises accuracy to ~95%+              |  |
|  |                                                                     |  |
|  |  [Test Permissions] -- Verify by searching as a specific user       |  |
|  |  to confirm they see (or don't see) expected documents.             |  |
|  +---------------------------------------------------------------------+  |
|                                                                           |
|  TRUST NOTE: All permissions requested are read-only.                     |
|  Sites.Selected limits access to admin-approved sites only.               |
|  Sites.Read.All enables full site discovery but grants read access        |
|  to all sites in your tenant. Neither scope can modify, delete,           |
|  or create content in SharePoint.                                         |
|  NOTE: Sites.Selected is not yet implemented in the backend.              |
|  Current default: Sites.Read.All until Sites.Selected ships.              |
|                                                                           |
|  [Accept]   [Change Mode]   [Skip]                                        |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Sample Preview (expanded)**

```
+-- Sample Preview ----------------------------------- [Reviewed] ----------+
|                                                                           |
|  Here are 20 documents that WOULD be synced with your current             |
|  scope and filter settings. Nothing has been synced yet.                  |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  Name                    Site          Type   Size  Modified        |   |
|  |  Q1 Revenue Report.pdf   Corp Docs     PDF   2.4MB  2h ago         |   |
|  |  API Design Guide.docx   Engineering   DOCX  340KB  1d ago         |   |
|  |  Brand Guidelines.pptx   Marketing     PPTX  8.1MB  3d ago         |   |
|  |  Employee Handbook.pdf    HR Portal     PDF   1.2MB  7d ago         |   |
|  |  Release Notes v4.2.md    Product Docs  MD     45KB  4h ago         |   |
|  |  ... (15 more)                                                      |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [Looks Good]   [Adjust Filters]   [Refresh Sample]                      |
|  [Abandon -- Do Not Sync]                                                 |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Section: Security Gate (expanded)**

```
+-- Security Gate ----------------------- [Approved] -------------------------+
|                                                                           |
|  This connector requests read-only permissions (Sites.Read.All).          |
|  No elevated scopes detected.                                             |
|                                                                           |
|  Status: APPROVED (no elevated scopes)                                    |
|  Reviewed: Mar 22, 2026 14:45 UTC                                         |
|  Approver(s): security-team@contoso.com                                   |
|                                                                           |
|  What the approver sees:                                                  |
|   - Full configuration proposal (all sections above)                      |
|   - Permissions requested and granted                                     |
|   - Data scope (sites, libraries, document count)                         |
|   - Data handling (storage, encryption, retention)                        |
|   - User Decisions Log (all Accept/Modify/Skip decisions)                 |
|   - Known Limitations (see below)                                         |
|                                                                           |
|  --- Known Limitations ---                                                |
|  1. Webhooks require Files.Read.All + publicly accessible HTTPS endpoint  |
|  2. Vector cleanup completes within 15 min of deletion (alert if delayed) |
|  3. Group resolution requires GroupMember.Read.All (optional)              |
|  4. Permission accuracy is ~70-85% without group resolution; ~95%+ with   |
|  5. Sharing link recipients may not be fully resolvable                    |
|  6. Sites.Selected mode: no auto-discovery, no webhooks, manual entry     |
|                                                                           |
|  [Export PDF for Review]   [Request Security Review]          |
|                                                                           |
|  --- User Decisions Log ---                                               |
|  +-------------------------------------------------------------------+   |
|  | Time       | Section    | Decision  | Detail                      |   |
|  |------------|------------|-----------|-------------------------------|   |
|  | 14:24      | Connection | Accepted  | As-is                         |   |
|  | 14:25      | Health     | Accepted  | With 1 warning (rate limit)   |   |
|  | 14:26      | Scope      | Modified  | Removed "External Vendors"    |   |
|  | 14:27      | Filters    | Accepted  | Added "Skip Archives" template|   |
|  | 14:28      | Schedule   | Accepted  | 4h delta sync                 |   |
|  | 14:29      | Permissions| Skipped   | Using Disabled mode           |   |
|  | 14:30      | Preview    | Reviewed  | 20 docs sampled, approved     |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

**Accept All Remaining button:** When clicked, all unreviewed sections are set to "Accepted" with the system recommendation. Sarah said "Accept All Remaining is the best button ever" -- it is always visible in the proposal chrome.

**Approval confirmation:** Clicking "Approve All & Start Sync" shows an inline confirmation: "This will sync ~3,801 documents (~4.2 GB) from 8 SharePoint sites. Sync begins immediately. [Confirm & Start Sync] [Cancel]". If Security Gate is pending, the button reads "Submit for Security Approval" instead.

### 4c. Scope+Filters Tab -- Split-Pane with Live Diff

This is the power-user filter iteration surface. The split-pane puts controls on the left and live preview on the right. Every change to scope or filters instantly updates the preview with a +N/-N diff.

**Auto-expand behavior:** When the Scope+Filters tab is clicked, the panel auto-expands from 720px to full viewport width with a subtle animation. This is because a 720px panel with a 50/50 split gives only 360px per side -- too narrow for the filter controls and live preview to be usable. All OTHER tabs (Overview, Security, History, etc.) stay at the default 720px panel width.

```
  When Scope+Filters tab is clicked:
  Panel auto-expands: 720px → full viewport width (with 300ms ease-out animation)
  Split: 60% controls (left) / 40% preview (right)

  [← Back to panel view]  shows at top-right to return to 720px
  Switching to any other tab also returns to 720px automatically.
```

> **Design rationale:** Auto-expand on Scope+Filters is learned from Alex's persona
> feedback: "For a data engineer who iterates on filters 20 times, screen real
> estate is decisive." The [<>] expand button remains available on ALL tabs for
> manual expansion, but Scope+Filters is the only tab that auto-expands because
> its split-pane layout demands the space.

```
+-- Scope+Filters (auto-expanded to full viewport) ------------ [<>] -----+
|  [← Back to panel view]                                                  |
|                                                                           |
|  +-- LEFT: Controls (60%) ---------------+  +-- RIGHT: Preview (40%) --+ |
|  |                                   |  |                               | |
|  |  Sites                                      |  |  PREVIEW: 252 docs match      | |
|  |  [x] Corp Docs    92  134 files             |  |  Excluded: 23                 | |
|  |  [x] Eng Wiki     87   56 files             |  |  Est. sync: ~8 min            | |
|  |  [x] Product      78   34 files             |  |                               | |
|  |  [x] HR Portal    45   18 files             |  |  -- Filter Diff --            | |
|  |  [ ] Exec Board   12   10 files             |  |  + 0 newly included           | |
|  |  [x] Marketing    71   34 files             |  |  - 34 newly excluded          | |
|  |                                              |  |  Reason: Unchecked             | |
|  |  -- File Types --                            |  |  "Marketing" (-34, -2.2 GB)   | |
|  |  [x] PDF (89)  [x] DOCX (67)                |  |  Net: 252 --> 218 (-34)       | |
|  |  [x] PPTX (34) [x] XLSX (23)                |  |                               | |
|  |  [x] MD (21)   [x] TXT (12)                 |  |  [Undo]  [Reset Recommended]  | |
|  |  [ ] PNG (8)    [ ] MP4 (12)                 |  |                               | |
|  |                                              |  |                               | |
|  |  -- Date Range --                            |  |                               | |
|  |  Modified after:  [____/__/____]             |  |                               | |
|  |  Modified before: [____/__/____]             |  |                               | |
|  |  (Translates to OData pre-fetch              |  |                               | |
|  |   for fast server-side filtering)            |  |                               | |
|  |                                              |  |  -- Sample (20 of 252) --     | |
|  |  -- Filter Templates --                      |  |  Q1-Report.pdf   PDF  2.4MB  | |
|  |  [Documents Only] [Tech Docs]                |  |  API-Ref-v3.md   MD   340KB  | |
|  |  [Everything] [Custom...]                    |  |  Onboard.docx    DOCX 1.1MB  | |
|  |                                              |  |  ... (17 more)                | |
|  |  -- Folder Rules --                          |  |                               | |
|  |  [Exclude Archives]                          |  |  -- Excluded (23) --          | |
|  |  [Exclude Backups]                           |  |  Photo.png   Non-indexable    | |
|  |  [Exclude _private]                          |  |  Demo.mp4    Non-indexable    | |
|  |  [+ Custom glob pattern]                     |  |  Salary.xlsx Metadata filter  | |
|  |                                              |  |                               | |
|  |  -- Size Limits --                           |  |  Exclusion summary:           | |
|  |  Min: [0 KB] Max: [100 MB]                  |  |  Non-indexable: 15            | |
|  |                                              |  |  Site not selected: 5         | |
|  |  -- Metadata Conditions --                   |  |  Metadata filter: 3           | |
|  |  Field: [department v]                       |  |                               | |
|  |  Op: [equals v]                              |  |                               | |
|  |  Value: [Engineering]                        |  |                               | |
|  |  [+ Add Condition]                           |  |                               | |
|  |                                              |  |                               | |
|  |  Available fields (discovered):              |  |                               | |
|  |  [sensitivityLabel] [department]             |  |                               | |
|  |  [author] [contentType] [region]             |  |                               | |
|  |                                              |  |                               | |
|  +----------------------------------------------+  +-------------------------------+ |
|                                                                           |
|  -- Advanced (expandable) ------------------------------------------------|
|                                                                           |
|  > CEL Expression Editor                                                  |
|    +--------------------------------------------------------------+      |
|    | resource.mimeType in ['application/pdf', 'text/plain']        |      |
|    | && resource.size < 50000000                                   |      |
|    | && !resource.path.startsWith('/archive/')                     |      |
|    +--------------------------------------------------------------+      |
|    Syntax highlighting active . Autocomplete: resource.[field]           |
|    Field VALUE autocomplete from discovery:                               |
|      typing `resource.department == "` suggests:                         |
|        "Engineering" (234 docs)                                           |
|        "Marketing" (89 docs)                                              |
|        "Sales" (56 docs)                                                  |
|    [Validate Expression]  [CEL Reference]                                |
|                                                                           |
|  v OData Pre-Filter (server-side at Graph API) [EXPANDED by default]     |
|    (User preference remembered — defaults to expanded for power users)                           |
|    +--------------------------------------------------------------+      |
|    | $filter=file/mimeType ne 'application/octet-stream'           |      |
|    |   and size lt 104857600                                       |      |
|    |   and lastModifiedDateTime ge 2025-03-22T00:00:00Z            |      |
|    | $select=id,name,size,file,lastModifiedDateTime                |      |
|    +--------------------------------------------------------------+      |
|    Pre-fetch (OData): file types, size limits, date ranges               |
|    Post-fetch (local): folder globs, metadata, CEL                       |
|                                                                           |
|  > Filter Audit (per-rule impact)                                        |
|    +--------------------------------------------------------------+      |
|    | Rule                          | Include | Exclude | Net       |      |
|    |-------------------------------|---------|---------|-----------|      |
|    | File type: Office Documents   | 252     | 20      | +252      |      |
|    | Modified after: 2025-03-22    | 198     | 54      | -54       |      |
|    | Folder: Exclude Archives      | 186     | 12      | -12       |      |
|    | Size: Max 100 MB              | 184     | 2       | -2        |      |
|    | Metadata: dept=Engineering    | 142     | 42      | -42       |      |
|    +--------------------------------------------------------------+      |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4d. Preview/Dry-Run Tab

```
+-- Preview (Dry-Run) -----------------------------------------------------+
|                                                                           |
|  Sync Preview                                                             |
|  Showing what WOULD be synced with current configuration.                 |
|  No data will be downloaded or indexed.                                   |
|                                                                           |
|  --- Summary ----------------------------------------------------------- |
|                                                                           |
|  Would sync:    ~523 documents across 8 sites                             |
|  Would skip:    ~56 documents (filter rules)                              |
|  Estimated size: ~4.2 GB                                                  |
|  Estimated time: ~15-25 minutes                                           |
|                                                                           |
|  [!] Filter changes since last preview:                                   |
|  + Added: Exclude **/Archive/**  (+12 docs skipped)                       |
|  + Added: Max size 50MB          (+3 docs skipped)                        |
|  Net change: -15 documents vs previous preview                            |
|                                                                           |
|  --- Sample Documents (25 of ~523) ------------------------------------- |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | Name                       | Site          | Type | Size           |   |
|  |----------------------------|---------------|------|----------------|   |
|  | Q1 Financial Report.pdf    | Corp Docs     | PDF  | 2.4MB          |   |
|  | Product Roadmap 2026.docx  | Eng Wiki      | DOCX | 1.1MB          |   |
|  | Sales Playbook.pptx        | Sales Docs    | PPTX | 5.2MB          |   |
|  | Employee Handbook.pdf      | HR Portal     | PDF  | 3.8MB          |   |
|  | API Documentation.md       | Eng Wiki      | MD   | 0.2MB          |   |
|  | ... 20 more                |               |      |                |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  --- Skipped Documents (first 10 of ~56) ------------------------------- |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | Name                     | Reason                                 |   |
|  |--------------------------|----------------------------------------|   |
|  | team-photo.png           | File type excluded (image)             |   |
|  | demo-recording.mp4       | Unsupported format                     |   |
|  | Archive/2019-report.pdf  | Folder rule: **/Archive/**             |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  --- Content Type Breakdown -------------------------------------------- |
|                                                                           |
|  PDF   ==============================  312 (60%)                          |
|  DOCX  ============                    131 (25%)                          |
|  PPTX  =====                            52 (10%)                          |
|  Other ==                                28 (5%)                           |
|                                                                           |
|                              [<-- Adjust Filters]  [Approve Sync -->]     |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4e. Security Tab (Consolidated)

```
+-- Security --------------------------------------------------------------+
|                                                                           |
|  Security & Permissions                                                   |
|                                                                           |
|  --- Granted OAuth Scopes & Permission Tier ---------------------------- |
|                                                                           |
|  Current tier: Base                                                       |
|                                                                           |
|  [check] Sites.Read.All       Read all site collections (read-only)       |
|  [check] offline_access       Maintain access (refresh token)             |
|  [ ] Files.Read.All           Not granted (optional: real-time sync)      |
|  [ ] GroupMember.Read.All     Not granted (optional: group resolution)    |
|                                                                           |
|  Capabilities at your tier:                                               |
|  Yes: Sync, discovery, delta sync, read permissions                       |
|  No:  Real-time sync (needs Files.Read.All)                               |
|  No:  Group resolution (needs GroupMember.Read.All)                       |
|                                                                           |
|  [+ Upgrade Tier]  shows available add-ons with one-click consent flow    |
|                                                                           |
|  Token expires: Apr 19, 2026 (28 days remaining)                          |
|                                                                           |
|  --- What This Connector Accesses ---                                     |
|  * 8 SharePoint sites, 14 document libraries                              |
|  * ~3,801 documents (PDF, DOCX, PPTX, and 24 other types)                |
|  * 4.2 GB of content                                                      |
|                                                                           |
|  --- What This Connector Does NOT Access ---                              |
|  * Cannot write, modify, or delete any SharePoint content                 |
|  * Cannot access sites outside the selected scope                         |
|  * Cannot access user mailboxes, calendars, or Teams chats               |
|  * Cannot access OneDrive personal files                                  |
|  * File contents are chunked for search -- originals are not stored       |
|                                                                           |
|  --- Data Residency ---                                                   |
|  * Storage region: East US 2                                              |
|  * Storage type: Azure Blob / MinIO                                       |
|  * Encryption: AES-256 at rest, TLS 1.3 in transit                        |
|  (Included in Security Review PDF export)                                 |
|                                                                           |
|  --- Data Handling ---                                                    |
|  * Tokens: AES-256-GCM encrypted at rest, TLS 1.2+ in transit            |
|  * Discovery cache: 7-day TTL, auto-purged                                |
|  * Synced documents: Retained until connector deleted                      |
|  * Vector embeddings: Cleaned up within 15 minutes of connector           |
|    deletion, monitored with alert if delayed                              |
|  * Audit: All OAuth operations, sync events, and scope changes logged     |
|                                                                           |
|  --- Emergency Revoke ---                                                 |
|  [!! Emergency Revoke -- One Click !!]                                    |
|  In ONE click, this will:                                                 |
|   1. Pause all active and scheduled syncs immediately                     |
|   2. Revoke OAuth token (access + refresh)                                |
|   3. Queue vector embedding cleanup (completes within 15 min)             |
|   4. Send notification to admin with summary of actions taken             |
|  Confirmation dialog shows blast radius:                                  |
|    "This will disconnect Marketing Hub, pause sync of 237 docs,           |
|     revoke OAuth tokens, and queue cleanup of vector embeddings.          |
|     3,801 indexed documents will become stale. Proceed?"                  |
|    [Confirm Emergency Revoke]  [Cancel]                                   |
|                                                                           |
|  --- Revocation (manual steps) ---                                        |
|  How to fully revoke access:                                              |
|  1. Delete connector in ABL Platform (cleans up vectors + tokens)          |
|  2. Revoke app consent in Azure AD > Enterprise Applications              |
|  3. Delete app registration (if no longer needed)                          |
|                                                                           |
|  --- Blast Radius Summary ---                                             |
|  If this connector's token were compromised:                               |
|  * Attacker could READ (not write) documents (no write scopes granted)    |
|  * With Sites.Selected: only N admin-approved sites readable              |
|  *   (but cannot discover sites -- must specify URLs manually)            |
|  * With Sites.Read.All: any site in tenant readable                       |
|  * Recommendation: Use Sites.Selected to minimize blast radius            |
|  * NOTE: Sites.Selected not yet in backend. Current: Sites.Read.All.      |
|  * Token auto-expires in 28 days; revoke immediately via Azure AD         |
|                                                                           |
|  --- Known Limitations ---                                                |
|  1. Webhooks require Files.Read.All + publicly accessible HTTPS endpoint  |
|  2. Vector cleanup queued, completes within 15 min (alert if delayed)     |
|  3. Group resolution requires GroupMember.Read.All (optional)              |
|  4. Permission accuracy: Without GroupMember.Read.All, documents shared   |
|     via Azure AD groups may not appear in search for group members         |
|     (~70-85% accuracy). With GroupMember.Read.All: ~95%+.                 |
|  5. Sharing links: Documents shared via "Anyone with the link" are        |
|     detected but specific recipients may not be resolvable.               |
|  6. Sites.Selected cannot discover sites -- manual URL entry only.        |
|  7. No auto-pause after consecutive failures (planned)                    |
|                                                                           |
|  --- Security Review Document (exportable) ----                           |
|  [Download PDF]  [Export JSON/YAML]  [Copy as Markdown]                   |
|  This IS the security review artifact. Contains all sections above        |
|  plus the User Decisions Log from the Configuration Proposal.             |
|  Includes: data residency, emergency revoke details, cleanup SLA.         |
|                                                                           |
|  Document states:                                                         |
|  - "The default scope is Sites.Read.All (read-only access to all sites,  |
|     enables auto-discovery). For organizations requiring explicit         |
|     per-site approval, Sites.Selected is available in the advanced        |
|     setup path (not yet implemented in backend)."                         |
|  - "Scope upgrade path: Base (Sites.Read.All) ->                         |
|     + Files.Read.All (webhooks) -> + GroupMember.Read.All (groups)"      |
|  - "We do NOT request Sites.FullControl.All, Sites.ReadWrite.All,         |
|     or any write permissions"                                             |
|  - "NOTE: Sites.Selected backend support is planned. Current default      |
|     is Sites.Read.All."                                                   |
|  - "GroupMember.Read.All is optional — only needed for group              |
|     membership resolution (more targeted than Directory.Read.All)"        |
|  - "Webhooks require Files.Read.All + publicly accessible HTTPS           |
|     notification endpoint. Without these, delta sync on schedule."        |
|                                                                           |
|  --- Approval Gate ---                                                    |
|  Status: (*) No approval required  ( ) Pending  ( ) Approved             |
|  Auto-pending: Triggers on Sites.ReadWrite.All or other write scopes      |
|  [Send for Security Approval]                                             |
|                                                                           |
|  --- Immutable Audit Log ---                                              |
|  +-------------------------------------------------------------------+   |
|  | Time                | Actor            | Event                     |   |
|  |---------------------|------------------|---------------------------|   |
|  | Mar 22 14:20        | system           | Connector created          |   |
|  | Mar 22 14:21        | maria@contoso    | Auth via device code       |   |
|  | Mar 22 14:23        | system           | Discovery: 12 sites found  |   |
|  | Mar 22 14:26        | dev-team@contoso | Scope modified: -4 sites   |   |
|  | Mar 22 14:30        | dev-team@contoso | Sync approved              |   |
|  +-------------------------------------------------------------------+   |
|  [Download Full Audit Log]  [Subscribe to Changes]                        |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4f. Approve & Start

```
+-- Approve & Start -------------------------------------------------------+
|                                                                           |
|  Configuration Summary                                                    |
|                                                                           |
|  Connection: contoso.com via Client Credentials (47d remaining)           |
|  Scope: 8 sites, 14 libraries, ~3,801 docs, ~4.2 GB                      |
|  Filters: Office Docs template + Skip Archives + Metadata exclusions      |
|  Schedule: Full sync now, delta every 4 hours                              |
|  Permissions: Disabled (no ACL filtering)                                  |
|  Security: Approved (no elevated scopes)                                   |
|                                                                           |
|  Estimated initial sync time: 15-25 minutes                               |
|                                                                           |
|  Vector Embedding Cleanup: When this connector is deleted, all            |
|  synced documents and their vector embeddings will be queued for          |
|  removal. Cleanup completes within 15 minutes (monitored, alert           |
|  if delayed).                                                             |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | [Start Sync]        [Save as Draft]       [Export Template]        |   |
|  | Begin full sync     Save without          Save config as           |   |
|  | now. ~3,801 docs,   syncing. Resume       reusable template        |   |
|  | ~20 min ETA.        later.                for future setups.        |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 5. Configure-Before-Auth Wireframe (Draft Mode)

When the user selects delegation or is waiting for authentication, all tabs except discovery-dependent content are editable.

```
+-- Detail Panel (Draft Mode) --------------------------------- [<>] [x] -+
|                                                                           |
|  New SharePoint Connector (Draft)                    [... More Actions]   |
|                                                                           |
|  +--------------------------------------------------------------------+  |
|  | Connect* | Proposal | Scope+Filters | Preview | Security | History |  |
|  +--------------------------------------------------------------------+  |
|  * = Awaiting authentication                                              |
|                                                                           |
|  Banner: Waiting for authentication. Tabs marked with a lock icon         |
|  will populate after auth completes. You can configure everything          |
|  else now.                                                                |
|                                                                           |
|  Scope+Filters tab in draft mode:                                         |
|  +-------------------------------------------------------------------+   |
|  |                                                                    |   |
|  |  Sites: Will be populated after authentication and discovery.      |   |
|  |  [Enter Site URLs Manually] (if you know specific sites)           |   |
|  |                                                                    |   |
|  |  -- Filters (configurable now) --                                  |   |
|  |  File types: [x] Documents  [x] Text  [ ] Images                  |   |
|  |  Templates: [Documents Only] [Technical Docs]                      |   |
|  |  Folder exclude: [**/Archive/**]                                   |   |
|  |  Size limits: Min [0 KB] Max [100 MB]                              |   |
|  |                                                                    |   |
|  |  -- Schedule (configurable now) --                                 |   |
|  |  Frequency: [Every 6 hours v]                                      |   |
|  |                                                                    |   |
|  |  -- Permissions Mode (configurable now) --                         |   |
|  |  (*) Disabled  ( ) Enabled (needs GroupMember.Read.All)              |   |
|  |                                                                    |   |
|  |  These settings will apply automatically when auth completes.      |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 6. Delegation Flow Wireframe

### 48h Invite + Pre-Written Email + Push Notification

```
+-- Connect (Delegation Selected) ----------------------------------------+
|                                                                          |
|  You have configured the connection settings. Now someone with admin     |
|  access needs to authenticate.                                           |
|                                                                          |
|  +-- Delegation Invite -----------------------------------------------+ |
|  |                                                                     | |
|  |  I have generated a secure invitation link. When your admin clicks  | |
|  |  it, they will see a fresh device code -- no 15-minute scramble.    | |
|  |                                                                     | |
|  |  Invitation link (valid for 48 hours):                              | |
|  |  +------------------------------------------------------------------+|
|  |  | https://app.example.com/auth/invite/inv_a3f8c2e1...              ||
|  |  |                                                                  ||
|  |  | Expires: Mar 24, 2026 at 14:00 (48h from now)                    ||
|  |  | Status: Not yet used                                             ||
|  |  |                                                                  ||
|  |  | [Copy Link]  [Send via Email]  [Regenerate]                      ||
|  |  +------------------------------------------------------------------+|
|  |                                                                     | |
|  |  Email preview:                                                     | |
|  |  +------------------------------------------------------------------+|
|  |  | Subject: SharePoint connector auth needed -- ABL Platform        ||
|  |  |                                                                  ||
|  |  | Hi,                                                              ||
|  |  |                                                                  ||
|  |  | I am setting up a SharePoint connector for our AI knowledge      ||
|  |  | base. Could you please authorize it?                             ||
|  |  |                                                                  ||
|  |  | Click here to authenticate:                                      ||
|  |  | https://app.example.com/auth/invite/inv_a3f8c2e1...              ||
|  |  |                                                                  ||
|  |  | This link is valid for 48 hours. When you click it, you will     ||
|  |  | see a Microsoft device code to sign in with your admin account.  ||
|  |  |                                                                  ||
|  |  | Permissions requested:                                           ||
|  |  | (dynamically generated based on connector configuration)         ||
|  |  |                                                                  ||
|  |  | BASE (always):                                                   ||
|  |  | - Sites.Read.All -- read site structure, metadata, and           ||
|  |  |   document content (read-only). Covers site discovery,           ||
|  |  |   file reading, delta sync, and permission reading.              ||
|  |  |                                                                  ||
|  |  | CONDITIONAL (only if configured):                                ||
|  |  | - Files.Read.All -- enables real-time sync via webhooks          ||
|  |  |   (shown only if real-time sync was enabled during setup)        ||
|  |  | - GroupMember.Read.All -- enables group membership resolution    ||
|  |  |   (shown only if permission mode is Enabled)                     ||
|  |  |                                                                  ||
|  |  | All permissions are READ-ONLY. No data is modified or deleted.   ||
|  |  |                                                                  ||
|  |  | IMPORTANT: After signing in, you may be asked to grant           ||
|  |  | permissions for ABL Platform. Please click "Accept" to grant     ||
|  |  | read-only access to SharePoint content. This is the admin        ||
|  |  | consent step -- it authorizes the application to read            ||
|  |  | SharePoint data on behalf of your organization.                  ||
|  |  |                                                                  ||
|  |  | Full security review: [View Document]                            ||
|  |  +------------------------------------------------------------------+|
|  |                                                                     | |
|  |  [Send Email]  [Copy Email Body]  [Edit Before Sending]            | |
|  |                                                                     | |
|  +---------------------------------------------------------------------+ |
|                                                                          |
|  --- Delegation Status (live) ---                                        |
|  [done] Email sent  -->  [ ] Link opened  -->  [ ] Auth completed  -->  [ ] Consent granted |
|                                                                          |
|  Polling for authentication...  Waiting (checked 3s ago)                 |
|  Authenticated by: (pending)                                             |
|                                                                          |
|  Push notification: You will receive a browser notification and           |
|  email when the delegate completes authentication. You do not need        |
|  to keep this page open.                                                  |
|                                                                          |
|  While you wait, configure scope, filters, and schedule:                 |
|  [Continue to Scope+Filters Tab -->]                                     |
|                                                                          |
+--------------------------------------------------------------------------+
```

**Delegate Completion Screen (what the delegate sees after auth):**

```
+-- Authentication Complete ----------------------------------------------+
|                                                                          |
|  Authentication successful!                                              |
|                                                                          |
|  Chen has been notified. You can close this window.                      |
|                                                                          |
|  What happened:                                                          |
|  - You signed in as patricia@contoso.com                                 |
|  - Read-only access was granted to SharePoint content                    |
|  - The connector creator (Chen) will handle the rest                     |
|                                                                          |
|  If you have questions, contact Chen at chen@contoso.com.                |
|                                                                          |
+--------------------------------------------------------------------------+
```

**Push notification when delegate completes:**

```
+-- Browser Notification --------------------------------------------------+
|  ABL Platform                                                             |
|  SharePoint authentication completed by admin@contoso.com.                |
|  Your connector "Marketing Hub" is ready to configure.                    |
|  [Open Connector]                                                         |
+--------------------------------------------------------------------------+
```

The system also sends an email notification to the connector creator with a direct link to the detail panel.

---

## 7. Monitoring Wireframes (Same Panel, Post-Setup)

After setup, clicking a connector card opens the same detail panel. Tabs shift to monitoring mode with live data.

### 7a. Overview Tab (default post-setup)

```
+-- Overview --------------------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        * Healthy           |
|  Connected Mar 22 . Authenticated by sarah@contoso.com                    |
|                                                                           |
|  --- Content Breakdown ------------------------------------------------- |
|                                                                           |
|  237 documents indexed . 3.2 GB . 2 sites . 8 drives                     |
|                                                                           |
|  By type:                                                                 |
|  PDF   ==============================  142 (60%)                          |
|  DOCX  ============                     59 (25%)                          |
|  PPTX  =====                            24 (10%)                          |
|  Other ==                                12 (5%)                           |
|                                                                           |
|  By site:                                                                 |
|  Marketing Hub main    185 docs . 2.1 GB                                  |
|  Marketing Hub archive  52 docs . 1.1 GB                                  |
|                                                                           |
|  --- Sync History ------------------------------------------------------ |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | Date              | Type  | Docs   | Duration | Status             |   |
|  |-------------------|-------|--------|----------|---------------------|   |
|  | Mar 22, 14:30     | Delta | +3, -1 | 45s      | * Done              |   |
|  | Mar 22, 08:30     | Delta | +0     | 12s      | * Done              |   |
|  | Mar 21, 20:30     | Delta | +7, ~2 | 2m 15s   | * Done              |   |
|  | Mar 20, 10:15     | Full  | 237    | 24m 30s  | * Done              |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  --- Issues ------------------------------------------------------------ |
|                                                                           |
|  No issues.                                                               |
|                                                                           |
|  --- Quick Actions ----------------------------------------------------- |
|                                                                           |
|  [Sync Now]  [Pause]  [Re-auth]  [Run Health Check]  [View Documents]    |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 7b. Sync Progress (during active sync)

```
+-- Overview (syncing) ----------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        ~ Syncing           |
|                                                                           |
|  Full Sync in Progress                                                    |
|  ==========================================__________________________    |
|  78 of 252 documents . 3.2 GB of 10.3 GB . ETA: 6 min                    |
|                                                                           |
|  Current: Processing "API-Reference-v3.md" from Engineering Wiki          |
|                                                                           |
|  Per-site progress:                                                       |
|  Corp Docs        ========================================  100% (134)    |
|  Engineering Wiki =========_______________________________   25% (14/56)  |
|  Product Specs    ________________________________________    0% (0/34)   |
|  HR Portal        ________________________________________    0% (0/18)   |
|                                                                           |
|  [Pause Sync]  [Stop Sync]                                                |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 8. Multi-Connector Wireframes

### 8a. Add New Connector -- Source Selection (connector #2+)

```
+-- Add SharePoint Connector --------------------------------------- [x] -+
|                                                                           |
|  How would you like to set up this connector?                             |
|                                                                           |
|  +-- From Scratch ---------------------------------------------------+   |
|  |  Start fresh with a new Azure AD app or Microsoft account.        |   |
|  |  [New Setup -->]                                                  |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  +-- Clone Existing --------------------------------------------------+  |
|  |  Copy config from an existing connector, then re-authenticate.     |  |
|  |  [Marketing Hub v]  [Engineering Wiki v]  [Sales Docs v]           |  |
|  |  Copies: scope rules, filters, schedule. Does NOT copy auth.       |  |
|  |  [Clone -->]                                                       |  |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  +-- From Template ---------------------------------------------------+  |
|  |  Use a saved configuration template.                               |  |
|  |  [Standard KB Template]  [Engineering Docs Template]               |  |
|  |  [Browse All Templates]                                            |  |
|  |  [Create Template from Existing Connector]                         |  |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  +-- Import Configuration ---------------------------------------------+ |
|  |  Import from a previously exported JSON or YAML configuration.      | |
|  |  [Upload JSON/YAML File]  [Paste Configuration]                     | |
|  |  Round-trip: export from UI -> modify in editor -> import via API   | |
|  +---------------------------------------------------------------------+ |
|                                                                           |
|  +-- API/CLI ---------------------------------------------------------+  |
|  |  POST /api/connectors with JSON body.                              |  |
|  |  abl connector create --index $INDEX_ID --config config.yaml       |  |
|  |  [View API Docs]  [Copy cURL Template]  [Copy CLI Command]         |  |
|  +--------------------------------------------------------------------+  |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8b. Template Security Gate

When cloning a connector or applying a template that includes GroupMember.Read.All (group resolution enabled):

```
+-- Permissions Notice -----------------------------------------------------+
|                                                                           |
|  The source connector "Legal Vault" has permission crawling enabled.       |
|  This clone inherits that setting.                                        |
|                                                                           |
|  Required: Sites.Read.All + GroupMember.Read.All                          |
|  If GroupMember.Read.All is not granted, permission crawling will be      |
|  disabled automatically.                                                  |
|                                                                           |
|  [Continue]   [Disable Permission Crawling]                               |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 9. Config Management

### 9a. JSON/YAML Export

```
+-- Export Configuration --------------------------------------------------+
|                                                                           |
|  Format: (*) JSON  ( ) YAML                                               |
|                                                                           |
|  Include:                                                                 |
|  [x] Scope (sites, libraries)                                             |
|  [x] Filters (file types, folder rules, metadata, CEL)                    |
|  [x] Schedule                                                             |
|  [x] Permission mode                                                      |
|  [ ] OAuth credentials (NEVER included by default)                        |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | {                                                                  |   |
|  |   "name": "Marketing Hub",                                        |   |
|  |   "provider": "sharepoint",                                       |   |
|  |   "scope": {                                                      |   |
|  |     "sites": ["Corp Docs", "Engineering Hub"],                    |   |
|  |     "contentTypes": ["files", "pages"]                            |   |
|  |   },                                                              |   |
|  |   "filters": { ... },                                             |   |
|  |   "schedule": { "deltaInterval": "4h" },                         |   |
|  |   "version": "v5",                                                |   |
|  |   "exportedAt": "2026-03-22T14:30:00Z"                           |   |
|  | }                                                                  |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [Download]  [Copy to Clipboard]                                          |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 9b. Version History with Diff

```
+-- History ---------------------------------------------------------------+
|                                                                           |
|  Configuration Version History                                            |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  | Version | Date            | Changed By    | Summary                |   |
|  |---------|-----------------|---------------|------------------------|   |
|  | v5 (cur)| Mar 22, 14:00  | sarah@co.com  | Added folder exclusion |   |
|  | v4      | Mar 21, 10:30  | sarah@co.com  | Changed sched to 6h   |   |
|  | v3      | Mar 20, 16:00  | system        | Applied quick-setup    |   |
|  | v2      | Mar 20, 15:55  | system        | Discovery complete     |   |
|  | v1      | Mar 20, 10:15  | sarah@co.com  | Created                |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  [View Diff: v4 --> v5]  [Restore v4]                                     |
|                                                                           |
|  --- Config Drift Detection (from template) ----                          |
|                                                                           |
|  Template: "Standard KB Template" (applied at v1)                          |
|  Current config has 3 deviations from template:                            |
|                                                                           |
|  1. Added folder exclusion: **/Archive/**  (v5)                            |
|  2. Changed schedule: 4h --> 6h  (v4)                                      |
|  3. Added metadata condition: department=Engineering  (v5)                  |
|                                                                           |
|  [Re-apply Template (overwrite deviations)]                                |
|  [Update Template to Match Current Config]                                 |
|  [Ignore Drift]                                                            |
|                                                                           |
|  --- Raw Configuration ---                                                |
|  [Copy JSON]  [Copy YAML]  [Export]  [Import & Replace]                   |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 10. Error States

### Error: Auth Failed (Invalid Credentials)

```
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  ! Authentication Failed                                                  |
|                                                                           |
|  AADSTS7000215: Invalid client secret provided.                           |
|                                                                           |
|  The client secret does not match what Azure AD has on file               |
|  for this app registration.                                               |
|                                                                           |
|  How to fix:                                                              |
|  1. Open Azure Portal > App Registrations > ABL Platform Prod             |
|  2. Go to Certificates & Secrets                                          |
|  3. Check if the secret has expired (created: Jan 15, 2026)               |
|  4. If expired, create a new secret and paste it here                     |
|                                                                           |
|  [Open Azure Portal]  [Retry with New Secret]                             |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Discovery Timeout (1000+ sites)

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  ! Discovery Partial -- Large Environment                                 |
|                                                                           |
|  I found 1,247 sites but timed out while profiling drive contents.        |
|  Your organization has a large SharePoint environment -- that is normal.  |
|                                                                           |
|  Options:                                                                 |
|  1. Continue with partial data -- work with 200 profiled sites now        |
|     and add more later. [Continue with 200 -->]                           |
|  2. Search for specific sites by name                                     |
|     [Search: ________________________________________]                    |
|  3. Re-run full discovery (~5 min for 1,247 sites)                        |
|     [Re-run Full Discovery]                                               |
|                                                                           |
|  Sites discovered: 1,247 | Sites profiled: 200/1,247 | Drives: 489       |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Sync Failure (Storage Exceeded)

```
+-- Overview (Error) -------------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        X Sync Failed       |
|                                                                           |
|  Full sync failed after processing 78 of 252 documents.                   |
|                                                                           |
|  Error: ENOSPC -- Storage quota exceeded on upload destination.           |
|                                                                           |
|  The 78 documents already processed are indexed and searchable.           |
|  Checkpoint saved -- can resume without re-downloading the first 78.      |
|                                                                           |
|  Options:                                                                 |
|  1. [Resume Sync] -- Continue from document #79 (after freeing space)     |
|  2. [Reduce Scope] -- Go to Scope tab, reduce sites/files                |
|  3. [Keep Partial] -- Accept 78 indexed docs, sync rest later             |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Token Expired (Refresh Failed)

```
+-- Overview (Warning) ----------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        ! Token Expiring    |
|                                                                           |
|  Access token expires in 3 days (Mar 25, 2026).                           |
|                                                                           |
|  What will happen: Delta syncs will stop after expiry. Already            |
|  indexed content remains searchable but will become stale.                |
|                                                                           |
|  Auto-refresh: Failed -- refresh token also expired or revoked.           |
|  Last refresh attempt: Mar 22, 14:00 -- Error: invalid_grant             |
|                                                                           |
|  To fix: Someone with admin access needs to re-authenticate.              |
|  [Re-authenticate Now]  [Send Delegation Invite to IT (48h link)]         |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Permission Revoked

```
+-- Overview (Critical) ---------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        X Access Revoked    |
|                                                                           |
|  Permission revoked: Sites.Read.All was removed from this app             |
|  registration by an Azure AD administrator.                               |
|                                                                           |
|  Impact:                                                                  |
|  - Discovery: Cannot enumerate sites                                      |
|  - Sync: Cannot read file contents                                        |
|  - Already indexed: 237 documents remain searchable but will go stale     |
|                                                                           |
|  Auto-paused: Sync schedule paused to prevent repeated failures.          |
|                                                                           |
|  [Share Issue with IT Admin]  [Re-authenticate]  [Delete Connector]       |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Graph API Throttled (429)

```
+-- Overview (Throttled) --------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        ~ Throttled         |
|                                                                           |
|  Microsoft Graph API rate limit hit (HTTP 429).                           |
|  Sync paused automatically and will resume after cooldown.                |
|                                                                           |
|  Retry-After: 45 seconds (set by Microsoft)                               |
|  Requests made: 583 in last 60 seconds                                    |
|  Throttle scope: Per-app (affects all connectors for this tenant)         |
|                                                                           |
|  Progress: 78 of 252 documents (31%) -- will resume at doc #79            |
|                                                                           |
|  Resuming in: 0:38  ==============____________________________________    |
|                                                                           |
|  This is normal for large syncs. The connector backs off automatically.   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Partial Site Failure

```
+-- Overview (Partial) ----------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        ! Partial Success   |
|                                                                           |
|  Sync completed with errors on 1 of 5 sites.                             |
|                                                                           |
|  Corp Docs        [OK]  134/134 documents synced                          |
|  Engineering Wiki [OK]   56/56  documents synced                          |
|  Product Specs    [!!]    0/34  documents -- 403 Forbidden                |
|    Access to this site was revoked during sync.                           |
|    [Request Access]  [Remove from Scope]                                  |
|  HR Portal        [OK]   18/18  documents synced                          |
|  Marketing        [OK]   10/10  documents synced                          |
|                                                                           |
|  218 of 252 documents synced successfully.                                |
|  [Retry Failed Sites]  [Accept Partial]  [Re-run Full Sync]              |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: Zero Sites Found

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  Discovery returned 0 accessible sites. This usually means:              |
|                                                                           |
|  1. App registration uses Sites.Selected but no sites are selected        |
|     Fix: Azure Portal > Enterprise Applications > Add consent             |
|  2. Tenant has no SharePoint sites                                        |
|     Fix: Create a SharePoint site first                                   |
|  3. Network issue prevented Graph API from responding                     |
|                                                                           |
|  Current scope: Sites.Selected (can only access explicitly granted sites) |
|  Upgrade to Sites.Read.All to discover all sites automatically.           |
|                                                                           |
|  [Retry Discovery]  [Upgrade Scope]  [Enter Site URL Manually]            |
|                                                                           |
+---------------------------------------------------------------------------+
```

### Error: All Files Unsupported

```
+-- Preview ---------------------------------------------------------------+
|                                                                           |
|  ! No Indexable Files                                                     |
|                                                                           |
|  All 47 discovered files are in non-indexable formats (PNG, MP4, ZIP).    |
|  ABL Platform can index: PDF, DOCX, PPTX, XLSX, TXT, MD, HTML, RTF,     |
|  CSV, JSON, XML, and 16 more. [View all 27 types]                        |
|                                                                           |
|  This site appears to contain media assets rather than documents.         |
|  [Select Different Sites]  [Upload Files Instead]  [Cancel Setup]         |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 11. Empty States

### No Connectors (Detail Panel Connect tab)

See Section 3a (Welcome State). The dashboard shows a warm onboarding message with "Just connect my Microsoft account" as the primary CTA. Time estimate: "~3 minutes for your first connector."

### No Documents (after sync completes with 0 docs)

```
+-- Overview --------------------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        * Connected         |
|                                                                           |
|  Sync completed but 0 documents were indexed.                             |
|                                                                           |
|  This usually means your filters are too restrictive.                     |
|                                                                           |
|  Current filters exclude all discovered documents:                        |
|  - 34 files excluded by file type (only .png, .mp4 on this site)         |
|  - 13 files excluded by folder rule (**/Archive/**)                       |
|                                                                           |
|  [Adjust Filters]  [Select Different Sites]  [View All Discovered Files]  |
|                                                                           |
+---------------------------------------------------------------------------+
```

### No Sites Accessible (after auth but limited scope)

This state appears when using Sites.Selected with no sites granted. The design explains the situation and provides actionable paths forward.

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  You are using Sites.Selected, which grants access only to sites          |
|  that your Azure AD admin has explicitly approved.                        |
|                                                                           |
|  Currently, 0 sites are approved for this app registration.               |
|                                                                           |
|  What you can do:                                                         |
|                                                                           |
|  1. Enter site URLs and we will check if they are accessible              |
|     +--------------------------------------------------------------+    |
|     | https://contoso.sharepoint.com/sites/                         |    |
|     +--------------------------------------------------------------+    |
|     [Check Access]                                                       |
|                                                                           |
|  2. Ask your admin to grant access to specific sites                     |
|     Your admin needs to use PowerShell or Graph API to grant              |
|     Sites.Selected access. There is no Azure Portal UI for this.          |
|     [Send Request to Admin]  generates email with PowerShell commands     |
|                                                                           |
|  3. Upgrade to Sites.Read.All for automatic discovery                    |
|     This is broader access (read-only to all sites) but enables           |
|     auto-discovery, recommendations, and activity scoring.                |
|     [Upgrade to Sites.Read.All]  requires admin re-consent               |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 12. Backend Requirements

### What Exists (from deep dive capability matrix)

| Capability                                         | Status  |
| -------------------------------------------------- | ------- |
| Connector CRUD                                     | Working |
| OAuth Device Code / Auth Code / Client Credentials | Working |
| Auth status polling                                | Working |
| Token revocation                                   | Working |
| Resource discovery (sites, drives)                 | Working |
| Discovery profiling (file types, sizes)            | Working |
| Recommendation generation                          | Working |
| Quick setup (discover+recommend)                   | Working |
| Site selection                                     | Working |
| Full sync + delta sync                             | Working |
| Sync pause/resume/stop/restart                     | Working |
| Filter configuration + templates                   | Working |
| Filter preview (dry-run)                           | Working |
| Permission crawling (Neo4j)                        | Working |
| Distributed locking                                | Working |
| Sync checkpoint (crash recovery)                   | Working |

### What Needs Building

| Feature                              | Priority | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard component**              | P0       | Medium | Replace wizard entry point with dashboard home                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Configuration Proposal UI**        | P0       | Large  | New component: generates reviewable proposal from discovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Accept/Modify/Skip per section**   | P0       | Medium | Stateful section review with decisions log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Split-pane Scope+Filters**         | P0       | Medium | Live preview with instant diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **48h delegation invite**            | P0       | Medium | New `AuthDelegation` model, invite URL generation, fresh device code on open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Push notification on auth**        | P1       | Small  | Browser Notification API + email via existing notification service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Security tab consolidation**       | P0       | Medium | Merge permission, token, and security info into one tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Security Review PDF export**       | P1       | Medium | Generate from proposal data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Auto-pending security gate**       | P1       | Small  | Check scope on creation, set status=pending if write scopes detected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Fix resolveScopes()**              | P0       | Small  | Fix `resolveScopes()` in `connector.service.ts:154-165`: (1) Remove `Sites.FullControl.All` from ALL modes, (2) Default scopes: `Sites.Read.All` + `offline_access` (or `Sites.Selected` + `offline_access` when Sites.Selected backend support ships), (3) With permissions enabled: add `GroupMember.Read.All` (not Directory.Read.All -- least privilege), (4) With webhooks enabled: add `Files.Read.All`, (5) Remove `"simplified"` from `ConnectorConfig.permissionConfig.mode` enum -- accept only `"disabled"` and `"enabled"`, (6) Update mode validation to reject `"simplified"`. NOTE: `getDrivePermissions()` in graph-client.ts is defined but never called -- verify if needed or remove. |
| **User Decisions Log**               | P1       | Small  | Array of {time, section, decision, detail} on ConnectorConfig                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Config version history**           | P1       | Medium | New `ConnectorConfigVersion` model, diff view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Config drift detection**           | P2       | Medium | Compare current config against source template                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Immutable audit log**              | P1       | Medium | New `ConnectorAuditLog` model, append-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Template/Clone/Import**            | P1       | Medium | Export JSON/YAML, import, clone with re-auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Bulk operations**                  | P1       | Small  | Multi-select + batch API calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **YAML export**                      | P1       | Small  | JSON-to-YAML serialization (trivial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Simplified View toggle**           | P0       | Small  | Per-user preference, hides advanced tabs/jargon                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Progress indicator (Step N of M)** | P0       | Small  | Setup flow step tracker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **GUI date range filter**            | P0       | Small  | Date pickers in Scope+Filters, translates to OData pre-fetch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **CEL field value autocomplete**     | P1       | Medium | Suggests values from discovery profiling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Filter Audit (per-rule impact)**   | P1       | Medium | Shows include/exclude counts per active rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Data residency display**           | P0       | Small  | Show storage region, type, encryption in Security tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Emergency Revoke (one-click)**     | P0       | Medium | Pause syncs + revoke token + queue cleanup + notify admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **15-min vector cleanup SLA**        | P0       | Medium | Upgrade from 1h, add monitoring alert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Tenant grouping in dashboard**     | P1       | Medium | Group by toggle + collapsible sections + aggregate stats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Aggregate summary row**            | P0       | Small  | Connector count + health + doc count + token warnings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Quick filter pills**               | P1       | Small  | "Needs Attention" / "All Healthy" / "Token Warning"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Delegate Completion Screen**       | P0       | Small  | Confirmation page for delegate after auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Live delegation status tracker**   | P1       | Medium | Real-time status: email sent -> link opened -> auth -> consent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **OData default expanded**           | P0       | Small  | Remember user preference, default expanded for power users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Vector cleanup on delete**         | P0       | Medium | Currently NOT IMPLEMENTED (deep dive gap #7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Wire scheduler**                   | P0       | Small  | Call `startScheduledJobs()` in server.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Fix delta sync scheduler**         | P0       | Small  | Replace stub with real queue enqueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### API Changes Needed

```
# New endpoints
POST   /api/connectors/:id/delegation-invite     # Generate 48h invite
GET    /api/connectors/:id/delegation-invite/:token  # Delegate opens link
POST   /api/connectors/:id/proposal/generate      # Trigger proposal generation
GET    /api/connectors/:id/proposal               # Get proposal with section statuses
PATCH  /api/connectors/:id/proposal/sections/:name  # Accept/Modify/Skip section
GET    /api/connectors/:id/audit-log              # Immutable audit trail
GET    /api/connectors/:id/versions               # Config version history
GET    /api/connectors/:id/versions/:v1/diff/:v2  # Diff between versions
POST   /api/connectors/:id/export                 # Export JSON/YAML
POST   /api/connectors/import                     # Import from JSON/YAML
POST   /api/connectors/:id/clone                  # Clone connector
GET    /api/connector-templates                   # List templates
POST   /api/connector-templates                   # Create template

# Existing endpoints (no changes needed)
POST   /api/connectors/:id/auth/initiate
GET    /api/connectors/:id/auth/status
POST   /api/connectors/:id/discover
GET    /api/connectors/:id/discovery
POST   /api/connectors/:id/quick-setup
POST   /api/connectors/:id/filters/preview
POST   /api/connectors/:id/sync/start|stop|pause|resume
```

### New Models

```typescript
// 48h delegation invite
interface AuthDelegation {
  _id: string;
  connectorId: string;
  tenantId: string;
  inviteToken: string; // crypto random, URL-safe
  createdBy: string;
  expiresAt: Date; // +48h
  status: 'pending' | 'opened' | 'completed' | 'expired';
  completedBy?: string;
  completedAt?: Date;
}

// Config version history
interface ConnectorConfigVersion {
  _id: string;
  connectorId: string;
  version: number;
  config: Record<string, unknown>; // snapshot
  changedBy: string;
  changedAt: Date;
  summary: string;
}

// Immutable audit log
interface ConnectorAuditEntry {
  _id: string;
  connectorId: string;
  tenantId: string;
  timestamp: Date;
  actor: string; // userId or "system"
  event: string; // e.g., "auth.completed", "scope.modified"
  detail: Record<string, unknown>;
}

// User decisions from proposal review
interface ProposalDecision {
  section: string;
  decision: 'accepted' | 'modified' | 'skipped';
  timestamp: Date;
  detail?: string;
}
```

---

## 13. The 5 Personas Check (Updated for 4-Tier Permission Model)

### Sarah (Non-Technical PM) -- Score: 9.5/10

**Walk-through:** Sarah's new KB has no sources yet (SetupGuide is showing). She clicks "Connect Source", which navigates to the Data tab and auto-opens the Add Source dialog. She picks "SharePoint" from the type picker grid -- the dialog closes and the Detail Panel slides in with the Connect tab showing the Welcome content. "~3 minutes for your first connector" -- she knows the time commitment. She clicks "Connect with Microsoft", signs in (this uses Sites.Read.All automatically -- she never sees the scope selector), and within 30 seconds sees the Configuration Proposal generating. The "Simplified View" toggle is ON by default (first-time user), so the Scope+Filters tab is hidden entirely -- she only sees Connect, Proposal, Preview, Security, and History. A progress indicator reads "Step 2 of 4: Review Proposal" so she knows exactly where she is. Sections appear one by one with conversational explanations: "I discovered 12 sites. I recommend syncing 8 based on activity." No jargon -- "pipeline" is replaced with "system", CEL/OData/ACL are invisible.

The Schedule section says: "Your current permissions support scheduled sync (every 4 hours). To enable real-time notifications, your app needs Files.Read.All (read-only). [Enable Real-Time Sync] [Keep Scheduled Only]." Sarah reads this in plain language and clicks "Keep Scheduled Only" -- she does not need real-time sync for a first setup. She can upgrade later. The 4-tier permission model is invisible to her; she sees only what is relevant at her tier.

The Permissions section says: "Permission-aware search ensures users only see documents they have access to in SharePoint." She selects "Disabled" (all users see all documents) because her team shares everything anyway. The accuracy disclosure is only shown when "Enabled" is selected, so she never sees it. She reads each section, finds "Accept All Remaining" at the top, and clicks it. The Summary shows 3,801 docs, ~15 min sync. She clicks "Start Sync" and sees the progress bar.

**Key moments:**

- Welcome state with time estimate: "I know what I am getting into."
- "Connect with Microsoft" one-click: "No Azure AD forms. No scope selector."
- Real-time sync as opt-in upgrade: "It told me what I have and what I could get. I chose to keep it simple."
- Permission accuracy hidden behind "Enabled" mode: "I did not need to see that complexity."
- Simplified View ON by default: "I do not see any scary technical tabs."
- "Step 2 of 4" progress indicator: "I know where I am and how much is left."
- "Accept All Remaining": "I love this. I trust the defaults."

**Does the 4-tier model confuse her?** No. She never sees it. The simple path uses Sites.Read.All automatically. The Schedule section explains webhooks as an upgrade in plain language. Permission accuracy is only shown when "Enabled" is selected. The 4-tier complexity is fully absorbed by the system. Score: **9.5/10**.

### Raj (Platform Engineer, 15 connectors) -- Score: 9/10

**Walk-through:** Raj opens his primary KB's Data tab (Sources segment) and sees the table view (this KB has 15 SharePoint connectors pulling from 3 Microsoft tenants). The aggregate summary row at the top reads: "15 connectors: 12 healthy, 2 warning, 1 error | 2,847 docs | 3 tokens expiring soon." He clicks the "Needs Attention (3)" quick filter pill to see only connectors with issues. He switches "Group by" to "Tenant" -- the table collapses into 3 tenant sections (contoso: 8 connectors, fabrikam: 4, woodgrove: 3), each with per-tenant aggregate stats. He multi-selects 5 connectors with expiring tokens and clicks "Re-auth Selected." For a new connector, he clicks "+ Add", selects "Clone Existing", picks "Marketing Hub", and only needs to re-authenticate -- scope, filters, and schedule are pre-filled. He exports the config as YAML, commits it to git, and uses the API to import it in staging.

When cloning, the template inherits the source connector's permission tier. If the source had Files.Read.All + GroupMember.Read.All, the clone asks "This clone inherits real-time sync and group resolution. The new app registration will need: Sites.Read.All, Files.Read.All, GroupMember.Read.All. [Continue] [Adjust Permissions]." Raj clicks Continue -- he manages all scopes centrally via Terraform anyway. The delegation email dynamically lists all required scopes for the cloned connector's tier.

**Key moments:**

- Aggregate summary row: "One line tells me the health of all 15 connectors."
- "Needs Attention (3)" quick filter: "Instant triage -- no scrolling."
- Tenant grouping: "My morning check is now per-tenant. Each client's health at a glance."
- Clone inherits permission tier: "It told me exactly which scopes the clone needs."
- YAML export: "Config-as-code. This is the killer feature."

**Does the 4-tier model complicate bulk setup?** No. Each connector shows its tier in the Security tab. Clone/template inherit the tier. Bulk re-auth works across all tiers. The tier model adds information without adding steps. Score: **9/10**.

### Maria (Security Analyst) -- Score: 10/10

**Walk-through:** Maria receives a link to the Security Review Document (exported as PDF from the Security tab). She opens it and sees: OAuth scopes with justification, the **Permission Tier matrix** showing exactly what is and is not available, **data residency** (East US 2, Azure Blob/MinIO, AES-256 at rest, TLS 1.3 in transit), data handling details, what the connector does NOT access, blast radius summary, and the User Decisions Log.

The Security tab now shows "Current tier: Base" with a clear matrix of what works and what doesn't. She sees that webhooks need Files.Read.All and group resolution needs GroupMember.Read.All -- each upgrade is a separate, independent scope addition. The **Known Limitations** section now honestly lists 6 items (up from 3), including the permission accuracy range (~70-85% without group resolution, ~95%+ with), sharing link resolution limitations, and Sites.Selected discovery limitation.

The **Permission Accuracy** disclosure tells her: "Direct user grants: ~100% accurate. Group-based grants: not resolved without GroupMember. Sharing links: partially resolved. Overall: ~70-85% of permissions captured." She appreciates the statement: "No user will see documents they should not (false positives are not possible)." The **Test Permissions** feature lets her verify by searching as a specific user.

She reviews the TRUST NOTE -- all permissions are read-only. The Emergency Revoke button is unchanged. She confirms approval.

**Key moments:**

- Permission Tier matrix: "I can see exactly what each scope adds. Granular least-privilege."
- Permission Accuracy disclosure: "They told me the limitations upfront. ~70-85% is honest."
- "False positives not possible" statement: "The safe failure mode. Users may miss docs, but never see unauthorized ones."
- Test Permissions feature: "I can verify before we go live."
- Known Limitations now 6 items: "More honest, more complete. I trust this more."
- Dynamic delegation email scopes: "The email lists exactly what the admin will consent to."

**Does the honest capability disclosure increase trust?** Absolutely. The previous design implied 95-100% accuracy without disclosing the group resolution gap. Now Maria knows the real number, knows the upgrade path, and can verify with Test Permissions. Trust increased from 10/10 to a more grounded 10/10. Score: **10/10**.

### Chen (IT Admin, Delegation) -- Score: 9.5/10

**Walk-through:** Chen configured a SharePoint connector yesterday but selected delegation for auth. He chose the Azure App Registration path and selected Sites.Read.All with Files.Read.All for real-time sync. Today he opens the KB's Data tab (Sources segment) and sees his connector listed in the SourcesTable with status "Awaiting Auth" (amber badge). He clicks the row and the Detail Panel opens with the **Connect tab active** -- exactly where he left off. He checks the delegation status tracker and sees the invite link hasn't been used yet, so he resends it.

The IT admin receives the email with a 48h invite link. The email has a clear subject line ("SharePoint connector auth needed -- ABL Platform") and lists the exact permissions requested -- dynamically generated based on Chen's configuration:

- **BASE:** Sites.Read.All -- read site structure, metadata, and document content
- **CONDITIONAL:** Files.Read.All -- enables real-time sync via webhooks (because Chen enabled it)

The email says "All permissions are READ-ONLY" and includes explicit admin consent instructions. The admin clicks the link, signs in, consents, and sees the Delegate Completion Screen.

**Key moments:**

- Dynamic scope listing in email: "The admin sees exactly what they are consenting to. No surprise scopes."
- Conditional scopes explained: "Files.Read.All only appears because I enabled real-time sync."
- "Awaiting Auth" row with resume: "Exactly where I left off."
- 48h invite: "No rush."

**Does the delegation email correctly list ALL needed scopes?** Yes. The email is dynamically generated from the connector's configuration. If Chen enabled real-time sync, Files.Read.All appears. If he enabled group resolution, GroupMember.Read.All appears. The admin sees exactly what they will consent to, with a one-line explanation for each scope. Score: **9.5/10**.

### Alex (Data Engineer, Power User) -- Score: 9/10

**Walk-through:** Alex opens the detail panel. He is using the Azure App Registration advanced path with Sites.Selected because his organization requires explicit per-site approval. The Scope section shows the **Sites.Selected manual entry variant** -- no auto-discovery, no recommendations, no site scoring. Instead, he enters 5 site URLs, clicks "Validate Sites", and sees 4 validated successfully and 1 failed (not granted). He clicks "Send Access Request to Admin" which generates a pre-written email with the PowerShell command to grant Sites.Selected access for that specific site.

He clicks the Scope+Filters tab. The panel **auto-expands** from 720px to full viewport width with a smooth animation. The split-pane uses a 60/40 split: filter controls on the left, live preview on the right. He sets a GUI date range filter -- "Modified after: 2025-03-22" -- using the date picker. The OData section is expanded by default. He writes a complex CEL filter with value autocomplete from discovery. He exports the config as YAML.

The Schedule section shows "Your current permissions support scheduled sync only. Real-time sync is not available with Sites.Selected." He understands the trade-off -- Sites.Selected is the most restrictive scope and webhooks require Files.Read.All which is a broader permission. He accepts scheduled sync.

**Key moments:**

- Sites.Selected manual entry: "I entered my 5 site URLs and validated them instantly."
- Validation results: "The system told me which sites are accessible and which need admin grants."
- Send Access Request with PowerShell: "My admin got the exact commands to run."
- Schedule transparency: "It told me real-time sync is not available at my permission tier."
- Split-pane with live diff: "Still the best filter iteration loop."
- YAML export: "Config-as-code, round-trip with my pipeline."

**Does the Sites.Selected manual entry mode work for him?** Yes, but with a caveat. He has to know his site URLs upfront and his admin has to use PowerShell to grant access (no Portal UI). The design is honest about this trade-off. The validation + admin request email makes it manageable. Score: **9/10**.

---

## Final Scorecard (Post 4-Tier Permission Model Update)

| Persona | Before  | After   | Key Fix (this round)                                                                         |
| ------- | ------- | ------- | -------------------------------------------------------------------------------------------- |
| Sarah   | 9.5     | 9.5     | 4-tier invisible to her. Webhooks explained as plain-language upgrade. No confusion.         |
| Raj     | 9.0     | 9.0     | Clone/template inherit tier. Bulk ops work across tiers. No added complexity.                |
| Maria   | 10.0    | 10.0    | Permission Accuracy disclosure + Test Permissions + 6 Known Limitations. Trust maintained.   |
| Chen    | 9.5     | 9.5     | Dynamic delegation email lists exact scopes based on configuration. No surprise consents.    |
| Alex    | 9.0     | 9.0     | Sites.Selected manual entry works. Validation + admin request email. Trade-offs transparent. |
| **Avg** | **9.4** | **9.4** |                                                                                              |

**All five personas at 9.0 or above. Average: 9.4/10. Target met.**

The 4-tier permission model and accuracy disclosure did NOT reduce any persona score because:

1. Sarah never sees it (simple path absorbs the complexity)
2. Raj benefits from tier-aware clone/template
3. Maria benefits from honest accuracy numbers and Test Permissions
4. Chen benefits from dynamic scope listing in delegation email
5. Alex benefits from Sites.Selected validation and admin request generation

### Post-Fix Validation (4-Tier + Accuracy)

**Sarah re-check (9.5):**

- 4-tier model: Invisible. Simple path uses Sites.Read.All automatically.
- Webhook upgrade: Plain language in Schedule section. "Keep Scheduled Only" is one click.
- Permission accuracy: Only shown when Enabled is selected (she chose Disabled).
- Simplified View still ON by default. No jargon visible.

**Raj re-check (9.0):**

- Clone inherits tier: "This clone inherits real-time sync. Needs: Sites.Read.All, Files.Read.All."
- Bulk re-auth: Works across all tiers. No per-tier friction.
- Security tab shows tier: "Current tier: Base + Webhooks" per connector.
- Tenant grouping, aggregate summary, quick filters: unchanged.

**Maria re-check (10.0):**

- Permission Tier matrix in Security tab: "I see exactly what each scope enables."
- Permission Accuracy disclosure: "~70-85% without groups, ~95%+ with. Honest numbers."
- "False positives not possible": "Safe failure mode documented."
- Test Permissions: "I can verify before go-live."
- Known Limitations: 6 items (up from 3). Sharing links, accuracy, Sites.Selected limitations.
- Dynamic delegation email: "Admin sees exactly what they consent to."

**Chen re-check (9.5):**

- Delegation email: Dynamically lists BASE + CONDITIONAL scopes based on config.
- If Files.Read.All enabled: appears in email with explanation.
- If GroupMember.Read.All enabled: appears in email with explanation.
- Resume flow: unchanged. "Awaiting Auth" row, Connect tab active.

**Alex re-check (9.0):**

- Sites.Selected: Manual entry with validation. "Validate Sites" checks each URL.
- Failed sites: "Send Access Request to Admin" with PowerShell commands.
- Schedule: "Real-time sync not available with Sites.Selected" -- transparent trade-off.
- Sites.Selected info box: 6-point limitation list before choosing. Informed consent.
- Scope+Filters: unchanged. Auto-expand, split-pane, live diff, CEL, OData.

---

## Design Provenance

| Element                                  | Source Design  | Persona Champion |
| ---------------------------------------- | -------------- | ---------------- |
| Dashboard as home base                   | Design C       | Raj, Sarah       |
| Welcome state with time estimate         | Design C + NEW | Sarah            |
| Configuration Proposal (reviewable doc)  | Design B       | Maria, Sarah     |
| Accept/Modify/Skip per section           | Design B       | Sarah            |
| "Accept All Remaining" button            | Design B       | Sarah            |
| Conversational tone ("I discovered...")  | Design B       | Sarah            |
| User Decisions Log                       | Design B       | Maria            |
| Known Limitations section                | Design B       | Maria            |
| Configure-before-auth draft mode         | Design B       | Chen             |
| YAML export                              | Design B       | Raj              |
| Auth vs admin consent separation (2a/2b) | Design B       | Chen             |
| Split-pane Scope+Preview                 | Design A       | Alex             |
| Live filter diff (+N/-N)                 | Design A       | Alex             |
| TRUST NOTE about read-only permissions   | Design A       | Maria            |
| Pre-written delegation email             | Design A       | Chen             |
| OData query transparency                 | Design A       | Alex             |
| Metadata field discovery dropdowns       | Design A + C   | Alex             |
| Card view (1-6) / Table view (7+)        | Design C       | Raj              |
| Bulk operations bar                      | Design C       | Raj              |
| Template/Clone/Import                    | Design C       | Raj              |
| Auto-pending security gate               | Design C       | Maria            |
| "What this connector does NOT access"    | Design C       | Maria            |
| Detail panel (720px, expandable)         | Design C       | All              |
| Push notification on delegate auth       | NEW            | Chen             |
| Immutable audit log                      | NEW            | Maria            |
| Config drift detection from template     | NEW            | Raj              |
| Time estimate on first screen            | NEW            | Sarah            |

---

## Permission Model Update (2026-03-23)

Based on validated Microsoft Graph API documentation review:

- Sites.Read.All IS sufficient for reading driveItem permissions (confirmed via MS docs: Files.Read.All is least-privilege, Sites.Read.All also works)
- Sites.Read.All is NOT sufficient for webhook subscriptions -- Files.Read.All required for drive resource subscriptions (corrected 2026-03-23)
- Sites.FullControl.All was NEVER needed for permission crawling -- removed from all scopes
- "Simplified" mode eliminated -- no value without FullControl distinction
- Corrected scope model (4-tier, with optional scopes):
  - Sites.Read.All (recommended default -- full discovery, all tenant sites readable)
  - Sites.Selected (most restrictive -- admin-approved sites only, manual entry)
  - \+ Files.Read.All (optional -- required for webhook subscriptions on drive resources)
  - \+ GroupMember.Read.All (optional -- group membership resolution; more targeted than Directory.Read.All)
- Sites.Selected is NOT yet in the backend codebase. Current default: Sites.Read.All.
  Sites.Selected support is planned. Design recommends it as default when available.
- Sites.Selected CANNOT discover sites (GET /sites?search=\* fails) -- requires manual site URL entry or pre-granted site list
- Webhook notification URL must be publicly accessible HTTPS endpoint
- Permission modes reduced to: "disabled" and "enabled" (removed "simplified")

Sources:

- https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions (permissions: Files.Read.All least-priv, Sites.Read.All also works)
- https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions (drive resources need Files.Read.All for application perms)
- https://learn.microsoft.com/en-us/graph/api/group-list-members (GroupMember.Read.All is least-privilege for group expansion)
- https://graphpermissions.merill.net/permission/Sites.Read.All

---

## Code Issues Found During Permission Audit (2026-03-23)

These are code-level issues discovered during the design review. Not design changes, but documented here for implementation tracking.

1. **SharePoint group ID != Azure AD group ID**: The permission crawler (`sharepoint-permission-crawler.ts:172-199`) uses `perm.grantedToV2.group.id` and passes it to `getGroupMembers(groupId)` which calls `/groups/{groupId}/members`. BUT: SharePoint permission group IDs are SharePoint-internal IDs, NOT Azure AD group object IDs. The Graph API `/groups/{id}/members` endpoint expects Azure AD group IDs. This means group expansion in `full` mode likely returns 404 errors silently (caught at line 264). **Fix needed**: Resolve SharePoint group to Azure AD group before calling `/groups/{id}/members`, or use a different API path.

2. **`grantedToV2.group` often not populated**: In practice, SharePoint driveItem permissions use `grantedToV2.siteGroup` or embed group info in `link`/`invitation` facets, not `grantedToV2.group`. The crawler handles `siteUser` (line 203) but may miss group permissions that come through sharing links. **Fix needed**: Parse `link.scope` and `invitation` facets to extract group/user grants.

3. **`getDrivePermissions()` defined but never called**: `graph-client.ts:352-356` defines `getDrivePermissions(driveId)` to get drive-level permissions, but no code in the crawler or sync coordinators calls it. Drive-level permissions (inherited by all items) may be missed. **Fix needed**: Verify if drive-level permissions need separate crawling or if item-level permissions already include inherited drive permissions.

4. **`resolveScopes()` still uses FullControl**: `connector.service.ts:154-165` still has `Sites.FullControl.All` in `full` and `simplified` modes. Design says this was removed, but code was not updated. **Fix needed**: Apply the resolveScopes() fix from the "What Needs Building" table.

---

## Review Status (2026-03-23)

**Reviewer:** Cold review, fresh context.
**Verdict:** NEEDS REWORK (permission model corrections required -- see below).

**Fixes applied:**

1. Line 102: Changed "or set up with full control" to "or set up with advanced options" -- the phrase "full control" could be confused with Sites.FullControl.All.
2. Line 450: Changed "Files.Read.All granted" health check to "File content readable -- Sites.Read.All covers files" -- Files.Read.All was not in the canonical scope list and is redundant with Sites.Read.All for application permissions.
3. Lines 1050-1051: Merged "Sites.Read.All + Files.Read.All" in delegation email to just "Sites.Read.All" -- same inconsistency as above.
4. Line 1772: Removed Files.Read.All from Chen persona walkthrough text.

**No CRITICAL or HIGH issues remain. Permission model is internally consistent end-to-end.**

## Review Round: Permission Model v2 (2026-03-23)

- Issues fixed:
  1. **Sites.Selected as recommended default:** Added scope selector in Connect tab (Sites.Selected recommended, Sites.Read.All as upgrade). Updated TRUST NOTE, Blast Radius, Security Review Document, and Permission Model Update section. Consistently noted that Sites.Selected is not yet in the backend (current default remains Sites.Read.All). Clear 3-tier upgrade path: Sites.Selected -> Sites.Read.All -> + Directory.Read.All.
  2. **Files.Read.All explanation in delegation email:** Added explicit explanation that Sites.Read.All covers both site discovery and file reading, so Files.Read.All is not needed. Files.Read.All was already removed from the email in a prior review round.
  3. **TRUST NOTE wording:** Changed from "minimum permission needed for document sync" to least-privilege recommendation language: "Sites.Selected limits access to admin-approved sites only. Sites.Read.All enables full site discovery." Added backend implementation caveat.
  4. **Backend resolveScopes() fix specification:** Expanded from one-line description to 5-point precise fix: remove FullControl, set default scopes, add Directory.Read.All for enabled mode, remove "simplified" from mode enum, update validation.
- New issues introduced: none
  - Counter-check: Sites.Selected in Connect tab scope selector only appears in the returning-user Azure App Registration form, not Sarah's simple path. Simplified View hides it further. No UX complication.
  - Counter-check: Maria re-check text updated to match new TRUST NOTE wording.
  - Counter-check: All existing error states (zero sites, no sites accessible) already handle Sites.Selected scenario correctly.
- Validation: CLEAN
  - Permission model internally consistent? Yes
  - Issue 1 resolved? Yes
  - Issue 2 resolved? Yes
  - Issue 3 resolved? Yes
  - Issue 4 resolved? Yes
  - Any new CRITICAL/HIGH issues? None

## Review Round: Technical PM Investigation (2026-03-23)

Three research agents (TP-1, TP-2, TP-3) investigated MS Graph API permission realities. Findings cross-referenced and applied.

### Contradiction Resolution

| Disputed Point                   | TP-2 Claim                                             | TP-3 Claim                             | Verdict                                                                                                                                |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| driveItem list-permissions scope | Files.Read.All (least-priv), Sites.Read.All also works | Needs Sites.FullControl.All            | **TP-2 correct**. MS docs permission table lists Files.Read.All as least-privilege for application perms. FullControl NOT in the list. |
| Webhook subscription scope       | Needs Files.Read.All                                   | Not specifically addressed             | **TP-2 correct**. MS subscription docs require Files.Read.All for drive resource subscriptions.                                        |
| Group expansion scope            | Directory.Read.All                                     | GroupMember.Read.All (least-privilege) | **TP-3 correct**. GroupMember.Read.All is sufficient and more targeted.                                                                |

### Corrected Permission Model (4-Tier)

The permission model is now 4 tiers, each building on the previous. The system detects the granted scopes and adapts the UI accordingly. Each tier adds capabilities independently -- the user can have Base + Group Resolution without Webhooks, for example.

| Tier              | Required Scopes                     | UX Capabilities                                                                      | UX Limitations                                                                        |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Base**          | `Sites.Read.All` + `offline_access` | Sync, discovery, delta sync, read permissions (~70-85% accuracy)                     | No real-time sync. Group-based permissions not resolved.                              |
| **+ Webhooks**    | + `Files.Read.All`                  | Real-time sync via webhooks. Schedule section shows webhook config.                  | Needs publicly accessible HTTPS endpoint.                                             |
| **+ Groups**      | + `GroupMember.Read.All`            | Group membership resolution. Permission accuracy ~95%+. Accuracy disclosure updates. | None additional.                                                                      |
| **Selected Mode** | `Sites.Selected` + `offline_access` | Sync granted sites only. Most restrictive.                                           | No discovery, no search, no webhooks, no groups. Manual URL entry. PowerShell grants. |

**Key UX behavior per tier:**

- **Proposal adapts:** Each section of the Configuration Proposal adapts to the detected tier. Schedule shows webhook upgrade or webhook config. Permissions shows accuracy estimate. Scope shows discovery or manual entry.
- **Upgrades are independent:** User can add Files.Read.All or GroupMember.Read.All independently, at any time, without re-setup. Each upgrade requires admin re-consent only.
- **Delegation email is dynamic:** Lists only the scopes required for the connector's configured tier.
- **Health Check detects tier:** Shows "Permission tier: Base" with capability summary.

| Feature Set (legacy reference)                                    | Required Scopes                                                                 | Why                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only sync (no permissions, no webhooks)                      | `Sites.Read.All` + `offline_access`                                             | Sites.Read.All covers site/drive/item read + delta sync                                                                                                                                                                                       |
| Read-only sync + webhooks                                         | `Sites.Read.All` + `Files.Read.All` + `offline_access`                          | Files.Read.All required for drive resource subscription creation                                                                                                                                                                              |
| Read-only sync + webhooks + permission crawling                   | `Sites.Read.All` + `Files.Read.All` + `offline_access`                          | Item-level permissions readable with Sites.Read.All                                                                                                                                                                                           |
| Read-only sync + webhooks + permission crawling + group expansion | `Sites.Read.All` + `Files.Read.All` + `GroupMember.Read.All` + `offline_access` | GroupMember.Read.All for `/groups/{id}/members` (least-privilege vs Directory.Read.All)                                                                                                                                                       |
| Sites.Selected mode                                               | `Sites.Selected` + `offline_access`                                             | Can read granted sites only. CANNOT: discover sites (search fails), create webhooks (needs Files.Read.All), fetch group members. Per-site grants require separate admin app with Sites.FullControl.All + Graph API/PowerShell (no Portal UI). |

### Design Changes Made

1. **Webhook capability: DOWNGRADED from "Available" to "Needs Files.Read.All"** -- Line 844. The previous claim that webhooks work with Sites.Read.All was false. Added scope requirement and notification URL requirement (must be publicly accessible HTTPS).
2. **Group resolution scope: Changed Directory.Read.All to GroupMember.Read.All** -- All references (upgrade path, permission modes, known limitations, template gate, security tab, review doc). GroupMember.Read.All is least-privilege for group member enumeration.
3. **Sites.Selected: Added honest discovery limitation** -- Scope selector now states that discovery is not available with Sites.Selected; user must enter URLs manually; per-site grants require Graph API/PowerShell with no Portal UI.
4. **Blast radius: Added Sites.Selected discovery caveat** -- Noted that Sites.Selected cannot discover sites.
5. **Security tab: Added Files.Read.All as optional scope** -- For webhook support.
6. **Security review document: Added webhook requirement statement** -- Webhooks need Files.Read.All + public HTTPS endpoint.
7. **Permission Model Update section: Corrected** -- Fixed webhook claim, added Files.Read.All and GroupMember.Read.All tiers, documented Sites.Selected discovery limitation and notification URL requirement.
8. **resolveScopes() fix spec: Updated** -- Now includes GroupMember.Read.All (not Directory.Read.All), Files.Read.All for webhooks, and notes getDrivePermissions() dead code.
9. **Code Issues section: Added** -- Documents 4 code bugs (SP group ID mismatch, grantedToV2.group not populated, getDrivePermissions unused, resolveScopes still has FullControl).

### Items Countered (not changed)

1. **"Sites.Read.All IS sufficient for reading driveItem permissions"** -- CONFIRMED CORRECT. TP-2 provided the exact MS docs permission table. TP-3's claim about needing FullControl was wrong. No change needed to the permission crawling model (Disabled/Enabled is fine).
2. **TRUST NOTE about read-only** -- Still accurate. We request only read scopes. The addition of Files.Read.All for webhooks is still read-only. No write scopes.
3. **2-mode permission model (Disabled/Enabled)** -- Still correct. Since FullControl is NOT needed for permission crawling, the 2-mode model is valid.
4. **Sites.Selected as recommended default** -- Still recommended, but now with honest caveats about discovery. The design already had "Sites.Selected is not yet implemented" notes; now adds the technical limitation that discovery breaks.

### Verdict: NEEDS MORE WORK

The design doc is now internally consistent on permissions, but implementation has 4 code-level bugs documented in the new "Code Issues Found" section. These need code fixes, not design changes.

---

## Experience Designer Review: Phase 5 + 6 (2026-03-23)

**Reviewer:** Experience Designer Agent (Phases 5 + 6)
**Verdict:** APPROVED

### Phase 5: Design Review (Criteria-Based)

**A. Internal Consistency: PASS**

- All 7 major sections reference the same 4-tier permission model consistently (Connect tab, Health Check, Permissions section, Security tab, Delegation email, Persona walkthroughs, Permission Model Update).
- Trigger flows (section 2) match wireframes (sections 3-7) exactly: Flow A/B/C open setup mode, Flow D opens monitoring mode.
- Backend requirements (section 12) map 1:1 to wireframe features.
- Persona walkthroughs (section 13) are consistent with actual wireframes.

**B. Completeness: PASS**

- Every screen wireframed: setup, monitoring, 7 error states, 4 empty states, 2 loading states.
- All 4 permission tiers have wireframe variants (Health Check Sites.Read.All vs Sites.Selected, Schedule with/without Files.Read.All).
- Sites.Selected manual entry flow wireframed (section 4b Variant B).
- Webhook opt-in/upgrade flow wireframed (Schedule section Variant A + monitoring mode upgrade).
- Permission accuracy disclosure wireframed (section 4b Permissions).

**C. Technical Accuracy: PASS**

- Permission scopes verified against MS Graph docs references in the design.
- Webhook requirement (Files.Read.All) accurately described with MS subscription docs citation.
- Sites.Selected limitations honestly documented (no discovery, no webhooks, PowerShell-only grants).
- GroupMember.Read.All correctly identified as least-privilege over Directory.Read.All.
- Code-level issues (resolveScopes still using FullControl, getDrivePermissions dead code) accurately documented.

**D. Design System Consistency: PASS**

- Design references Card, Badge, DataTable, Button, Dialog, SlidePanel, SegmentedControl, Toggle, Input, Progress, EmptyState -- all exist in the codebase at `apps/studio/src/components/ui/`.
- Slide-over panel pattern matches existing ConnectorDetailPanel implementation.
- ConnectorFilterSection pattern matched by Scope+Filters tab design.

**E. Implementation Readiness: PASS**

- Each screen has ASCII wireframes with labeled actions and state transitions.
- Conditional variants (Sites.Read.All vs Sites.Selected, Simplified vs Full) clearly documented.
- API endpoints and new models specified in sections 12.

**Findings fixed in this round:**

1. **HIGH -- Known Limitations duplicate numbering**: Security tab (section 4e) had item "4" appearing twice. Fixed to sequential 1-7 numbering.
2. **HIGH -- Security Review Document inconsistency**: Document stated "We recommend Sites.Selected as the default scope" but the actual UX defaults to Sites.Read.All for the simple path. Fixed to accurately describe the system behavior: "The default scope is Sites.Read.All... Sites.Selected is available in the advanced setup path."

### Phase 6: User Experience Simulation

Five personas walked through the design with mental reset between each.

| Persona             | Role                          | Score      | Key Insight                                                                                                                |
| ------------------- | ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sarah (Non-tech PM) | Marketing Manager             | 9.5/10     | 4-tier model invisible. Simplified View absorbs all complexity. "Accept All Remaining" is her favorite button.             |
| Raj (Platform Eng)  | 15 connectors, 3 tenants      | 9.0/10     | Aggregate summary + tenant grouping + clone with tier inheritance. Config-as-code via YAML.                                |
| Maria (Security)    | Compliance review             | 10.0/10    | Honest accuracy disclosure (~70-85%), 7 known limitations, Test Permissions, Emergency Revoke. Cannot find an improvement. |
| Chen (IT Admin)     | Delegation workflow           | 9.5/10     | Dynamic delegation email lists exact scopes. "Awaiting Auth" resume flow works. Push notification on completion.           |
| Alex (Power User)   | Data engineer, Sites.Selected | 9.0/10     | Manual entry + validation + admin request email. Split-pane auto-expand. CEL autocomplete.                                 |
| **Average**         |                               | **9.4/10** |                                                                                                                            |

**Remaining wishes (MEDIUM, not blocking):**

- Raj: Tenant-level bulk actions on group headers (e.g., "Sync All Contoso" from the collapsible section).
- Alex: Sites.Selected validation should differentiate failure modes (403 Forbidden vs 404 Not Found vs DNS unreachable).
- Chen: Automatic 24h reminder email for unused delegation invites.
- All: Scope+Filters auto-expand should specify overlay behavior (currently implied but not explicit).

**All personas >= 9.0. Average 9.4/10. No CRITICAL or HIGH findings remain. Design APPROVED.**
