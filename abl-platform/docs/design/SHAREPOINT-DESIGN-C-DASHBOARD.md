# Design C: Dashboard + Detail Panels — SharePoint Connector

**Date:** 2026-03-22
**Interaction Pattern:** Dashboard overview with drill-down detail panels
**Context:** Deep-dive capability matrix (32 questions, 4 rounds) + gap analysis + market research + filter system analysis (14 operators, 8 templates, OData translation, folder globs, advanced conditions)

---

## 1. Philosophy

The dashboard is the user's command center — every connector's health, status, and action surface is visible in one glance, like a monitoring tool. Setup and management happen in the same slide-over panel with progressive tabs, so adding a connector and monitoring it later are the same gesture, achieving all 9 objectives through a single interaction pattern: click a card, work in the panel, close the panel and you are back at the big picture.

The dashboard scales from 1 connector to 50+ because the primary view is a grid/table — not a wizard or a form. Smart defaults mean every new connector starts healthy with zero configuration. Transparency lives in the panel tabs: each tab shows what the system detected, what it recommends, and why. Advanced controls (CEL, globs, metadata conditions) appear inline in the same tabs — not behind a separate "advanced mode" — so the transition from simple to powerful is seamless.

---

## 2. Flow Diagram

```
                         ┌──────────────────────────────────┐
                         │        CONNECTOR DASHBOARD        │
                         │   (grid/table of all connectors)  │
                         └──────────┬───────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
             │ [+ Add New] │ │ Click Card │ │ Bulk Actions│
             └──────┬──────┘ └─────┬──────┘ └──────┬──────┘
                    │              │               │
             ┌──────▼──────────────▼──────┐  ┌─────▼──────────┐
             │   DETAIL PANEL (slide-in)  │  │ Re-auth All    │
             │   Same panel for setup     │  │ Pause All      │
             │   AND monitoring           │  │ Export Configs  │
             └──────┬─────────────────────┘  └────────────────┘
                    │
    ┌───────────────┼───────────────────────────────────┐
    │               │               │                   │
┌───▼────┐  ┌───────▼──────┐ ┌─────▼──────┐  ┌────────▼───────┐
│Connect │  │Health Check  │ │  Scope     │  │  Filters       │
│  tab   │  │  (6-axis)    │ │  tab       │  │  tab           │
└───┬────┘  └───────┬──────┘ └─────┬──────┘  └────────┬───────┘
    │               │              │                   │
    │       ┌───────▼──────┐ ┌─────▼──────┐  ┌────────▼───────┐
    │       │  Schedule    │ │Permissions │  │  Preview       │
    │       │  tab         │ │  tab       │  │  (dry-run)     │
    │       └──────────────┘ └────────────┘  └────────┬───────┘
    │                                                  │
    ▼                                                  ▼
  Auth ───► Discovery ───► Proposal ───► Approve ───► Sync
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │ Back to         │
                                              │ DASHBOARD       │
                                              │ (card = Healthy)│
                                              └────────────────┘
```

---

## 3. Dashboard Wireframe

### 3a. Card View (1-6 connectors)

The default view for small deployments. Each card is a self-contained health summary. Click any card to open its detail panel.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  SharePoint Connectors                                                        │
│  5 active · 1 warning · 0 errors               [Card ▣] [Table ≡] [+ Add]  │
│                                                                               │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐        │
│  │ Marketing Hub     │  │ Engineering Wiki  │  │ Sales Docs        │        │
│  │                   │  │                   │  │                   │        │
│  │ ● Healthy         │  │ ⚠ 3 failed docs  │  │ ◐ Syncing...      │        │
│  │                   │  │                   │  │                   │        │
│  │ 237 docs indexed  │  │ 128 docs indexed  │  │ 67 / ~120 docs    │        │
│  │ 3.2 GB · 2 sites  │  │ 1.1 GB · 1 site  │  │ 5.4 GB · 3 sites  │        │
│  │                   │  │                   │  │                   │        │
│  │ Last sync: 2h ago │  │ Last sync: 1d ago │  │ ETA: ~12 min      │        │
│  │ Next: in 4h       │  │ Next: in 23h      │  │ █████████░░░ 56%  │        │
│  │                   │  │                   │  │                   │        │
│  │ Token: ● 28d left │  │ Token: ● 28d left │  │ Token: ● 27d left │        │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘        │
│                                                                               │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─ ─ ─ ─ ─ ─ ─ ─ ─┐        │
│  │ HR Portal         │  │ Legal Vault       │  │                   │        │
│  │                   │  │                   │  │    + Add New       │        │
│  │ ● Healthy         │  │ ● Healthy         │  │    Connector      │        │
│  │                   │  │                   │  │                   │        │
│  │ 89 docs indexed   │  │ 45 docs indexed   │  │  From scratch,    │        │
│  │ 0.8 GB · 1 site   │  │ 0.2 GB · 1 site   │  │  template, or     │        │
│  │                   │  │                   │  │  clone existing    │        │
│  │ Last sync: 6h ago │  │ Last sync: 12h ago│  │                   │        │
│  │ Next: in 6h       │  │ Next: in 12h      │  └─ ─ ─ ─ ─ ─ ─ ─ ─┘        │
│  │                   │  │                   │                                │
│  │ Token: ● 25d left │  │ Token: ⚠ 3d left  │                                │
│  └───────────────────┘  └───────────────────┘                                │
│                                                                               │
│  ─── Summary ─────────────────────────────────────────────────────────────── │
│  566 docs total · 10.7 GB · 8 sites · 5 connectors · 3 failed docs          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3b. Table View (7+ connectors)

Automatically switches when connector count exceeds 6. Users can also toggle manually. Supports column sorting, row selection, and inline status indicators.

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│  SharePoint Connectors                                                                │
│  15 active · 2 warnings · 1 error             [Card ▣] [Table ≡] [+ Add]            │
│                                                                                       │
│  [🔍 Filter connectors...]  [Status: Any ▼]  [Tenant: Any ▼]  [Sort: Name ▼]       │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│  │ ☐ │ Name              │ Status    │ Docs    │ Size   │ Sites│Failures│ Token    │ │
│  │───│───────────────────│───────────│─────────│────────│──────│────────│──────────│ │
│  │ ☐ │ Marketing Hub     │ ● Healthy │ 237     │ 3.2 GB │ 2   │ 0      │ ● 28d   │ │
│  │ ☐ │ Engineering Wiki  │ ⚠ Partial │ 128     │ 1.1 GB │ 1   │ 3      │ ● 28d   │ │
│  │ ☐ │ Sales Docs        │ ◐ Syncing │ 67/120  │ 5.4 GB │ 3   │ 0      │ ● 27d   │ │
│  │ ☐ │ HR Portal         │ ● Healthy │ 89      │ 0.8 GB │ 1   │ 0      │ ● 25d   │ │
│  │ ☐ │ Legal Vault       │ ● Healthy │ 45      │ 0.2 GB │ 1   │ 0      │ ⚠ 3d    │ │
│  │ ☐ │ Finance Reports   │ ● Healthy │ 312     │ 4.1 GB │ 2   │ 0      │ ● 20d   │ │
│  │ ☐ │ Exec Comms        │ ● Healthy │ 12      │ 0.1 GB │ 1   │ 0      │ ● 18d   │ │
│  │ ☐ │ IT Knowledge      │ ✗ Failed  │ 0       │ —      │ —   │ 5      │ ✗ Expired│ │
│  │ ☐ │ Product Docs      │ ● Healthy │ 456     │ 2.8 GB │ 4   │ 0      │ ● 28d   │ │
│  │ ☐ │ Support Articles  │ ● Healthy │ 891     │ 1.2 GB │ 1   │ 0      │ ● 22d   │ │
│  │   │                   │           │         │        │      │        │          │ │
│  │   │ Showing 1-10 of 15                                       [< 1  2 >]        │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ─── Summary ─────────────────────────────────────────────────────────────────────── │
│  2,237 docs total · 18.9 GB · 16 sites · 15 connectors · 8 failed docs              │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 3c. Bulk Actions Bar

