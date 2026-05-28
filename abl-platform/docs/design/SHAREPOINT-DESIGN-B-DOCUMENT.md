# Design B: Reviewable Document

**Date:** 2026-03-22
**Pattern:** Generated document with inline annotations (PR-review metaphor)
**Status:** Design proposal

---

## 1. Philosophy

The system generates a complete configuration proposal as a readable, annotated document where each section can be independently accepted, modified, or skipped -- turning setup into a review process rather than a wizard, so every decision is visible, auditable, and exportable as a security review artifact. This single artifact achieves all 9 objectives because the document IS the transparency layer (shows what was detected and why), IS the progressive disclosure mechanism (accepted sections collapse, modified sections expand into inline editors from basic to CEL), IS the security review (export as PDF with permissions, scope, and data handling), and IS the dry-run (sample preview section shows real documents before committing).

---

## 2. Flow Diagram

```
                     ┌─────────────────┐
                     │   Connect Card   │
                     │                  │
                     │  Enter App Reg   │
                     │  credentials     │
                     │  [Authenticate]  │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  Auth + Consent   │
                     │                  │
                     │  Device code OR  │
                     │  Auth code OR    │
                     │  Client creds    │
                     │                  │
                     │  (Delegation:    │
                     │  share auth req) │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │   Generating...   │
                     │                  │
                     │  Discovery runs  │
                     │  Profiling runs  │
                     │  Recommendations │
                     │  generated       │
                     │                  │
                     │  Sections appear │
                     │  as they resolve │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────────────────────────────┐
                     │                                          │
                     │  SharePoint Configuration Proposal       │
                     │  Generated Mar 22, 2026                  │
                     │                                          │
                     │  § Connection      [✅ Accepted]         │
                     │  § Health Check    [✅ 6/6 passed]       │
                     │  § Scope           [✏️ Modified]          │
                     │  § Filters         [✅ Accepted]         │
                     │  § Schedule        [✅ Accepted]         │
                     │  § Permissions     [⏭️ Skipped]          │
                     │  § Sample Preview  [✅ Reviewed]         │
                     │                                          │
                     │  [Export as PDF]  [Approve All & Sync]   │
                     │                                          │
                     └────────┬──────────────┬──────────────────┘
                              │              │
                     ┌────────▼────┐  ┌──────▼──────────────┐
                     │  Export PDF  │  │  Approve & Sync     │
                     │  (security   │  │                     │
                     │   review)    │  │  Sync starts        │
                     └─────────────┘  │  Document becomes    │
                                      │  live monitoring     │
                                      │  dashboard           │
                                      └─────────────────────┘
```

---

## 3. Connect Screen (Pre-Document)

This is the only screen before the document is generated. It collects credentials and authenticates.

### 3.1 App Registration Guidance

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Connect to SharePoint                                               │
│                                                                      │
│  ─── Step 1: Azure App Registration ───────────────────────────────  │
│                                                                      │
│  You need an Azure AD App Registration to connect. If you already    │
│  have one, enter its details below. If not:                          │
│                                                                      │
│  ┌─ How to create an App Registration ──────────────────── [▾] ──┐  │
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
│  (•) Device Code     -- Best for delegation. Share a code.           │
│  ( ) Auth Code       -- Browser popup. You authenticate now.         │
│  ( ) Client Creds    -- App-only. Requires client secret.            │
│                                                                      │
│                                                   [Continue]         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Auth + Consent as Separate Steps

After clicking Continue, auth and admin consent are presented as two distinct actions:

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
│  Waiting for sign-in...  ◌ (expires in 14:32)                        │
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
│  │ Share this link with the person who should authenticate:      │   │
│  │                                                               │   │
│  │ https://your-app.com/auth/delegate/abc123...                  │   │
│  │ [Copy Link]   [Send via Email]                                │   │
│  │                                                               │   │
│  │ They will see the device code and sign-in instructions.       │   │
│  │ You will be notified when authentication completes.           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 Auth Completed -> Document Generation

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ✓ Authenticated as maria@contoso.com                                │
│  ✓ Admin consent granted                                             │
│                                                                      │
│  Generating your configuration proposal...                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  § Connection        ✓ Ready                                  │   │
│  │  § Health Check      ● Running checks...                      │   │
│  │  § Scope             ◌ Discovering sites...                    │   │
│  │  § Filters           ◌ Waiting for scope                      │   │
│  │  § Schedule          ◌ Analyzing patterns...                   │   │
│  │  § Permissions       ◌ Detecting granted scopes...             │   │
│  │  § Sample Preview    ◌ Waiting for filters                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Sections will appear as they are ready. This typically              │
│  takes 30-90 seconds depending on the number of sites.              │
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
│  │  § Connection      ✅ Accepted                              │    │
│  │  § Health Check    ✅ 6/6 passed                            │    │
│  │  § Scope           ✏️ Modified                               │    │
│  │  § Filters         ✅ Accepted                              │    │
│  │  § Schedule        ✅ Accepted                              │    │
│  │  § Permissions     ⏭️ Skipped                               │    │
│  │  § Sample Preview  ✅ Reviewed                              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Progress: 6 of 7 sections reviewed   [Accept All Remaining]        │
│                                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  (sections below)                                                    │
│                                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  [Export as PDF]              [Approve All & Start Sync]             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Approval confirmation:** Clicking "Approve All & Start Sync" shows an inline confirmation banner at the bottom of the document: "This will sync ~3,801 documents (~4.2 GB) from 8 SharePoint sites. Sync will begin immediately. [Confirm & Start Sync] [Cancel]". If any sections are still in "Pending" state, the button is disabled with tooltip "Review all sections before approving."

### 4.1 Section: Connection

**Collapsed (accepted):**

```
┌── § Connection ────────────────────────────────── ✅ Accepted ───┐
│  Connected as maria@contoso.com via Device Code. Token healthy.  │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded (default on first view):**

```
┌── § Connection ──────────────────────────────────────────────────┐
│                                                                   │
│  Connection to Microsoft 365 tenant contoso.onmicrosoft.com       │
│  is active and healthy.                                           │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Tenant         contoso.onmicrosoft.com                     │  │
│  │  Client ID      a1b2c3d4-e5f6-7890-abcd-ef1234567890       │  │
│  │  Auth Method    Device Code Flow                            │  │
│  │  Authenticated  maria@contoso.com                           │  │
│  │  Auth Time      Mar 22, 2026 14:20 UTC                      │  │
│  │  Token Expires  Mar 22, 2026 15:20 UTC (59 min remaining)   │  │
│  │  Refresh Token  ● Valid (expires Apr 21, 2026)              │  │
│  │  Delegated By   dev-team@contoso.com (shared auth link)     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  [✅ Accept]   [✏️ Re-authenticate]   [⏭️ Skip]                   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Section: Health Check

**Collapsed (accepted):**

