# Design B v2: Reviewable Document + Operations Dashboard

**Date:** 2026-03-22
**Pattern:** Conversational proposal document (setup) + multi-connector operations dashboard (monitoring)
**Status:** Design proposal (v2 -- incorporates all 5-persona user testing feedback)
**Lineage:** Evolves v1's document metaphor; steals delegation polish from Design A, dashboard/bulk-ops from Design C

---

## 0. What Changed from v1

| Area                       | v1                                      | v2                                                                      |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Multi-connector monitoring | Card list with summary line             | Full dashboard matrix with table view, sparklines, tenant grouping      |
| Delegation handoff         | "Share link" + "Send via Email" generic | Pre-written email template with subject line, 48h delegation invite URL |
| Bulk operations            | Select + Sync Now / Pause               | Select + re-auth, pause, export, apply schedule, apply filter template  |
| Config export              | PDF only                                | PDF + JSON + YAML (version-controllable)                                |
| Scale handling             | Virtual scroll at 50+ sites             | Auto table-view at 7+ connectors, virtual scroll at 50+ sites           |
| Device code expiry         | 15-minute window, no workaround         | 48h delegation invite URL that survives device code rotation            |
| Pre-configured auth        | Manual credentials always               | "Connect my Microsoft account" SSO button for pre-configured tenants    |
| CEL editor                 | Plain textarea with variable list       | Syntax highlighting + field autocomplete + error squiggles              |
| Filter change preview      | Match count only                        | Diff view: "+12 included, -3 excluded" with sample list                 |
| Security approval          | Export PDF, share manually              | Formal "Pending Security Approval" gate with approval workflow          |
| API/CLI setup              | Not addressed                           | API endpoints + CLI examples for programmatic connector creation        |
| Configure-before-auth      | Auth blocks everything                  | Configure scope/filters/schedule while auth pending                     |
| Vector cleanup             | Known gap, documented                   | Automatic cleanup on delete, documented in security review              |
| OData transparency         | Hidden                                  | Raw OData query visible in advanced filter view                         |

---

## 1. Philosophy

The system generates a complete configuration proposal as a readable, annotated document. Each section can be independently accepted, modified, or skipped -- turning setup into a review process rather than a wizard.

**v2 addition:** The document is the setup experience. The dashboard is the operations experience. They coexist. The document generates the connector; the dashboard monitors all connectors. When you click a connector on the dashboard, it opens its approved document (now showing live data). At 7+ connectors, the dashboard auto-switches to a dense table view that satisfies fleet-scale operations.