Appears when one or more rows are selected in table view:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  ☑ 3 selected                                                                │
│                                                                               │
│  [↻ Re-auth Selected]  [⏸ Pause Selected]  [▶ Resume Selected]              │
│  [🔄 Sync Now]  [📤 Export Configs]  [🗑 Delete Selected]                    │
│                                                                               │
│  [Select All (15)]  [Clear Selection]                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Setup Flow (Inside Detail Panel)

The detail panel slides in from the right (560px wide). During initial setup, it guides through configuration via tabs. After setup, the same tabs show live monitoring data. There is no mode switch.

### Panel Structure

```
┌─ Detail Panel ──────────────────────────────────────────── [×] ─┐
│                                                                   │
│  [Connector Name]                               [⋯ More Actions] │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Connect │ Health │ Scope │ Filters │ Schedule │ Perms │ ... │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [Active tab content fills the rest of the panel]                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

The overflow menu (`...`) contains: Preview (Dry-Run), Advanced, Diagnostics, Clone, Export Config, Delete.

### 4a. Connect Tab — App Registration + Auth + Delegation

This tab handles the entire connection setup. It separates app registration guidance, authentication, and admin consent into distinct, clearly labeled sections.

**Initial state (no connection):**

```
┌─ Connect ────────────────────────────────────────────────────────┐
│                                                                   │
│  Step 1: Azure App Registration                                   │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Client ID (Application ID)                       │            │
│  └──────────────────────────────────────────────────┘            │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Tenant ID (Directory ID)                         │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ▸ Don't have an app registration? (expandable)                   │
│    Step-by-step guide:                                            │
│    1. Go to Azure Portal > App Registrations > New                │
│    2. Set redirect URI: https://your-domain/api/connectors/...   │
│    3. Under API Permissions, add Microsoft Graph:                 │
│       - Sites.Selected (recommended — least privilege)            │
│       - Or Sites.Read.All (broader, simpler)                     │
│    4. Generate a client secret (for app-only auth)               │
│    [📄 Download Setup Guide PDF]                                  │
│                                                                   │
│  Step 2: Authentication Method                                    │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  (●) Device Code — share a code with the person who authenticates │
│  ( ) Browser Login — sign in with your Microsoft account now      │
│  ( ) App-Only (Client Credentials) — automated with secret        │
│                                                                   │
│  ▸ Which method should I choose? (expandable)                     │
│    Device Code: Best for delegation. Developer configures,        │
│    security team authenticates. No redirect URI needed.           │
│    Browser Login: Simplest. You authenticate right now.           │
│    App-Only: No user token. Uses app permissions only.            │
│    Requires client secret and admin-granted app permissions.      │
│                                                                   │
│                                        [Cancel]  [Connect →]     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**After clicking Connect (Device Code selected):**

```
┌─ Connect ────────────────────────────────────────────────────────┐
│                                                                   │
│  ✅ App Registration saved                                        │
│                                                                   │
│  Authenticate with Microsoft                                      │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  Enter this code at microsoft.com/devicelogin:                    │
│                                                                   │
│          ┌──────────────┐                                         │
│          │   GXKR-HTPF  │   [📋 Copy]                            │
│          └──────────────┘                                         │
│                                                                   │
│  [Open Microsoft Login ↗]                                         │
│                                                                   │
│  ─── Need someone else to authenticate? ─────────────────────── │
│                                                                   │
│  [📤 Share Authentication Request]                                │
│  Copies a message with code + link + instructions + expiry.       │
│  Send this to your IT admin or security team.                     │
│                                                                   │
│  ⏱ Code expires in 13:42                            ● Waiting... │
│                                                                   │
│  Note: Entering the device code signs you in. It does NOT         │
│  grant admin consent. Admin consent (if needed for                │
│  Sites.Read.All) is a separate step after authentication.         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**After successful authentication:**

```
┌─ Connect ────────────────────────────────────────────────────────┐
│                                                                   │
│  ✅ Connected                                                     │
│                                                                   │
│  Authenticated by: sarah@contoso.com                              │
│  Method: Device Code                                              │
│  Token expires: Apr 19, 2026 (28 days)                            │
│  Scopes granted: Sites.Read.All, offline_access                  │
│                                                                   │
│  [↻ Re-authenticate]  [📤 Delegate Re-auth]                      │
│                                                                   │
│  ─── Admin Consent ──────────────────────────────────────────── │
│                                                                   │
│  ✅ Admin consent granted for Sites.Read.All                      │
│  Granted by: admin@contoso.com on Mar 20, 2026                   │
│                                                                   │
│  ─── Connection History ─────────────────────────────────────── │
│                                                                   │
│  Mar 22 14:30  Token refreshed automatically                     │
│  Mar 22 10:15  Authenticated via device code (sarah@contoso.com) │
│  Mar 22 10:12  Connector created                                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 4b. Health Check — 6-Axis Validation (Inline in Panel)

The Health tab runs automatically after authentication and is available on demand afterward. It checks 6 axes and shows pass/fail with remediation for each failure.

```
┌─ Health ─────────────────────────────────────────────────────────┐
│                                                                   │
│  Connection Health Check                     [↻ Re-run Checks]   │
│  Last run: 2 seconds ago                                          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                                                             │ │
│  │  1. Authentication        ✅ Pass                           │ │
│  │     Token valid, expires in 28 days                         │ │
│  │                                                             │ │
│  │  2. Graph API Access      ✅ Pass                           │ │
│  │     Microsoft Graph v1.0 reachable, 45ms latency            │ │
│  │                                                             │ │
│  │  3. Site Access           ✅ Pass                           │ │
│  │     5 of 5 selected sites accessible                        │ │
│  │                                                             │ │
│  │  4. Drive Enumeration     ✅ Pass                           │ │
│  │     8 drives found across 5 sites                           │ │
│  │                                                             │ │
│  │  5. File Download         ✅ Pass                           │ │
│  │     Sample file downloaded successfully (234ms)             │ │
│  │                                                             │ │
│  │  6. Permission Scope      ⚠ Partial                        │ │
│  │     Sites.Read.All granted (can read all sites)             │ │
│  │     Directory.Read.All missing (group membership)           │ │
│  │     Impact: Permission-based search unavailable             │ │
│  │     [📄 Download Permission Request Document]               │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Result: 5 passed · 1 partial · 0 failed                         │
│  Your connector is ready to sync.                                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**When a check fails:**

```
│  │  1. Authentication        ✗ Failed                          │ │
│  │     Token expired on Mar 20, 2026                           │ │
│  │                                                             │ │
│  │     What to do:                                             │ │
│  │     The OAuth token has expired and automatic refresh       │ │
│  │     failed. This usually means the refresh token was        │ │
│  │     revoked or the app registration was modified.           │ │
│  │                                                             │ │
│  │     [↻ Re-authenticate Now]  [📤 Delegate Re-auth]         │ │
```

### 4c. Scope Tab — Auto-Discovered Sites with Recommendations

During setup, this tab shows discovery results and the system's recommendations. After setup, it shows what is currently being synced with live stats.

**During setup (discovery in progress):**

```
┌─ Scope ──────────────────────────────────────────────────────────┐
│                                                                   │
│  Discovering your SharePoint environment...                       │
│                                                                   │
│  ✅ 5 sites found                                                 │
│  ████████████████░░░░  Profiling content...  4 of 5 sites         │
│                                                                   │
│  Sites discovered so far:                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Site               │ Files  │ Size    │ Last Updated    │    │
│  │─────────────────────│────────│─────────│─────────────────│    │
│  │  Marketing Hub      │ ~240   │ 3.2 GB  │ 2 days ago      │    │
│  │  Engineering Wiki   │ ~130   │ 1.1 GB  │ today           │    │
│  │  Sales Docs         │ ~120   │ 5.4 GB  │ 1 week ago      │    │
│  │  HR Portal          │ ~90    │ 0.8 GB  │ 3 days ago      │    │
│  │  ░░░ Profiling...   │        │         │                 │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  [Cancel Discovery]  [Use what we found so far →]                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**After discovery (proposal view):**