```
┌── § Health Check ──────────────────────────────── ✅ 6/6 passed ─┐
│  All checks passed. Graph API reachable, permissions sufficient.  │
└───────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Health Check ────────────────────────────────────────────────┐
│                                                                   │
│  I ran 6 validation checks against your Microsoft 365 tenant.     │
│  All passed.                                                      │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ✓  Graph API reachable         14ms response               │ │
│  │  ✓  Token valid                 59 min remaining            │ │
│  │  ✓  Sites.Read.All granted      Can enumerate all sites     │ │
│  │  ✓  Files.Read.All granted      Can read file content       │ │
│  │  ✓  At least 1 site accessible  Found 12 sites              │ │
│  │  ✓  Rate limit headroom         9,800 of 10,000 req/10min  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [✅ Accept]   [↻ Re-run Checks]   [⏭️ Skip]                     │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**With failures:**

```
┌── § Health Check ────────────────────────────── ⚠ 4/6 passed ───┐
│                                                                   │
│  I ran 6 validation checks. 4 passed, 2 need attention.          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ✓  Graph API reachable         14ms response               │ │
│  │  ✓  Token valid                 59 min remaining            │ │
│  │  ✗  Sites.Read.All NOT granted  Only Sites.Selected         │ │
│  │     You have access to 3 of 12 sites. To access all:        │ │
│  │     [Request broader permissions]  [Continue with 3 sites]  │ │
│  │  ✓  Files.Read.All granted      Can read file content       │ │
│  │  ✓  At least 1 site accessible  Found 3 sites               │ │
│  │  ✗  Rate limit warning          Only 200 of 10,000 remain  │ │
│  │     Another application is consuming your quota. Sync may   │ │
│  │     be throttled. Consider scheduling sync during off-hours.│ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [✅ Accept with warnings]  [↻ Re-run]  [⏭️ Skip]                │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 Section: Scope

**Collapsed (accepted):**

```
┌── § Scope ─────────────────────────────────────── ✅ Accepted ───┐
│  8 of 12 sites selected, containing 14 document libraries.       │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Scope ───────────────────────────────────────────────────────┐
│                                                                   │
│  I discovered 12 SharePoint sites with 18 document libraries.     │
│  I recommend syncing 8 sites (14 libraries) based on:             │
│   - Activity score (documents modified in last 30 days)           │
│   - Content relevance (file types your pipeline can process)      │
│   - Size (estimated 4.2 GB, within your storage quota)            │
│                                                                   │
│  4 sites excluded:                                                │
│   - "Archived Projects" -- no activity in 180+ days               │
│   - "Personal Sites" -- user OneDrive, not shared content         │
│   - "Test Environment" -- flagged as non-production               │
│   - "External Vendors" -- sensitivity score too high              │
│                                                                   │
│  ┌─ Recommended Sites ──────────────────────────────────────┐    │
│  │                                                           │    │
│  │  [✓] Corp Docs           4 libraries   1,234 docs  2.1GB │    │
│  │      Score: 92  Activity: High  Last modified: 2h ago     │    │
│  │                                                           │    │
│  │  [✓] Engineering Hub     3 libraries     890 docs  1.4GB │    │
│  │      Score: 87  Activity: High  Last modified: 30m ago    │    │
│  │                                                           │    │
│  │  [✓] Product Docs        2 libraries     456 docs  0.3GB │    │
│  │      Score: 81  Activity: Medium  Last modified: 1d ago   │    │
│  │                                                           │    │
│  │  [✓] HR Portal           1 library       234 docs  0.2GB │    │
│  │  [✓] Marketing           2 libraries     567 docs  0.1GB │    │
│  │  [✓] Legal               1 library       189 docs  0.05GB│    │
│  │  [✓] Support KB          1 library       345 docs  0.04GB│    │
│  │  [✓] Sales Enablement    1 library       123 docs  0.01GB│    │
│  │                                                           │    │
│  │  ─── Excluded (uncheck to include) ─────────────────────  │    │
│  │                                                           │    │
│  │  [ ] Archived Projects   2 libraries     12K docs  8.5GB │    │
│  │      Reason: No activity in 180+ days                     │    │
│  │                                                           │    │
│  │  [ ] Personal Sites      --              --        --     │    │
│  │      Reason: OneDrive personal content                    │    │
│  │                                                           │    │
│  │  [ ] Test Environment    1 library        45 docs  0.01GB│    │
│  │      Reason: Non-production site                          │    │
│  │                                                           │    │
│  │  [ ] External Vendors    1 library        78 docs  0.2GB │    │
│  │      Reason: High sensitivity score (external sharing)    │    │
│  │                                                           │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  Summary: 8 sites, 14 libraries, ~4,038 documents, ~4.2 GB       │
│                                                                   │
│  [✅ Accept]   [✏️ Modify Selection]   [⏭️ Skip]                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Large-scale handling (100+ sites):** When discovery returns more than 50 sites, the site list uses virtual scrolling with search/filter controls. Sites are paginated in groups of 25 with "Show More" loading. The recommendation algorithm runs server-side and returns a pre-sorted, pre-categorized list so the client never receives unbounded data. Discovery itself uses server-side pagination of the Graph API `/sites` endpoint with a 120-second timeout; if discovery times out, partial results are shown with a "Discovery incomplete -- {N} sites found so far. [Continue Discovery] [Use These Sites]" banner.

### 4.4 Section: Filters

**Collapsed (accepted):**

```
┌── § Filters ───────────────────────────────────── ✅ Accepted ───┐
│  Syncing 3,801 of 4,038 docs. 237 excluded (exec, archive, >50MB)│
└──────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Filters ─────────────────────────────────────────────────────┐
│                                                                   │
│  I recommend syncing 3,801 of 4,038 documents from your          │
│  selected sites. 237 excluded:                                    │
│                                                                   │
│   - 14 executables (.exe, .msi, .bat) -- blocked by policy        │
│   - 189 files in /Archive folders -- template: "Skip Archives"    │
│   - 8 files in /_private paths -- template: "Skip Private"        │
│   - 23 files over 50 MB -- size limit                             │
│   - 3 unsupported formats (.dwg, .pst) -- not processable        │
│                                                                   │
│  Applied templates:                                               │
│   - "Office Documents" (docx, xlsx, pptx, pdf, txt, md, csv)     │
│   - "Skip Archives" (exclude /Archive, /Old, /Backup paths)      │
│   - "Skip Private" (exclude /_private, /_drafts paths)            │
│                                                                   │
│  File type breakdown of included documents:                       │
│   PDF: 1,204 (32%)  |  DOCX: 987 (26%)  |  PPTX: 456 (12%)     │
│   XLSX: 389 (10%)   |  TXT: 234 (6%)    |  Other: 531 (14%)    │
│                                                                   │
│  [✅ Accept]   [✏️ Modify Filters]   [⏭️ Skip]                    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.5 Section: Schedule

**Collapsed (accepted):**