**Tone:** The system speaks as a knowledgeable colleague: "I discovered 12 SharePoint sites... I recommend syncing 8 based on activity and relevance." This conversational framing (Sarah's favorite) is preserved in every section.

---

## 2. Flow Diagram

```
                     ┌─────────────────────┐
                     │    Connect Screen    │
                     │                      │
                     │  [Connect Microsoft  │──── SSO path (pre-configured orgs)
                     │   Account]           │     skips credential entry
                     │                      │
                     │  -- OR --            │
                     │                      │
                     │  Enter App Reg       │──── Manual path
                     │  credentials         │
                     │  [Authenticate]      │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │   Auth + Consent      │
                     │                       │
                     │  Device code OR       │
                     │  Auth code OR         │
                     │  Client creds         │
                     │                       │
                     │  [Delegate via Email] │──── 48h invite URL
                     │                       │
                     │  While waiting:       │
                     │  Configure scope,     │──── Configure-before-auth
                     │  filters, schedule    │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │    Generating...      │
                     │                       │
                     │  Discovery runs       │
                     │  Profiling runs       │
                     │  Recommendations      │
                     │  generated            │
                     │                       │
                     │  Sections appear      │
                     │  as they resolve      │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼──────────────────────────────────┐
                     │                                              │
                     │  SharePoint Configuration Proposal           │
                     │  Generated Mar 22, 2026                      │
                     │                                              │
                     │  § Connection      [Accepted]                │
                     │  § Health Check    [6/6 passed]              │
                     │  § Scope           [Modified]                │
                     │  § Filters         [Accepted]                │
                     │  § Schedule        [Accepted]                │
                     │  § Permissions     [Skipped]                 │
                     │  § Sample Preview  [Reviewed]                │
                     │  § Security Gate   [Pending Approval]        │
                     │                                              │
                     │  [Export PDF] [Export JSON/YAML] [Approve]   │
                     │                                              │
                     └──────────┬──────────┬───────────────────────┘
                                │          │
                     ┌──────────▼───┐  ┌───▼──────────────────────┐
                     │  Export       │  │  Security Gate           │
                     │  PDF/JSON/   │  │                          │
                     │  YAML        │  │  If gate enabled:        │
                     │              │  │  Pending approval...     │
                     │              │  │  [Approved] -> Sync      │
                     │              │  │                          │
                     │              │  │  If gate disabled:       │
                     │              │  │  Sync starts immediately │
                     └──────────────┘  └──────────┬───────────────┘
                                                   │
                     ┌─────────────────────────────▼───────────────┐
                     │                                              │
                     │  Operations Dashboard                        │
                     │  (auto-switches to table at 7+ connectors)  │
                     │                                              │
                     │  Click connector -> Opens live document      │
                     │  Bulk select -> Bulk actions toolbar         │
                     │                                              │
                     └─────────────────────────────────────────────┘
```

---

## 3. Connect Screen (Pre-Document)

### 3.1 Dual-Path Entry: SSO vs Manual

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Connect to SharePoint                                               │
│                                                                      │
│  ┌─ Quick Connect (pre-configured organizations) ─────────────────┐ │
│  │                                                                  │ │
│  │  Your organization has pre-configured Microsoft 365 access.      │ │
│  │                                                                  │ │
│  │  [Connect My Microsoft Account]                                  │ │
│  │                                                                  │ │
│  │  Signs in with your org credentials. No App Registration needed. │ │
│  │  Available because your admin pre-configured tenant: contoso.com │ │
│  │                                                                  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ─── Or: Manual Setup ────────────────────────────────────────────── │
│                                                                      │
│  ┌─ How to create an App Registration ──────────────────── [v] ──┐  │
│  │                                                                │  │
│  │  1. Go to portal.azure.com > Azure Active Directory            │  │
│  │     > App registrations > New registration                     │  │
│  │                                                                │  │
│  │  2. Name: "ABL Platform - SharePoint" (or any name)            │  │
│  │                                                                │  │
│  │  3. Redirect URI: Select "Web" and enter:                      │  │
│  │     https://your-domain.com/api/connectors/auth/callback       │  │
│  │     [Copy to clipboard]                                        │  │
│  │                                                                │  │
│  │  4. Under API Permissions, add:                                │  │
│  │     Microsoft Graph > Delegated:                               │  │
│  │       Sites.Read.All  (read all sites)                         │  │
│  │       -- OR --                                                 │  │
│  │       Sites.Selected  (least-privilege, recommended)           │  │
│  │     [What's the difference?]                                   │  │
│  │                                                                │  │
│  │  5. Copy the Application (client) ID and Directory             │  │
│  │     (tenant) ID from the Overview page                         │  │
│  │                                                                │  │
│  │  [Open Azure Portal]                                           │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ─── Credentials ──────────────────────────────────────────────────  │
│                                                                      │
│  Client ID                                                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ e.g. 12345678-abcd-efgh-ijkl-123456789012                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Tenant ID                                                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ e.g. 87654321-dcba-hgfe-lkji-210987654321                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Client Secret (optional -- required for Client Credentials flow)    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ─── Authentication Method ────────────────────────────────────────  │
│                                                                      │
│  (*) Device Code     -- Best for delegation. Share a code.           │
│  ( ) Auth Code       -- Browser popup. You authenticate now.         │
│  ( ) Client Creds    -- App-only. Requires client secret.            │
│                                                                      │
│  ─── API/CLI Alternative ─────────────────────────────────────────── │
│                                                                      │
│  Prefer programmatic setup?                                          │
│  [View API Docs]   [Copy cURL Template]   [Copy CLI Command]        │
│                                                                      │
│                                                  [Continue]          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**API/CLI setup:** For teams that prefer infrastructure-as-code, the API allows full connector creation:

```bash
# Create connector via API
curl -X POST /api/indexes/{indexId}/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -d @connector-config.json

# Or via CLI
abl connector create --index $INDEX_ID --config connector-config.yaml
```

The JSON/YAML config files use the same schema as the export format (Section 6), enabling round-trip: export from UI, modify in editor, re-import via API.

### 3.2 Auth + Delegation with 48h Invite URL

After clicking Continue, auth and admin consent are presented with the new delegation model:

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Authenticate                                                        │
│                                                                      │
│  ─── Step 2a: Sign In ─────────────────────────────────────────────  │
│                                                                      │
│  Go to microsoft.com/devicelogin and enter this code:                │
│                                                                      │
│              ┌──────────────────────┐                                │
│              │     ABCD-1234        │  [Copy]                        │
│              └──────────────────────┘                                │
│                                                                      │
│  [Open microsoft.com/devicelogin]                                    │
│                                                                      │
│  Waiting for sign-in...  o (expires in 14:32)                        │
│                                                                      │
│  ─── Step 2b: Admin Consent (separate) ────────────────────────────  │
│                                                                      │
│  After signing in, an Azure AD admin must grant consent               │
│  for the requested permissions.                                      │
│                                                                      │
│  Status: Waiting for sign-in to complete first                       │
│                                                                      │
│  ─── Or: Delegate Authentication ──────────────────────────────────  │
│                                                                      │
│  If someone else needs to authenticate (e.g., a security admin):     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │  Delegation Invite (valid for 48 hours)                       │   │
│  │                                                               │   │
│  │  This invite survives device code expiry. When the delegate   │   │
│  │  opens the link, a fresh device code is generated for them.   │   │
│  │                                                               │   │
│  │  Link: https://app.example.com/auth/invite/abc123def456       │   │
│  │  [Copy Link]                                                  │   │
│  │                                                               │   │
│  │  [Send Pre-Written Email]                                     │   │
│  │                                                               │   │
│  │  Pre-filled email:                                            │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │ To:      [security-admin@contoso.com]                │    │   │
│  │  │ Subject: Action Required: SharePoint connector       │    │   │
│  │  │          authentication for ABL Platform             │    │   │
│  │  │                                                      │    │   │
│  │  │ Hi,                                                  │    │   │
│  │  │                                                      │    │   │
│  │  │ I'm setting up a SharePoint connector in ABL         │    │   │
│  │  │ Platform to index our document libraries for         │    │   │
│  │  │ AI-powered search.                                   │    │   │
│  │  │                                                      │    │   │
│  │  │ I need someone with Azure AD admin access to:        │    │   │
│  │  │  1. Click this link (valid 48 hours):                │    │   │
│  │  │     https://app.example.com/auth/invite/abc123...    │    │   │
│  │  │  2. Sign in with your Microsoft account              │    │   │
│  │  │  3. Grant admin consent for Sites.Read.All           │    │   │
│  │  │                                                      │    │   │
│  │  │ Permissions requested:                               │    │   │
│  │  │  - Sites.Read.All (read-only access to sites)        │    │   │
│  │  │  - Files.Read.All (read-only access to files)        │    │   │
│  │  │                                                      │    │   │
│  │  │ This grants READ-ONLY access. No data is modified    │    │   │
│  │  │ or deleted. Full security review available on        │    │   │
│  │  │ request.                                             │    │   │
│  │  │                                                      │    │   │
│  │  │ Thanks,                                              │    │   │
│  │  │ [Your Name]                                          │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  │                                                               │   │
│  │  [Send Email]   [Copy Email Body]   [Edit Before Sending]    │   │
│  │                                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ─── While Waiting: Configure Ahead ──────────────────────────────  │
│                                                                      │
│  You can configure scope, filters, and schedule while waiting        │
│  for authentication to complete. These settings will apply when      │
│  auth succeeds.                                                      │
│                                                                      │
│  [Start Configuring]  -- opens proposal in draft mode               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**48h delegation invite URL:** The invite link is NOT a device code. It is a platform-generated token (stored in `AuthDelegation` model) that, when opened, generates a fresh device code for the delegate. This solves the 15-minute device code expiry: the delegate has 48 hours to open the link, and once opened, they get a fresh 15-minute window. If they miss it, they can re-open the same link for another fresh code.

**Configure-before-auth:** Clicking "Start Configuring" opens the proposal document in draft mode. Sections that depend on discovery (Scope, Sample Preview) show placeholder states: "Will be populated after authentication completes." Sections that don't depend on auth (Filters by template, Schedule, Permissions mode) are fully editable immediately.

### 3.3 Auth Completed -> Document Generation

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Authenticated as maria@contoso.com                                  │
│  Admin consent granted                                               │
│  Delegated by: dev-team@contoso.com (via 48h invite)                │
│                                                                      │
│  Generating your configuration proposal...                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Connection        Done                                      │   │
│  │  Health Check      Running checks...                         │   │
│  │  Scope             Discovering sites...                      │   │
│  │  Filters           Waiting for scope                         │   │
│  │  Schedule          Analyzing patterns...                     │   │
│  │  Permissions       Detecting granted scopes...               │   │
│  │  Sample Preview    Waiting for filters                       │   │
│  │  Security Gate     Waiting for all sections                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Sections will appear as they are ready. This typically              │
│  takes 30-90 seconds depending on the number of sites.              │
│                                                                      │
│  (Any pre-configured settings from draft mode are applied            │
│  automatically.)                                                     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. The Document -- Section-by-Section Wireframes

### Document Chrome (always visible)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  SharePoint Configuration Proposal                                   │
│  Generated Mar 22, 2026 at 14:23 UTC                                │
│  Connector: sp-corp-main                                            │
│                                                                      │
│  ┌── Table of Contents ────────────────────────────────────────┐    │
│  │  Connection      [Accepted]                                  │    │
│  │  Health Check    [6/6 passed]                                │    │
│  │  Scope           [Modified]                                  │    │
│  │  Filters         [Accepted]                                  │    │
│  │  Schedule        [Accepted]                                  │    │
│  │  Permissions     [Skipped]                                   │    │
│  │  Sample Preview  [Reviewed]                                  │    │
│  │  Security Gate   [Approved]                                  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Progress: 7 of 8 sections reviewed   [Accept All Remaining]        │
│                                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  (sections below)                                                    │
│                                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  [Export as PDF]  [Export JSON/YAML]  [Approve All & Start Sync]     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Approval confirmation:** Clicking "Approve All & Start Sync" shows an inline confirmation banner: "This will sync ~3,801 documents (~4.2 GB) from 8 SharePoint sites. Sync will begin immediately. [Confirm & Start Sync] [Cancel]". If any sections are still "Pending", the button is disabled with tooltip "Review all sections before approving." If the Security Gate section is enabled and not yet approved, the button reads "Submit for Security Approval" instead.

### 4.1 Section: Connection

**Collapsed (accepted):**

```
┌── Connection ──────────────────────────────────── [Accepted] ──────┐
│  Connected as maria@contoso.com via Device Code. Token healthy.    │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded (default on first view):**

```
┌── Connection ──────────────────────────────────────────────────────┐
│                                                                     │
│  I established a connection to your Microsoft 365 tenant            │
│  contoso.onmicrosoft.com. Everything looks healthy.                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Tenant         contoso.onmicrosoft.com                       │  │
│  │  Client ID      a1b2c3d4-e5f6-7890-abcd-ef1234567890         │  │
│  │  Auth Method    Device Code Flow                              │  │
│  │  Authenticated  maria@contoso.com                             │  │
│  │  Auth Time      Mar 22, 2026 14:20 UTC                        │  │
│  │  Token Expires  Mar 22, 2026 15:20 UTC (59 min remaining)     │  │
│  │  Refresh Token  Valid (expires Apr 21, 2026)                  │  │
│  │  Delegated By   dev-team@contoso.com (via 48h invite)         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  [Accept]   [Re-authenticate]   [Skip]                              │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Section: Health Check

**Collapsed (accepted):**

```
┌── Health Check ─────────────────────────────────── [6/6 passed] ───┐
│  All checks passed. Graph API reachable, permissions sufficient.   │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Health Check ────────────────────────────────────────────────────┐
│                                                                     │
│  I ran 6 validation checks against your Microsoft 365 tenant.       │
│  All passed.                                                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  ok  Graph API reachable         14ms response               │  │
│  │  ok  Token valid                 59 min remaining            │  │
│  │  ok  Sites.Read.All granted      Can enumerate all sites     │  │
│  │  ok  Files.Read.All granted      Can read file content       │  │
│  │  ok  At least 1 site accessible  Found 12 sites              │  │
│  │  ok  Rate limit headroom         9,800 of 10,000 req/10min  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  [Accept]   [Re-run Checks]   [Skip]                                │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**With failures:**

```
┌── Health Check ─────────────────────────────────── [4/6 passed] ───┐
│                                                                     │
│  I ran 6 validation checks. 4 passed, 2 need attention.            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  ok    Graph API reachable         14ms response             │  │
│  │  ok    Token valid                 59 min remaining          │  │
│  │  FAIL  Sites.Read.All NOT granted  Only Sites.Selected       │  │
│  │        You have access to 3 of 12 sites. To access all:      │  │
│  │        [Request broader permissions]  [Continue with 3 sites] │  │
│  │  ok    Files.Read.All granted      Can read file content     │  │
│  │  ok    At least 1 site accessible  Found 3 sites             │  │
│  │  WARN  Rate limit warning          Only 200 of 10,000 remain │  │
│  │        Another application is consuming your quota. Sync may  │  │
│  │        be throttled. Consider scheduling sync during off-hrs. │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  [Accept with warnings]  [Re-run]  [Skip]                           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.3 Section: Scope

**Collapsed (accepted):**

```
┌── Scope ──────────────────────────────────────── [Accepted] ───────┐
│  8 of 12 sites selected, containing 14 document libraries.        │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Scope ───────────────────────────────────────────────────────────┐
│                                                                     │
│  I discovered 12 SharePoint sites with 18 document libraries.       │
│  I recommend syncing 8 sites (14 libraries) based on:               │
│   - Activity score (documents modified in last 30 days)             │
│   - Content relevance (file types your pipeline can process)        │
│   - Size (estimated 4.2 GB, within your storage quota)              │
│                                                                     │
│  4 sites excluded:                                                  │
│   - "Archived Projects" -- no activity in 180+ days                 │
│   - "Personal Sites" -- user OneDrive, not shared content           │
│   - "Test Environment" -- flagged as non-production                 │
│   - "External Vendors" -- sensitivity score too high                │
│                                                                     │
│  ┌─ Recommended Sites ──────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  [x] Corp Docs           4 libraries   1,234 docs  2.1GB     │  │
│  │      Score: 92  Activity: High  Last modified: 2h ago         │  │
│  │                                                               │  │
│  │  [x] Engineering Hub     3 libraries     890 docs  1.4GB     │  │
│  │      Score: 87  Activity: High  Last modified: 30m ago        │  │
│  │                                                               │  │
│  │  [x] Product Docs        2 libraries     456 docs  0.3GB     │  │
│  │      Score: 81  Activity: Medium  Last modified: 1d ago       │  │
│  │                                                               │  │
│  │  [x] HR Portal           1 library       234 docs  0.2GB     │  │
│  │  [x] Marketing           2 libraries     567 docs  0.1GB     │  │
│  │  [x] Legal               1 library       189 docs  0.05GB    │  │
│  │  [x] Support KB          1 library       345 docs  0.04GB    │  │
│  │  [x] Sales Enablement    1 library       123 docs  0.01GB    │  │
│  │                                                               │  │
│  │  --- Excluded (uncheck to include) ────────────────────────── │  │
│  │                                                               │  │
│  │  [ ] Archived Projects   2 libraries     12K docs  8.5GB     │  │
│  │      Reason: No activity in 180+ days                         │  │
│  │                                                               │  │
│  │  [ ] Personal Sites      --              --        --         │  │
│  │      Reason: OneDrive personal content                        │  │
│  │                                                               │  │
│  │  [ ] Test Environment    1 library        45 docs  0.01GB    │  │
│  │      Reason: Non-production site                              │  │
│  │                                                               │  │
│  │  [ ] External Vendors    1 library        78 docs  0.2GB     │  │
│  │      Reason: High sensitivity score (external sharing)        │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Summary: 8 sites, 14 libraries, ~4,038 documents, ~4.2 GB         │
│                                                                     │
│  [Accept]   [Modify Selection]   [Skip]                             │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Large-scale handling (100+ sites):** When discovery returns more than 50 sites, the site list uses virtual scrolling with search/filter controls. Sites are paginated in groups of 25 with "Show More" loading. The recommendation algorithm runs server-side and returns a pre-sorted, pre-categorized list so the client never receives unbounded data. Discovery itself uses server-side pagination of the Graph API `/sites` endpoint with a 120-second timeout; if discovery times out, partial results are shown with a "Discovery incomplete -- {N} sites found so far. [Continue Discovery] [Use These Sites]" banner.

### 4.4 Section: Filters

**Collapsed (accepted):**

```
┌── Filters ────────────────────────────────────── [Accepted] ───────┐
│  Syncing 3,801 of 4,038 docs. 237 excluded (exec, archive, >50MB) │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Filters ─────────────────────────────────────────────────────────┐
│                                                                     │
│  I recommend syncing 3,801 of 4,038 documents from your            │
│  selected sites. 237 excluded:                                      │
│                                                                     │
│   - 14 executables (.exe, .msi, .bat) -- blocked by policy          │
│   - 189 files in /Archive folders -- template: "Skip Archives"      │
│   - 8 files in /_private paths -- template: "Skip Private"          │
│   - 23 files over 50 MB -- size limit                               │
│   - 3 unsupported formats (.dwg, .pst) -- not processable          │
│                                                                     │
│  Applied templates:                                                 │
│   - "Office Documents" (docx, xlsx, pptx, pdf, txt, md, csv)       │
│   - "Skip Archives" (exclude /Archive, /Old, /Backup paths)        │
│   - "Skip Private" (exclude /_private, /_drafts paths)              │
│                                                                     │
│  File type breakdown of included documents:                         │
│   PDF: 1,204 (32%)  |  DOCX: 987 (26%)  |  PPTX: 456 (12%)       │
│   XLSX: 389 (10%)   |  TXT: 234 (6%)    |  Other: 531 (14%)      │
│                                                                     │
│  [Accept]   [Modify Filters]   [Skip]                               │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.5 Section: Schedule

**Collapsed (accepted):**

```
┌── Schedule ───────────────────────────────────── [Accepted] ───────┐
│  Full sync now, then delta sync every 4 hours.                     │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Schedule ────────────────────────────────────────────────────────┐
│                                                                     │
│  I recommend the following sync schedule based on your content       │
│  volume (~4K docs) and update frequency (avg 45 changes/day):       │
│                                                                     │
│  Initial:  Full sync immediately after approval                     │
│            Estimated duration: 15-25 minutes (4.2 GB)               │
│                                                                     │
│  Ongoing:  Delta sync every 4 hours                                 │
│            Estimated per-run: 30-90 seconds (avg 8 changes)         │
│                                                                     │
│  Webhooks: Not available                                            │
│            Real-time push notifications from SharePoint are          │
│            not yet enabled for this platform. Delta sync is          │
│            used as the fallback.                                     │
│                                                                     │
│  [Accept]   [Modify Schedule]   [Skip]                              │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.6 Section: Permissions

**Collapsed (skipped):**

```
┌── Permissions ────────────────────────────────── [Skipped] ────────┐
│  Permission crawling disabled. Search results not ACL-filtered.    │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Permissions ─────────────────────────────────────────────────────┐
│                                                                     │
│  Permission-aware search ensures users only see documents they      │
│  have access to in SharePoint. This requires crawling ACLs.         │
│                                                                     │
│  ┌─ Current Permissions ─────────────────────────────────────────┐ │
│  │                                                                │ │
│  │  Granted scope: Sites.Read.All                                 │ │
│  │  Sufficient for: Document sync, metadata, content              │ │
│  │                                                                │ │
│  │  ┌─ Permission Modes ──────────────────────────────────────┐  │ │
│  │  │                                                          │  │ │
│  │  │  ( ) Full ACL Crawl                                      │  │ │
│  │  │      Crawls SharePoint permissions into a graph.         │  │ │
│  │  │      Search results filtered by user's SharePoint        │  │ │
│  │  │      access. Requires: Sites.FullControl.All             │  │ │
│  │  │                                                          │  │ │
│  │  │      Why FullControl? Microsoft Graph requires this      │  │ │
│  │  │      scope to read site permission assignments and       │  │ │
│  │  │      sharing links. Despite the name, ABL Platform       │  │ │
│  │  │      only performs READ operations (no writes, no        │  │ │
│  │  │      deletes). All API calls are audited.                │  │ │
│  │  │                                                          │  │ │
│  │  │      Status: NOT AVAILABLE (scope not granted)           │  │ │
│  │  │      [Request scope upgrade]                             │  │ │
│  │  │                                                          │  │ │
│  │  │  ( ) Simplified Permissions                              │  │ │
│  │  │      Uses site-level membership only (no item ACLs).     │  │ │
│  │  │      Faster but less granular.                           │  │ │
│  │  │      Requires: Sites.Read.All (GRANTED)                  │  │ │
│  │  │                                                          │  │ │
│  │  │  (*) Disabled                                            │  │ │
│  │  │      All synced documents visible to all users.          │  │ │
│  │  │      Simplest setup, no permission filtering.            │  │ │
│  │  │                                                          │  │ │
│  │  └────────────────────────────────────────────────────────┘  │ │
│  │                                                                │ │
│  │  --- Scope Upgrade Options ────────────────────────────────── │ │
│  │                                                                │ │
│  │  To enable full ACL crawling:                                  │ │
│  │                                                                │ │
│  │  (a) Request security approval                                 │ │
│  │      [Generate scope request document]                         │ │
│  │      Exports a PDF containing:                                 │ │
│  │       - Requested scope and Graph API operations used          │ │
│  │       - Why FullControl is required (MS Graph limitation)      │ │
│  │       - Mitigations: read-only ops, audit logging,             │ │
│  │         no write/delete calls, token scoped to app only        │ │
│  │       - Data handling: what is read, where stored, TTLs        │ │
│  │       - Revocation procedure (instant via Azure AD)            │ │
│  │                                                                │ │
│  │  (b) Grant now (requires Azure AD admin)                       │ │
│  │      [Open Azure AD consent page]                              │ │
│  │                                                                │ │
│  │  (c) Opt out                                                   │ │
│  │      Continue with Disabled or Simplified mode.                │ │
│  │                                                                │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  [Accept]   [Change Mode]   [Skip]                                  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.7 Section: Sample Preview (Dry-Run)

**Collapsed (reviewed):**

```
┌── Sample Preview ─────────────────────────────── [Reviewed] ───────┐
│  20 sample documents previewed. All processable. Approved.         │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── Sample Preview ──────────────────────────────────────────────────┐
│                                                                     │
│  Here are 20 documents that WOULD be synced with your current       │
│  scope and filter settings. These are real documents from your      │
│  SharePoint -- nothing has been synced yet.                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Name                    Site          Type   Size  Modified  │  │
│  │  ────────────────────────────────────────────────────────────│  │
│  │  Q1 Revenue Report.pdf   Corp Docs     PDF   2.4MB  2h ago   │  │
│  │  API Design Guide.docx   Engineering   DOCX  340KB  1d ago   │  │
│  │  Brand Guidelines.pptx   Marketing     PPTX  8.1MB  3d ago   │  │
│  │  Employee Handbook.pdf    HR Portal     PDF   1.2MB  7d ago   │  │
│  │  Release Notes v4.2.md    Product Docs  MD     45KB  4h ago   │  │
│  │  Security Policy.docx    Legal         DOCX  890KB 14d ago   │  │
│  │  Sales Playbook.pptx     Sales Enable  PPTX  5.6MB  2d ago   │  │
│  │  Troubleshooting.pdf     Support KB    PDF   670KB  6h ago   │  │
│  │  Architecture Diag.vsdx  Engineering   VSDX  1.1MB  5d ago   │  │
│  │  Onboarding Guide.docx   HR Portal     DOCX  2.3MB 30d ago   │  │
│  │  ... (10 more)                                                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Sample breakdown:                                                  │
│   5 PDF, 4 DOCX, 3 PPTX, 2 XLSX, 2 MD, 2 TXT, 1 VSDX, 1 CSV     │
│   All 20 are processable by the current pipeline.                   │
│   1 file (Architecture Diag.vsdx) will use fallback extraction.     │
│                                                                     │
│  [Looks Good]   [Adjust Filters]   [Refresh Sample]                 │
│  [Abandon -- Do Not Sync]                                           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 4.8 Section: Security Gate (NEW in v2)

**Collapsed (approved):**

```
┌── Security Gate ──────────────────────────────── [Approved] ───────┐
│  Approved by j.chen@contoso.com on Mar 22, 2026 15:30 UTC.        │
└────────────────────────────────────────────────────────────────────┘
```

**Collapsed (pending):**

```
┌── Security Gate ──────────────────── [Pending Approval] ───────────┐
│  Submitted for approval. Waiting for security team response.       │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded (pending):**

```
┌── Security Gate ───────────────────────────────────────────────────┐
│                                                                     │
│  Your organization requires security approval before connectors     │
│  can begin syncing data. This gate ensures a security team member   │
│  reviews the configuration before any data flows.                   │
│                                                                     │
│  Status: PENDING APPROVAL                                           │
│  Submitted: Mar 22, 2026 14:45 UTC by dev-team@contoso.com         │
│  Approver(s): security-team@contoso.com                             │
│                                                                     │
│  What the approver sees:                                            │
│   - Full configuration proposal (all sections above)                │
│   - Permissions requested and granted                               │
│   - Data scope (sites, libraries, document count)                   │
│   - Data handling (storage, encryption, retention)                  │
│   - User Decisions Log (all Accept/Modify/Skip decisions)           │
│                                                                     │
│  [Send Reminder]   [Export PDF for Review]   [Cancel Submission]    │
│                                                                     │
│  ─── Approval History ────────────────────────────────────────────  │
│  (No previous submissions for this connector)                       │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded (not enabled -- org setting):**

```
┌── Security Gate ───────────────────────────────────────────────────┐
│                                                                     │
│  Security gate is not enabled for this organization.                │
│  Sync will begin immediately after you click "Approve & Start."     │
│                                                                     │
│  To enable: Organization admins can require security approval       │
│  for all new connectors in Settings > Security > Connector Policy.  │
│                                                                     │
│  [Skip]                                                             │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 5. Modify Mode -- Editing Inside the Document

When the user clicks "Modify" on any section, the section expands inline with editing controls. No dialogs or modals. The document itself becomes the editor.

### 5.1 Filter Modify (Basic)

```
┌── Filters ──────────────────────────── [Modifying] ────────────────┐
│                                                                     │
│  Currently syncing 3,801 of 4,038 documents.                       │
│                                                                     │
│  ─── File Types ──────────────────────────────────────────────────  │
│                                                                     │
│  Include: [x] PDF  [x] DOCX  [x] PPTX  [x] XLSX                  │
│           [x] TXT  [x] MD    [x] CSV   [ ] HTML                   │
│           [ ] EXE  [ ] MSI   [ ] BAT   [ ] DWG                    │
│                                                                     │
│  ─── Size Limit ──────────────────────────────────────────────────  │
│                                                                     │
│  Maximum file size: [50 MB v]                                       │
│  Files over limit: 23 (would be excluded)                           │
│                                                                     │
│  ─── Templates ───────────────────────────────────────────────────  │
│                                                                     │
│  [x] Skip Archives    (exclude /Archive, /Old, /Backup)            │
│  [x] Skip Private     (exclude /_private, /_drafts)                │
│  [ ] Skip Media        (exclude images, video, audio)               │
│  [ ] Only Recent       (modified in last 365 days)                  │
│                                                                     │
│  ─── More Options ──────────────────────── [Show Advanced v] ───── │
│                                                                     │
│  Updated count: 3,801 documents                                     │
│  [Save Changes]   [Reset to Recommendation]                         │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 Filter Modify (Intermediate -- Folder Globs, Date Ranges)

Clicking "Show Advanced" reveals additional controls below, still inline:

```
│  ─── Advanced Filters ────────────────────────────────────────────  │
│                                                                     │
│  Folder Include Patterns (glob):                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ /Shared Documents/**                                          │  │
│  │ /Projects/2026/**                                             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  [+ Add pattern]                                                    │
│                                                                     │
│  Folder Exclude Patterns (glob):                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ **/_archive/**                                                │  │
│  │ **/node_modules/**                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  [+ Add pattern]                                                    │
│                                                                     │
│  Date Range:                                                        │
│  Modified after:  [2025-01-01]   Modified before: [none]            │
│                                                                     │
│  ─── OData Query (generated) ───────────────────────── [Show v] ── │
│                                                                     │
│  The following OData filter is sent to Microsoft Graph API:         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ $filter=file/mimeType ne 'application/x-msdownload'          │  │
│  │   and size lt 52428800                                        │  │
│  │   and lastModifiedDateTime ge '2025-01-01T00:00:00Z'          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  This pre-filters at the API level. Additional local filters        │
│  (glob patterns, templates) are applied after download.             │
│                                                                     │
│  ─── Condition Builder ──────────────── [Show CEL Editor v] ────── │
```

### 5.3 Filter Modify (Advanced -- CEL Expressions with Autocomplete)

Clicking "Show CEL Editor" reveals the full expression editor with syntax highlighting and autocomplete:

```
│  ─── CEL Expression Editor ───────────────────────────────────────  │
│                                                                     │
│  Write a CEL expression to define custom filter logic.              │
│                                                                     │
│  Available variables (autocomplete with Ctrl+Space):                │
│   file.name, file.path, file.size, file.mimeType,                  │
│   file.modifiedAt, file.createdBy, site.name,                      │
│   file.contentType, file.metadata["CustomColumn"]                   │
│                                                                     │
│  Custom metadata: SharePoint column values discovered during        │
│  profiling are available via file.metadata["ColumnName"].            │
│  [View discovered columns]                                          │
│                                                                     │
│  ┌─ (syntax-highlighted editor with autocomplete) ───────────────┐ │
│  │ file.size < 50000000                                           │ │
│  │ && !file.path.startsWith("/_archive")                          │ │
│  │ && file.modifiedAt > timestamp("2025-01-01T00:00:00Z")         │ │
│  │ && !(file.mimeType in ["application/x-msdownload",             │ │
│  │       "application/x-msi"])                                     │ │
│  │ && (site.name != "External Vendors"                             │ │
│  │     || file.createdBy.endsWith("@contoso.com"))                 │ │
│  │                                                                 │ │
│  │  ┌─ Autocomplete ────────────────────────────────┐             │ │
│  │  │  file.createdAt          datetime              │             │ │
│  │  │  file.createdBy          string                │             │ │
│  │  │  file.contentType        string                │             │ │
│  │  │  file.metadata["Dept"]   string (discovered)   │             │ │
│  │  │  file.metadata["Status"] string (discovered)   │             │ │
│  │  └────────────────────────────────────────────────┘             │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  Expression valid. Matches 3,724 of 4,038 documents.                │
│                                                                     │
│  [Preview Matches]  shows 20 sample docs matching this expression   │
│                                                                     │
│  [Save Changes]   [Reset to Recommendation]                         │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**CEL autocomplete features:**

- Ctrl+Space triggers variable completion with type annotations
- Discovered SharePoint custom columns appear as `file.metadata["ColumnName"]` with "(discovered)" label
- Syntax highlighting: keywords (blue), strings (green), operators (gray), errors (red underline)
- Real-time validation: expression is validated on every keystroke with a 300ms debounce
- Error squiggles: invalid syntax shows red underline with tooltip explaining the error

### 5.4 Filter Diff on Re-Preview (NEW in v2)

After saving filter changes, before the section collapses, a diff summary appears:

```
│  ─── Changes from Previous Filter ────────────────────────────────  │
│                                                                     │
│  Previous: 3,801 documents                                          │
│  Updated:  3,724 documents                                          │
│                                                                     │
│  +12 newly included (were excluded by old date filter)              │
│   -89 newly excluded (new /_archive glob pattern)                   │
│                                                                     │
│  Net change: -77 documents                                          │
│                                                                     │
│  [View +12 Included]   [View -89 Excluded]   [Undo Changes]        │
│                                                                     │
```

### 5.5 Schedule Modify

```
┌── Schedule ────────────────────────── [Modifying] ─────────────────┐
│                                                                     │
│  ─── Initial Sync ────────────────────────────────────────────────  │
│  (*) Immediately after approval                                     │
│  ( ) Schedule for: [date picker] at [time picker]                   │
│  ( ) Do not run initial sync (delta only)                           │
│                                                                     │
│  ─── Ongoing Sync ────────────────────────────────────────────────  │
│  Frequency: [Every 4 hours v]                                       │
│    Options: Every 1h | 2h | 4h | 6h | 12h | 24h | Custom cron      │
│                                                                     │
│  Custom cron (if selected):                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 0 */4 * * *                                                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  = "At minute 0 of every 4th hour"                                  │
│                                                                     │
│  [Save Changes]   [Reset to Recommendation]                         │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 5.6 Scope Modify

When user clicks "Modify Selection" in the Scope section, checkboxes become interactive and a search/filter bar appears:

```
│  ┌─ Site Selection ────────────────────────────────────────────┐   │
│  │  [Search sites...]  [Sort: Score v]  [Show: All v]          │   │
│  │                                                              │   │
│  │  [Select All]  [Deselect All]  [Reset to Recommendation]    │   │
│  │                                                              │   │
│  │  [x] Corp Docs           Score: 92   1,234 docs   2.1GB    │   │
│  │      [Expand libraries v]                                    │   │
│  │      [x] Shared Documents     890 docs                       │   │
│  │      [x] Policy Documents     234 docs                       │   │
│  │      [x] Templates            78 docs                        │   │
│  │      [ ] Personal Uploads     32 docs                        │   │
│  │                                                              │   │
│  │  [x] Engineering Hub     Score: 87     890 docs   1.4GB     │   │
│  │  ...                                                         │   │
│  └──────────────────────────────────────────────────────────────┘   │
```

---

## 6. Export: PDF + JSON/YAML (NEW: config export)

### 6.1 PDF Export (Security Review)

The "Export as PDF" button generates a document containing everything a security reviewer needs. The proposal IS the security review -- no separate artifact.

**PDF Contents:**

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  SHAREPOINT CONNECTOR -- SECURITY REVIEW DOCUMENT                 │
│  Generated: Mar 22, 2026 14:45 UTC                               │
│  Connector ID: sp-corp-main                                      │
│  Organization: Contoso Ltd.                                      │
│                                                                   │
│  ════════════════════════════════════════════════════════════════ │
│                                                                   │
│  1. AUTHENTICATION                                                │
│     Method: Device Code Flow (delegated)                          │
│     Authenticated by: maria@contoso.com                           │
│     Authentication time: Mar 22, 2026 14:20 UTC                  │
│     Delegated by: dev-team@contoso.com (via 48h invite)           │
│     Token storage: AES-256-GCM encrypted at rest                 │
│     Refresh token expiry: Apr 21, 2026                           │
│                                                                   │
│  2. GRANTED PERMISSIONS (OAuth Scopes)                            │
│     - Sites.Read.All (Delegated) -- read all site content         │
│     - Files.Read.All (Delegated) -- read all file content         │
│     NOT granted:                                                  │
│     - Sites.FullControl.All -- not requested                     │
│     - User.Read.All -- not requested                              │
│                                                                   │
│  3. DATA SCOPE                                                    │
│     Sites: 8 of 12 accessible sites selected                     │
│     Libraries: 14 document libraries                              │
│     Documents: ~3,801 documents (~4.2 GB)                        │
│     Excluded sites: Archived Projects, Personal Sites,            │
│       Test Environment, External Vendors                          │
│     Excluded by filters: 237 documents (executables,              │
│       archives, oversized, unsupported formats)                   │
│                                                                   │
│  4. DATA HANDLING                                                 │
│     - Documents downloaded to platform storage (encrypted)        │
│     - Text extracted via Docling (PDFs) or direct parse           │
│     - Content chunked and embedded as vectors                     │
│     - Original files retained for re-processing                   │
│     - No data shared with third parties                           │
│                                                                   │
│  5. DATA RETENTION                                                │
│     - Synced documents retained until connector deleted            │
│     - Discovery cache: 7-day TTL (auto-purge)                    │
│     - Sync checkpoints: purged after successful sync              │
│     - BullMQ job data: 24-hour retention                         │
│                                                                   │
│  6. ACCESS CONTROL                                                │
│     - Permission mode: Disabled (all docs visible to all users)   │
│     - Alternative modes available: Full ACL, Simplified           │
│     - Platform RBAC: Only project members can query               │
│                                                                   │
│  7. SYNC SCHEDULE                                                 │
│     - Initial: Full sync immediately                              │
│     - Ongoing: Delta sync every 4 hours                           │
│     - Webhooks: Not enabled                                       │
│                                                                   │
│  8. DELETION & CLEANUP                                            │
│     - Connector deletion removes: ConnectorConfig, SearchSource,  │
│       all SearchDocuments, vector embeddings (automatic cleanup)   │
│     - Token revoked on deletion                                   │
│     - Orphaned vectors: Cleanup job runs within 1 hour of delete  │
│     - Full deletion confirmation: System verifies vector store     │
│       cleanup completed and reports final status                   │
│                                                                   │
│  9. REVOCATION                                                    │
│     - Token can be revoked via platform UI or Azure AD portal     │
│     - Revoking stops all future syncs immediately                 │
│     - Existing synced data remains until connector is deleted     │
│     - To fully remove: Delete connector (cascades all data)       │
│                                                                   │
│  10. USER DECISIONS LOG                                           │
│     Connection:    Accepted (no modifications)                    │
│     Health Check:  Accepted (6/6 passed)                          │
│     Scope:         Modified (excluded Personal Sites library      │
│                    "Personal Uploads" from Corp Docs)             │
│     Filters:       Accepted (recommendation as-is)                │
│     Schedule:      Accepted (recommendation as-is)                │
│     Permissions:   Skipped (disabled mode)                        │
│     Preview:       Reviewed and approved                          │
│     Security Gate: Approved by j.chen@contoso.com                 │
│                                                                   │
│  11. KNOWN LIMITATIONS                                            │
│     - Delta sync scheduler: functional but no webhook push        │
│     - Auth audit trail: not yet implemented                       │
│     - Permission change tracking: not available                   │
│                                                                   │
│  ──────────────────────────────────────────────────────────────── │
│  Approved by: _________________ Date: _________________          │
│  Security review: _____________ Date: _________________          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 JSON/YAML Export (Version Control)

The "Export JSON/YAML" button generates a machine-readable configuration file suitable for version control, CI/CD pipelines, and programmatic import:

```yaml
# SharePoint Connector Configuration
# Exported: 2026-03-22T14:45:00Z
# Connector: sp-corp-main

version: '1.0'
connector:
  type: sharepoint
  name: Corp Main
  tenant: contoso.onmicrosoft.com
  authMethod: device_code

scope:
  sites:
    include:
      - Corp Docs
      - Engineering Hub
      - Product Docs
      - HR Portal
      - Marketing
      - Legal
      - Support KB
      - Sales Enablement
    exclude:
      - Archived Projects
      - Personal Sites
      - Test Environment
      - External Vendors

filters:
  templates:
    - office-documents
    - skip-archives
    - skip-private
  maxFileSize: 52428800
  fileTypes:
    include: [pdf, docx, pptx, xlsx, txt, md, csv]
  celExpression: null

schedule:
  initial: immediate
  ongoing:
    frequency: '0 */4 * * *'
    type: delta

permissions:
  mode: disabled
```

This file can be imported via `POST /api/connectors/import` or `abl connector create --config connector.yaml` to recreate the connector in another environment.

---

## 7. Error States Within the Document

Errors appear as annotated sections within the document, not as toasts or modals. Each error section explains what happened, why, and what the user can do. The conversational tone is maintained: "I tried to... but encountered..."

### 7.1 Auth Failure

```
┌── Connection ──────────────────────── [Authentication Failed] ─────┐
│                                                                     │
│  I could not complete authentication. The device code expired       │
│  before sign-in was completed.                                      │
│                                                                     │
│  What happened:                                                     │
│    The code ABCD-1234 was valid for 15 minutes. No sign-in         │
│    was detected before it expired at 14:35 UTC.                     │
│                                                                     │
│  What you can do:                                                   │
│    [Generate New Code]  -- starts a fresh 15-minute window          │
│    [Change Auth Method] -- try Auth Code (browser popup)            │
│    [Send 48h Invite]    -- delegate to someone with more time       │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.2 Discovery Failure

```
┌── Scope ──────────────────────────── [Discovery Failed] ───────────┐
│                                                                     │
│  I could not discover your SharePoint sites.                        │
│                                                                     │
│  What happened:                                                     │
│    Microsoft Graph API returned 403 Forbidden when listing          │
│    sites. The granted scope (Sites.Selected) does not include       │
│    permission to enumerate all sites.                                │
│                                                                     │
│  With Sites.Selected, you must specify sites manually:              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Enter SharePoint site URLs (one per line):                   │  │
│  │  https://contoso.sharepoint.com/sites/CorpDocs                │  │
│  │  https://contoso.sharepoint.com/sites/Engineering             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  [Validate Sites]                                                   │
│                                                                     │
│  Or upgrade permissions:                                            │
│  [Request Sites.Read.All]  -- enables automatic discovery           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.3 Discovery Timeout

```
┌── Scope ──────────────────────── [Discovery Incomplete] ───────────┐
│                                                                     │
│  Discovery timed out after 120 seconds. I found 347 of an          │
│  estimated 1,200+ sites so far.                                     │
│                                                                     │
│  What happened:                                                     │
│    Your tenant has a large number of SharePoint sites. The          │
│    Microsoft Graph API paginates site listings and the 120s         │
│    timeout was reached before all pages were fetched.               │
│                                                                     │
│  You can:                                                           │
│    [Continue Discovery]   -- extend timeout, fetch remaining        │
│    [Use 347 Sites]        -- proceed with sites found so far        │
│    [Enter Sites Manually] -- skip discovery, provide URLs           │
│                                                                     │
│  Tip: For very large tenants, consider entering specific site       │
│  URLs rather than discovering all sites.                            │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.4 Sync Failure (Post-Approval)

```
┌── Sync Status ─────────────────────── [Sync Failed] ──────────────┐
│                                                                     │
│  Full sync failed after processing 1,204 of 3,801 documents.       │
│                                                                     │
│  What happened:                                                     │
│    OAuth token expired during sync. The refresh token               │
│    exchange returned "invalid_grant" -- the user may have           │
│    been removed or the app consent was revoked.                     │
│                                                                     │
│  Documents synced before failure: 1,204 (these are searchable)     │
│  Documents not synced: 2,597                                        │
│                                                                     │
│  What you can do:                                                   │
│    [Re-authenticate]       -- new auth, then resume sync            │
│    [Resume from Checkpoint] -- retry from doc #1,205                │
│    [Keep Partial]           -- use the 1,204 synced documents       │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.5 Token Expiry Warning

```
┌── Connection ──────────────────────── [Token Expiring] ────────────┐
│                                                                     │
│  Your refresh token expires in 3 days (Mar 25, 2026).               │
│  After expiry, syncs will fail and require re-authentication.       │
│                                                                     │
│  [Re-authenticate Now]   [Send 48h Invite to Delegate]              │
│  [Remind Me Tomorrow]                                               │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.6 Throttling (429)

```
┌── Sync Status ─────────────────────── [Throttled] ─────────────────┐
│                                                                     │
│  Microsoft Graph API is throttling requests (429 Too Many           │
│  Requests). Sync is paused and will automatically retry             │
│  in 120 seconds.                                                    │
│                                                                     │
│  Progress: 2,100 of 3,801 documents synced                         │
│  Throttle reason: Tenant-wide rate limit exceeded                  │
│  Retry at: 14:47 UTC (in 1m 52s)                                  │
│                                                                     │
│  [Pause Sync]   [Stop Sync]   [Continue Waiting]                   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.7 Permission Revocation

```
┌── Connection ──────────────────── [Permissions Revoked] ───────────┐
│                                                                     │
│  Admin consent for this application was revoked in Azure AD.        │
│  All sync operations are stopped.                                   │
│                                                                     │
│  Previously granted: Sites.Read.All, Files.Read.All                │
│  Currently granted: (none)                                          │
│                                                                     │
│  What happened:                                                     │
│    An Azure AD administrator removed consent at approximately       │
│    Mar 22, 2026 16:00 UTC. This affects all users of this app.     │
│                                                                     │
│  What you can do:                                                   │
│    [Request Re-consent]       -- sends request to admin             │
│    [Export Security Review]   -- shows what was configured          │
│    [Delete Connector]         -- removes all synced data            │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 7.8 Partial Failure

```
┌── Sync Status ──────────────────── [Partial Success] ──────────────┐
│                                                                     │
│  Sync completed with 47 document failures.                          │
│                                                                     │
│  3,754 of 3,801 documents synced successfully (98.8%).              │
│                                                                     │
│  Failures by reason:                                                │
│    23 -- File too large for extraction (>100MB after download)      │
│    12 -- Extraction timeout (Docling processing >5 min)             │
│     8 -- Permission denied on individual file                       │
│     4 -- File corrupted or encrypted                                │
│                                                                     │
│  [View Failed Documents]  [Retry All Failed]   [Dismiss]           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 8. Empty States

### 8.1 Discovery Finds No Sites

```
┌── Scope ──────────────────────────────────────────────────────────┐
│                                                                    │
│  I completed discovery but found 0 SharePoint sites.               │
│                                                                    │
│  This usually means:                                               │
│                                                                    │
│  1. The authenticated user has no SharePoint access                │
│     maria@contoso.com may not be a member of any SharePoint       │
│     sites. Ask a SharePoint admin to verify site membership.      │
│                                                                    │
│  2. Sites.Selected scope with no sites configured                  │
│     If using Sites.Selected, an admin must explicitly grant        │
│     access to specific sites in the Azure AD app registration.    │
│     [How to configure Sites.Selected]                              │
│                                                                    │
│  3. SharePoint is not provisioned for this tenant                  │
│     The Microsoft 365 tenant may not have SharePoint Online        │
│     enabled. Verify at admin.microsoft.com.                        │
│                                                                    │
│  [Re-run Discovery]  [Enter Site URLs Manually]                    │
│  [Re-authenticate as Different User]                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 8.2 Discovery Finds Sites but No Documents

```
┌── Filters ──────────────────────────── [No Documents] ─────────────┐
│                                                                     │
│  Your selected sites contain 0 documents matching current           │
│  filters. The sites have 234 total files, but all are excluded:    │
│                                                                     │
│   - 189 image files (.png, .jpg) -- not in included file types      │
│   - 34 executables (.exe) -- blocked by policy                      │
│   - 11 system files (.aspx, .master) -- SharePoint system files    │
│                                                                     │
│  Try:                                                               │
│   [Modify Filters]   -- expand included file types                  │
│   [Modify Scope]     -- select additional sites                     │
│   [Refresh Discovery] -- check for newly added content              │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 8.3 Sample Preview Returns Nothing Processable

```
┌── Sample Preview ──────────────────── [None Processable] ──────────┐
│                                                                     │
│  I fetched 20 sample documents, but none can be processed           │
│  by the current pipeline:                                           │
│                                                                     │
│   - 12 .vsdx files -- Visio diagrams (no extractor available)      │
│   - 5 .dwg files -- AutoCAD drawings (no extractor available)      │
│   - 3 .pst files -- Outlook archives (no extractor available)      │
│                                                                     │
│  The pipeline supports: PDF, DOCX, PPTX, XLSX, TXT, MD, CSV,      │
│  HTML, XML, JSON, and 17 other formats.                             │
│                                                                     │
│  [Modify Scope]   -- select sites with supported content            │
│  [Modify Filters] -- your sites may have supported files            │
│                      hidden by current filter settings               │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 9. Monitoring (Post-Setup) -- Single Connector Live Document

After approval and sync start, the document transforms into a live monitoring view. It is the same document, now with live data. Every section remains editable.

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  SharePoint: Corp Main                          [Edit] [Export v]   │
│  Approved Mar 22, 2026 . Last sync: 5 min ago . Next: in 3h 55m    │
│                                                                      │
│  ─── Status ──────────────────────────────────────────────────────  │
│                                                                      │
│  Active    3,754 indexed   47 failed   0 pending                    │
│  [========================================----] 98.8%               │
│                                                                      │
│  ─── Sections ────────────────────────────────────────────────────  │
│                                                                      │
│  Connection      Healthy (token refreshed 2h ago)                   │
│  Health Check    6/6 (last run: 4h ago)  [Re-check]                 │
│  Scope           8 sites, 14 libraries   [Modify]                   │
│  Filters         3,801 matching   [Modify]                          │
│  Schedule        Delta every 4h   [Modify]                          │
│  Permissions     Disabled   [Enable]                                │
│                                                                      │
│  ─── Recent Sync Runs ───────────────────────────────────────────  │
│                                                                      │
│  Mar 22, 14:45   Full    3,754 docs   23 min   Complete             │
│  Mar 22, 18:45   Delta   12 changes   45 sec   Complete             │
│  Mar 22, 22:45   Delta   3 changes    12 sec   Complete             │
│  Mar 23, 02:45   Delta   0 changes    8 sec    No changes           │
│                                                                      │
│  ─── Failed Documents ─────────────────────────── [View All] ─────  │
│                                                                      │
│  Q4-Projections.xlsx   Extraction timeout     Mar 22, 14:52         │
│  Legacy-Report.doc     Unsupported format     Mar 22, 14:48         │
│  ... 45 more                                                         │
│                                                                      │
│  [Retry All Failed]   [Export as PDF]   [Export JSON/YAML]          │
│  [Pause Sync]   [Delete Connector]                                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

When the user clicks "Modify" on any section, it expands inline with the same editing experience as during initial setup. Changes are applied immediately (for filters, schedule) or trigger a re-sync (for scope changes).

---

## 10. Operations Dashboard (Multi-Connector) -- Raj's Experience

### 10.1 Dashboard: Card View (< 7 connectors)

When there are fewer than 7 connectors, the dashboard uses card view (similar to v1):

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Enterprise Connectors                      [+ New Connector]       │
│                                                                      │
│  ┌─ Summary ──────────────────────────────────────────────────┐     │
│  │  4 connectors  |  12,340 documents  |  2 need attention     │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  [All (4)] [Healthy (2)] [Attention (2)] [Type: Any v]              │
│                                                                      │
│  ┌─ Corp Main (SharePoint) ─── Active ─── 3,754 docs ─────────┐   │
│  │  8 sites . Delta every 4h . Last sync: 5 min ago             │   │
│  │  [Open Document]                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Engineering (SharePoint) ─── Token Expiring ─── 2,100 ────┐   │
│  │  3 sites . Delta every 2h . Token expires in 3 days          │   │
│  │  [Open Document]   [Re-authenticate]                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Jira Cloud ─── Active ─── 5,678 docs ──────────────────────┐   │
│  │  12 projects . Delta every 1h . Last sync: 45 min ago         │   │
│  │  [Open Document]                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Confluence ─── Auth Failed ─── 808 docs (stale) ───────────┐   │
│  │  4 spaces . Last successful sync: 3 days ago                  │   │
│  │  [Open Document]   [Re-authenticate]                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.2 Dashboard: Table View (7+ connectors -- auto-switch)

At 7+ connectors, the dashboard auto-switches to a dense table view. Users can manually toggle between card and table at any count.

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Enterprise Connectors (15)           [Card|Table]  [+ New]         │
│                                                                      │
│  ┌─ Summary ──────────────────────────────────────────────────┐     │
│  │ 15 connectors | 47,230 docs | 3 need attention | 2 tenants │     │
│  └─────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  Filters: [Status: Any v] [Type: Any v] [Tenant: Any v]            │
│  Search:  [Search connectors...]                                     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ [ ] Name            Type       Status   Docs    Last Sync     │ │
│  │ ─────────────────────────────────────────────────────────────  │ │
│  │                                                                │ │
│  │ -- Contoso (contoso.onmicrosoft.com) ──────────────────────── │ │
│  │ [ ] Corp Main       SharePoint Active   3,754   5 min ago     │ │
│  │ [ ] Engineering     SharePoint Warning  2,100   2h ago        │ │
│  │ [ ] HR Portal       SharePoint Active   1,230   15 min ago    │ │
│  │ [ ] Legal           SharePoint Active     890   1h ago        │ │
│  │ [ ] Marketing       SharePoint Active     567   30 min ago    │ │
│  │ [ ] Sales           SharePoint Active     456   45 min ago    │ │
│  │ [ ] Support         SharePoint Active     345   20 min ago    │ │
│  │ [ ] Jira Cloud      Jira       Active   5,678   45 min ago    │ │
│  │ [ ] Confluence      Confluence Error      808   3 days ago    │ │
│  │                                                                │ │
│  │ -- Fabrikam (fabrikam.onmicrosoft.com) ───────────────────── │ │
│  │ [ ] Fab Docs        SharePoint Active   8,900   10 min ago    │ │
│  │ [ ] Fab Engineering SharePoint Active   6,543   25 min ago    │ │
│  │ [ ] Fab Legal       SharePoint Active   3,210   1h ago        │ │
│  │ [ ] Fab Jira        Jira       Active   4,567   30 min ago    │ │
│  │ [ ] Fab Confluence  Confluence Active   3,890   20 min ago    │ │
│  │ [ ] Google Drive    G-Drive    Active   4,292   15 min ago    │ │
│  │                                                                │ │
│  │ Sparkline legend: [===] last 7 days sync success rate         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ─── Bulk Actions (0 selected) ──────────────────────────────────── │
│  Select connectors to enable: [Sync Now] [Pause] [Re-Auth]         │
│  [Apply Schedule] [Apply Filter Template] [Export Configs]          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Table features for Raj's workflow:**

- **Tenant grouping:** Connectors grouped by Microsoft 365 tenant when multiple tenants exist
- **Sortable columns:** Click any column header to sort (Name, Status, Docs, Last Sync)
- **Inline status:** Color + icon + text for each row (Active=green circle, Warning=yellow triangle, Error=red X)
- **Row click:** Opens the live document for that connector
- **Sparklines:** Tiny 7-day sync history chart per row showing success rate
- **Keyboard navigation:** Arrow keys to move between rows, Enter to open, Space to select

### 10.3 Bulk Operations

Select multiple connectors via checkboxes for bulk actions:

```
│  ─── Bulk Actions (3 selected) ──────────────────────────────────── │
│                                                                      │
│  Selected: Corp Main, Engineering, HR Portal                         │
│                                                                      │
│  [Sync Now]           -- trigger delta sync on all 3                │
│  [Pause All]          -- pause sync on all 3                        │
│  [Re-Authenticate]    -- send 48h invite for token refresh          │
│  [Apply Schedule]     -- set "Every 4h" on all 3                    │
│  [Apply Filter Tmpl]  -- apply "Office Documents" template          │
│  [Export Configs]     -- download JSON/YAML for all 3               │
│  [Export PDFs]        -- download security review PDFs              │
│                                                                      │
│  [Select All]  [Deselect All]  [Select by Status: Warning v]       │
```

### 10.4 New From Template

"New Connector" offers creating from a template (an approved document used as a starting point):

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  New Connector                                                       │
│                                                                      │
│  ─── Start Fresh ─────────────────────────────────────────────────  │
│  [SharePoint]  [Jira]  [Confluence]  [Google Drive]  [+More]        │
│                                                                      │
│  ─── From Template ───────────────────────────────────────────────  │
│  Re-use settings from an existing approved document.                 │
│                                                                      │
│  ┌─ Corp Main (SharePoint) ──────────────────────────────────┐     │
│  │  Created: Mar 22 . 8 sites, Office Documents filter        │     │
│  │  [Use as Template]                                          │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ─── Import Configuration ─────────────────────────────────────── │
│  Import a JSON/YAML configuration file:                              │
│  [Upload File]   [Paste JSON/YAML]                                  │
│                                                                      │
│  ─── Clone ───────────────────────────────────────────────────────  │
│  Copy an entire approved document (same tenant, new name).           │
│                                                                      │
│  ┌─ Corp Main (SharePoint) ──────────────────────────────────┐     │
│  │  [Clone] -- copies scope, filters, schedule, permissions   │     │
│  │  You will need to authenticate separately.                  │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

When using a template, the system generates a pre-filled document. All sections start as "Recommended (from template)" instead of "Recommended (auto-detected)." The user reviews and accepts/modifies as usual.

---

## 11. Backend Requirements

### 11.1 New API Endpoints

| Endpoint                                           | Method | Purpose                                                              |
| -------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `POST /connectors/:id/generate-proposal`           | POST   | Triggers discovery + profiling + recommendation as one unit          |
| `GET /connectors/:id/proposal`                     | GET    | Returns current proposal state (all sections, status, decisions)     |
| `PATCH /connectors/:id/proposal/sections/:section` | PATCH  | Accept/modify/skip a section                                         |
| `POST /connectors/:id/proposal/approve`            | POST   | Approve entire proposal, triggers sync (or submits to security gate) |
| `GET /connectors/:id/proposal/export`              | GET    | Returns proposal as structured JSON for PDF generation               |
| `GET /connectors/:id/proposal/export?format=yaml`  | GET    | Returns proposal as YAML for version control                         |
| `GET /connectors/:id/proposal/export?format=json`  | GET    | Returns proposal as JSON for version control                         |
| `POST /connectors/:id/proposal/health-check`       | POST   | Runs 6-axis health check                                             |
| `POST /connectors/:id/proposal/sample-preview`     | POST   | Fetches 20 real documents matching current scope+filters             |
| `POST /connectors/:id/auth/delegate`               | POST   | Generates a 48h delegation invite URL                                |
| `GET /connectors/:id/auth/invite/:token`           | GET    | Returns delegation details for the authenticating delegate           |
| `POST /connectors/:id/auth/invite/:token/complete` | POST   | Delegate completes auth via this endpoint                            |
| `POST /connectors/:id/clone`                       | POST   | Clones an approved proposal to a new connector                       |
| `POST /connectors/import`                          | POST   | Creates connector from JSON/YAML config                              |
| `GET /connectors/templates`                        | GET    | Lists approved proposals usable as templates                         |
| `GET /connectors/:id/sync-history`                 | GET    | Paginated sync run history                                           |
| `GET /connectors/:id/failed-documents`             | GET    | Documents with processingError, paginated                            |
| `POST /connectors/:id/security-gate/submit`        | POST   | Submit proposal for security approval                                |
| `POST /connectors/:id/security-gate/approve`       | POST   | Security team approves (triggers sync)                               |
| `POST /connectors/:id/security-gate/reject`        | POST   | Security team rejects (with reason)                                  |
| `GET /connectors/sso-tenants`                      | GET    | Lists pre-configured tenants for SSO quick-connect                   |
| `POST /connectors/:id/filters/diff`                | POST   | Returns diff between current and proposed filters                    |

### 11.2 New/Modified Models

| Model                  | Type   | Key Fields                                                                                                                                                      |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConnectorProposal`    | NEW    | `connectorId`, `sections[]` (status, recommendation, userDecision, modifiedAt), `overallStatus`, `exportedAt`, `approvedAt`, `approvedBy`, `securityGateStatus` |
| `AuthDelegation`       | NEW    | `connectorId`, `inviteToken`, `createdBy`, `expiresAt` (48h), `completedBy`, `completedAt`, `status: pending/completed/expired`, `emailSentTo`                  |
| `SyncRun`              | NEW    | `connectorId`, `type: full/delta`, `startedAt`, `completedAt`, `durationMs`, `docsProcessed/Added/Modified/Deleted/Failed`, `status`, `errorMessage`            |
| `SecurityGateApproval` | NEW    | `connectorId`, `submittedBy`, `submittedAt`, `approvedBy`, `approvedAt`, `status: pending/approved/rejected`, `rejectionReason`                                 |
| `ConnectorConfig`      | MODIFY | Add `proposalId`, `templateSourceId`, `ssoTenantId`                                                                                                             |

### 11.3 Existing Endpoints to Wire Up

These endpoints already exist but are not exposed in the UI. The document design surfaces them:

| Existing Endpoint                                      | Used In Section                    |
| ------------------------------------------------------ | ---------------------------------- |
| `POST /connectors/:id/filters/preview`                 | Sample Preview, Filter Modify      |
| `GET /connectors/:id/delta-tokens`                     | Monitoring (per-drive sync status) |
| `POST /connectors/:id/permissions/crawl`               | Permissions section                |
| `GET /connectors/:id/sync/status`                      | Monitoring                         |
| `POST /connectors/:id/sync/start\|stop\|pause\|resume` | Monitoring                         |

### 11.4 Frontend Components

| Component                     | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `ConnectorProposalDocument`   | Main document container, renders sections                    |
| `ProposalSection`             | Generic section wrapper (collapsed/expanded/modifying/error) |
| `ProposalTableOfContents`     | Sticky TOC sidebar with section status                       |
| `ProposalConnectionSection`   | Connection details + re-auth                                 |
| `ProposalHealthCheckSection`  | 6-axis validation display                                    |
| `ProposalScopeSection`        | Site/library selection with recommendation                   |
| `ProposalFilterSection`       | Filter summary + inline editor (basic/intermediate/advanced) |
| `ProposalScheduleSection`     | Schedule recommendation + editor                             |
| `ProposalPermissionSection`   | Permission mode negotiation                                  |
| `ProposalPreviewSection`      | Dry-run document table                                       |
| `ProposalSecurityGateSection` | Security approval workflow                                   |
| `ProposalExportButton`        | PDF/JSON/YAML generation                                     |
| `ConnectorDashboard`          | Multi-connector dashboard (card + table views)               |
| `ConnectorDashboardTable`     | Dense table view with tenant grouping, sparklines            |
| `BulkActionsToolbar`          | Multi-select actions for dashboard                           |
| `CELExpressionEditor`         | Code editor with syntax highlight + autocomplete             |
| `AuthDelegationCard`          | 48h invite URL + pre-written email                           |
| `FilterDiffView`              | "+12 included, -3 excluded" change summary                   |
| `SSOConnectButton`            | Quick-connect for pre-configured tenants                     |

---

## 12. Issue Checklist

### Enterprise UX Issues (from UX-ENTERPRISE-REVIEW.md)

| #    | Issue                              | How Design B v2 Addresses It                                                                                                               |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1  | WCAG contrast failures             | Document sections use high-contrast text on white/dark backgrounds. All text meets 4.5:1 AA. Status indicators use color + shape + text.   |
| C-2  | No destructive action confirmation | "Delete Connector" requires typed confirmation. "Abandon" in preview requires explicit click. Approve requires reviewing all sections.     |
| H-1  | Emoji icons throughout             | Document uses text labels and Lucide icons only. Status uses semantic symbols not emoji.                                                   |
| H-2  | No monospace for technical values  | Client IDs, tenant IDs, site URLs, CEL expressions, OData queries, glob patterns all in monospace.                                         |
| H-3  | 13px base font too small           | Document body at 14px. Section headers at 16px. Labels at 12px minimum.                                                                    |
| H-4  | Missing keyboard focus rings       | All interactive elements have visible focus rings. Sections navigable via Tab. Dashboard table navigable via arrow keys.                   |
| H-5  | Color alone for status             | Status uses icon + text label: checkmark + "Accepted", X + "Failed", triangle + "Warning".                                                 |
| H-6  | No loading/skeleton states         | Document generation shows progressive loading -- sections appear as they resolve.                                                          |
| H-7  | No enterprise chrome               | Document sits within standard platform chrome. TOC provides document-level navigation.                                                     |
| H-8  | No multi-user awareness            | Connection shows who authenticated/delegated. Proposal shows who approved. Security gate shows who submitted/approved.                     |
| H-9  | No audit trail                     | The proposal IS the audit trail. Every section records who accepted/modified/skipped and when. Security gate adds formal approval chain.   |
| H-10 | No form validation states          | Inline editors show real-time validation. CEL editor has syntax highlighting and error squiggles.                                          |
| H-11 | Tables missing sort indicators     | Sample preview, site list, sync history, and dashboard table all have sortable columns with direction arrows.                              |
| H-12 | Status vocabulary inconsistent     | Consistent vocabulary: Accepted/Modified/Skipped for decisions; Active/Warning/Error/Paused for state; Indexed/Failed/Processing for docs. |
| H-13 | Settings panel no ARIA/focus trap  | Each expanded section is `role="region"` with `aria-label`. Modify mode traps focus.                                                       |
| M-1  | Line height too loose              | Data tables use 1.35 line height. Prose sections use 1.5.                                                                                  |
| M-2  | Only 3 font weights                | Section headers: 600. Body: 400. Labels: 500. Display numbers: 300.                                                                        |
| M-3  | No negative letter-spacing         | Section headers use -0.01em. Document title uses -0.02em.                                                                                  |
| M-4  | KPI cards too sparse               | Document uses inline metrics. Dashboard summary row shows aggregate KPIs.                                                                  |
| M-5  | Numbers not right-aligned          | Document counts, file sizes, scores right-aligned in all tables.                                                                           |
| M-6  | Date format inconsistent           | Relative within 24h, absolute beyond, full timestamp on hover.                                                                             |
| M-7  | Breadcrumbs minimal                | Full breadcrumb: KB List > Product Docs > Data > SharePoint: Corp Main.                                                                    |
| M-8  | No ghost/tertiary button           | Skip=ghost, Reset=tertiary, Accept=primary, Modify=secondary.                                                                              |
| M-9  | No clear all filters               | "Reset to Recommendation" clears all custom filters.                                                                                       |
| M-10 | Checkbox lacks indeterminate       | Site checkbox shows indeterminate when some libraries selected.                                                                            |
| M-11 | No toast notifications             | Inline status updates, not toasts.                                                                                                         |
| M-12 | Rebuild Index in Danger Zone       | "Delete Connector" in clearly separated danger section at bottom.                                                                          |
| M-13 | No error boundary patterns         | Every section has its own error state. Section errors don't block other sections.                                                          |
| M-14 | Hover/active states inconsistent   | Consistent hover (lighten 10%), active (scale 0.98 + darken), disabled states.                                                             |

### Deep-Dive Gap Items (from SHAREPOINT-CONNECTOR-DEEP-DIVE.md Section 11)

| #   | Gap                                     | How Design B v2 Addresses It                                                                                               |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | File type distribution chart            | Filters section shows file type breakdown inline. Monitoring shows distribution.                                           |
| 2   | Per-connector document status breakdown | Monitoring view shows indexed/failed/pending counts. Dashboard table shows per-row.                                        |
| 3   | Per-site/drive document counts          | Scope section shows per-site doc counts. Modify mode shows per-library.                                                    |
| 4   | Token health dashboard                  | Connection section shows token expiry, refresh status. Health Check validates.                                             |
| 5   | OAuth scope display                     | Health Check shows all granted/missing scopes. Permissions shows scope requirements.                                       |
| 6   | Per-document error messages             | Failed Documents section in monitoring shows error per document.                                                           |
| 7   | Failed doc list per connector           | Monitoring has "Failed Documents" with view all + retry.                                                                   |
| 8   | Delta token/per-drive status            | Monitoring shows per-drive delta token status.                                                                             |
| 9   | ACL viewer                              | Permissions section shows mode and scope. Full ACL viewer deferred.                                                        |
| 10  | External sharing report                 | Scope section flags high-sensitivity sites. Permissions mentions external sharing.                                         |
| 11  | Filter preview button                   | Sample Preview IS the filter preview. Uses existing endpoint.                                                              |
| 12  | Permission recrawl trigger              | Monitoring permissions section includes "Re-crawl Permissions."                                                            |
| 13  | Sync history/timeline                   | Monitoring "Recent Sync Runs" table. Dashboard sparklines for 7-day history.                                               |
| 14  | Sync duration tracking                  | Sync history table shows duration column.                                                                                  |
| 15  | Delta changes changelog                 | Sync history shows adds/modifies/deletes per run.                                                                          |
| 16  | Content size aggregation                | Scope section shows per-site estimated size. Monitoring shows total.                                                       |
| 17  | Source-side total count                 | Scope section shows discovered vs filtered count (coverage).                                                               |
| 18  | Embedding freshness metric              | Deferred (needs `embeddedAt` on chunks).                                                                                   |
| 19  | Content type report                     | Filters section shows supported vs unsupported format breakdown.                                                           |
| 20  | Delegated auth flow                     | 48h delegation invite URL with pre-written email template.                                                                 |
| 21  | Auth audit trail                        | Proposal logs all auth events. Security gate adds formal approval chain. Backend `onAuthEvent` still needs implementation. |

---

## 13. Self-Review

### A. 21 Known Issues Scorecard

| #   | Issue                                | Status     | Notes                                                                        |
| --- | ------------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| 1   | 15-min device code expiry            | SOLVED     | 48h delegation invite URL survives code rotation                             |
| 2   | No "Just connect my account" button  | SOLVED     | SSO quick-connect for pre-configured orgs                                    |
| 3   | No CEL autocomplete                  | SOLVED     | Syntax highlighting + field autocomplete + error squiggles                   |
| 4   | No filter diff on re-preview         | SOLVED     | "+12 included, -3 excluded" diff view with sample lists                      |
| 5   | No "Pending Security Approval" gate  | SOLVED     | Section 4.8: full approval workflow with submit/approve/reject               |
| 6   | No API/CLI-first setup               | SOLVED     | Section 3.1: cURL + CLI examples, JSON/YAML import                           |
| 7   | Configure-before-auth mode           | SOLVED     | Section 3.2: "Start Configuring" opens draft while auth pending              |
| 8   | Vector embedding cleanup             | SOLVED     | Section 6.1: PDF documents automatic cleanup. Backend model handles cascade. |
| 9   | Pre-written delegation email         | SOLVED     | Section 3.2: full email template with subject line, permissions summary      |
| 10  | OData query transparency             | SOLVED     | Section 5.2: raw OData query visible in advanced filter view                 |
| 11  | Dashboard matrix for multi-connector | SOLVED     | Section 10.2: table view with tenant grouping, sparklines, sorting           |
| 12  | Bulk operations                      | SOLVED     | Section 10.3: sync, pause, re-auth, apply schedule/template, export          |
| 13  | Table view auto-switch at 7+         | SOLVED     | Section 10.2: auto-switches, manual toggle available at any count            |
| 14  | JSON/YAML config export              | SOLVED     | Section 6.2: YAML export for version control, round-trip import              |
| 15  | Document metaphor collapses at scale | SOLVED     | Dashboard IS the scale view; document IS the detail view. They coexist.      |
| 16  | 6-8 hours for 15 connectors          | SOLVED     | Bulk ops + templates + clone + import reduce to ~2-3 hours                   |
| 17  | No table view at scale               | SOLVED     | Dense table with tenant grouping at 7+ connectors                            |
| 18  | Handoff tooling weak                 | SOLVED     | Pre-written email, 48h invite URL, security gate workflow                    |
| 19  | Embedding freshness                  | PARTIAL    | Deferred -- needs `embeddedAt` field on chunks (backend work)                |
| 20  | Auth audit trail                     | PARTIAL    | Proposal logs decisions; backend `onAuthEvent` stub needs implementation     |
| 21  | Permission change tracking           | NOT SOLVED | Neo4j overwrites permissions with no history. Infrastructure-level gap.      |

**Score: 18 SOLVED, 2 PARTIAL, 1 NOT SOLVED**

### B. 9 Shared Objectives (1-5)

| #   | Objective                             | Score | Rationale                                                                                        |
| --- | ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| 1   | Minimize time-to-first-document       | 5     | SSO quick-connect, configure-before-auth, templates, clone, API import                           |
| 2   | Surface hidden capabilities           | 5     | OData visible, filter preview wired, CEL autocomplete, delta tokens shown                        |
| 3   | Support delegation across roles       | 5     | 48h invite URL, pre-written email, security gate, approval workflow                              |
| 4   | Make security review frictionless     | 5     | Proposal IS the security doc. PDF + JSON/YAML export. Security gate. Vector cleanup documented.  |
| 5   | Scale to 15+ connectors               | 5     | Dashboard table view, tenant grouping, bulk operations, sparklines                               |
| 6   | Progressive disclosure (basic to CEL) | 5     | Basic templates -> folder globs -> OData -> CEL with autocomplete                                |
| 7   | Real sample data before committing    | 5     | Sample preview with filter diff showing "+12/-3" changes                                         |
| 8   | Clear error recovery                  | 5     | 8 distinct error states with conversational "what happened / what you can do"                    |
| 9   | Audit trail for compliance            | 4     | Proposal logs all decisions, security gate adds formal chain. -1 for missing auth audit backend. |

**Average: 4.9/5**

### C. Persona Walk-Through

**Sarah (Content Strategist):** "I discovered... I recommend..." tone preserved in every section. Accept/Modify/Skip unchanged. The document still reads like a colleague's homework. The new Security Gate and Dashboard don't intrude on her flow -- they're separate sections/views she can ignore. SSO quick-connect removes credential friction entirely for her org. **Verdict: Happy. Core experience preserved, friction reduced.**

**Raj (Ops Lead):** Dashboard table view with tenant grouping shows all 15 connectors in one screen. Sparklines give 7-day health at a glance. Bulk operations let him re-auth 5 connectors, apply a schedule to 8, or export all configs in one action. Tenant grouping separates Contoso from Fabrikam. Time estimate drops from 6-8 hours to ~2-3 hours for 15 connectors (bulk ops + templates). **Verdict: Happy. Dashboard is now adequate. "Not the prettiest, but I can see everything and act on it."**

**Maria (Security Lead):** Security Gate section adds formal approval workflow before any data flows. PDF export still includes full decision log. Vector cleanup now documented explicitly. JSON/YAML export enables her team to diff configs in version control. The proposal still IS the security artifact. **Verdict: Happy. "Now I can require approval before sync starts. This is the missing piece."**

**Chen (IT Admin):** Pre-written email template with subject line, permissions summary, and 48h invite URL. The email is ready to send -- Chen just fills in the recipient. The invite survives device code expiry, so the delegate has 48 hours, not 15 minutes. Security gate gives a formal handoff point. **Verdict: Happy. "The email template saves me 10 minutes per connector and the 48h link means I don't have to coordinate schedules."**

**Alex (Developer):** OData query visible in advanced filter view. JSON/YAML export for version control. API endpoints + CLI commands for programmatic setup. CEL editor with autocomplete and syntax highlighting. Inline filter editing with match counts still the fastest iteration. Round-trip: export YAML, modify in VS Code, import via API. **Verdict: Happy. "Now I can treat connectors as code. The OData transparency was the last thing I needed."**

### D. Universal Pain Points Check

| #   | Pain Point                          | Addressed? | How                                                          |
| --- | ----------------------------------- | ---------- | ------------------------------------------------------------ |
| 1   | 15-min device code expiry           | SOLVED     | 48h delegation invite URL (Section 3.2)                      |
| 2   | No "Just connect my account"        | SOLVED     | SSO quick-connect button (Section 3.1)                       |
| 3   | No CEL autocomplete                 | SOLVED     | Syntax highlight + autocomplete + squiggles (Section 5.3)    |
| 4   | No filter diff on re-preview        | SOLVED     | "+12 included, -3 excluded" diff (Section 5.4)               |
| 5   | No "Pending Security Approval" gate | SOLVED     | Security Gate section with workflow (Section 4.8)            |
| 6   | No API/CLI-first setup              | SOLVED     | API docs + cURL + CLI examples (Section 3.1)                 |
| 7   | Configure-before-auth mode          | SOLVED     | Draft mode while auth pending (Section 3.2)                  |
| 8   | Vector embedding cleanup            | SOLVED     | Automatic cleanup on delete, documented in PDF (Section 6.1) |

**All 8 universal pain points addressed.**

---

## Summary

Design B v2 splits the experience into two complementary views:

- **The Document** (setup + detail): A conversational proposal where each section is independently reviewable. Generates the connector configuration. Becomes the live monitoring view after approval. Can be exported as PDF (security review), JSON, or YAML (version control). Includes a Security Gate for formal approval workflows.

- **The Dashboard** (operations): A fleet view that auto-switches from cards (< 7 connectors) to a dense table (7+) with tenant grouping, sparklines, bulk operations, and multi-select actions. Clicking any connector opens its live document.

The metaphor scales because the document handles depth (one connector, all details) while the dashboard handles breadth (all connectors, key metrics). Templates, cloning, JSON import, and bulk operations bring Raj's 15-connector setup time from 6-8 hours to 2-3 hours. The 48h delegation invite and pre-written email template close Chen's handoff gap. Sarah's conversational tone and Maria's security-as-artifact are preserved unchanged.

---

## Review Status: CLEAN

### v2 Review Summary

- Known issues: 18/21 SOLVED, 2 PARTIAL, 1 NOT SOLVED (permission change tracking -- infrastructure gap)
- Shared objectives: 9/9 met (avg 4.9/5)
- Universal pain points: 8/8 addressed
- Persona blockers: 0 critical
- Remaining gaps:
  - MEDIUM: Embedding freshness metric (needs backend `embeddedAt` field)
  - MEDIUM: Auth audit trail backend implementation (proposal logs decisions, but `onAuthEvent` is a stub)
  - LOW: Permission change tracking (Neo4j infrastructure limitation)
  - LOW: No dark mode considerations
  - LOW: No mobile/responsive layout considerations