```
┌─ Scope ──────────────────────────────────────────────────────────┐
│                                                                   │
│  What to Sync                                                     │
│  The system analyzed your environment and recommends:             │
│                                                                   │
│  Sites   (●) All 5 sites  ( ) Selected  ( ) Exclude specific     │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ ☑ │ Site              │ Files │ Size   │ Updated  │ Score    ││
│  │───│───────────────────│───────│────────│──────────│──────────││
│  │ ☑ │ Marketing Hub     │ 242   │ 3.2 GB │ 2d ago   │ ⭐ 92   ││
│  │ ☑ │ Engineering Wiki  │ 128   │ 1.1 GB │ today    │ ⭐ 88   ││
│  │ ☑ │ Sales Docs        │ 120   │ 5.4 GB │ 1w ago   │ ⭐ 85   ││
│  │ ☑ │ HR Portal         │ 89    │ 0.8 GB │ 3d ago   │ 72      ││
│  │ ☐ │ IT Infrastructure │ 3     │ 0.1 GB │ 6mo ago  │ 15      ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ⭐ = Recommended (active content, rich document types)           │
│  Score: Activity 30% + Size 20% + Content 20% - Sensitivity 30%  │
│                                                                   │
│  ▸ Why was IT Infrastructure not recommended? (expandable)        │
│    Only 3 files, last updated 6 months ago. Low activity and      │
│    minimal content volume. You can still include it.              │
│                                                                   │
│  Libraries: (●) All libraries  ( ) Selected                      │
│  Content types: ☑ Files  ☑ SharePoint Pages                      │
│                                                                   │
│  ─── Advanced: Manual Site Entry ────────────────────────────── │
│                                                                   │
│  Add sites by URL (for Sites.Selected or unlisted sites):        │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ https://contoso.sharepoint.com/sites/...                 │    │
│  └──────────────────────────────────────────────────────────┘    │
│  [+ Add Site URL]                                                 │
│                                                                   │
│  Estimated sync: ~579 documents · ~10.6 GB · ~25 min             │
│                                                                   │
│                               [Save Scope]  [Save & Preview →]   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 4d. Filters Tab — Smart Defaults, Expandable to Advanced

Shows the current filter configuration with smart defaults applied. Every section expands to reveal full control.

```
┌─ Filters ────────────────────────────────────────────────────────┐
│                                                                   │
│  Filter Configuration                                             │
│  Using: SharePoint defaults (27 file types)     [Reset Defaults] │
│                                                                   │
│  ─── File Types ─────────────────────────────────────────────── │
│                                                                   │
│  ☑ Documents   pdf docx pptx xlsx odt rtf                        │
│  ☑ Text        txt csv tsv md html xml json yaml                 │
│  ☑ Email       eml msg                                           │
│  ☑ Other       sql log rst                                       │
│  ☐ Images      png jpg gif svg (not indexed by default)          │
│                                                                   │
│  Your content breakdown:                                          │
│  60% PDF · 25% DOCX · 10% PPTX · 5% other                       │
│  3 unsupported files will be skipped: 2 .vsdx, 1 .mp4            │
│                                                                   │
│  Executables (.exe, .dll, .bat, etc.) are always blocked.        │
│                                                                   │
│  ─── Folder Rules ───────────────────────────────────────────── │
│                                                                   │
│  No folder restrictions (sync all folders)         [Add Rules]   │
│                                                                   │
│  Quick templates:                                                 │
│  [Exclude Archives]  [Exclude Backups]  [Exclude _private]       │
│                                                                   │
│  ▸ Custom folder patterns (expandable)                            │
│    Include patterns (glob):                                       │
│    ┌──────────────────────────────────────────────┐              │
│    │ e.g. /sites/*/Shared Documents/**            │              │
│    └──────────────────────────────────────────────┘              │
│    Exclude patterns (glob):                                       │
│    ┌──────────────────────────────────────────────┐              │
│    │ e.g. **/Archive/**, **/Backup/**             │              │
│    └──────────────────────────────────────────────┘              │
│                                                                   │
│  ─── Size Limits ────────────────────────────────────────────── │
│                                                                   │
│  Min: [0 KB      ]  Max: [100 MB    ]  (default: 0-100MB)       │
│                                                                   │
│  ─── Date Range ─────────────────────────────────────────────── │
│                                                                   │
│  Modified after: [No limit     ]  Modified before: [No limit  ]  │
│                                                                   │
│  ─── Advanced Conditions ────────────────────────────────────── │
│                                                                   │
│  ▸ Metadata conditions (expandable)                               │
│    Add conditions on SharePoint metadata columns:                 │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │ Field: [metadata.sharepoint.Department ▼]                │  │
│    │ Operator: [equals ▼]                                     │  │
│    │ Value: [Engineering                    ]                 │  │
│    └──────────────────────────────────────────────────────────┘  │
│    [+ Add Condition]                                              │
│                                                                   │
│  ▸ CEL expression editor (expandable)                             │
│    For complex logic combining multiple conditions:               │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │ resource.size < 50000000 &&                              │  │
│    │ resource.name.endsWith('.pdf') &&                        │  │
│    │ resource.metadata.department == 'Engineering'            │  │
│    └──────────────────────────────────────────────────────────┘  │
│    [Validate Expression]  [📖 CEL Reference]                     │
│                                                                   │
│  ─── Pre-fetch vs Post-fetch ────────────────────────────────── │
│                                                                   │
│  ℹ Filters labeled "Reduces API calls" are evaluated             │
│  server-side via OData before downloading. Filters labeled       │
│  "Evaluates locally" download metadata first, then filter.       │
│  This affects sync speed for large sites.                         │
│                                                                   │
│                               [Save Filters]  [Run Preview →]   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 4e. Schedule Tab — Frequency + Webhooks

```
┌─ Schedule ───────────────────────────────────────────────────────┐
│                                                                   │
│  Sync Schedule                                                    │
│                                                                   │
│  ─── Automatic Sync ─────────────────────────────────────────── │
│                                                                   │
│  Frequency: [Every 6 hours    ▼]                                 │
│                                                                   │
│  Options:                                                         │
│  ( ) Every 1 hour     — highest freshness, most API usage        │
│  ( ) Every 3 hours                                                │
│  (●) Every 6 hours    — recommended balance                      │
│  ( ) Every 12 hours                                               │
│  ( ) Every 24 hours   — lowest API usage                         │
│  ( ) Custom cron: [____________]                                  │
│  ( ) Manual only   — no automatic sync                           │
│                                                                   │
│  Next scheduled sync: Mar 22, 2026 at 20:30 (in 4h 12m)         │
│                                                                   │
│  ─── Real-Time Updates (Webhooks) ───────────────────────────── │
│                                                                   │
│  Status: ⚠ Not available                                         │
│                                                                   │
│  SharePoint webhooks would provide near-instant updates when      │
│  content changes. This feature requires:                          │
│  - Publicly accessible callback URL                               │
│  - Webhook routes to be enabled (currently disabled)             │
│                                                                   │
│  When available: changes in SharePoint trigger sync within        │
│  minutes instead of waiting for the next scheduled sync.         │
│                                                                   │
│  ─── Sync Controls ──────────────────────────────────────────── │
│                                                                   │
│  [▶ Sync Now (Delta)]  [▶ Full Re-sync]  [⏸ Pause Auto-Sync]   │
│                                                                   │
│  ─── Auto-Pause on Failures ─────────────────────────────────── │
│                                                                   │
│  Auto-pause after: [5] consecutive failures                      │
│  Current consecutive failures: 0                                  │
│  If paused, resume requires manual action or re-authentication.  │
│                                                                   │
│                                                    [Save Schedule]│
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 4f. Permissions Tab — Detection, Negotiation, Security Review

```
┌─ Permissions ────────────────────────────────────────────────────┐
│                                                                   │
│  Permission & Security Configuration                              │
│                                                                   │
│  ─── Granted Scopes ─────────────────────────────────────────── │
│                                                                   │
│  Your OAuth token has these Microsoft Graph permissions:          │
│                                                                   │
│  ✅ Sites.Read.All       Read all site collections                │
│  ✅ offline_access        Maintain access (refresh token)         │
│  ⬚ Directory.Read.All   Read directory data (not granted)        │
│  ⬚ Sites.FullControl.All  Full control (not granted)             │
│                                                                   │
│  ─── Permission-Based Search ────────────────────────────────── │
│                                                                   │
│  Mode: [Simplified ▼]                                            │
│                                                                   │
│  ( ) Full — crawl all ACLs, enforce per-user search results      │
│      Requires: Sites.FullControl.All, Directory.Read.All         │
│  (●) Simplified — respect site-level permissions only            │
│      Uses: Sites.Read.All (current permissions)                  │
│  ( ) Disabled — no permission enforcement on search results      │
│      All authenticated users see all synced content              │
│                                                                   │
│  ▸ What does each mode mean? (expandable)                         │
│    Full: Crawls SharePoint ACLs (item, folder, site, group       │
│    membership). Search results filtered per-user. Most secure    │
│    but requires elevated permissions and Neo4j.                  │
│    Simplified: Checks site membership only. Users with site      │
│    access see all content from that site.                        │
│    Disabled: All synced content visible to all KB users.         │
│                                                                   │
│  ─── Permission Upgrade ─────────────────────────────────────── │
│                                                                   │
│  To enable Full permission-based search, you need additional     │
│  Microsoft Graph permissions.                                     │
│                                                                   │
│  Three options:                                                   │
│                                                                   │
│  (a) Request security approval                                    │
│      [📄 Download Security Review Document]                       │
│      Contains: permission justifications, data handling scope,   │
│      retention policy, token rotation guidance, risk assessment.  │
│      Share with your security team for approval.                 │
│                                                                   │
│  (b) Grant permissions now                                        │
│      If you have Azure AD admin access:                          │
│      [Open Azure Portal → API Permissions ↗]                     │
│      After granting, click [↻ Re-check Permissions]              │
│                                                                   │
│  (c) Continue without upgrade                                     │
│      Simplified permission mode works with current scopes.       │
│      You can upgrade later without re-syncing.                   │
│                                                                   │
│  ─── Security Review Document ──────────────────────────────── │
│                                                                   │
│  The downloadable Security Review Document contains:             │
│                                                                   │
│  1. Permission Justifications — why each Graph scope is needed,  │
│     what data it accesses, and what it cannot access.            │
│  2. Data Handling Scope — what content is downloaded, where it   │
│     is stored (encrypted at rest), and what is never stored      │
│     (e.g., file contents are chunked, originals are not kept).   │
│  3. Retention Policy — how long synced content, delta tokens,    │
│     and OAuth tokens are retained. Automatic cleanup schedules.  │
│  4. Token Rotation Guidance — recommended refresh intervals,     │
│     how to revoke tokens, and what happens when tokens expire.   │
│  5. Risk Assessment — attack surface analysis, blast radius      │
│     of a compromised token, and mitigations in place.            │
│  6. Revocation Procedures — step-by-step instructions to         │
│     revoke app access, delete synced data, and audit trail.      │
│  7. Compliance Mapping — how the connector maps to SOC 2,        │
│     GDPR, and organizational data governance policies.           │
│                                                                   │
│  ─── Permission Crawl Status ────────────────────────────────── │
│                                                                   │
│  Last crawl: Mar 21, 2026 at 03:00 (automatic)                  │
│  Next scheduled: Mar 28, 2026 at 03:00                           │
│  Status: ● Complete — 5 sites, 8 drives, 1,247 ACL entries      │
│                                                                   │
│  [🔄 Crawl Now]  [View Permission Graph ↗]                       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 4g. Preview Tab — Dry-Run with Sample Documents

Accessible from the overflow menu (`...` > Preview) or from the "Save & Preview" button on the Scope and Filters tabs.

```
┌─ Preview (Dry-Run) ──────────────────────────────────────────────┐
│                                                                   │
│  Sync Preview                                                     │
│  Showing what WOULD be synced with current configuration.        │
│  No data will be downloaded or indexed.                           │
│                                                                   │
│  ─── Summary ────────────────────────────────────────────────── │
│                                                                   │
│  Would sync:    ~523 documents across 4 sites                    │
│  Would skip:    ~56 documents (filter rules)                     │
│  Estimated size: ~10.2 GB                                        │
│  Estimated time: ~22 minutes                                     │
│                                                                   │
│  ─── Sample Documents (25 of ~523) ──────────────────────────── │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Name                       │ Site          │ Type │ Size  │  │
│  │────────────────────────────│───────────────│──────│───────│  │
│  │ Q1 Financial Report.pdf   │ Marketing Hub │ PDF  │ 2.4MB │  │
│  │ Product Roadmap 2026.docx │ Eng Wiki      │ DOCX │ 1.1MB │  │
│  │ Sales Playbook.pptx       │ Sales Docs    │ PPTX │ 5.2MB │  │
│  │ Employee Handbook.pdf     │ HR Portal     │ PDF  │ 3.8MB │  │
│  │ API Documentation.md      │ Eng Wiki      │ MD   │ 0.2MB │  │
│  │ ... 20 more shown below                                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ─── Skipped Documents (showing first 10 of ~56) ────────────── │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Name                     │ Reason                         │  │
│  │──────────────────────────│────────────────────────────────│  │
│  │ team-photo.png           │ File type excluded (image)     │  │
│  │ demo-recording.mp4       │ Unsupported format             │  │
│  │ legacy-backup.zip        │ File type excluded (archive)   │  │
│  │ Archive/2019-report.pdf  │ Folder rule: **/Archive/**     │  │
│  │ draft_v0.1.docx          │ Size < minimum (0.5KB)         │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ─── Content Type Breakdown ─────────────────────────────────── │
│                                                                   │
│  PDF   ██████████████████████████████  312 (60%)                 │
│  DOCX  ████████████                    131 (25%)                 │
│  PPTX  █████                            52 (10%)                 │
│  Other ██                               28 (5%)                  │
│                                                                   │
│                              [← Adjust Filters]  [Approve →]    │
│                                                                   │
│  Approve starts the first sync with this configuration.          │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 5. Monitoring (Same Panel, Same Tabs) — Post-Setup

After the connector is set up and syncing, every tab in the detail panel shifts from configuration to monitoring mode. The tabs are the same, the structure is the same, but the content now shows live data.

### 5a. Overview (default tab after setup replaces Connect)

The Connect tab transforms into an Overview tab once setup is complete.

```
┌─ Overview ───────────────────────────────────────────────────────┐
│                                                                   │
│  Marketing Hub                                  ● Healthy        │
│  Connected Mar 22 · Authenticated by sarah@contoso.com           │
│                                                                   │
│  ─── Content Breakdown ──────────────────────────────────────── │
│                                                                   │
│  237 documents indexed · 3.2 GB · 2 sites · 8 drives            │
│                                                                   │
│  By type:                                                         │
│  PDF   ██████████████████████████████  142 (60%)                 │
│  DOCX  ████████████                     59 (25%)                 │
│  PPTX  █████                            24 (10%)                 │
│  Other ██                               12 (5%)                  │
│                                                                   │
│  By site:                                                         │
│  Marketing Hub main    185 docs · 2.1 GB                         │
│  Marketing Hub archive  52 docs · 1.1 GB                         │
│                                                                   │
│  ─── Sync History ───────────────────────────────────────────── │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Date              │ Type  │ Docs   │ Duration │ Status   │   │
│  │───────────────────│───────│────────│──────────│──────────│   │
│  │ Mar 22, 14:30     │ Delta │ +3, -1 │ 45s      │ ● Done   │   │
│  │ Mar 22, 08:30     │ Delta │ +0     │ 12s      │ ● Done   │   │
│  │ Mar 21, 20:30     │ Delta │ +7, ~2 │ 2m 15s   │ ● Done   │   │
│  │ Mar 21, 14:30     │ Delta │ +1     │ 18s      │ ● Done   │   │
│  │ Mar 20, 10:15     │ Full  │ 237    │ 24m 30s  │ ● Done   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ─── Issues ─────────────────────────────────────────────────── │
│                                                                   │
│  No issues.                                                       │
│                                                                   │
│  ─── Quick Actions ──────────────────────────────────────────── │
│                                                                   │
│  [▶ Sync Now]  [⏸ Pause]  [↻ Re-auth]  [📄 View Documents]     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 5b. Scope Tab (Monitoring Mode)

Shows what is being synced with live document counts per site.

```
┌─ Scope (Live) ───────────────────────────────────────────────────┐
│                                                                   │
│  Currently Syncing                                [Edit Scope]   │
│                                                                   │
│  4 of 5 sites selected · All libraries · Files + Pages           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Site              │ Docs   │ Size   │ Last Delta │ Drift │   │
│  │───────────────────│────────│────────│────────────│───────│   │
│  │ Marketing Hub     │ 142    │ 2.1 GB │ 2h ago     │ +3   │   │
│  │ Engineering Wiki  │ 128    │ 1.1 GB │ 2h ago     │ +0   │   │
│  │ Sales Docs        │ 120    │ 5.4 GB │ 2h ago     │ +7   │   │
│  │ HR Portal         │ 89     │ 0.8 GB │ 2h ago     │ +1   │   │
│  │ (IT Infra)        │ —      │ —      │ excluded   │ —    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  Drift: documents changed at source since last sync.             │
│                                                                   │
│  ─── Per-Drive Delta Tokens ─────────────────────────────────── │
│                                                                   │
│  ▸ Marketing Hub — 3 drives (expandable)                          │
│    Documents:     token Mar 22 14:30 · valid                     │
│    Site Assets:   token Mar 22 14:30 · valid                     │
│    Site Pages:    token Mar 22 14:30 · valid                     │
│    [Reset Delta Tokens] — forces full re-sync of this site       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 5c. Filters Tab (Monitoring Mode)

Shows active filter rules with live match counts.

```
┌─ Filters (Live) ─────────────────────────────────────────────────┐
│                                                                   │
│  Active Filter Rules                              [Edit Filters] │
│                                                                   │
│  File types: 27 types included                                    │
│    Matched:  479 documents                                        │
│    Skipped:  44 documents (unsupported types)                    │
│                                                                   │
│  Folder rules: Exclude **/Archive/**, **/Backup/**               │
│    Excluded: 12 documents                                        │
│                                                                   │
│  Size limits: 0 KB - 100 MB                                      │
│    Excluded: 0 documents                                         │
│                                                                   │
│  Date range: No restrictions                                      │
│                                                                   │
│  ─── Filter Effectiveness ───────────────────────────────────── │
│                                                                   │
│  Source total:  ~579 files at source                              │
│  After filters: 523 files pass (90%)                             │
│  Skipped:       56 files excluded (10%)                          │
│                                                                   │
│  Top skip reasons:                                                │
│  Unsupported type    32 (57%)                                    │
│  Folder excluded     12 (21%)                                    │
│  File type excluded  12 (21%)                                    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 5d. Health Tab (Monitoring Mode)

Same 6-axis check, available on demand. Shows last check results and allows re-running.

```
┌─ Health (Live) ──────────────────────────────────────────────────┐
│                                                                   │
│  Connection Diagnostics                          [↻ Run Checks]  │
│  Last checked: 6 hours ago (automatic)                           │
│                                                                   │
│  1. Authentication   ✅ Token valid (28 days remaining)           │
│  2. Graph API        ✅ Reachable (38ms)                          │
│  3. Site Access      ✅ 4/4 sites accessible                      │
│  4. Drive Enum       ✅ 8 drives found                            │
│  5. File Download    ✅ Sample download OK (187ms)                │
│  6. Permissions      ⚠ Simplified mode (upgrade available)       │
│                                                                   │
│  ─── API Quota Usage ────────────────────────────────────────── │
│                                                                   │
│  Graph API calls today: 1,247 of ~20,000 throttle threshold      │
│  ████░░░░░░░░░░░░░░░░  6%                                       │
│                                                                   │
│  ─── Latency Trend ──────────────────────────────────────────── │
│                                                                   │
│  Graph API response time (last 24h):                             │
│  avg 42ms · p95 180ms · p99 450ms                                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 6. Templates and Clone

### 6a. Add New Connector — Source Selection

When clicking [+ Add] on the dashboard, a dialog offers three paths:

```
┌─ Add SharePoint Connector ───────────────────────────────── [×] ─┐
│                                                                    │
│  How would you like to set up this connector?                      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  🔧 From Scratch                                             │ │
│  │  Connect a new SharePoint tenant with fresh configuration.   │ │
│  │  The system will auto-discover and recommend settings.       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  📋 From Template                                            │ │
│  │  Start with a predefined configuration template.             │ │
│  │                                                              │ │
│  │  Available templates:                                        │ │
│  │  ● Standard (Sites.Read.All, 27 types, 6h sync)             │ │
│  │  ● Minimal (Sites.Selected, docs only, 24h sync)            │ │
│  │  ● Full Control (all perms, all types, 1h sync, ACL crawl)  │ │
│  │  ● Custom... (import JSON)                                   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  📑 Clone Existing                                           │ │
│  │  Copy configuration from an existing connector.              │ │
│  │  Auth credentials are NOT cloned — you will re-authenticate. │ │
│  │                                                              │ │
│  │  Clone from:                                                 │ │
│  │  [Marketing Hub           ▼]                                 │ │
│  │                                                              │ │
│  │  What is cloned: filter config, schedule, permission mode,   │ │
│  │  file types, folder rules, size limits.                      │ │
│  │  What is NOT cloned: auth tokens, site selection,            │ │
│  │  sync history, documents.                                    │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  📥 Import Configuration                                     │ │
│  │  Upload a JSON config file exported from another connector   │ │
│  │  or environment.                                             │ │
│  │                                                              │ │
│  │  [Choose File...]  or drag and drop                          │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 6b. Export Configuration

Available from the detail panel overflow menu or bulk actions bar.

```
┌─ Export Configuration ───────────────────────────────────── [×] ─┐
│                                                                    │
│  Export: Marketing Hub                                             │
│                                                                    │
│  Format: (●) JSON  ( ) YAML                                       │
│                                                                    │
│  What is exported:                                                 │
│  ☑ Filter configuration (file types, folder rules, conditions)    │
│  ☑ Schedule (frequency, auto-pause threshold)                     │
│  ☑ Permission mode                                                │
│  ☑ Scope (site selection, libraries, content types)               │
│  ☐ App registration details (Client ID, Tenant ID)               │
│                                                                    │
│  What is NEVER exported (security):                               │
│  ✗ OAuth tokens, client secrets, refresh tokens                   │
│  ✗ Sync history, document data                                    │
│  ✗ Delta tokens, checkpoint data                                  │
│                                                                    │
│                              [Cancel]  [📥 Download JSON]         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 7. Config Version History (Inside Advanced Tab)

The Advanced tab in the detail panel (accessible via overflow menu: `...` > Advanced) contains config versioning, raw JSON view, and API quota details.

```
┌─ Advanced ───────────────────────────────────────────────────────┐
│                                                                   │
│  ─── Configuration Version History ──────────────────────────── │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Version │ Date              │ Changed By    │ Summary    │   │
│  │─────────│───────────────────│───────────────│────────────│   │
│  │ v5      │ Mar 22, 14:00    │ sarah@co.com  │ Added      │   │
│  │ (current)                   │               │ folder     │   │
│  │         │                   │               │ exclusion  │   │
│  │ v4      │ Mar 21, 10:30    │ sarah@co.com  │ Changed    │   │
│  │         │                   │               │ schedule   │   │
│  │         │                   │               │ to 6h      │   │
│  │ v3      │ Mar 20, 16:00    │ system        │ Applied    │   │
│  │         │                   │               │ quick-     │   │
│  │         │                   │               │ setup rec  │   │
│  │ v2      │ Mar 20, 15:55    │ system        │ Discovery  │   │
│  │         │                   │               │ complete   │   │
│  │ v1      │ Mar 20, 10:15    │ sarah@co.com  │ Created    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [View Diff: v4 → v5]  [Restore v4]                             │
│                                                                   │
│  ─── Raw Configuration (JSON) ───────────────────────────────── │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ {                                                         │   │
│  │   "name": "Marketing Hub",                                │   │
│  │   "provider": "sharepoint",                               │   │
│  │   "tenantId": "abc123-...",                               │   │
│  │   "clientId": "def456-...",                               │   │
│  │   "authMethod": "device_code",                            │   │
│  │   "filterConfig": {                                       │   │
│  │     "fileTypes": ["pdf", "docx", ...],                    │   │
│  │     "folderExclude": ["**/Archive/**"],                   │   │
│  │     ...                                                   │   │
│  │   },                                                      │   │
│  │   "schedule": { "frequency": "6h" },                      │   │
│  │   ...                                                     │   │
│  │ }                                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│  [📋 Copy JSON]  [📤 Export]  [📥 Import & Replace]             │
│                                                                   │
│  ─── API Quota & Rate Limits ────────────────────────────────── │
│                                                                   │
│  Microsoft Graph throttle limit: ~20,000 requests/10min          │
│  Current usage: 1,247 requests in last 10 min (6%)              │
│  Throttle events today: 0                                        │
│  Throttle events this week: 2 (Mar 19, Mar 20)                  │
│                                                                   │
│  ─── Danger Zone ────────────────────────────────────────────── │
│                                                                   │
│  [Reset All Delta Tokens]  — forces full re-sync of all sites   │
│  [Revoke OAuth Token]      — disconnects from SharePoint         │
│  [Delete Connector]        — removes connector and all data      │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 7a. Destructive Action Confirmation

All Danger Zone actions require a confirmation dialog. The dialog names the action, explains its impact, and requires typing the connector name to confirm deletion.

```
┌─ Confirm: Delete Connector ────────────────────────────── [×] ─┐
│                                                                   │
│  ⚠  This action cannot be undone                                 │
│                                                                   │
│  Deleting "Marketing Hub" will:                                   │
│  • Remove 237 indexed documents from the knowledge base          │
│  • Delete all sync history and configuration versions            │
│  • Revoke the OAuth token                                        │
│  • Remove all associated delta tokens and checkpoints            │
│                                                                   │
│  Type the connector name to confirm:                             │
│  ┌──────────────────────────────────────────────────┐            │
│  │                                                  │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│                              [Cancel]  [Delete Connector]        │
│                              (Delete button disabled until name   │
│                               matches exactly)                   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

For "Revoke OAuth Token" and "Reset All Delta Tokens," a simpler confirmation is used (no name typing required):

```
┌─ Confirm: Revoke OAuth Token ──────────────────────────── [×] ─┐
│                                                                   │
│  ⚠  Are you sure?                                                │
│                                                                   │
│  Revoking the OAuth token for "Marketing Hub" will:              │
│  • Stop all automatic syncs immediately                          │
│  • Require re-authentication to resume syncing                   │
│  • Existing indexed content will remain searchable               │
│                                                                   │
│                              [Cancel]  [Revoke Token]            │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 8. Error States

Every error state has a dedicated wireframe. Each shows what happened, why, and what the user can do.

### 8a. Auth Failure (Invalid Credentials)

```
┌─ Connect ────────────────────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ✗  Authentication Failed                                │   │
│  │                                                          │   │
│  │  Microsoft returned: AADSTS700016 — Application with     │   │
│  │  identifier 'abc123...' was not found in directory        │   │
│  │  'contoso.onmicrosoft.com'.                              │   │
│  │                                                          │   │
│  │  This usually means:                                     │   │
│  │  • The Client ID is incorrect                            │   │
│  │  • The App Registration was deleted                      │   │
│  │  • The Tenant ID doesn't match the App Registration      │   │
│  │                                                          │   │
│  │  What to do:                                             │   │
│  │  1. Verify Client ID in Azure Portal > App Registrations │   │
│  │  2. Verify Tenant ID matches the directory               │   │
│  │  3. Check the app hasn't been deleted                    │   │
│  │                                                          │   │
│  │  [Edit Connection Details]  [📤 Share Error with Admin]  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8b. Discovery Timeout (1000+ Sites)

```
┌─ Scope ──────────────────────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⚠  Discovery is taking longer than expected              │   │
│  │                                                          │   │
│  │  Found 847 sites so far (still scanning...)              │   │
│  │  Elapsed: 3 minutes 42 seconds                           │   │
│  │                                                          │   │
│  │  Large SharePoint environments can have thousands of     │   │
│  │  sites. You can:                                         │   │
│  │                                                          │   │
│  │  [Use 847 sites found so far]                            │   │
│  │  Continue setup with what's been discovered. You can     │   │
│  │  re-run discovery later to find more.                    │   │
│  │                                                          │   │
│  │  [Keep waiting...]                                       │   │
│  │  Discovery will complete — it's enumerating all sites.   │   │
│  │                                                          │   │
│  │  [Cancel and enter sites manually]                       │   │
│  │  Paste SharePoint site URLs directly if you know which   │   │
│  │  sites you want.                                         │   │
│  │                                                          │   │
│  │  [Search discovered sites: ____________]                 │   │
│  │  Filter the 847 sites already found.                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8c. Sync Failure

```
┌─ Overview ───────────────────────────────────────────────────────┐
│                                                                   │
│  Marketing Hub                                  ✗ Sync Failed    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ✗  Last sync failed                                     │   │
│  │                                                          │   │
│  │  Started: Mar 22, 14:30                                  │   │
│  │  Failed after: 12 minutes (processed 145 of ~237 docs)  │   │
│  │                                                          │   │
│  │  Error: Graph API returned 503 Service Unavailable for   │   │
│  │  drive 'Documents' on site 'Marketing Hub'.              │   │
│  │  SharePoint may be experiencing an outage.               │   │
│  │                                                          │   │
│  │  145 documents were synced successfully before failure.  │   │
│  │  Your existing index is intact — no data was lost.       │   │
│  │                                                          │   │
│  │  What to do:                                             │   │
│  │  • Check Microsoft 365 Service Health for outages        │   │
│  │  • The next automatic sync will retry in 6 hours         │   │
│  │  • Or retry now (will resume from checkpoint):           │   │
│  │                                                          │   │
│  │  [↻ Retry Now]  [View Full Error Log]                    │   │
│  │                                                          │   │
│  │  Consecutive failures: 1 of 5 (auto-pause at 5)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8d. Token Expiry

```
┌─ Dashboard Card ─────────────────┐
│  Marketing Hub                    │
│                                   │
│  ⚠ Token expires in 3 days       │
│                                   │
│  237 docs · Last sync 2h ago     │
│  [↻ Re-authenticate]            │
└───────────────────────────────────┘

┌─ Connect (detail panel) ─────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⚠  Token expiring soon                                  │   │
│  │                                                          │   │
│  │  Your OAuth token expires in 3 days (Mar 25, 2026).     │   │
│  │  Automatic refresh failed — the refresh token may have   │   │
│  │  been revoked or the app registration was modified.      │   │
│  │                                                          │   │
│  │  If the token expires:                                   │   │
│  │  • Automatic syncs will stop                             │   │
│  │  • Existing indexed content remains searchable           │   │
│  │  • New content won't be synced until re-authenticated    │   │
│  │                                                          │   │
│  │  [↻ Re-authenticate Now]  [📤 Delegate Re-auth]         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**After token has expired:**

```
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ✗  Token expired                                        │   │
│  │                                                          │   │
│  │  Your OAuth token expired on Mar 25, 2026.              │   │
│  │  Syncs are paused. Existing content is still searchable. │   │
│  │                                                          │   │
│  │  [↻ Re-authenticate Now]  [📤 Delegate Re-auth]         │   │
│  └──────────────────────────────────────────────────────────┘   │
```

### 8e. Permission Revoked

```
┌─ Health ─────────────────────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ✗  Permissions revoked                                   │   │
│  │                                                          │   │
│  │  The app registration's permissions were changed in      │   │
│  │  Azure AD. Previously granted scopes are no longer       │   │
│  │  available.                                              │   │
│  │                                                          │   │
│  │  Before:  Sites.Read.All, offline_access                 │   │
│  │  Now:     offline_access only                            │   │
│  │                                                          │   │
│  │  Impact:                                                 │   │
│  │  • Cannot read any SharePoint content                    │   │
│  │  • Syncs will fail until permissions are restored        │   │
│  │  • Existing indexed content remains searchable           │   │
│  │                                                          │   │
│  │  What to do:                                             │   │
│  │  1. Check Azure Portal > App Registrations > Permissions │   │
│  │  2. Re-grant Sites.Read.All (or Sites.Selected)          │   │
│  │  3. Admin must re-consent after permission changes       │   │
│  │                                                          │   │
│  │  [📄 Download Permission Request Doc]                    │   │
│  │  [↻ Re-check Permissions]                                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8f. Throttled (429 — Graph API Rate Limit)

```
┌─ Overview ───────────────────────────────────────────────────────┐
│                                                                   │
│  Marketing Hub                                  ⚠ Throttled      │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⚠  Microsoft Graph API throttling                        │   │
│  │                                                          │   │
│  │  Sync paused — Microsoft is rate-limiting API requests.  │   │
│  │  This is normal during large syncs or when multiple      │   │
│  │  connectors sync simultaneously.                         │   │
│  │                                                          │   │
│  │  Retry-After: 45 seconds                                 │   │
│  │  Sync will automatically resume at 14:31:15              │   │
│  │                                                          │   │
│  │  Progress before throttle:                               │   │
│  │  ████████████████░░░░  167 / 237 docs (70%)              │   │
│  │                                                          │   │
│  │  Throttle events today: 3                                │   │
│  │  Throttle events this week: 7                            │   │
│  │                                                          │   │
│  │  If throttling is frequent, consider:                    │   │
│  │  • Reducing sync frequency (currently every 6h)          │   │
│  │  • Staggering connector sync times                       │   │
│  │  • Reducing the number of sites per connector            │   │
│  │                                                          │   │
│  │  [Wait for auto-resume]  [⏸ Pause sync]                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8g. Partial Failure (Some Documents Failed)

```
┌─ Overview ───────────────────────────────────────────────────────┐
│                                                                   │
│  Engineering Wiki                               ⚠ 3 failed docs │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⚠  Sync completed with errors                            │   │
│  │                                                          │   │
│  │  128 documents synced · 3 failed                         │   │
│  │                                                          │   │
│  │  Failed documents:                                       │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │ Name                    │ Error                     │  │   │
│  │  │─────────────────────────│───────────────────────────│  │   │
│  │  │ architecture-v2.vsdx   │ Unsupported format         │  │   │
│  │  │ Q4-data.xlsx (120MB)   │ Exceeds 100MB size limit  │  │   │
│  │  │ encrypted-report.pdf   │ Password protected         │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                                                          │   │
│  │  [↻ Retry Failed]  [Adjust Filters to Exclude]           │   │
│  │  [Dismiss — these are expected]                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8h. Zero Sites Discovered (Sites.Selected with No Approved Sites)

```
┌─ Scope ──────────────────────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⬚  No sites accessible                                  │   │
│  │                                                          │   │
│  │  Your app registration uses Sites.Selected permissions,  │   │
│  │  but no sites have been approved for this app yet.       │   │
│  │                                                          │   │
│  │  To sync SharePoint content, an Azure AD admin must      │   │
│  │  approve specific sites for your app:                    │   │
│  │                                                          │   │
│  │  Option 1: Approve sites via Azure Portal                │   │
│  │  [📄 Download Approval Guide (with PowerShell script)]   │   │
│  │                                                          │   │
│  │  Option 2: Switch to Sites.Read.All                      │   │
│  │  Broader permission — access all sites without approval. │   │
│  │  Requires admin consent.                                 │   │
│  │  [View Permission Upgrade Steps]                         │   │
│  │                                                          │   │
│  │  Option 3: Enter site URLs manually                      │   │
│  │  If sites are approved but discovery can't find them:    │   │
│  │  ┌──────────────────────────────────────────────────┐   │   │
│  │  │ https://contoso.sharepoint.com/sites/...         │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  │  [+ Add Site URL]                                       │   │
│  │                                                          │   │
│  │  [↻ Re-run Discovery]                                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 8i. All Files Unsupported

```
┌─ Preview (Dry-Run) ──────────────────────────────────────────────┐
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ⬚  No indexable content found                            │   │
│  │                                                          │   │
│  │  We scanned 4 sites and found 156 files, but none match  │   │
│  │  your current filter configuration.                      │   │
│  │                                                          │   │
│  │  Content found at source:                                │   │
│  │  89 .vsdx (Visio) — unsupported format                   │   │
│  │  45 .mp4 (video) — unsupported format                    │   │
│  │  22 .psd (Photoshop) — unsupported format                │   │
│  │                                                          │   │
│  │  Suggestions:                                            │   │
│  │  • This SharePoint may contain non-document content      │   │
│  │  • Check if documents are in a different library         │   │
│  │  • Try adding more sites to the scope                    │   │
│  │                                                          │   │
│  │  [← Edit Scope]  [← Edit Filters]                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 9. Empty States

### 9a. Dashboard with No Connectors

```
┌───────────────────────────────────────────────────────────────────┐
│  SharePoint Connectors                                            │
│                                                                   │
│                                                                   │
│              ┌─────────────────────────────────────┐              │
│              │                                     │              │
│              │   No SharePoint connectors yet      │              │
│              │                                     │              │
│              │   Connect your SharePoint sites to  │              │
│              │   make documents searchable by your  │              │
│              │   AI agents and knowledge bases.     │              │
│              │                                     │              │
│              │   The system will auto-discover your │              │
│              │   sites and recommend what to sync.  │              │
│              │                                     │              │
│              │   [+ Add Your First Connector]       │              │
│              │                                     │              │
│              │   Or:                               │              │
│              │   [📥 Import Configuration]          │              │
│              │   [📋 Use Template]                  │              │
│              │                                     │              │
│              └─────────────────────────────────────┘              │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 9b. Connector with No Documents (Connected but Not Yet Synced)

```
┌─ Overview ───────────────────────────────────────────────────────┐
│                                                                   │
│  Marketing Hub                                  ○ Not synced     │
│  Connected Mar 22 · Authenticated by sarah@contoso.com           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                                                          │   │
│  │   No documents indexed yet                               │   │
│  │                                                          │   │
│  │   This connector is authenticated and configured, but    │   │
│  │   hasn't synced yet. Run a sync to start indexing        │   │
│  │   documents.                                             │   │
│  │                                                          │   │
│  │   Scope: 4 sites · ~523 documents estimated              │   │
│  │   Filters: 27 file types · No folder restrictions        │   │
│  │                                                          │   │
│  │   [▶ Start First Sync]  [Preview First →]               │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  Sync History: No syncs yet                                      │
│  Issues: None                                                     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 10. Backend Requirements

### New API Endpoints

| #   | Endpoint                                                | Method | Purpose                                    | Effort | Exists? |
| --- | ------------------------------------------------------- | ------ | ------------------------------------------ | ------ | ------- |
| 1   | `GET /connectors`                                       | GET    | List all connectors across KBs (dashboard) | S      | No      |
| 2   | `GET /connectors/:id/health`                            | GET    | Run 6-axis health check                    | M      | No      |
| 3   | `GET /connectors/:id/stats`                             | GET    | Document counts by type, site, status      | S      | No      |
| 4   | `GET /connectors/:id/sync-history`                      | GET    | Paginated sync run history                 | M      | No      |
| 5   | `GET /connectors/:id/token-health`                      | GET    | Token expiry, refresh status, scopes       | S      | No      |
| 6   | `POST /connectors/:id/validate`                         | POST   | Connection validation checklist            | M      | No      |
| 7   | `GET /connectors/:id/config-versions`                   | GET    | Config version history                     | M      | No      |
| 8   | `POST /connectors/:id/config-versions/:version/restore` | POST   | Restore previous config version            | S      | No      |
| 9   | `POST /connectors/:id/clone`                            | POST   | Clone connector config                     | S      | No      |
| 10  | `GET /connector-templates`                              | GET    | List available templates                   | S      | No      |
| 11  | `POST /connectors/:id/export`                           | POST   | Export config as JSON                      | S      | No      |
| 12  | `POST /connectors/import`                               | POST   | Import config from JSON                    | S      | No      |
| 13  | `POST /connectors/:id/filters/preview`                  | POST   | Dry-run filter preview                     | —      | Yes     |
| 14  | `GET /connectors/:id/delta-tokens`                      | GET    | Per-drive delta token status               | —      | Yes     |
| 15  | `POST /connectors/:id/permissions/crawl`                | POST   | Trigger permission recrawl                 | —      | Yes     |
| 16  | `POST /connectors/bulk/re-auth`                         | POST   | Bulk re-authentication                     | M      | No      |
| 17  | `POST /connectors/bulk/pause`                           | POST   | Bulk pause/resume                          | S      | No      |
| 18  | `POST /connectors/bulk/export`                          | POST   | Bulk config export                         | S      | No      |
| 19  | `GET /connectors/:id/documents/failed`                  | GET    | Failed documents with error messages       | S      | No      |
| 20  | `POST /connectors/:id/auth/delegation`                  | POST   | Generate shareable auth request            | M      | No      |

### New Database Models

| Model                    | Purpose                                                 | Fields                                                        |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| `SyncRun`                | Per-sync history (currently only latest sync is stored) | `connectorId, type, startedAt, completedAt, duration, counts` |
| `ConnectorConfigVersion` | Config versioning for restore and diff                  | `connectorId, version, config, changedBy, changedAt, summary` |
| `ConnectorInvite`        | Delegated auth tracking                                 | `connectorId, token, email, status, expiresAt`                |
| `ConnectorTemplate`      | Predefined configuration templates                      | `name, description, config, isBuiltIn`                        |

### Existing Model Changes

| Model               | Change                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `ConnectorConfig`   | Add `clonedFrom`, `templateId`, `autoResumeAfter`, `organizationId` |
| `EndUserOAuthToken` | Add `authenticatedBy` (email of who authenticated)                  |

### Backend Fixes Required

| #   | Fix                                          | Effort | Details                                                                 |
| --- | -------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| 1   | Wire scheduler (`startScheduledJobs()`)      | S      | Call from `server.ts` after workers start                               |
| 2   | Fix delta sync scheduler                     | S      | Replace timestamp-only update with actual job enqueue                   |
| 3   | Fix webhook renewal mock token               | S      | Replace `'mock-token'` with real `EndUserOAuthToken` lookup             |
| 4   | Add auto-pause on consecutive failures       | S      | Check `consecutiveFailures >= threshold` in worker error handler        |
| 5   | Add vector store cleanup on connector delete | M      | Delete orphaned vectors when connector is deleted                       |
| 6   | Persist sync duration                        | S      | Save `durationMs` from `SyncResult` to `SyncRun`                        |
| 7   | Add aggregation endpoints                    | S      | `$group` queries for document stats by type, site, status per connector |

---

## 11. Issue Checklist — All 21 Review Issues Addressed

### CRITICAL (7/7 addressed)

| #   | Issue                                       | How Addressed in Dashboard + Panels                                                                                                                                                                                                                      |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No Azure App Registration guidance          | Connect tab has expandable "Don't have an app registration?" section with step-by-step Azure Portal guide, downloadable PDF, and redirect URI template. Visible in the same panel where credentials are entered — no separate page needed.               |
| 2   | Device code != admin consent conflated      | Connect tab explicitly separates authentication (device code section) from admin consent (displayed as a separate section below auth status). Disclaimer inline: "Entering the device code signs you in. It does NOT grant admin consent."               |
| 3   | Sites.FullControl.All mitigation misleading | Permissions tab shows actual granted scopes with honest capability descriptions. No "read-only" claims for write-capable tokens. Security Review Document includes risk assessment and token rotation guidance.                                          |
| 4   | Error states completely unspecified         | 9 dedicated error wireframes in Section 8: auth failure, discovery timeout, sync failure, token expiry, permission revoked, throttled (429), partial failure, zero sites (Sites.Selected), all unsupported files. Each shows cause, impact, remediation. |
| 5   | Discovery timeout for 1000+ sites           | Scope tab shows streaming discovery with progressive results. "Use what we found so far" button, search/filter for large lists, manual URL entry fallback, and cancel button — all inline in the panel.                                                  |
| 6   | No dry-run/preview before sync              | Preview tab (accessible from overflow menu or "Save & Preview" buttons) shows sample documents, skipped files with reasons, content breakdown, and estimated time. Must be approved before first sync starts.                                            |
| 7   | Sites.Selected not supported                | Scope tab adapts to Sites.Selected: shows only approved sites, provides PowerShell approval guide download, manual URL entry for sites not found by discovery, and option to upgrade to Sites.Read.All with clear tradeoff explanation.                  |

### HIGH (14/14 addressed)

| #   | Issue                                             | How Addressed in Dashboard + Panels                                                                                                                                                                                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8   | "Proposal" was a pre-filled form                  | No "proposal" dialog. The Scope tab shows discovery results with recommendations (scores, reasons) inline. User checks/unchecks sites and clicks "Save Scope." It is a tab in the panel, not a separate dialog or form.              |
| 9   | No bulk/clone/template for multi-connector        | Dashboard itself is the multi-connector view. Bulk actions bar for selected rows. Clone and template options in "Add New" dialog. Export/import JSON in Advanced tab. Dashboard scales from 1 to 50+ with card/table toggle.         |
| 10  | No filter dry-run/preview                         | "Run Preview" button at bottom of Filters tab calls existing `POST /filters/preview`. Preview tab shows full dry-run results. Filter monitoring mode shows live match counts per rule.                                               |
| 11  | Security doc missing data handling/retention      | Permissions tab offers downloadable Security Review Document containing: permission justifications, data handling scope, retention policy, token rotation guidance, risk assessment, and revocation procedures.                      |
| 12  | Competitive claims overstated                     | No competitive claims in the design. The design stands on its own merits.                                                                                                                                                            |
| 13  | Graph API throttling unaddressed                  | Dedicated throttle error wireframe (8f). Health tab shows API quota usage. Advanced tab shows throttle event history. Auto-resume after Retry-After period. Schedule tab suggests staggering syncs when throttling is frequent.      |
| 14  | Pre-fetch/post-fetch leaks implementation details | Filters tab labels by user impact: "Reduces API calls" vs "Evaluates locally." Implementation details (OData vs local evaluation) only appear in the Advanced tab's raw config view, not in the default filter UI.                   |
| 15  | No connection validation checklist                | Health tab runs 6-axis validation (auth, Graph API access, site access, drive enumeration, file download, permission scope). Each axis shows pass/fail with specific remediation. Re-runnable on demand.                             |
| 16  | Custom SharePoint metadata not discoverable       | Filters tab "Metadata conditions" section shows custom columns discovered from SharePoint, prefixed with `metadata.sharepoint.`. Available as dropdown options in condition builder and in CEL editor.                               |
| 17  | No multi-connector monitoring dashboard           | The dashboard IS the primary view. Card view (1-6 connectors) and table view (7+) with status, docs, size, sites, failures, token health at a glance. Summary row at bottom. Filter and sort controls.                               |
| 18  | Empty states undefined                            | Section 9 defines empty states: dashboard with no connectors (welcome + quick start), connector with no documents (not yet synced), plus error states for zero sites and zero supported files.                                       |
| 19  | Loading states incomplete                         | Scope tab shows streaming discovery with progressive site list and progress bar. Sync progress shown on dashboard cards and in Overview tab. Health check shows per-axis progress. All polling-based states have visible indicators. |
| 20  | Multiple tenants in one KB not addressed          | Each connector belongs to one Azure AD tenant. Dashboard table view includes "Tenant" column and filter dropdown. Multiple connectors from different tenants can coexist in one KB — each authenticated independently.               |
| 21  | Proposal in dialog too complex                    | No dialog-based proposal at all. Configuration happens across panel tabs (Scope, Filters, Schedule, Permissions) — each focused on one concern. The panel is 560px wide with unlimited scroll, not a constrained dialog.             |

---

## Review Status: CLEAN

### Round 1 Summary

- Issues resolved: 21/21 (18 fully solved, 3 partial but acceptable — no CRITICAL or HIGH gaps remain)
- Objectives met: 9/9 (avg score 4.78/5)
- Persona blockers: 0 remaining (all 5 personas can complete their workflows)
- Fixes applied this round:
  - Added Security Review Document contents specification (7 sections) in Permissions tab
  - Added destructive action confirmation dialogs (type-to-confirm for delete, simple confirm for revoke/reset)
- Remaining gaps (MEDIUM/LOW only):
  - **MEDIUM** — Pre-fetch/post-fetch labels ("Reduces API calls" / "Evaluates locally") not annotated on individual filter rules in wireframe
  - **MEDIUM** — No dashboard loading skeleton or health check "running" state wireframe
  - **MEDIUM** — Panel tab overflow behavior on small screens unspecified (7 tabs in 560px)
  - **MEDIUM** — Client secret input field missing for App-Only auth method
  - **MEDIUM** — Per-filter server-side vs local evaluation tags not shown in wireframe
  - **LOW** — "Stagger sync times" suggestion in throttle error has no actionable UI
  - **LOW** — No keyboard shortcuts for power user navigation between tabs/connectors