```
┌── § Schedule ──────────────────────────────────── ✅ Accepted ───┐
│  Full sync now, then delta sync every 4 hours.                    │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Schedule ────────────────────────────────────────────────────┐
│                                                                   │
│  I recommend the following sync schedule based on your content     │
│  volume (~4K docs) and update frequency (avg 45 changes/day):     │
│                                                                   │
│  Initial:  Full sync immediately after approval                   │
│            Estimated duration: 15-25 minutes (4.2 GB)             │
│                                                                   │
│  Ongoing:  Delta sync every 4 hours                               │
│            Estimated per-run: 30-90 seconds (avg 8 changes)       │
│                                                                   │
│  Webhooks: Not available                                          │
│            Real-time push notifications from SharePoint are        │
│            not yet enabled for this platform. Delta sync is        │
│            used as the fallback. When webhooks are enabled,        │
│            changes will be detected within 60 seconds.             │
│                                                                   │
│  [✅ Accept]   [✏️ Modify Schedule]   [⏭️ Skip]                   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.6 Section: Permissions

**Collapsed (skipped):**

```
┌── § Permissions ───────────────────────────────── ⏭️ Skipped ────┐
│  Permission crawling disabled. Search results not ACL-filtered.   │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Permissions ─────────────────────────────────────────────────┐
│                                                                   │
│  Permission-aware search ensures users only see documents they    │
│  have access to in SharePoint. This requires crawling ACLs.       │
│                                                                   │
│  ┌─ Current Permissions ─────────────────────────────────────┐   │
│  │                                                            │   │
│  │  Granted scope: Sites.Read.All                             │   │
│  │  Sufficient for: Document sync, metadata, content          │   │
│  │                                                            │   │
│  │  ┌─ Permission Modes ──────────────────────────────────┐  │   │
│  │  │                                                      │  │   │
│  │  │  ( ) Full ACL Crawl                                  │  │   │
│  │  │      Crawls SharePoint permissions into a graph.     │  │   │
│  │  │      Search results filtered by user's SharePoint    │  │   │
│  │  │      access. Requires: Sites.FullControl.All         │  │   │
│  │  │                                                      │  │   │
│  │  │      Why FullControl? Microsoft Graph requires this  │  │   │
│  │  │      scope to read site permission assignments and   │  │   │
│  │  │      sharing links. Despite the name, ABL Platform   │  │   │
│  │  │      only performs READ operations (no writes, no    │  │   │
│  │  │      deletes). All API calls are audited. See the    │  │   │
│  │  │      scope request document for full details.        │  │   │
│  │  │                                                      │  │   │
│  │  │      Status: NOT AVAILABLE (scope not granted)       │  │   │
│  │  │      [Request scope upgrade]                         │  │   │
│  │  │                                                      │  │   │
│  │  │  ( ) Simplified Permissions                          │  │   │
│  │  │      Uses site-level membership only (no item ACLs). │  │   │
│  │  │      Faster but less granular.                       │  │   │
│  │  │      Requires: Sites.Read.All (GRANTED)              │  │   │
│  │  │                                                      │  │   │
│  │  │  (•) Disabled                                        │  │   │
│  │  │      All synced documents visible to all users.      │  │   │
│  │  │      Simplest setup, no permission filtering.        │  │   │
│  │  │                                                      │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  │                                                            │   │
│  │  ─── Scope Upgrade Options ─────────────────────────────── │   │
│  │                                                            │   │
│  │  To enable full ACL crawling:                              │   │
│  │                                                            │   │
│  │  (a) Request security approval                             │   │
│  │      [Generate scope request document]                     │   │
│  │      Exports a PDF containing:                             │   │
│  │       - Requested scope and Graph API operations used      │   │
│  │       - Why FullControl is required (MS Graph limitation)  │   │
│  │       - Mitigations: read-only operations, audit logging,  │   │
│  │         no write/delete calls, token scoped to app only    │   │
│  │       - Data handling: what is read, where stored, TTLs    │   │
│  │       - Revocation procedure (instant via Azure AD)        │   │
│  │                                                            │   │
│  │  (b) Grant now (requires Azure AD admin)                   │   │
│  │      [Open Azure AD consent page]                          │   │
│  │      Admin grants consent in Azure portal, then re-run     │   │
│  │      health check to detect new scopes.                    │   │
│  │                                                            │   │
│  │  (c) Opt out                                               │   │
│  │      Continue with Disabled or Simplified mode.            │   │
│  │                                                            │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [✅ Accept]   [✏️ Change Mode]   [⏭️ Skip]                       │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.7 Section: Sample Preview (Dry-Run)

**Collapsed (reviewed):**

```
┌── § Sample Preview ────────────────────────────── ✅ Reviewed ───┐
│  20 sample documents previewed. All processable. Approved.        │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded:**

```
┌── § Sample Preview ──────────────────────────────────────────────┐
│                                                                   │
│  Here are 20 documents that WOULD be synced with your current     │
│  scope and filter settings. These are real documents from your    │
│  SharePoint -- nothing has been synced yet.                       │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Name                    Site          Type   Size  Modified│  │
│  │  ──────────────────────────────────────────────────────────│  │
│  │  Q1 Revenue Report.pdf   Corp Docs     PDF   2.4MB  2h ago │  │
│  │  API Design Guide.docx   Engineering   DOCX  340KB  1d ago │  │
│  │  Brand Guidelines.pptx   Marketing     PPTX  8.1MB  3d ago │  │
│  │  Employee Handbook.pdf    HR Portal     PDF   1.2MB  7d ago │  │
│  │  Release Notes v4.2.md    Product Docs  MD     45KB  4h ago │  │
│  │  Security Policy.docx    Legal         DOCX  890KB 14d ago │  │
│  │  Sales Playbook.pptx     Sales Enable  PPTX  5.6MB  2d ago │  │
│  │  Troubleshooting.pdf     Support KB    PDF   670KB  6h ago │  │
│  │  Architecture Diag.vsdx  Engineering   VSDX  1.1MB  5d ago │  │
│  │  Onboarding Guide.docx   HR Portal     DOCX  2.3MB 30d ago │  │
│  │  ... (10 more)                                              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Sample breakdown:                                                │
│   5 PDF, 4 DOCX, 3 PPTX, 2 XLSX, 2 MD, 2 TXT, 1 VSDX, 1 CSV   │
│   All 20 are processable by the current pipeline.                 │
│   1 file (Architecture Diag.vsdx) will use fallback extraction.   │
│                                                                   │
│  [✅ Looks Good]   [✏️ Adjust Filters]   [↻ Refresh Sample]      │
│  [Abandon -- Do Not Sync]                                         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Modify Mode -- Editing Inside the Document

When the user clicks "Modify" on any section, the section expands inline with editing controls. No dialogs or modals. The document itself becomes the editor.

### 5.1 Filter Modify (Basic)

Clicking "Modify Filters" on the Filters section expands inline controls:

