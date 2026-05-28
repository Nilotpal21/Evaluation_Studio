# Design C v2: Dashboard + Detail Panels — SharePoint Connector

**Date:** 2026-03-22
**Version:** 2 (incorporates all user testing feedback from 5 personas)
**Interaction Pattern:** Dashboard overview with drill-down detail panels
**What Changed:** First-time experience redesigned (Sarah's #1 complaint), panel widened to 720px, Preview promoted to visible tab, template security gate added (Maria), delegation email polished (Chen), filter iteration improved (Alex), conversational tone for onboarding stolen from Design B.

---

## 1. Philosophy

**Two modes, one surface.** The dashboard is the command center for Day 2+ operations — every connector's health, status, and action surface is visible in one glance. But the first connector setup is warm, guided, and conversational — not a form dump. This is the key v2 insight: the dashboard layout serves Raj's 15-connector fleet, while the detail panel _adapts its personality_ based on context. First connector? Friendly onboarding voice, wider panel, linear guidance. Tenth connector? Tabs, speed, bulk ops.

The dashboard scales from 0 connectors (welcome state with guided onboarding) to 50+ (sortable table with bulk actions). Smart defaults mean every new connector starts healthy with zero configuration. Transparency lives in the panel tabs: each tab shows what the system detected, what it recommends, and why. Advanced controls (CEL with autocomplete, folder globs, metadata conditions) appear inline — not behind a separate mode.

**Stolen from other designs:**

- From B: Conversational discovery voice — "I discovered 5 sites. Here is what I recommend..." (Sarah's favorite)
- From B: Inline editing within the same view — no tab-switching for filter iteration (Alex's need)
- From B: Proposal-as-security-doc concept — one exportable view consolidating all security info (Maria)
- From A: Pre-written delegation email template with copy-to-clipboard (Chen's #1)
- From A: "HONEST NOTE" pattern for FullControl template warning (Maria's trust-builder)
- From A: OData query transparency — show the generated OData query for power users (Alex)

---

## 2. Flow Diagram

```
                         +----------------------------------+
                         |        CONNECTOR DASHBOARD        |
                         |   (grid/table of all connectors)  |
                         +----------------------------------+
                                    |
                    +---------------+---------------+
                    |               |               |
             +------v------+ +-----v------+ +------v------+
             | [+ Add New] | | Click Card | | Bulk Actions|
             +------+------+ +-----+------+ +------+------+
                    |              |               |
             +------v--------------v------+  +-----v-----------+
             |   DETAIL PANEL (slide-in)  |  | Re-auth All     |
             |   720px wide               |  | Pause All       |
             |   First-time: guided mode  |  | Export Configs   |
             |   Returning: tabbed mode   |  +-----------------+
             +------+-----+---------+----+
                    |     |         |
    +---------------+     |         +-----------+----------+
    |               |     |         |           |          |
+---v----+  +------v-----++ +-----v------+ +---v------+ +-v--------+
|Connect |  |Scope &     || |  Filters   | | Security | | Preview  |
|  tab   |  |Discovery   || |  (inline)  | |   tab    | | (visible |
|        |  |(merged)    || |            | |(consol.) | |  tab)    |
+---+----+  +------+-----++ +-----+-----+ +---+------+ +----+-----+
    |               |              |           |              |
    |       +-------v------+ +----v------+    |              |
    |       |  Schedule    | | OData     |    |              |
    |       |  tab         | | Preview   |    |              |
    |       +--------------+ +-----------+    |              |
    v                                         v              v
  Auth --> Discovery --> Configure --> Security Gate --> Preview --> Sync
                                         |
                                         v
                                 +-----------------+
                                 | Back to          |
                                 | DASHBOARD        |
                                 | (card = Healthy) |
                                 +-----------------+
```

---

## 3. Dashboard Wireframe

### 3a. Empty State — Welcome (0 connectors)

When there are no connectors, the dashboard shows a warm onboarding experience — not an empty grid. This directly addresses Sarah's complaint that the dashboard "feels like a tool built for the person who manages 10 connectors."

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
|  |   |   for getting started. Upgrade to App Registration        |  |  |
|  |   |   later for automated sync and delegation.                |  |  |
|  |   |                                                           |  |  |
|  |   +-----------------------------------------------------------+  |  |
|  |                                                                   |  |
|  |   --- or set up with full control ---                             |  |
|  |                                                                   |  |
|  |   [Azure App Registration]   [Import JSON Config]                 |  |
|  |   For automated sync,        Have an exported config              |  |
|  |   delegation, and            from another environment?            |  |
|  |   app-only auth                                                   |  |
|  |                                                                   |  |
|  |   --- What happens next ---                                       |  |
|  |                                                                   |  |
|  |   1. You authenticate with Microsoft                              |  |
|  |   2. We discover your SharePoint sites (~30 seconds)              |  |
|  |   3. We recommend what to sync (you can customize)                |  |
|  |   4. Preview before any data is downloaded                        |  |
|  |   5. Approve and sync starts                                      |  |
|  |                                                                   |  |
|  |   Typical setup time: 3-5 minutes for your first connector        |  |
|  |                                                                   |  |
|  +-------------------------------------------------------------------+  |
|                                                                          |
|  API/CLI: POST /api/connectors with JSON body. See API docs.            |
|                                                                          |
+-------------------------------------------------------------------------+
```

### 3b. Card View (1-6 connectors)

The default view for small deployments. Each card is a self-contained health summary. Click any card to open its detail panel.

```
+-------------------------------------------------------------------------+
|  SharePoint Connectors                                                   |
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

### 3c. Table View (7+ connectors)

Auto-switches at 7+ connectors. Supports column sorting, row selection, and inline status indicators. This is the view that won Raj.

```
+-----------------------------------------------------------------------------------+
|  SharePoint Connectors                                                             |
|  15 active . 2 warnings . 1 error             [Card] [Table] [+ Add]             |
|                                                                                    |
|  [Search connectors...]  [Status: Any v]  [Tenant: Any v]  [Sort: Name v]        |
|                                                                                    |
|  +-------------------------------------------------------------------------------+|
|  | _ | Name              | Status    | Docs    | Size   | Sites|Failures| Token   ||
|  |---|-------------------|-----------|---------|--------|------|--------|---------|+
|  | _ | Marketing Hub     | * Healthy | 237     | 3.2 GB | 2   | 0      | * 28d   ||
|  | _ | Engineering Wiki  | ! Partial | 128     | 1.1 GB | 1   | 3      | * 28d   ||
|  | _ | Sales Docs        | ~ Syncing | 67/120  | 5.4 GB | 3   | 0      | * 27d   ||
|  | _ | HR Portal         | * Healthy | 89      | 0.8 GB | 1   | 0      | * 25d   ||
|  | _ | Legal Vault       | * Healthy | 45      | 0.2 GB | 1   | 0      | ! 3d    ||
|  | _ | Finance Reports   | * Healthy | 312     | 4.1 GB | 2   | 0      | * 20d   ||
|  | _ | Exec Comms        | * Healthy | 12      | 0.1 GB | 1   | 0      | * 18d   ||
|  | _ | IT Knowledge      | X Failed  | 0       | --     | --  | 5      | X Exprd ||
|  | _ | Product Docs      | * Healthy | 456     | 2.8 GB | 4   | 0      | * 28d   ||
|  | _ | Support Articles  | * Healthy | 891     | 1.2 GB | 1   | 0      | * 22d   ||
|  |   |                   |           |         |        |      |        |         ||
|  |   | Showing 1-10 of 15                                       [< 1  2 >]       ||
|  +-------------------------------------------------------------------------------+|
|                                                                                    |
|  --- Summary -------------------------------------------------------------------- |
|  2,237 docs total . 18.9 GB . 16 sites . 15 connectors . 8 failed docs           |
+-----------------------------------------------------------------------------------+
```

### 3d. Bulk Actions Bar

Appears when one or more rows are selected in table view:

```
+-------------------------------------------------------------------------+
|  [check] 3 selected                                                      |
|                                                                          |
|  [Re-auth Selected]  [Pause Selected]  [Resume Selected]                |
|  [Sync Now]  [Export Configs]  [Delete Selected]                        |
|                                                                          |
|  [Select All (15)]  [Clear Selection]                                   |
+-------------------------------------------------------------------------+
```

---

## 4. Setup Flow (Inside Detail Panel)

The detail panel slides in from the right. **Width is context-sensitive:**

- **First connector (0 existing):** 720px — extra space for guidance text, explanations, and the conversational discovery voice
- **Subsequent connectors:** 720px — consistent panel width (v1's 560px was Sarah's complaint — "feels tight")
- **Full-page option:** User can click "Expand" icon to use full viewport for complex filter iteration (Alex's need)

### Panel Structure

```
+-- Detail Panel (720px) -------------------------------------- [<>] [x] -+
|                                                                          |
|  [Connector Name]                                    [... More Actions]  |
|                                                                          |
|  +--------------------------------------------------------------------+ |
|  | Connect | Scope | Filters | Schedule | Security | Preview | History | |
|  +--------------------------------------------------------------------+ |
|                                                                          |
|  [Active tab content fills the rest of the panel]                        |
|                                                                          |
+--------------------------------------------------------------------------+
```

Key changes from v1:

- **Preview is a visible tab**, not hidden in overflow menu (Sarah's complaint)
- **Security tab** consolidates permissions + security review (Maria's request for non-fragmented info)
- **History tab** for config version history (moved out of overflow to reduce discovery cost)
- **[<>] expand button** lets user go full-page for filter work (Alex)
- Overflow menu (`...`) contains: Clone, Export Config, Import Config, Diagnostics, Delete

### 4a. Connect Tab — First-Time Guided Experience

**Key v2 change:** When this is the user's first connector, the Connect tab uses a warm, conversational tone borrowed from Design B. It does not just show form fields — it explains the journey.

**First-time experience (0 existing connectors):**

```
+-- Connect (First Connector) -------------------------------------------+
|                                                                          |
|  Let us get you connected to SharePoint                                  |
|                                                                          |
|  This takes about 3 minutes. You will authenticate with Microsoft,       |
|  and then we will discover your SharePoint sites automatically.          |
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

**Returning user experience (1+ existing connectors):**

The Connect tab is more compact for users who have done this before:

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
|  > Don't have an app registration? (expandable)                           |
|    Step-by-step guide:                                                    |
|    1. Go to Azure Portal > App Registrations > New                        |
|    2. Set redirect URI: https://your-domain/api/connectors/callback       |
|    3. Under API Permissions, add Microsoft Graph:                         |
|       - Sites.Selected (recommended -- least privilege)                   |
|       - Or Sites.Read.All (broader, simpler)                              |
|    4. Generate a client secret (for app-only auth)                        |
|    [Download Setup Guide PDF]                                             |
|                                                                           |
|  Step 2: Authentication Method                                            |
|  ----------------------------------------------------------------        |
|                                                                           |
|  (*) Device Code -- share a code with the person who authenticates        |
|  ( ) Browser Login -- sign in with your Microsoft account now             |
|  ( ) App-Only (Client Credentials) -- automated with secret               |
|                                                                           |
|  > Which method should I choose? (expandable)                             |
|                                                                           |
|  +------------------------------------------------------+                |
|  | Client Secret (required for App-Only)                |                |
|  +------------------------------------------------------+                |
|                                                                           |
|  Configure-before-auth: You can set up scope, filters, and               |
|  schedule in the other tabs while waiting for authentication.             |
|                                                                           |
|                                            [Cancel]  [Connect -->]        |
|                                                                           |
+---------------------------------------------------------------------------+
```

**After clicking Connect (Device Code selected):**

```
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  [check] App Registration saved                                           |
|                                                                           |
|  Authenticate with Microsoft                                              |
|  ----------------------------------------------------------------        |
|                                                                           |
|  Enter this code at microsoft.com/devicelogin:                            |
|                                                                           |
|          +--------------+                                                 |
|          |   GXKR-HTPF  |   [Copy]                                       |
|          +--------------+                                                 |
|                                                                           |
|  [Open Microsoft Login]                                                   |
|                                                                           |
|  --- Need someone else to authenticate? -------------------------------- |
|                                                                           |
|  [Send Authentication Invite]                                             |
|  Generates a secure link (valid 48 hours) that you can send to           |
|  your IT admin. They complete auth at their own pace -- no 15-minute     |
|  device code pressure.                                                    |
|                                                                           |
|  Or share the device code directly (expires in 15 min):                   |
|  [Copy Delegation Message]                                                |
|                                                                           |
|  --- Pre-written message (click to copy): ----------------------------- |
|                                                                           |
|  | Subject: SharePoint Connector Authentication Request                 | |
|  |                                                                      | |
|  | Hi [Name],                                                           | |
|  |                                                                      | |
|  | I am setting up a SharePoint connector for our knowledge base        | |
|  | and need someone with SharePoint admin access to authenticate.       | |
|  |                                                                      | |
|  | Option A (quick, 15 min window):                                     | |
|  |   1. Go to https://microsoft.com/devicelogin                        | |
|  |   2. Enter code: GXKR-HTPF                                          | |
|  |   3. Sign in with your Microsoft account                            | |
|  |   4. Approve the permissions prompt                                  | |
|  |                                                                      | |
|  | Option B (no time pressure):                                         | |
|  |   Click this link: https://app.example.com/auth/invite/abc123       | |
|  |   Valid for 48 hours. Complete at your convenience.                  | |
|  |                                                                      | |
|  | Permissions requested: Sites.Read.All (read-only access              | |
|  | to SharePoint sites). This does NOT grant write access.              | |
|  |                                                                      | |
|  | If you have questions about what data will be accessed,              | |
|  | I can share the Security Review Document.                            | |
|  |                                                                      | |
|  | Thanks,                                                              | |
|  | [Your Name]                                                          | |
|  +----------------------------------------------------------------------+|
|                                                                           |
|  [Copy to Clipboard]  [Open in Email Client]                              |
|                                                                           |
|  Timer: Code expires in 13:42                            * Waiting...     |
|                                                                           |
|  Note: Entering the device code signs you in. It does NOT                 |
|  grant admin consent. Admin consent (if needed for                        |
|  Sites.Read.All) is a separate step after authentication.                 |
|                                                                           |
+---------------------------------------------------------------------------+
```

**After successful authentication:**

```
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  [check] Connected                                                        |
|                                                                           |
|  Authenticated by: sarah@contoso.com                                      |
|  Method: Device Code                                                      |
|  Token expires: Apr 19, 2026 (28 days)                                    |
|  Scopes granted: Sites.Read.All, offline_access                           |
|                                                                           |
|  [Re-authenticate]  [Send Re-auth Invite (48h link)]                      |
|                                                                           |
|  --- Admin Consent ------------------------------------------------------ |
|                                                                           |
|  [check] Admin consent granted for Sites.Read.All                         |
|  Granted by: admin@contoso.com on Mar 20, 2026                            |
|                                                                           |
|  --- Connection History ------------------------------------------------- |
|                                                                           |
|  Mar 22 14:30  Token refreshed automatically                              |
|  Mar 22 10:15  Authenticated via device code (sarah@contoso.com)          |
|  Mar 22 10:12  Connector created                                          |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4b. Scope Tab — Discovery with Conversational Voice

During setup, this tab runs discovery and presents results in a conversational tone borrowed from Design B. After setup, it shows live sync scope with edit capability.

**During discovery (conversational voice):**

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  Discovering your SharePoint environment...                               |
|                                                                           |
|  [check] 5 sites found                                                    |
|  ===============-------  Profiling content...  4 of 5 sites               |
|                                                                           |
|  Sites discovered so far:                                                 |
|  +--------------------------------------------------------------+        |
|  |  Site               | Files  | Size    | Last Updated         |        |
|  |---------------------|--------|---------|----------------------|        |
|  |  Marketing Hub      | ~240   | 3.2 GB  | 2 days ago           |        |
|  |  Engineering Wiki   | ~130   | 1.1 GB  | today                |        |
|  |  Sales Docs         | ~120   | 5.4 GB  | 1 week ago           |        |
|  |  HR Portal          | ~90    | 0.8 GB  | 3 days ago           |        |
|  |  ... Profiling...   |        |         |                      |        |
|  +--------------------------------------------------------------+        |
|                                                                           |
|  [Cancel Discovery]  [Use what we found so far -->]                       |
|                                                                           |
+---------------------------------------------------------------------------+
```

**After discovery (proposal with conversational tone):**

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  Here is what I found                                                     |
|  ----------------------------------------------------------------        |
|                                                                           |
|  I discovered 5 SharePoint sites with ~580 documents (10.6 GB).           |
|  Based on content activity, file types, and size, I recommend             |
|  syncing 4 of the 5 sites. Here is my reasoning:                          |
|                                                                           |
|  Sites                                                                    |
|  (*) All 5 sites  ( ) Selected  ( ) Exclude specific                     |
|                                                                           |
|  +--------------------------------------------------------------------+  |
|  | [x]| Site              | Files | Size   | Updated  | Score | Why   |  |
|  |----|-------------------|-------|--------|----------|-------|-------|  |
|  | [x]| Marketing Hub     | 242   | 3.2 GB | 2d ago   | 92    | High  |  |
|  |    |                   |       |        |          |       | act-  |  |
|  |    |                   |       |        |          |       | ivity,|  |
|  |    |                   |       |        |          |       | rich  |  |
|  |    |                   |       |        |          |       | docs  |  |
|  | [x]| Engineering Wiki  | 128   | 1.1 GB | today    | 88    | Very  |  |
|  |    |                   |       |        |          |       | active|  |
|  | [x]| Sales Docs        | 120   | 5.4 GB | 1w ago   | 85    | Large |  |
|  |    |                   |       |        |          |       | volume|  |
|  | [x]| HR Portal         | 89    | 0.8 GB | 3d ago   | 72    | Mod.  |  |
|  |    |                   |       |        |          |       | active|  |
|  | [ ]| IT Infrastructure | 3     | 0.1 GB | 6mo ago  | 15    | Stale |  |
|  +--------------------------------------------------------------------+  |
|                                                                           |
|  Score: Activity 30% + Size 20% + Content 20% - Sensitivity 30%          |
|                                                                           |
|  > Why was IT Infrastructure not recommended? (expandable)                |
|    Only 3 files, last updated 6 months ago. Low activity and              |
|    minimal content volume. You can still include it.                      |
|                                                                           |
|  Libraries: (*) All libraries  ( ) Selected                              |
|  Content types: [x] Files  [x] SharePoint Pages                         |
|                                                                           |
|  --- Manual Site Entry (for Sites.Selected or unlisted sites) ---------- |
|                                                                           |
|  +--------------------------------------------------------------+        |
|  | https://contoso.sharepoint.com/sites/...                      |        |
|  +--------------------------------------------------------------+        |
|  [+ Add Site URL]                                                         |
|                                                                           |
|  Estimated sync: ~523 documents . ~10.6 GB . ~25 min                     |
|                                                                           |
|                               [Save Scope]  [Save & Preview -->]          |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4c. Filters Tab — Inline Editing, OData Transparency, CEL Autocomplete

Key v2 changes: All filter editing happens inline (no tab switching, stolen from Design B). OData query transparency shows what query is sent to Microsoft Graph (stolen from Design A, Alex's favorite). CEL editor has syntax highlighting and field autocomplete.

**Filter diff on re-preview:** When filters change after an initial preview, the system shows a delta — what changed, how many more/fewer documents would sync.

```
+-- Filters ---------------------------------------------------------------+
|                                                                           |
|  Filter Configuration                                                     |
|  Using: SharePoint defaults (27 file types)              [Reset Defaults] |
|                                                                           |
|  --- File Types -------------------------------------------------------- |
|                                                                           |
|  [x] Documents   pdf docx pptx xlsx odt rtf                              |
|  [x] Text        txt csv tsv md html xml json yaml                       |
|  [x] Email       eml msg                                                 |
|  [x] Other       sql log rst                                             |
|  [ ] Images      png jpg gif svg (not indexed by default)                |
|                                                                           |
|  Your content breakdown:                                                  |
|  60% PDF . 25% DOCX . 10% PPTX . 5% other                               |
|  3 unsupported files will be skipped: 2 .vsdx, 1 .mp4                    |
|                                                                           |
|  Executables (.exe, .dll, .bat, etc.) are always blocked.                |
|                                                                           |
|  --- Folder Rules ------------------------------------------------------ |
|                                                                           |
|  No folder restrictions (sync all folders)                 [Add Rules]    |
|                                                                           |
|  Quick templates:                                                         |
|  [Exclude Archives]  [Exclude Backups]  [Exclude _private]               |
|                                                                           |
|  > Custom folder patterns (expandable)                                    |
|    Include patterns (glob):                                               |
|    +------------------------------------------------------+              |
|    | e.g. /sites/*/Shared Documents/**                     |              |
|    +------------------------------------------------------+              |
|    Exclude patterns (glob):                                               |
|    +------------------------------------------------------+              |
|    | e.g. **/Archive/**, **/Backup/**                      |              |
|    +------------------------------------------------------+              |
|                                                                           |
|  --- Size Limits ------------------------------------------------------- |
|                                                                           |
|  Min: [0 KB      ]  Max: [100 MB    ]  (default: 0-100MB)               |
|                                                                           |
|  --- Date Range -------------------------------------------------------- |
|                                                                           |
|  Modified after: [No limit     ]  Modified before: [No limit  ]          |
|                                                                           |
|  --- Advanced Conditions ----------------------------------------------- |
|                                                                           |
|  > Metadata conditions (expandable)                                       |
|    Add conditions on SharePoint metadata columns:                         |
|    +--------------------------------------------------------------+      |
|    | Field: [metadata.sharepoint.Department v]                     |      |
|    | Operator: [equals v]                                          |      |
|    | Value: [Engineering                    ]                      |      |
|    +--------------------------------------------------------------+      |
|    [+ Add Condition]                                                      |
|                                                                           |
|  > CEL expression editor (expandable)                                     |
|    For complex logic combining multiple conditions:                       |
|    +--------------------------------------------------------------+      |
|    | resource.size < 50000000 &&                                   |      |
|    | resource.name.endsWith('.pdf') &&                             |      |
|    | resource.metadata.department == 'Engineering'                 |      |
|    +--------------------------------------------------------------+      |
|    Syntax highlighting: keywords, strings, operators                      |
|    Autocomplete: resource.size, resource.name, resource.mimeType,        |
|                  resource.metadata.*, resource.path, ...                  |
|    [Validate Expression]  [CEL Reference]                                 |
|                                                                           |
|  --- OData Query Preview (for power users) ----------------------------- |
|                                                                           |
|  > Show generated OData query (expandable)                                |
|    This query runs server-side to pre-filter before download:             |
|    +--------------------------------------------------------------+      |
|    | $filter=file/mimeType ne 'application/octet-stream'           |      |
|    |   and size lt 104857600                                       |      |
|    | $select=id,name,size,file,lastModifiedDateTime,               |      |
|    |   createdDateTime,parentReference                             |      |
|    +--------------------------------------------------------------+      |
|    Pre-fetch (OData): file types, size limits (reduces API calls)        |
|    Post-fetch (local): folder globs, metadata, CEL (evaluates locally)   |
|                                                                           |
|  --- Filter Impact (live) ---------------------------------------------- |
|                                                                           |
|  Source total:  ~579 files                                                |
|  After filters: ~523 files pass (90%)                                     |
|  Skipped:       ~56 files (10%)                                           |
|                                                                           |
|  [!] Filters changed since last preview                                   |
|  Delta: +12 documents, -3 documents vs last preview                       |
|  [View Updated Preview -->]                                               |
|                                                                           |
|                               [Save Filters]  [Run Preview -->]           |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4d. Schedule Tab — Frequency + Webhooks + Auto-Pause

```
+-- Schedule --------------------------------------------------------------+
|                                                                           |
|  Sync Schedule                                                            |
|                                                                           |
|  --- Automatic Sync ---------------------------------------------------- |
|                                                                           |
|  Frequency: [Every 6 hours    v]                                          |
|                                                                           |
|  Options:                                                                 |
|  ( ) Every 1 hour     -- highest freshness, most API usage               |
|  ( ) Every 3 hours                                                        |
|  (*) Every 6 hours    -- recommended balance                             |
|  ( ) Every 12 hours                                                       |
|  ( ) Every 24 hours   -- lowest API usage                                |
|  ( ) Custom cron: [____________]                                          |
|  ( ) Manual only   -- no automatic sync                                  |
|                                                                           |
|  Next scheduled sync: Mar 22, 2026 at 20:30 (in 4h 12m)                  |
|                                                                           |
|  --- Real-Time Updates (Webhooks) -------------------------------------- |
|                                                                           |
|  Status: ! Not available                                                  |
|                                                                           |
|  SharePoint webhooks would provide near-instant updates when              |
|  content changes. This feature requires:                                  |
|  - Publicly accessible callback URL                                       |
|  - Webhook routes to be enabled (currently disabled)                      |
|                                                                           |
|  --- Sync Controls ----------------------------------------------------- |
|                                                                           |
|  [Sync Now (Delta)]  [Full Re-sync]  [Pause Auto-Sync]                   |
|                                                                           |
|  --- Auto-Pause on Failures -------------------------------------------- |
|                                                                           |
|  Auto-pause after: [5] consecutive failures                               |
|  Current consecutive failures: 0                                          |
|  If paused, resume requires manual action or re-authentication.           |
|                                                                           |
|                                                        [Save Schedule]    |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4e. Security Tab — Consolidated (Maria's Request)

**Key v2 change:** All security-related information is consolidated in one tab instead of spread across Connect (scopes), Permissions (modes), and Advanced (tokens). This directly addresses Maria's complaint: "Information I need is spread across multiple tabs."

The Security tab also contains the **exportable Security Review Document** — the "proposal-as-security-doc" concept from Design B.

```
+-- Security --------------------------------------------------------------+
|                                                                           |
|  Security & Permissions                                                   |
|                                                                           |
|  --- Granted OAuth Scopes ---------------------------------------------- |
|                                                                           |
|  Your OAuth token has these Microsoft Graph permissions:                   |
|                                                                           |
|  [check] Sites.Read.All       Read all site collections                   |
|  [check] offline_access       Maintain access (refresh token)             |
|  [ ] Directory.Read.All       Read directory data (not granted)           |
|  [ ] Sites.FullControl.All    Full control (not granted)                  |
|                                                                           |
|  Authenticated by: sarah@contoso.com                                      |
|  Token expires: Apr 19, 2026 (28 days remaining)                          |
|  Last token refresh: Mar 22, 2026 14:30                                   |
|                                                                           |
|  --- Permission-Based Search ------------------------------------------- |
|                                                                           |
|  Mode: [Simplified v]                                                     |
|                                                                           |
|  ( ) Full -- crawl all ACLs, enforce per-user search results             |
|      Requires: Sites.FullControl.All, Directory.Read.All                  |
|  (*) Simplified -- respect site-level permissions only                   |
|      Uses: Sites.Read.All (current permissions)                           |
|  ( ) Disabled -- no permission enforcement on search results             |
|      All authenticated users see all synced content                       |
|                                                                           |
|  > What does each mode mean? (expandable)                                 |
|                                                                           |
|  --- Permission Crawl Status ------------------------------------------- |
|                                                                           |
|  Last crawl: Mar 21, 2026 at 03:00 (automatic)                           |
|  Next scheduled: Mar 28, 2026 at 03:00                                    |
|  Status: * Complete -- 5 sites, 8 drives, 1,247 ACL entries              |
|                                                                           |
|  [Crawl Now]  [View Permission Graph]                                     |
|                                                                           |
|  --- Data Access Summary ----------------------------------------------- |
|                                                                           |
|  What this connector accesses:                                            |
|  * 4 SharePoint sites (Marketing Hub, Engineering Wiki, Sales Docs,      |
|    HR Portal)                                                             |
|  * ~523 documents (PDF, DOCX, PPTX, and 24 other types)                 |
|  * 10.6 GB of content                                                     |
|                                                                           |
|  What this connector does NOT access:                                     |
|  * Cannot write, modify, or delete any SharePoint content                |
|  * Cannot access sites outside the selected scope                        |
|  * Cannot access user mailboxes, calendars, or Teams chats              |
|  * File contents are chunked for search -- originals are not stored      |
|                                                                           |
|  --- Security Review Document (exportable) ----------------------------- |
|                                                                           |
|  A comprehensive document for your security team containing:              |
|                                                                           |
|  1. Permission Justifications -- why each Graph scope is needed           |
|  2. Data Handling Scope -- what is downloaded, stored, and what is not    |
|  3. Retention Policy -- how long synced content and tokens are retained   |
|  4. Token Rotation Guidance -- refresh intervals, revocation steps        |
|  5. Risk Assessment -- attack surface, blast radius, mitigations          |
|  6. Revocation Procedures -- step-by-step to revoke access               |
|  7. Compliance Mapping -- SOC 2, GDPR, data governance alignment         |
|                                                                           |
|  [Download Security Review PDF]  [Copy as Markdown]                       |
|                                                                           |
|  --- Pending Security Approval Gate ------------------------------------ |
|                                                                           |
|  Status: ( ) No approval required  (*) Pending  ( ) Approved             |
|                                                                           |
|  When set to "Pending," the connector will NOT sync until a user          |
|  with the security-reviewer role marks it as Approved. This prevents      |
|  accidental data sync before security review.                             |
|                                                                           |
|  [Send for Security Approval]                                             |
|  Generates a link to the Security Review Document for your security       |
|  team to review and approve.                                              |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4f. Preview Tab — Visible, Not Hidden

**Key v2 change:** Preview is a first-class visible tab, not hidden in the overflow menu. Sarah said "I might approve sync without ever previewing." Now it is impossible to miss.

When filters change, the Preview tab shows a badge indicating it is stale and offers a one-click re-preview with a diff of what changed.

```
+-- Preview (Dry-Run) ----------------------------------------------------+
|                                                                           |
|  Sync Preview                                                             |
|  Showing what WOULD be synced with current configuration.                 |
|  No data will be downloaded or indexed.                                   |
|                                                                           |
|  --- Summary ----------------------------------------------------------- |
|                                                                           |
|  Would sync:    ~523 documents across 4 sites                             |
|  Would skip:    ~56 documents (filter rules)                              |
|  Estimated size: ~10.2 GB                                                 |
|  Estimated time: ~22 minutes                                              |
|                                                                           |
|  [!] Filter changes since last preview:                                   |
|  + Added: Exclude **/Archive/**  (+12 docs skipped)                       |
|  + Added: Max size 50MB          (+3 docs skipped)                        |
|  Net change: -15 documents vs previous preview                            |
|                                                                           |
|  --- Sample Documents (25 of ~523) ------------------------------------ |
|                                                                           |
|  +-------------------------------------------------------------+        |
|  | Name                       | Site          | Type | Size     |        |
|  |----------------------------|---------------|------|----------|        |
|  | Q1 Financial Report.pdf   | Marketing Hub | PDF  | 2.4MB    |        |
|  | Product Roadmap 2026.docx | Eng Wiki      | DOCX | 1.1MB    |        |
|  | Sales Playbook.pptx       | Sales Docs    | PPTX | 5.2MB    |        |
|  | Employee Handbook.pdf     | HR Portal     | PDF  | 3.8MB    |        |
|  | API Documentation.md      | Eng Wiki      | MD   | 0.2MB    |        |
|  | ... 20 more               |               |      |          |        |
|  +-------------------------------------------------------------+        |
|                                                                           |
|  --- Skipped Documents (showing first 10 of ~56) ---------------------- |
|                                                                           |
|  +-------------------------------------------------------------+        |
|  | Name                     | Reason                            |        |
|  |--------------------------|-----------------------------------|        |
|  | team-photo.png           | File type excluded (image)        |        |
|  | demo-recording.mp4       | Unsupported format                |        |
|  | legacy-backup.zip        | File type excluded (archive)      |        |
|  | Archive/2019-report.pdf  | Folder rule: **/Archive/**        |        |
|  | draft_v0.1.docx          | Size < minimum (0.5KB)            |        |
|  +-------------------------------------------------------------+        |
|                                                                           |
|  --- Content Type Breakdown -------------------------------------------- |
|                                                                           |
|  PDF   ==============================  312 (60%)                          |
|  DOCX  ============                    131 (25%)                          |
|  PPTX  =====                            52 (10%)                          |
|  Other ==                                28 (5%)                          |
|                                                                           |
|                              [<-- Adjust Filters]  [Approve Sync -->]     |
|                                                                           |
|  Approve starts the first sync with this configuration.                   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 4g. History Tab — Config Versioning, Diff, Rollback

Moved from overflow menu to a visible tab for easier discovery.

```
+-- History ---------------------------------------------------------------+
|                                                                           |
|  Configuration Version History                                            |
|                                                                           |
|  +--------------------------------------------------------------+        |
|  | Version | Date              | Changed By    | Summary         |        |
|  |---------|-------------------|---------------|-----------------|        |
|  | v5      | Mar 22, 14:00    | sarah@co.com  | Added folder    |        |
|  | (current)                   |               | exclusion       |        |
|  | v4      | Mar 21, 10:30    | sarah@co.com  | Changed sched   |        |
|  |         |                   |               | to 6h           |        |
|  | v3      | Mar 20, 16:00    | system        | Applied quick-  |        |
|  |         |                   |               | setup rec       |        |
|  | v2      | Mar 20, 15:55    | system        | Discovery       |        |
|  |         |                   |               | complete        |        |
|  | v1      | Mar 20, 10:15    | sarah@co.com  | Created         |        |
|  +--------------------------------------------------------------+        |
|                                                                           |
|  [View Diff: v4 --> v5]  [Restore v4]                                     |
|                                                                           |
|  --- Raw Configuration (JSON) ------------------------------------------ |
|                                                                           |
|  +--------------------------------------------------------------+        |
|  | {                                                              |        |
|  |   "name": "Marketing Hub",                                    |        |
|  |   "provider": "sharepoint",                                   |        |
|  |   "tenantId": "abc123-...",                                   |        |
|  |   ...                                                          |        |
|  | }                                                              |        |
|  +--------------------------------------------------------------+        |
|  [Copy JSON]  [Export]  [Import & Replace]                                |
|                                                                           |
|  --- API Quota & Rate Limits ------------------------------------------- |
|                                                                           |
|  Microsoft Graph throttle limit: ~20,000 requests/10min                   |
|  Current usage: 1,247 requests in last 10 min (6%)                        |
|  Throttle events today: 0                                                 |
|  Throttle events this week: 2 (Mar 19, Mar 20)                            |
|                                                                           |
|  --- Danger Zone ------------------------------------------------------- |
|                                                                           |
|  [Reset All Delta Tokens]  -- forces full re-sync of all sites           |
|  [Revoke OAuth Token]      -- disconnects from SharePoint                |
|  [Delete Connector]        -- removes connector and all data             |
|                                                                           |
|  Note: Deleting a connector automatically cleans up vector                |
|  embeddings from the search index. This may take a few minutes.           |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 5. Health Check — 6-Axis Validation

The Health Check runs automatically after authentication and is accessible on-demand via the "Run Health Check" action on the Overview or dashboard card context menu. It is NOT a separate tab (saves tab space) — it appears as an overlay or modal.

```
+-- Health Check ----------------------------------------------------------+
|                                                                           |
|  Connection Health Check                              [Re-run Checks]     |
|  Last run: 2 seconds ago                                                  |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |                                                                   |   |
|  |  1. Authentication        [check] Pass                            |   |
|  |     Token valid, expires in 28 days                               |   |
|  |                                                                   |   |
|  |  2. Graph API Access      [check] Pass                            |   |
|  |     Microsoft Graph v1.0 reachable, 45ms latency                  |   |
|  |                                                                   |   |
|  |  3. Site Access           [check] Pass                            |   |
|  |     5 of 5 selected sites accessible                              |   |
|  |                                                                   |   |
|  |  4. Drive Enumeration     [check] Pass                            |   |
|  |     8 drives found across 5 sites                                 |   |
|  |                                                                   |   |
|  |  5. File Download         [check] Pass                            |   |
|  |     Sample file downloaded successfully (234ms)                   |   |
|  |                                                                   |   |
|  |  6. Permission Scope      [!] Partial                             |   |
|  |     Sites.Read.All granted (can read all sites)                   |   |
|  |     Directory.Read.All missing (group membership)                 |   |
|  |     Impact: Permission-based search unavailable                   |   |
|  |     [Download Permission Request Document]                        |   |
|  |                                                                   |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  Result: 5 passed . 1 partial . 0 failed                                 |
|  Your connector is ready to sync.                                         |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 6. Monitoring (Same Panel, Same Tabs) — Post-Setup

After the connector is set up and syncing, the panel tabs shift from configuration to monitoring mode. The tabs are the same, the structure is the same, but the content now shows live data.

### 6a. Overview (default tab post-setup, replaces Connect)

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
|  Other ==                                12 (5%)                          |
|                                                                           |
|  By site:                                                                 |
|  Marketing Hub main    185 docs . 2.1 GB                                  |
|  Marketing Hub archive  52 docs . 1.1 GB                                  |
|                                                                           |
|  --- Sync History ------------------------------------------------------ |
|                                                                           |
|  +--------------------------------------------------------------+        |
|  | Date              | Type  | Docs   | Duration | Status        |        |
|  |-------------------|-------|--------|----------|---------------|        |
|  | Mar 22, 14:30     | Delta | +3, -1 | 45s      | * Done        |        |
|  | Mar 22, 08:30     | Delta | +0     | 12s      | * Done        |        |
|  | Mar 21, 20:30     | Delta | +7, ~2 | 2m 15s   | * Done        |        |
|  | Mar 21, 14:30     | Delta | +1     | 18s      | * Done        |        |
|  | Mar 20, 10:15     | Full  | 237    | 24m 30s  | * Done        |        |
|  +--------------------------------------------------------------+        |
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

---

## 7. Templates and Clone — With Security Gate

### 7a. Add New Connector — Source Selection

When clicking [+ Add] on the dashboard:

```
+-- Add SharePoint Connector --------------------------------------- [x] -+
|                                                                           |
|  How would you like to set up this connector?                             |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  From Scratch                                                     |   |
|  |  Connect a new SharePoint tenant with fresh configuration.        |   |
|  |  The system will auto-discover and recommend settings.            |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  From Template                                                    |   |
|  |  Start with a predefined configuration template.                  |   |
|  |                                                                   |   |
|  |  Available templates:                                             |   |
|  |  * Standard (Sites.Read.All, 27 types, 6h sync)                  |   |
|  |  * Minimal (Sites.Selected, docs only, 24h sync)                 |   |
|  |                                                                   |   |
|  |  * Full Control (all perms, all types, 1h sync, ACL crawl)       |   |
|  |    +-----------------------------------------------------------+  |   |
|  |    | HONEST NOTE: Full Control requests Sites.FullControl.All,  |  |   |
|  |    | which grants read AND write access to all SharePoint       |  |   |
|  |    | sites. This connector only reads data, but the token       |  |   |
|  |    | itself has write capability. Your security team should      |  |   |
|  |    | review this before approval. Most organizations can use    |  |   |
|  |    | "Standard" with Sites.Read.All instead.                    |  |   |
|  |    |                                                           |  |   |
|  |    | Selecting this template sets the Security Approval Gate    |  |   |
|  |    | to "Pending" -- the connector will not sync until a       |  |   |
|  |    | security reviewer approves it.                             |  |   |
|  |    +-----------------------------------------------------------+  |   |
|  |                                                                   |   |
|  |  * Custom... (import JSON)                                        |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  Clone Existing                                                   |   |
|  |  Copy configuration from an existing connector.                   |   |
|  |  Auth credentials are NOT cloned -- you will re-authenticate.     |   |
|  |                                                                   |   |
|  |  Clone from:                                                      |   |
|  |  [Marketing Hub           v]                                      |   |
|  |                                                                   |   |
|  |  What is cloned: filter config, schedule, permission mode,        |   |
|  |  file types, folder rules, size limits.                           |   |
|  |  What is NOT cloned: auth tokens, site selection,                 |   |
|  |  sync history, documents.                                         |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  Import Configuration                                             |   |
|  |  Upload a JSON config file exported from another connector        |   |
|  |  or environment.                                                  |   |
|  |                                                                   |   |
|  |  [Choose File...]  or drag and drop                               |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
|  --- API/CLI ---------------------------------------------------------- |
|                                                                           |
|  Create connectors programmatically:                                      |
|  POST /api/connectors with JSON body                                      |
|  CLI: abl connector create --config connector.json                        |
|  See API documentation for full schema.                                   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 7b. Export Configuration

```
+-- Export Configuration ------------------------------------------- [x] -+
|                                                                           |
|  Export: Marketing Hub                                                     |
|                                                                           |
|  Format: (*) JSON  ( ) YAML                                               |
|                                                                           |
|  What is exported:                                                        |
|  [x] Filter configuration (file types, folder rules, conditions)         |
|  [x] Schedule (frequency, auto-pause threshold)                          |
|  [x] Permission mode                                                     |
|  [x] Scope (site selection, libraries, content types)                    |
|  [ ] App registration details (Client ID, Tenant ID)                     |
|                                                                           |
|  What is NEVER exported (security):                                       |
|  X OAuth tokens, client secrets, refresh tokens                           |
|  X Sync history, document data                                            |
|  X Delta tokens, checkpoint data                                          |
|                                                                           |
|                              [Cancel]  [Download JSON]                    |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 8. Error States

Every error state has a dedicated wireframe. Each shows what happened, why, and what the user can do.

### 8a. Auth Failure (Invalid Credentials)

```
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  X  Authentication Failed                                         |   |
|  |                                                                   |   |
|  |  Microsoft returned: AADSTS700016 -- Application with             |   |
|  |  identifier 'abc123...' was not found in directory                 |   |
|  |  'contoso.onmicrosoft.com'.                                       |   |
|  |                                                                   |   |
|  |  This usually means:                                              |   |
|  |  * The Client ID is incorrect                                     |   |
|  |  * The App Registration was deleted                               |   |
|  |  * The Tenant ID doesn't match the App Registration               |   |
|  |                                                                   |   |
|  |  What to do:                                                      |   |
|  |  1. Verify Client ID in Azure Portal > App Registrations          |   |
|  |  2. Verify Tenant ID matches the directory                        |   |
|  |  3. Check the app hasn't been deleted                             |   |
|  |                                                                   |   |
|  |  [Edit Connection Details]  [Share Error with Admin]              |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8b. Discovery Timeout (1000+ Sites)

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  !  Discovery is taking longer than expected                      |   |
|  |                                                                   |   |
|  |  Found 847 sites so far (still scanning...)                       |   |
|  |  Elapsed: 3 minutes 42 seconds                                    |   |
|  |                                                                   |   |
|  |  Large SharePoint environments can have thousands of              |   |
|  |  sites. You can:                                                  |   |
|  |                                                                   |   |
|  |  [Use 847 sites found so far]                                     |   |
|  |  Continue setup with what's been discovered. You can              |   |
|  |  re-run discovery later to find more.                             |   |
|  |                                                                   |   |
|  |  [Keep waiting...]                                                |   |
|  |  Discovery will complete -- it's enumerating all sites.           |   |
|  |                                                                   |   |
|  |  [Cancel and enter sites manually]                                |   |
|  |  Paste SharePoint site URLs directly if you know which            |   |
|  |  sites you want.                                                  |   |
|  |                                                                   |   |
|  |  [Search discovered sites: ____________]                          |   |
|  |  Filter the 847 sites already found.                              |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8c. Sync Failure

```
+-- Overview --------------------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        X Sync Failed       |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  X  Last sync failed                                              |   |
|  |                                                                   |   |
|  |  Started: Mar 22, 14:30                                           |   |
|  |  Failed after: 12 minutes (processed 145 of ~237 docs)           |   |
|  |                                                                   |   |
|  |  Error: Graph API returned 503 Service Unavailable for            |   |
|  |  drive 'Documents' on site 'Marketing Hub'.                       |   |
|  |  SharePoint may be experiencing an outage.                        |   |
|  |                                                                   |   |
|  |  145 documents were synced successfully before failure.           |   |
|  |  Your existing index is intact -- no data was lost.               |   |
|  |                                                                   |   |
|  |  What to do:                                                      |   |
|  |  * Check Microsoft 365 Service Health for outages                 |   |
|  |  * The next automatic sync will retry in 6 hours                  |   |
|  |  * Or retry now (will resume from checkpoint):                    |   |
|  |                                                                   |   |
|  |  [Retry Now]  [View Full Error Log]                               |   |
|  |                                                                   |   |
|  |  Consecutive failures: 1 of 5 (auto-pause at 5)                  |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8d. Token Expiry

```
Dashboard Card:
+----------------------------------+
|  Marketing Hub                    |
|                                   |
|  ! Token expires in 3 days       |
|                                   |
|  237 docs . Last sync 2h ago     |
|  [Re-authenticate]              |
+----------------------------------+

Detail Panel:
+-- Connect ---------------------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  !  Token expiring soon                                           |   |
|  |                                                                   |   |
|  |  Your OAuth token expires in 3 days (Mar 25, 2026).              |   |
|  |  Automatic refresh failed -- the refresh token may have           |   |
|  |  been revoked or the app registration was modified.               |   |
|  |                                                                   |   |
|  |  If the token expires:                                            |   |
|  |  * Automatic syncs will stop                                      |   |
|  |  * Existing indexed content remains searchable                    |   |
|  |  * New content won't be synced until re-authenticated             |   |
|  |                                                                   |   |
|  |  [Re-authenticate Now]  [Send Re-auth Invite (48h link)]         |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8e. Permission Revoked

```
+-- Security --------------------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  X  Permissions revoked                                           |   |
|  |                                                                   |   |
|  |  The app registration's permissions were changed in               |   |
|  |  Azure AD. Previously granted scopes are no longer                |   |
|  |  available.                                                       |   |
|  |                                                                   |   |
|  |  Before:  Sites.Read.All, offline_access                          |   |
|  |  Now:     offline_access only                                     |   |
|  |                                                                   |   |
|  |  Impact:                                                          |   |
|  |  * Cannot read any SharePoint content                             |   |
|  |  * Syncs will fail until permissions are restored                 |   |
|  |  * Existing indexed content remains searchable                    |   |
|  |                                                                   |   |
|  |  What to do:                                                      |   |
|  |  1. Check Azure Portal > App Registrations > Permissions          |   |
|  |  2. Re-grant Sites.Read.All (or Sites.Selected)                   |   |
|  |  3. Admin must re-consent after permission changes                |   |
|  |                                                                   |   |
|  |  [Download Permission Request Doc]                                |   |
|  |  [Re-check Permissions]                                           |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8f. Throttled (429 — Graph API Rate Limit)

```
+-- Overview --------------------------------------------------------------+
|                                                                           |
|  Marketing Hub                                        ! Throttled         |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  !  Microsoft Graph API throttling                                |   |
|  |                                                                   |   |
|  |  Sync paused -- Microsoft is rate-limiting API requests.          |   |
|  |  This is normal during large syncs or when multiple               |   |
|  |  connectors sync simultaneously.                                  |   |
|  |                                                                   |   |
|  |  Retry-After: 45 seconds                                          |   |
|  |  Sync will automatically resume at 14:31:15                       |   |
|  |                                                                   |   |
|  |  Progress before throttle:                                        |   |
|  |  =================-----  167 / 237 docs (70%)                     |   |
|  |                                                                   |   |
|  |  Throttle events today: 3                                         |   |
|  |  Throttle events this week: 7                                     |   |
|  |                                                                   |   |
|  |  If throttling is frequent, consider:                             |   |
|  |  * Reducing sync frequency (currently every 6h)                   |   |
|  |  * Staggering connector sync times                                |   |
|  |  * Reducing the number of sites per connector                     |   |
|  |                                                                   |   |
|  |  [Wait for auto-resume]  [Pause sync]                             |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8g. Partial Failure (Some Documents Failed)

```
+-- Overview --------------------------------------------------------------+
|                                                                           |
|  Engineering Wiki                                     ! 3 failed docs     |
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  !  Sync completed with errors                                    |   |
|  |                                                                   |   |
|  |  128 documents synced . 3 failed                                  |   |
|  |                                                                   |   |
|  |  Failed documents:                                                |   |
|  |  +------------------------------------------------------------+  |   |
|  |  | Name                    | Error                             |  |   |
|  |  |-------------------------|-----------------------------------|  |   |
|  |  | architecture-v2.vsdx   | Unsupported format                 |  |   |
|  |  | Q4-data.xlsx (120MB)   | Exceeds 100MB size limit          |  |   |
|  |  | encrypted-report.pdf   | Password protected                 |  |   |
|  |  +------------------------------------------------------------+  |   |
|  |                                                                   |   |
|  |  [Retry Failed]  [Adjust Filters to Exclude]                     |   |
|  |  [Dismiss -- these are expected]                                  |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8h. Zero Sites (Sites.Selected with No Approved Sites)

```
+-- Scope -----------------------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  No sites accessible                                              |   |
|  |                                                                   |   |
|  |  Your app registration uses Sites.Selected permissions,           |   |
|  |  but no sites have been approved for this app yet.                |   |
|  |                                                                   |   |
|  |  Option 1: Approve sites via Azure Portal                         |   |
|  |  [Download Approval Guide (with PowerShell script)]               |   |
|  |                                                                   |   |
|  |  Option 2: Switch to Sites.Read.All                               |   |
|  |  Broader permission -- access all sites without approval.         |   |
|  |  Requires admin consent.                                          |   |
|  |  [View Permission Upgrade Steps]                                  |   |
|  |                                                                   |   |
|  |  Option 3: Enter site URLs manually                               |   |
|  |  +------------------------------------------------------+        |   |
|  |  | https://contoso.sharepoint.com/sites/...              |        |   |
|  |  +------------------------------------------------------+        |   |
|  |  [+ Add Site URL]                                                 |   |
|  |                                                                   |   |
|  |  [Re-run Discovery]                                               |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

### 8i. All Files Unsupported

```
+-- Preview (Dry-Run) ----------------------------------------------------+
|                                                                           |
|  +-------------------------------------------------------------------+   |
|  |  No indexable content found                                       |   |
|  |                                                                   |   |
|  |  We scanned 4 sites and found 156 files, but none match           |   |
|  |  your current filter configuration.                               |   |
|  |                                                                   |   |
|  |  Content found at source:                                         |   |
|  |  89 .vsdx (Visio) -- unsupported format                           |   |
|  |  45 .mp4 (video) -- unsupported format                            |   |
|  |  22 .psd (Photoshop) -- unsupported format                        |   |
|  |                                                                   |   |
|  |  Suggestions:                                                     |   |
|  |  * This SharePoint may contain non-document content               |   |
|  |  * Check if documents are in a different library                  |   |
|  |  * Try adding more sites to the scope                             |   |
|  |                                                                   |   |
|  |  [<-- Edit Scope]  [<-- Edit Filters]                             |   |
|  +-------------------------------------------------------------------+   |
|                                                                           |
+---------------------------------------------------------------------------+
```

---

## 9. Destructive Action Confirmation

All destructive actions require confirmation. Delete requires typing the connector name.

```
+-- Confirm: Delete Connector -------------------------------------- [x] -+
|                                                                           |
|  !  This action cannot be undone                                          |
|                                                                           |
|  Deleting "Marketing Hub" will:                                           |
|  * Remove 237 indexed documents from the knowledge base                  |
|  * Clean up all vector embeddings from the search index                  |
|  * Delete all sync history and configuration versions                    |
|  * Revoke the OAuth token                                                |
|  * Remove all associated delta tokens and checkpoints                    |
|                                                                           |
|  Type the connector name to confirm:                                      |
|  +------------------------------------------------------+                |
|  |                                                      |                |
|  +------------------------------------------------------+                |
|                                                                           |
|                              [Cancel]  [Delete Connector]                 |
|                              (Delete button disabled until name           |
|                               matches exactly)                            |
|                                                                           |
+---------------------------------------------------------------------------+
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
| 13  | `POST /connectors/:id/filters/preview`                  | POST   | Dry-run filter preview                     | --     | Yes     |
| 14  | `GET /connectors/:id/delta-tokens`                      | GET    | Per-drive delta token status               | --     | Yes     |
| 15  | `POST /connectors/:id/permissions/crawl`                | POST   | Trigger permission recrawl                 | --     | Yes     |
| 16  | `POST /connectors/bulk/re-auth`                         | POST   | Bulk re-authentication                     | M      | No      |
| 17  | `POST /connectors/bulk/pause`                           | POST   | Bulk pause/resume                          | S      | No      |
| 18  | `POST /connectors/bulk/export`                          | POST   | Bulk config export                         | S      | No      |
| 19  | `GET /connectors/:id/documents/failed`                  | GET    | Failed documents with error messages       | S      | No      |
| 20  | `POST /connectors/:id/auth/invite`                      | POST   | Generate 48h delegation invite link        | M      | No      |
| 21  | `GET /connectors/:id/auth/invite/:token`                | GET    | Validate and complete delegation invite    | M      | No      |
| 22  | `POST /connectors/:id/security/approve`                 | POST   | Security approval gate (approve/reject)    | S      | No      |
| 23  | `GET /connectors/:id/security/review-doc`               | GET    | Generate Security Review Document          | M      | No      |
| 24  | `GET /connectors/:id/filters/odata-preview`             | GET    | Generated OData query for current filters  | S      | No      |

### New Database Models

| Model                    | Purpose                                                 | Fields                                                             |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `SyncRun`                | Per-sync history (currently only latest sync is stored) | `connectorId, type, startedAt, completedAt, duration, counts`      |
| `ConnectorConfigVersion` | Config versioning for restore and diff                  | `connectorId, version, config, changedBy, changedAt, summary`      |
| `ConnectorInvite`        | Delegated auth tracking (48h link)                      | `connectorId, token, email, status, expiresAt, completedBy`        |
| `ConnectorTemplate`      | Predefined configuration templates                      | `name, description, config, isBuiltIn, securityApprovalRequired`   |
| `SecurityApproval`       | Security approval gate tracking                         | `connectorId, status, requestedBy, approvedBy, reviewDocGenerated` |

### Existing Model Changes

| Model               | Change                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `ConnectorConfig`   | Add `clonedFrom`, `templateId`, `autoResumeAfter`, `securityApprovalStatus`    |
| `EndUserOAuthToken` | Add `authenticatedBy` (email of who authenticated), `inviteId` (if via invite) |

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

## 11. Self-Review

### A. 21 Known Issues — Scorecard

| #   | Issue                                       | Status | How Addressed in v2                                                                                                                                                                 |
| --- | ------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No Azure App Registration guidance          | SOLVED | Connect tab has expandable guide + downloadable PDF. First-time experience offers "Sign in with Microsoft" path that skips app registration entirely.                               |
| 2   | Device code != admin consent conflated      | SOLVED | Explicit separation in Connect tab. Disclaimer inline. 48h delegation invite as alternative to 15-min device code.                                                                  |
| 3   | Sites.FullControl.All mitigation misleading | SOLVED | HONEST NOTE on Full Control template. Security approval gate auto-enabled. Security tab shows actual scopes with honest capability descriptions.                                    |
| 4   | Error states completely unspecified         | SOLVED | 9 dedicated error wireframes (section 8): auth failure, discovery timeout, sync failure, token expiry, permission revoked, throttled, partial failure, zero sites, all unsupported. |
| 5   | Discovery timeout for 1000+ sites           | SOLVED | Progressive results, "use what we found," search/filter, manual URL entry, cancel button.                                                                                           |
| 6   | No dry-run/preview before sync              | SOLVED | Preview is a visible first-class tab (not hidden in overflow). Filter diff shows delta on re-preview.                                                                               |
| 7   | Sites.Selected not supported                | SOLVED | Scope tab adapts: shows approved sites, PowerShell guide download, manual URL entry, upgrade option.                                                                                |
| 8   | "Proposal" was a pre-filled form            | SOLVED | Scope tab with conversational voice: "Here is what I found. I recommend..." Inline site selection, not a dialog.                                                                    |
| 9   | No bulk/clone/template for multi-connector  | SOLVED | Dashboard with bulk actions bar, clone, template (with security gate), import/export JSON, API/CLI mention.                                                                         |
| 10  | No filter dry-run/preview                   | SOLVED | "Run Preview" button on Filters tab. Preview tab shows full dry-run. Filter monitoring shows live match counts. OData query preview for power users.                                |
| 11  | Security doc missing data handling          | SOLVED | Security tab has consolidated 7-section Security Review Document with download and copy-as-markdown. Includes data handling, retention, risk assessment.                            |
| 12  | Competitive claims overstated               | SOLVED | No competitive claims in the design.                                                                                                                                                |
| 13  | Graph API throttling unaddressed            | SOLVED | Dedicated throttle error wireframe (8f). Health check shows API quota. History tab shows throttle events.                                                                           |
| 14  | Pre-fetch/post-fetch leaks impl details     | SOLVED | Filters tab labels by user impact. OData Preview expandable shows which filters are pre-fetch vs post-fetch with clear "reduces API calls" / "evaluates locally" labels.            |
| 15  | No connection validation checklist          | SOLVED | 6-axis Health Check: auth, Graph API, site access, drive enum, file download, permission scope. Re-runnable on demand.                                                              |
| 16  | Custom SharePoint metadata not discoverable | SOLVED | Filters tab metadata conditions show discovered columns as dropdown. Available in CEL editor autocomplete.                                                                          |
| 17  | No multi-connector monitoring dashboard     | SOLVED | Dashboard IS the primary view. Card (1-6) and table (7+) with status, docs, size, sites, failures, token health.                                                                    |
| 18  | Empty states undefined                      | SOLVED | Warm welcome state (0 connectors), connected but not synced state, plus all error empty states.                                                                                     |
| 19  | Loading states incomplete                   | SOLVED | Streaming discovery with progressive list. Sync progress on cards. Health check per-axis progress.                                                                                  |
| 20  | Multiple tenants in one KB not addressed    | SOLVED | Each connector has its own tenant. Table view includes Tenant column and filter. Multiple tenants coexist independently.                                                            |
| 21  | Proposal in dialog too complex              | SOLVED | No dialog. Configuration across panel tabs (Scope, Filters, Schedule, Security). 720px panel with expand-to-fullpage option.                                                        |

**Score: 21/21 SOLVED**

### B. 9 Shared Objectives — Scores (1-5)

| #   | Objective                                                      | Score | Notes                                                                                                       |
| --- | -------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Guide user from zero to synced documents                       | 5     | Warm welcome state, "Just connect my Microsoft account" path, conversational discovery, preview before sync |
| 2   | Show what the system discovered and why it recommends          | 5     | Scope tab with scores, reasons, expandable "why not recommended" sections, conversational voice             |
| 3   | Let user customize filters with preview                        | 5     | Inline filter editing, CEL autocomplete, OData transparency, filter diff on re-preview                      |
| 4   | Surface errors with remediation                                | 5     | 9 error wireframes, each with cause/impact/remediation. Health check for proactive detection.               |
| 5   | Support delegation (developer configures, admin authenticates) | 5     | 48h invite link, pre-written email template (copy + open in email client), configure-before-auth            |
| 6   | Handle security review workflow                                | 5     | Consolidated Security tab, exportable review doc, pending approval gate, HONEST NOTE on Full Control        |
| 7   | Scale to 15+ connectors                                        | 5     | Dashboard table view, bulk actions, clone/template/import, API/CLI                                          |
| 8   | Provide monitoring and management post-setup                   | 5     | Same panel shifts to monitoring mode. Sync history, health checks, filter effectiveness, quick actions.     |
| 9   | Handle empty, loading, and error states                        | 5     | Welcome state, streaming discovery, progressive results, 9 error states, all with actionable guidance       |

**Average: 5.0/5**

### C. Persona Walk-Throughs

**Sarah (first-time user, non-technical):**

- Opens dashboard, sees warm welcome with "Just connect my Microsoft account" button
- Clicks it, signs in with browser login, no App Registration needed
- Discovery runs automatically with conversational voice: "Here is what I found..."
- Preview tab is visible and shows exactly what will sync before any data moves
- Panel is 720px wide — plenty of room for guidance text and explanations
- Verdict: **Happy.** The first-time experience is welcoming, not intimidating. The dashboard complexity is hidden until she has connectors to manage.

**Raj (IT admin managing 15 connectors):**

- Dashboard table view shows all 15 connectors at a glance with status, docs, tokens
- Selects 5 with expired tokens, clicks "Re-auth Selected" in bulk actions bar
- Clones Marketing Hub config for new Sales West connector
- Exports all configs as JSON for disaster recovery
- API/CLI section lets him script connector creation
- Verdict: **Happy.** "Only design where I wouldn't dread connector #16" still applies. Dashboard + bulk ops preserved. 2.5-4 hours for 15 connectors.

**Maria (security reviewer):**

- Full Control template shows HONEST NOTE about write-capable token
- Selecting Full Control auto-sets Security Approval Gate to "Pending"
- Security tab consolidates all security info in one place (not spread across tabs)
- Downloads Security Review Document with 7 sections (permissions, data handling, retention, risk)
- Approves or rejects via approval gate
- Verdict: **Happy.** Template security concern resolved. Security info consolidated. Approval gate prevents accidental sync before review.

**Chen (developer who configures, admin authenticates):**

- Selects "Someone else will authenticate (delegation)" in Connect tab
- Configures scope, filters, schedule while waiting for auth (configure-before-auth)
- Clicks "Send Authentication Invite" — generates 48h link
- Pre-written email template has Subject, body with Option A (device code) and Option B (48h link), permission explanation
- [Copy to Clipboard] and [Open in Email Client] buttons
- Verdict: **Happy.** Delegation is as polished as Design A's email template, with the added 48h link that eliminates the 15-minute device code pressure.

**Alex (power user, filter iteration):**

- Edits filters inline in the Filters tab — no tab switching
- Expands "OData Query Preview" to see the generated server-side query
- Uses CEL editor with autocomplete for complex conditions
- Clicks [Run Preview] — sees filter diff showing delta from last preview
- Clicks [<>] expand to go full-page for complex filter work
- Verdict: **Happy.** Filter iteration as fast as Design B (inline editing). OData transparency added (Design A steal). CEL autocomplete solves the syntax pain. Filter diff shows what changed.

### D. Universal Pain Points — All 8 Addressed

| #   | Pain Point                             | Status | How Addressed                                                                                                                    |
| --- | -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 15-minute device code expiry           | SOLVED | 48h delegation invite link as alternative. Pre-written email offers both options (quick device code OR 48h link).                |
| 2   | No "Just connect my Microsoft account" | SOLVED | Welcome state has "Connect with Microsoft" button — browser login, no App Registration needed for getting started.               |
| 3   | No CEL autocomplete                    | SOLVED | CEL editor has syntax highlighting + field autocomplete (resource.size, resource.name, resource.metadata.\*, etc.)               |
| 4   | No filter diff on re-preview           | SOLVED | Filter change detection with badge on Preview tab. Delta view: "+12 docs skipped, -3 docs added" vs last preview.                |
| 5   | No "Pending Security Approval" gate    | SOLVED | Security tab has approval gate (No approval required / Pending / Approved). Full Control template auto-sets to Pending.          |
| 6   | No API/CLI-first setup                 | SOLVED | API endpoint documented in Add Connector dialog. CLI mention. Import JSON config. POST /api/connectors with JSON body.           |
| 7   | Configure-before-auth mode             | SOLVED | All tabs (Scope, Filters, Schedule, Security) are editable before auth completes. "Everything saves and applies once connected." |
| 8   | Vector embedding cleanup               | SOLVED | Delete confirmation mentions vector cleanup. History tab Danger Zone notes cleanup. Backend fix #5 implements it.                |

---

## 12. Review Status: CLEAN

### v2 Changes Summary

1. **First-time experience redesigned** — Warm welcome state, "Just connect my Microsoft account" button, conversational discovery voice, wider panel (720px)
2. **Preview promoted** — Visible first-class tab, not hidden in overflow menu
3. **Security consolidated** — Single Security tab with scopes, permissions, approval gate, exportable review document
4. **Template security gate** — HONEST NOTE on Full Control, auto-pending approval gate
5. **Delegation polished** — 48h invite link, pre-written email with copy/open-in-email, eliminates 15-min device code pressure
6. **Filter iteration improved** — Inline editing, OData query preview, CEL autocomplete, filter diff on re-preview, expand-to-fullpage
7. **Configure-before-auth** — All tabs editable while waiting for authentication
8. **API/CLI mentioned** — POST endpoint and CLI in Add Connector dialog
9. **Vector cleanup** — Delete confirmation mentions it, backend fix specified
10. **Panel width** — 720px consistent (up from 560px), with expand-to-fullpage option

### Remaining Gaps (MEDIUM/LOW only — no CRITICAL or HIGH)

- **MEDIUM** — Dashboard loading skeleton wireframe not shown (card/table loading state)
- **MEDIUM** — Panel tab overflow behavior on very small viewports unspecified (7 tabs in 720px should fit, but edge case)
- **LOW** — "Stagger sync times" suggestion in throttle error has no actionable UI (would need cross-connector schedule coordination)
- **LOW** — No keyboard shortcuts specified for power user navigation
- **LOW** — History tab Danger Zone could be a separate section to avoid accidental scrolling to destructive actions