```
┌── § Filters ────────────────────────── ✏️ Modifying ─────────────┐
│                                                                   │
│  Currently syncing 3,801 of 4,038 documents.                     │
│                                                                   │
│  ─── File Types ───────────────────────────────────────────────── │
│                                                                   │
│  Include: [✓] PDF  [✓] DOCX  [✓] PPTX  [✓] XLSX                │
│           [✓] TXT  [✓] MD    [✓] CSV   [ ] HTML                 │
│           [ ] EXE  [ ] MSI   [ ] BAT   [ ] DWG                  │
│                                                                   │
│  ─── Size Limit ───────────────────────────────────────────────── │
│                                                                   │
│  Maximum file size: [50 MB ▼]                                     │
│  Files over limit: 23 (would be excluded)                         │
│                                                                   │
│  ─── Templates ────────────────────────────────────────────────── │
│                                                                   │
│  [✓] Skip Archives    (exclude /Archive, /Old, /Backup)          │
│  [✓] Skip Private     (exclude /_private, /_drafts)              │
│  [ ] Skip Media        (exclude images, video, audio)             │
│  [ ] Only Recent       (modified in last 365 days)                │
│                                                                   │
│  ─── More Options ─────────────────────── [Show Advanced ▾] ──── │
│                                                                   │
│  Updated count: 3,801 documents                                   │
│  [✅ Save Changes]   [↩ Reset to Recommendation]                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Filter Modify (Intermediate -- Folder Globs, Date Ranges)

Clicking "Show Advanced" reveals additional controls below, still inline:

```
│  ─── Advanced Filters ─────────────────────────────────────────── │
│                                                                   │
│  Folder Include Patterns (glob):                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ /Shared Documents/**                                      │    │
│  │ /Projects/2026/**                                         │    │
│  └──────────────────────────────────────────────────────────┘    │
│  [+ Add pattern]                                                  │
│                                                                   │
│  Folder Exclude Patterns (glob):                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ **/_archive/**                                            │    │
│  │ **/node_modules/**                                        │    │
│  └──────────────────────────────────────────────────────────┘    │
│  [+ Add pattern]                                                  │
│                                                                   │
│  Date Range:                                                      │
│  Modified after:  [2025-01-01]   Modified before: [none]          │
│                                                                   │
│  ─── Condition Builder ───────────── [Show CEL Editor ▾] ─────── │
```

### 5.3 Filter Modify (Advanced -- CEL Expressions)

Clicking "Show CEL Editor" reveals the full expression editor:

```
│  ─── CEL Expression Editor ────────────────────────────────────── │
│                                                                   │
│  Write a CEL expression to define custom filter logic.            │
│  Available variables: file.name, file.path, file.size,            │
│  file.mimeType, file.modifiedAt, file.createdBy, site.name,      │
│  file.contentType, file.metadata["CustomColumn"]                  │
│                                                                   │
│  Custom metadata: SharePoint column values discovered during      │
│  profiling are available via file.metadata["ColumnName"].          │
│  [View discovered columns]  -- lists all custom columns found     │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ file.size < 50000000                                      │    │
│  │ && !file.path.startsWith("/_archive")                     │    │
│  │ && file.modifiedAt > timestamp("2025-01-01T00:00:00Z")    │    │
│  │ && !(file.mimeType in ["application/x-msdownload",        │    │
│  │       "application/x-msi"])                                │    │
│  │ && (site.name != "External Vendors"                        │    │
│  │     || file.createdBy.endsWith("@contoso.com"))            │    │
│  └──────────────────────────────────────────────────────────┘    │
│  ✓ Expression valid. Matches 3,724 of 4,038 documents.           │
│                                                                   │
│  [Preview Matches]  shows 20 sample docs matching this expression │
│                                                                   │
│  [✅ Save Changes]   [↩ Reset to Recommendation]                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 5.4 Schedule Modify

```
┌── § Schedule ──────────────────────── ✏️ Modifying ──────────────┐
│                                                                   │
│  ─── Initial Sync ─────────────────────────────────────────────── │
│  (•) Immediately after approval                                   │
│  ( ) Schedule for: [date picker] at [time picker]                 │
│  ( ) Do not run initial sync (delta only)                         │
│                                                                   │
│  ─── Ongoing Sync ─────────────────────────────────────────────── │
│  Frequency: [Every 4 hours ▼]                                     │
│    Options: Every 1h | 2h | 4h | 6h | 12h | 24h | Custom cron    │
│                                                                   │
│  Custom cron (if selected):                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 0 */4 * * *                                               │    │
│  └──────────────────────────────────────────────────────────┘    │
│  = "At minute 0 of every 4th hour"                                │
│                                                                   │
│  [✅ Save Changes]   [↩ Reset to Recommendation]                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 5.5 Scope Modify

When user clicks "Modify Selection" in the Scope section, checkboxes become interactive and a search/filter bar appears:

```
│  ┌─ Site Selection ──────────────────────────────────────────┐   │
│  │  [Search sites...]  [Sort: Score ▼]  [Show: All ▼]        │   │
│  │                                                            │   │
│  │  [Select All]  [Deselect All]  [Reset to Recommendation]  │   │
│  │                                                            │   │
│  │  [✓] Corp Docs           Score: 92   1,234 docs   2.1GB  │   │
│  │      [Expand libraries ▾]                                  │   │
│  │      [✓] Shared Documents     890 docs                     │   │
│  │      [✓] Policy Documents     234 docs                     │   │
│  │      [✓] Templates            78 docs                      │   │
│  │      [ ] Personal Uploads     32 docs                      │   │
│  │                                                            │   │
│  │  [✓] Engineering Hub     Score: 87     890 docs   1.4GB   │   │
│  │  ...                                                       │   │
│  └────────────────────────────────────────────────────────────┘   │
```

---

## 6. Export as Security Review

The "Export as PDF" button generates a document containing everything a security reviewer needs. The proposal IS the security review -- no separate artifact.

### PDF Contents

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  SHAREPOINT CONNECTOR — SECURITY REVIEW DOCUMENT                  │
│  Generated: Mar 22, 2026 14:45 UTC                               │
│  Connector ID: sp-corp-main                                      │
│  Organization: Contoso Ltd.                                      │
│                                                                   │
│  ═══════════════════════════════════════════════════════════════  │
│                                                                   │
│  1. AUTHENTICATION                                                │
│     Method: Device Code Flow (delegated)                          │
│     Authenticated by: maria@contoso.com                           │
│     Authentication time: Mar 22, 2026 14:20 UTC                  │
│     Delegated by: dev-team@contoso.com                            │
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
│  8. REVOCATION                                                    │
│     - Token can be revoked via platform UI or Azure AD portal     │
│     - Revoking stops all future syncs immediately                 │
│     - Existing synced data remains until connector is deleted     │
│     - To fully remove: Delete connector (removes config,          │
│       source, documents; NOTE: vector embeddings require          │
│       manual cleanup -- known gap)                                │
│                                                                   │
│  9. USER DECISIONS LOG                                            │
│     § Connection:   Accepted (no modifications)                   │
│     § Health Check: Accepted (6/6 passed)                        │
│     § Scope:        Modified (excluded Personal Sites library     │
│                     "Personal Uploads" from Corp Docs)            │
│     § Filters:      Accepted (recommendation as-is)               │
│     § Schedule:     Accepted (recommendation as-is)               │
│     § Permissions:  Skipped (disabled mode)                       │
│     § Preview:      Reviewed and approved                         │
│                                                                   │
│  10. KNOWN LIMITATIONS                                            │
│     - Delta sync scheduler: functional but no webhook push        │
│     - Vector cleanup on delete: not yet automated                 │
│     - Auth audit trail: not yet implemented                       │
│     - Permission change tracking: not available                   │
│                                                                   │
│  ─────────────────────────────────────────────────────────────── │
│  Approved by: _________________ Date: _________________          │
│  Security review: _____________ Date: _________________          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Error States Within the Document

Errors appear as annotated sections within the document, not as toasts or modals. Each error section explains what happened, why, and what the user can do.

### 7.1 Auth Failure

```
┌── § Connection ────────────────────── ✗ Authentication Failed ───┐
│                                                                   │
│  Authentication failed. The device code expired before            │
│  sign-in was completed.                                           │
│                                                                   │
│  What happened:                                                   │
│    The code ABCD-1234 was valid for 15 minutes. No sign-in       │
│    was detected before it expired at 14:35 UTC.                   │
│                                                                   │
│  What you can do:                                                 │
│    [↻ Generate New Code]  -- starts a fresh 15-minute window     │
│    [✏️ Change Auth Method] -- try Auth Code (browser popup)       │
│    [Share with Delegate]  -- let someone else authenticate        │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Discovery Failure

```
┌── § Scope ───────────────────────── ✗ Discovery Failed ──────────┐
│                                                                   │
│  Site discovery failed after 45 seconds.                          │
│                                                                   │
│  What happened:                                                   │
│    Microsoft Graph API returned 403 Forbidden when listing        │
│    sites. The granted scope (Sites.Selected) does not include     │
│    permission to enumerate all sites.                             │
│                                                                   │
│  With Sites.Selected, you must specify sites manually:            │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Enter SharePoint site URLs (one per line):               │    │
│  │  https://contoso.sharepoint.com/sites/CorpDocs            │    │
│  │  https://contoso.sharepoint.com/sites/Engineering         │    │
│  │                                                           │    │
│  └──────────────────────────────────────────────────────────┘    │
│  [Validate Sites]                                                 │
│                                                                   │
│  Or upgrade permissions:                                          │
│  [Request Sites.Read.All]  -- enables automatic discovery         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.3 Discovery Timeout

```
┌── § Scope ───────────────────── ⚠ Discovery Incomplete ────────┐
│                                                                   │
│  Discovery timed out after 120 seconds. 347 of an estimated      │
│  1,200+ sites have been loaded so far.                            │
│                                                                   │
│  What happened:                                                   │
│    Your tenant has a large number of SharePoint sites. The        │
│    Microsoft Graph API paginates site listings and the 120s       │
│    timeout was reached before all pages were fetched.             │
│                                                                   │
│  You can:                                                         │
│    [Continue Discovery]  -- extend timeout, fetch remaining       │
│    [Use 347 Sites]       -- proceed with sites found so far       │
│    [Enter Sites Manually] -- skip discovery, provide URLs         │
│                                                                   │
│  Tip: For very large tenants, consider entering specific site     │
│  URLs rather than discovering all sites.                          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.4 Sync Failure (Post-Approval)

```
┌── § Sync Status ─────────────────── ✗ Sync Failed ──────────────┐
│                                                                   │
│  Full sync failed after processing 1,204 of 3,801 documents.     │
│                                                                   │
│  What happened:                                                   │
│    OAuth token expired during sync. The refresh token             │
│    exchange returned "invalid_grant" -- the user may have         │
│    been removed or the app consent was revoked.                   │
│                                                                   │
│  Documents synced before failure: 1,204 (these are searchable)   │
│  Documents not synced: 2,597                                      │
│                                                                   │
│  What you can do:                                                 │
│    [↻ Re-authenticate]    -- new auth, then resume sync           │
│    [Resume from Checkpoint] -- retry from doc #1,205              │
│    [Keep Partial]          -- use the 1,204 synced documents      │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.5 Token Expiry

```
┌── § Connection ──────────────────── ⚠ Token Expiring ────────────┐
│                                                                   │
│  Your refresh token expires in 3 days (Mar 25, 2026).             │
│  After expiry, syncs will fail and require re-authentication.    │
│                                                                   │
│  [↻ Re-authenticate Now]   [Share with Delegate]                  │
│  [Remind Me Tomorrow]                                             │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.6 Throttling (429)

```
┌── § Sync Status ─────────────────── ⚠ Throttled ────────────────┐
│                                                                   │
│  Microsoft Graph API is throttling requests (429 Too Many         │
│  Requests). Sync is paused and will automatically retry           │
│  in 120 seconds.                                                  │
│                                                                   │
│  Progress: 2,100 of 3,801 documents synced                       │
│  Throttle reason: Tenant-wide rate limit exceeded                │
│  Retry at: 14:47 UTC (in 1m 52s)                                │
│                                                                   │
│  [Pause Sync]   [Stop Sync]   [Continue Waiting]                 │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.7 Permission Revocation

```
┌── § Connection ──────────────────── ✗ Permissions Revoked ───────┐
│                                                                   │
│  Admin consent for this application was revoked in Azure AD.      │
│  All sync operations are stopped.                                 │
│                                                                   │
│  Previously granted: Sites.Read.All, Files.Read.All              │
│  Currently granted: (none)                                        │
│                                                                   │
│  What happened:                                                   │
│    An Azure AD administrator removed consent at approximately     │
│    Mar 22, 2026 16:00 UTC. This affects all users of this app.   │
│                                                                   │
│  What you can do:                                                 │
│    [Request Re-consent]       -- sends request to admin           │
│    [Export Security Review]   -- shows what was configured        │
│    [Delete Connector]         -- removes all synced data          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 7.8 Partial Failure

```
┌── § Sync Status ─────────────────── ⚠ Partial Success ──────────┐
│                                                                   │
│  Sync completed with 47 document failures.                        │
│                                                                   │
│  3,754 of 3,801 documents synced successfully (98.8%).            │
│                                                                   │
│  Failures by reason:                                              │
│    23 -- File too large for extraction (>100MB after download)    │
│    12 -- Extraction timeout (Docling processing >5 min)           │
│     8 -- Permission denied on individual file                     │
│     4 -- File corrupted or encrypted                              │
│                                                                   │
│  [View Failed Documents]  [↻ Retry All Failed]   [Dismiss]       │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. Empty States

### 8.1 Discovery Finds No Sites

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  SharePoint Configuration Proposal                                │
│  Generated Mar 22, 2026 at 14:23 UTC                             │
│                                                                   │
│  § Connection      ✅ Accepted                                    │
│  § Health Check    ✅ 6/6 passed                                  │
│                                                                   │
│  ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  § Scope                                                          │
│                                                                   │
│  Discovery completed but found 0 SharePoint sites.                │
│                                                                   │
│  This usually means:                                              │
│                                                                   │
│  1. The authenticated user has no SharePoint access               │
│     maria@contoso.com may not be a member of any SharePoint      │
│     sites. Ask a SharePoint admin to verify site membership.     │
│                                                                   │
│  2. Sites.Selected scope with no sites configured                 │
│     If using Sites.Selected, an admin must explicitly grant       │
│     access to specific sites in the Azure AD app registration.   │
│     [How to configure Sites.Selected]                             │
│                                                                   │
│  3. SharePoint is not provisioned for this tenant                 │
│     The Microsoft 365 tenant may not have SharePoint Online       │
│     enabled. Verify at admin.microsoft.com.                       │
│                                                                   │
│  [↻ Re-run Discovery]  [✏️ Enter Site URLs Manually]              │
│  [Re-authenticate as Different User]                              │
│                                                                   │
│  (Remaining sections cannot be generated without sites.)          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 Discovery Finds Sites but No Documents

```
┌── § Filters ─────────────────────── ○ No Documents ──────────────┐
│                                                                   │
│  Your selected sites contain 0 documents matching current         │
│  filters. The sites have 234 total files, but all are excluded:  │
│                                                                   │
│   - 189 image files (.png, .jpg) -- not in included file types    │
│   - 34 executables (.exe) -- blocked by policy                    │
│   - 11 system files (.aspx, .master) -- SharePoint system files  │
│                                                                   │
│  Try:                                                             │
│   [✏️ Modify Filters]   -- expand included file types             │
│   [✏️ Modify Scope]     -- select additional sites                │
│   [↻ Refresh Discovery] -- check for newly added content         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 8.3 Sample Preview Returns Nothing Processable

```
┌── § Sample Preview ──────────────── ⚠ None Processable ─────────┐
│                                                                   │
│  20 sample documents were fetched, but none can be processed      │
│  by the current pipeline:                                         │
│                                                                   │
│   - 12 .vsdx files -- Visio diagrams (no extractor available)    │
│   - 5 .dwg files -- AutoCAD drawings (no extractor available)    │
│   - 3 .pst files -- Outlook archives (no extractor available)    │
│                                                                   │
│  The pipeline supports: PDF, DOCX, PPTX, XLSX, TXT, MD, CSV,    │
│  HTML, XML, JSON, and 17 other formats.                           │
│                                                                   │
│  [✏️ Modify Scope]   -- select sites with supported content       │
│  [✏️ Modify Filters] -- your sites may have supported files       │
│                         hidden by current filter settings         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. Monitoring (Post-Setup)

After approval and sync start, the document transforms into a live monitoring view. It is the same document, now with live data. Every section remains editable.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  SharePoint: Corp Main                          [Edit] [Export]  │
│  Approved Mar 22, 2026 · Last sync: 5 min ago · Next: in 3h 55m │
│                                                                   │
│  ─── Status ─────────────────────────────────────────────────── │
│                                                                   │
│  ● Active    3,754 indexed   47 failed   0 pending               │
│  ████████████████████████████████████████████░░ 98.8%            │
│                                                                   │
│  ─── Sections ───────────────────────────────────────────────── │
│                                                                   │
│  § Connection      ● Healthy (token refreshed 2h ago)            │
│  § Health Check    ✅ 6/6 (last run: 4h ago)  [↻ Re-check]       │
│  § Scope           8 sites, 14 libraries   [✏️ Modify]            │
│  § Filters         3,801 matching   [✏️ Modify]                   │
│  § Schedule        Delta every 4h   [✏️ Modify]                   │
│  § Permissions     Disabled   [✏️ Enable]                         │
│                                                                   │
│  ─── Recent Sync Runs ──────────────────────────────────────── │
│                                                                   │
│  Mar 22, 14:45   Full    3,754 docs   23 min   ● Complete        │
│  Mar 22, 18:45   Delta   12 changes   45 sec   ● Complete        │
│  Mar 22, 22:45   Delta   3 changes    12 sec   ● Complete        │
│  Mar 23, 02:45   Delta   0 changes    8 sec    ● No changes      │
│                                                                   │
│  ─── Failed Documents ──────────────────────────── [View All] ── │
│                                                                   │
│  Q4-Projections.xlsx   Extraction timeout     Mar 22, 14:52      │
│  Legacy-Report.doc     Unsupported format     Mar 22, 14:48      │
│  ... 45 more                                                      │
│                                                                   │
│  [↻ Retry All Failed]   [Export as PDF]   [Pause Sync]           │
│  [Delete Connector]                                               │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

When the user clicks "Modify" on any section, it expands inline with the same editing experience as during initial setup. Changes are applied immediately (for filters, schedule) or trigger a re-sync (for scope changes).

---

## 10. Multi-Connector

**Multiple Microsoft 365 tenants:** To sync content from multiple Microsoft 365 tenants into a single knowledge base, create one SharePoint connector per tenant. Each connector authenticates independently against its own tenant. The connector dashboard (below) groups connectors by type and shows cross-tenant aggregate metrics. There is no limit on the number of tenants -- each is a separate connector with its own proposal, credentials, and sync schedule.

### 10.1 Connector Dashboard

When there are multiple connectors, the document list becomes a dashboard:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Enterprise Connectors                   [+ New Connector]       │
│                                                                   │
│  ┌─ Summary ────────────────────────────────────────────────┐   │
│  │  4 connectors  │  12,340 documents  │  2 need attention   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [All (4)] [Healthy (2)] [Attention (2)] [Type: Any ▼]          │
│                                                                   │
│  ┌─ Corp Main (SharePoint) ─── ● Active ─── 3,754 docs ────┐  │
│  │  8 sites · Delta every 4h · Last sync: 5 min ago          │  │
│  │  [Open Proposal]                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Engineering (SharePoint) ─── ⚠ Token Expiring ── 2,100 ─┐  │
│  │  3 sites · Delta every 2h · Token expires in 3 days        │  │
│  │  [Open Proposal]   [Re-authenticate]                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Jira Cloud ─── ● Active ─── 5,678 docs ─────────────────┐  │
│  │  12 projects · Delta every 1h · Last sync: 45 min ago      │  │
│  │  [Open Proposal]                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─ Confluence ─── ✗ Auth Failed ─── 808 docs (stale) ──────┐  │
│  │  4 spaces · Last successful sync: 3 days ago               │  │
│  │  [Open Proposal]   [Re-authenticate]                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 10.2 New From Template

"New Connector" offers creating from a template (an approved proposal used as a starting point):

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  New Connector                                                    │
│                                                                   │
│  ─── Start Fresh ──────────────────────────────────────────────  │
│  [SharePoint]  [Jira]  [Confluence]  [Google Drive]  [+More]     │
│                                                                   │
│  ─── From Template ────────────────────────────────────────────  │
│  Re-use settings from an existing approved proposal.              │
│                                                                   │
│  ┌─ Corp Main (SharePoint) ─────────────────────────────────┐   │
│  │  Created: Mar 22 · 8 sites, Office Documents filter       │   │
│  │  [Use as Template]                                         │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ─── Clone ────────────────────────────────────────────────────  │
│  Copy an entire approved proposal (same tenant, new name).        │
│                                                                   │
│  ┌─ Corp Main (SharePoint) ─────────────────────────────────┐   │
│  │  [Clone] -- copies scope, filters, schedule, permissions   │   │
│  │  You will need to authenticate separately.                 │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

When using a template, the system generates a pre-filled document. All sections start as "Recommended (from template)" instead of "Recommended (auto-detected)." The user reviews and accepts/modifies as usual.

### 10.3 Bulk Operations

From the dashboard, multi-select connectors for bulk actions:

```
│  [✓] Corp Main   [✓] Engineering   [ ] Jira   [ ] Confluence    │
│                                                                   │
│  2 selected:  [↻ Sync Now]  [Pause]  [Export All as PDF]        │
│               [Apply Schedule: Every 4h]  [Apply Filter Template]│
```

---

## 11. Backend Requirements

### 11.1 New API Endpoints

| Endpoint                                           | Method | Purpose                                                                                |
| -------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `POST /connectors/:id/generate-proposal`           | POST   | Triggers discovery + profiling + recommendation as one unit, returns proposal skeleton |
| `GET /connectors/:id/proposal`                     | GET    | Returns current proposal state (all sections, their status, user decisions)            |
| `PATCH /connectors/:id/proposal/sections/:section` | PATCH  | Accept/modify/skip a section. Body contains decision + any modifications               |
| `POST /connectors/:id/proposal/approve`            | POST   | Approve entire proposal, triggers sync                                                 |
| `GET /connectors/:id/proposal/export`              | GET    | Returns proposal as structured JSON for PDF generation (client renders PDF)            |
| `POST /connectors/:id/proposal/health-check`       | POST   | Runs 6-axis health check, returns results                                              |
| `POST /connectors/:id/proposal/sample-preview`     | POST   | Fetches 20 real documents matching current scope+filters (dry-run)                     |
| `POST /connectors/:id/auth/delegate`               | POST   | Generates a shareable auth delegation link                                             |
| `GET /connectors/:id/auth/delegate/:token`         | GET    | Returns delegation details for the person authenticating                               |
| `POST /connectors/:id/clone`                       | POST   | Clones an approved proposal to a new connector                                         |
| `GET /connectors/templates`                        | GET    | Lists approved proposals usable as templates                                           |
| `GET /connectors/:id/sync-history`                 | GET    | Paginated sync run history                                                             |
| `GET /connectors/:id/failed-documents`             | GET    | Documents with processingError, paginated                                              |

### 11.2 New/Modified Models

| Model               | Type   | Fields                                                                                                                                                                                                                  |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConnectorProposal` | NEW    | `connectorId`, `sections[]` (each with `status: pending/accepted/modified/skipped`, `recommendation`, `userDecision`, `modifiedAt`), `overallStatus: draft/approved/rejected`, `exportedAt`, `approvedAt`, `approvedBy` |
| `AuthDelegation`    | NEW    | `connectorId`, `token` (random), `createdBy`, `expiresAt`, `completedBy`, `completedAt`, `status: pending/completed/expired`                                                                                            |
| `SyncRun`           | NEW    | `connectorId`, `type: full/delta`, `startedAt`, `completedAt`, `durationMs`, `documentsProcessed`, `documentsAdded`, `documentsModified`, `documentsDeleted`, `documentsFailed`, `status`, `errorMessage`               |
| `ConnectorConfig`   | MODIFY | Add `proposalId` reference, `templateSourceId` for cloned connectors                                                                                                                                                    |

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

| Component                    | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `ConnectorProposalDocument`  | Main document container, renders sections                    |
| `ProposalSection`            | Generic section wrapper (collapsed/expanded/modifying/error) |
| `ProposalTableOfContents`    | Sticky TOC sidebar with section status                       |
| `ProposalConnectionSection`  | Connection details + re-auth                                 |
| `ProposalHealthCheckSection` | 6-axis validation display                                    |
| `ProposalScopeSection`       | Site/library selection with recommendation                   |
| `ProposalFilterSection`      | Filter summary + inline editor (basic/intermediate/advanced) |
| `ProposalScheduleSection`    | Schedule recommendation + editor                             |
| `ProposalPermissionSection`  | Permission mode negotiation                                  |
| `ProposalPreviewSection`     | Dry-run document table                                       |
| `ProposalExportButton`       | PDF generation (client-side)                                 |
| `ConnectorDashboard`         | Multi-connector list with bulk actions                       |
| `CELExpressionEditor`        | Code editor for CEL filter expressions                       |
| `AuthDelegationCard`         | Share auth link UI                                           |

---

## 12. Issue Checklist

Below is every review issue from the UX Enterprise Review (C-1 through C-2, H-1 through H-13, M-1 through M-14 = 29 issues total, plus the deep-dive's 21 consolidated gap items). This section maps each to how Design B addresses it.

### Enterprise UX Issues (from UX-ENTERPRISE-REVIEW.md)

| #    | Issue                              | How Design B Addresses It                                                                                                                                               |
| ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1  | WCAG contrast failures             | Document sections use high-contrast text on white/dark backgrounds. All text meets 4.5:1 AA. Status indicators use color + shape (checkmark, X, triangle).              |
| C-2  | No destructive action confirmation | "Delete Connector" requires typed confirmation. "Abandon" in preview requires explicit click. Approve requires reviewing all sections.                                  |
| H-1  | Emoji icons throughout             | Document uses text labels and Lucide icons only. Status uses semantic symbols (checkmark, X, triangle) not emoji.                                                       |
| H-2  | No monospace for technical values  | Client IDs, tenant IDs, site URLs, CEL expressions, glob patterns all rendered in monospace.                                                                            |
| H-3  | 13px base font too small           | Document body at 14px. Section headers at 16px. Labels at 12px minimum.                                                                                                 |
| H-4  | Missing keyboard focus rings       | All interactive elements (Accept/Modify/Skip buttons, checkboxes, inputs) have visible focus rings. Sections navigable via Tab.                                         |
| H-5  | Color alone for status             | Section status uses icon + text: checkmark + "Accepted", X + "Failed", triangle + "Warning", circle + "Skipped".                                                        |
| H-6  | No loading/skeleton states         | Document generation shows progressive loading -- sections appear as they resolve with skeleton placeholders for pending sections.                                       |
| H-7  | No enterprise chrome               | Document sits within the standard platform chrome (top bar with tenant, user, notifications). The TOC provides document-level navigation.                               |
| H-8  | No multi-user awareness            | Connection section shows who authenticated, who delegated. Proposal shows who approved. Export includes full attribution.                                               |
| H-9  | No audit trail                     | The proposal itself IS the audit trail. Every section records who accepted/modified/skipped and when. Export captures full decision log.                                |
| H-10 | No form validation states          | Inline editors (CEL, globs, URLs) show validation in real-time: red border + error message for invalid, green check for valid, disabled states for inapplicable fields. |
| H-11 | Tables missing sort indicators     | Sample preview table and site list have sortable columns with directional arrows.                                                                                       |
| H-12 | Status vocabulary inconsistent     | Document uses consistent vocabulary: Accepted/Modified/Skipped for decisions; Active/Warning/Error/Paused for connector state; Indexed/Failed/Processing for documents. |
| H-13 | Settings panel no ARIA/focus trap  | Each expanded section is a `role="region"` with `aria-label`. Modify mode traps focus within the editing controls.                                                      |
| M-1  | Line height too loose              | Data tables (sites, sample docs) use 1.35 line height. Prose sections (recommendations, explanations) use 1.5.                                                          |
| M-2  | Only 3 font weights                | Section headers: 600. Body: 400. Labels: 500. Display numbers (doc counts): 300.                                                                                        |
| M-3  | No negative letter-spacing         | Section headers use -0.01em. Document title uses -0.02em.                                                                                                               |
| M-4  | KPI cards too sparse               | Not applicable -- document uses inline metrics within prose rather than separate KPI cards. Monitoring view shows trend data inline.                                    |
| M-5  | Numbers not right-aligned          | Document counts, file sizes, and scores are right-aligned in all tables (site list, sample preview, sync history).                                                      |
| M-6  | Date format inconsistent           | Relative within 24h ("5 min ago", "2h ago"), absolute beyond ("Mar 22, 2026"), full timestamp on hover tooltip.                                                         |
| M-7  | Breadcrumbs minimal                | Full breadcrumb: KB List > Product Docs > Data > SharePoint: Corp Main.                                                                                                 |
| M-8  | No ghost/tertiary button           | "Skip" buttons use ghost style. "Reset to Recommendation" uses tertiary. "Accept" is primary. "Modify" is secondary.                                                    |
| M-9  | No clear all filters               | Modify mode shows "Reset to Recommendation" to clear all custom filters back to system defaults.                                                                        |
| M-10 | Checkbox lacks indeterminate       | Site selection: if some libraries in a site are selected, site checkbox shows indeterminate state.                                                                      |
| M-11 | No toast notifications             | Document uses inline status updates, not toasts. Health check re-run shows result inline. Sync start confirmation inline.                                               |
| M-12 | Rebuild Index in Danger Zone       | Not applicable to connector flow -- but "Delete Connector" is in a clearly separated danger section at the bottom of monitoring view, not mixed with routine actions.   |
| M-13 | No error boundary patterns         | Every section has its own error state (see Section 7). Section-level errors do not block other sections.                                                                |
| M-14 | Hover/active states inconsistent   | Accept/Modify/Skip buttons have consistent hover (lighten 10%), active (scale 0.98 + darken), and disabled states.                                                      |

### Deep-Dive Gap Items (from SHAREPOINT-CONNECTOR-DEEP-DIVE.md Section 11)

| #   | Gap                                     | How Design B Addresses It                                                                                                                                                |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | File type distribution chart            | Filters section shows file type breakdown inline. Monitoring view shows distribution.                                                                                    |
| 2   | Per-connector document status breakdown | Monitoring view shows indexed/failed/pending counts inline.                                                                                                              |
| 3   | Per-site/drive document counts          | Scope section shows per-site doc counts. Modify mode shows per-library counts.                                                                                           |
| 4   | Token health dashboard                  | Connection section shows token expiry, refresh status, last used. Health Check validates.                                                                                |
| 5   | OAuth scope display                     | Health Check section shows all granted/missing scopes. Permissions section shows scope requirements per mode.                                                            |
| 6   | Per-document error messages             | Failed Documents section in monitoring shows error message per document.                                                                                                 |
| 7   | Failed doc list per connector           | Monitoring view has "Failed Documents" section with view all + retry.                                                                                                    |
| 8   | Delta token/per-drive status            | Monitoring can show per-drive delta token status (data exists via `GET /delta-tokens`).                                                                                  |
| 9   | ACL viewer                              | Permissions section shows permission mode and scope. Full ACL viewer deferred (needs new endpoint).                                                                      |
| 10  | External sharing report                 | Permissions section mentions external sharing detection. Scope section flags high-sensitivity sites.                                                                     |
| 11  | Filter preview button                   | Sample Preview section IS the filter preview. Uses existing `POST /filters/preview` endpoint.                                                                            |
| 12  | Permission recrawl trigger              | Monitoring permissions section includes "Re-crawl Permissions" action.                                                                                                   |
| 13  | Sync history/timeline                   | Monitoring view shows "Recent Sync Runs" table. Requires new `SyncRun` model.                                                                                            |
| 14  | Sync duration tracking                  | Sync history table shows duration column. Requires persisting `durationMs`.                                                                                              |
| 15  | Delta changes changelog                 | Sync history can show adds/modifies/deletes per run once `SyncRun` model tracks them.                                                                                    |
| 16  | Content size aggregation                | Scope section shows per-site estimated size. Monitoring shows total synced size.                                                                                         |
| 17  | Source-side total count                 | Scope section shows discovered doc count vs filtered count (coverage).                                                                                                   |
| 18  | Embedding freshness metric              | Deferred -- not directly addressed in proposal (would need `embeddedAt` on chunks).                                                                                      |
| 19  | Content type report                     | Filters section shows supported vs unsupported format breakdown. Sample preview flags unsupported.                                                                       |
| 20  | Delegated auth flow                     | Connect screen has delegation card with shareable link, email option, and status tracking.                                                                               |
| 21  | Auth audit trail                        | Proposal logs all auth events (who authenticated, when, delegated by whom). Export includes full auth history. Backend `onAuthEvent` handler still needs implementation. |

---

## Summary

Design B treats the entire connector configuration as a single reviewable document. The core insight is that setup, review, security audit, and monitoring are not separate workflows -- they are different views of the same artifact at different points in time.

- **Before approval:** The document is a proposal with Accept/Modify/Skip controls.
- **During approval:** The document is a dry-run with real sample documents.
- **After export:** The document is a security review PDF with full decision audit trail.
- **After approval:** The document is a live monitoring dashboard, still editable.
- **For new connectors:** An approved document becomes a template or clone source.

The metaphor scales because each section is independently reviewable, and the TOC provides constant orientation regardless of document length.

---

## Review Status: CLEAN

### Round 1 Summary

- Issues resolved: 19/21 original gaps addressed (2 upgraded from NOT SOLVED to SOLVED during this review)
- Objectives met: 9/9 (avg score 4.6/5)
- Persona blockers: 0 critical remaining
- Fixes applied this round:
  - Added Sites.FullControl.All justification with read-only mitigation explanation (issue #3, H-NEW-1)
  - Added scope request document content specification (M-NEW-4)
  - Added large-scale handling paragraph: virtual scrolling, pagination, 120s timeout with partial results (H-NEW-2)
  - Added discovery timeout error state (Section 7.3) with continue/use-partial/manual options (H-NEW-3)
  - Added approval confirmation banner with document/size summary (M-NEW-5)
  - Added custom SharePoint metadata support in CEL editor variables (issue #16)
  - Added multi-tenant guidance in Section 10 (issue #20)
  - Fixed section numbering (7.3-7.8)
- Remaining gaps (MEDIUM/LOW only):
  - MEDIUM: No version history for proposal modifications (can see current vs recommendation, but not edit history)
  - MEDIUM: No side-by-side connector comparison for managing 15+ connectors
  - LOW: No dark mode considerations
  - LOW: No mobile/responsive layout considerations
