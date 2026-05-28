# SharePoint Connector — Design C: "Power Platform"

**Date:** 2026-03-22
**Version:** 1.0
**Philosophy:** Configuration is a first-class citizen. Power users deserve a powerful tool with full control, version history, bulk operations, and configuration-as-code — while templates and automation make common paths fast. Inspired by Coveo, Yext, and Lucidworks.

---

## 1. Philosophy Statement

Every connector configuration is a versioned, exportable, diffable artifact — not ephemeral form state. Templates make the 80% case instant, but the remaining 20% has full access to every knob, every filter stage, every API quota metric, and every permission grant — all on a single full-page management surface with tabs, not buried in dialogs or wizards.

---

## 2. User Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONNECTOR LIFECYCLE                             │
│                                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐  │
│  │PREREQUIS.│───>│  CONNECTION   │───>│  CONFIGURE   │───>│ DRY-RUN  │  │
│  │ CHECKLIST│    │  + AUTH       │    │  (6 tabs)    │    │ PREVIEW  │  │
│  └──────────┘    └──────────────┘    └──────────────┘    └──────────┘  │
│       │                │                    │                   │        │
│       │           ┌────┴────┐          ┌────┴────┐        ┌────┴────┐  │
│       │           │ Device  │          │Template │        │Approve/ │  │
│       │           │ Code    │          │ or      │        │Abandon  │  │
│       │           │   +     │          │ Manual  │        │(7 days) │  │
│       │           │ Admin   │          │ Config  │        └────┬────┘  │
│       │           │ Consent │          └─────────┘             │        │
│       │           └─────────┘                                  v        │
│       │                                               ┌──────────────┐ │
│       │                                               │   MONITOR    │ │
│       │                                               │  Dashboard   │ │
│       │                                               └──────┬───────┘ │
│       │                                                      │         │
│       │           ┌──────────────────────────────────────────┘         │
│       │           v                                                     │
│       │    ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│       │    │ Version     │   │ Config as    │   │ Bulk Operations  │  │
│       │    │ History     │   │ Code Export  │   │ (clone/template) │  │
│       │    └─────────────┘   └──────────────┘   └──────────────────┘  │
│       │                                                                 │
│  Multi-Connector Dashboard (matrix view of all connectors)             │
│  API Quota Dashboard (Graph API usage across all connectors)           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Screen Architecture Overview

This design uses **full-page views** (not dialogs) for all connector management. The navigation hierarchy:

```
Knowledge Base > Data > Connectors (list/dashboard)
                      > Connector Detail (full page, tabbed)
                      > New Connector (full page, tabbed)
```

---

## 4. Prerequisites Checklist (Issue #1: Azure App Registration Guidance)

Before any connector creation, a prerequisites gate screen validates readiness.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  New SharePoint Connector                                               │
│                                                                         │
│  ┌─ Prerequisites Checklist ──────────────────────────────────────────┐ │
│  │                                                                     │ │
│  │  Complete these before connecting. [What's an App Registration? ->] │ │
│  │                                                                     │ │
│  │  1. Azure App Registration                                          │ │
│  │     ┌──────────────────────────────────────────────────────┐       │ │
│  │     │ Client ID (Application ID)                           │       │ │
│  │     └──────────────────────────────────────────────────────┘       │ │
│  │     ┌──────────────────────────────────────────────────────┐       │ │
│  │     │ Tenant ID (Directory ID)                             │       │ │
│  │     └──────────────────────────────────────────────────────┘       │ │
│  │                                                                     │ │
│  │     [Validate App Registration]                                     │ │
│  │                                                                     │ │
│  │     Validation results:                                             │ │
│  │     ✅ App registration found in tenant                             │ │
│  │     ✅ Redirect URIs configured correctly                           │ │
│  │     ⚠️ No API permissions granted yet (will configure next)        │ │
│  │     ✅ App supports device code flow                                │ │
│  │                                                                     │ │
│  │  2. Permission Strategy                                             │ │
│  │     Choose your permission model:                                   │ │
│  │                                                                     │ │
│  │     (●) Sites.Selected (RECOMMENDED — least privilege)              │ │
│  │         Grant access to specific sites only. You will grant         │ │
│  │         per-site permissions in Azure after selecting sites.        │ │
│  │         Best for: production, compliance-sensitive environments.    │ │
│  │                                                                     │ │
│  │     ( ) Sites.Read.All (broad read access)                          │ │
│  │         Read all sites in your tenant. Faster setup,                │ │
│  │         broader access. No per-site grants needed.                  │ │
│  │         Best for: dev/test, small tenants, internal tools.          │ │
│  │                                                                     │ │
│  │     ( ) Sites.Read.All + Permission Sync                            │ │
│  │         Read all sites + crawl document permissions for             │ │
│  │         security-trimmed search. Requires additional grants.        │ │
│  │         Best for: multi-team KBs where access control matters.     │ │
│  │                                                                     │ │
│  │     ┌─ Required Azure Permissions ────────────────────────────┐    │ │
│  │     │ For Sites.Selected:                                      │    │ │
│  │     │   • Sites.Selected (Application) — admin consent needed  │    │ │
│  │     │   • offline_access (Delegated) — token refresh           │    │ │
│  │     │                                                          │    │ │
│  │     │ [Copy Permission List]  [Open Azure Portal ->]           │    │ │
│  │     └──────────────────────────────────────────────────────────┘    │ │
│  │                                                                     │ │
│  │  3. Authentication Method                                           │ │
│  │     ( ) Device Code — share code with IT admin to authenticate     │ │
│  │     ( ) Browser Login — authenticate yourself now                   │ │
│  │     (●) Client Credentials — app-only (requires client secret)     │ │
│  │                                                                     │ │
│  │  4. Admin Consent (separate from user auth)  [Issue #2]             │ │
│  │     Admin consent is a one-time step performed by a Global Admin    │ │
│  │     or Privileged Role Administrator in Azure AD.                   │ │
│  │                                                                     │ │
│  │     Status: ⚠️ Not yet granted                                     │ │
│  │                                                                     │ │
│  │     [Generate Admin Consent URL]                                    │ │
│  │     ┌──────────────────────────────────────────────────────────┐   │ │
│  │     │ https://login.microsoftonline.com/{tenant}/adminconsent  │   │ │
│  │     │ ?client_id={clientId}&redirect_uri=...                   │   │ │
│  │     └──────────────────────────────────────────────────────────┘   │ │
│  │     [Copy URL]  [Share via Email]                                   │ │
│  │                                                                     │ │
│  │     This URL must be opened by an Azure AD admin.                   │ │
│  │     After they consent, click [Verify Admin Consent] below.         │ │
│  │                                                                     │ │
│  │     [Verify Admin Consent]                                          │ │
│  │                                                                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  Or start from a template:                                              │
│  [SharePoint Standard]  [SharePoint Minimal]  [Import JSON Config]     │
│                                                                         │
│                                            [Cancel]  [Continue ->]      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Validation Error States

```
┌─ Validation Failed ──────────────────────────────────────────────┐
│                                                                   │
│  ❌ App registration not found                                    │
│     Client ID "abc-123" does not exist in tenant "contoso.com".  │
│     Verify the Client ID in Azure Portal > App Registrations.    │
│     [Open Azure Portal ->]                                        │
│                                                                   │
│  ❌ Redirect URI missing                                          │
│     Add this redirect URI to your app registration:               │
│     https://your-domain.com/api/connectors/auth/callback          │
│     [Copy URI]                                                    │
│                                                                   │
│  ❌ Tenant ID format invalid                                      │
│     Expected a GUID (e.g., 12345678-abcd-1234-abcd-123456789012)│
│     You entered: "contoso.onmicrosoft.com"                        │
│     Use the Directory (tenant) ID from Azure Portal > Overview.  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 5. Tab Architecture — Full-Page Connector Detail

After prerequisites pass and authentication succeeds, the connector opens as a **full-page tabbed view** (Issue #8, #21).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Connectors    SharePoint: Marketing Hub         v3 (saved) │
│                                                                         │
│  ┌─────────┬────────┬─────────┬──────────┬─────────────┬──────────┐   │
│  │Connection│ Scope  │ Filters │ Schedule │ Permissions │ Advanced │   │
│  └─────────┴────────┴─────────┴──────────┴─────────────┴──────────┘   │
│                                                                         │
│  [Tab content here — see wireframes below]                             │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Unsaved changes: 2 fields modified                             │   │
│  │  [Discard]  [Save as Draft]  [Save & Dry-Run]  [Save & Sync]  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 1: Connection

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Connection                                                             │
│                                                                         │
│  ┌─ Authentication ───────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  Status: ● Connected                                                ││
│  │  Method: Device Code                                                ││
│  │  Authenticated by: security@contoso.com                             ││
│  │  Authenticated at: Mar 22, 2026, 2:15 PM                           ││
│  │                                                                     ││
│  │  Token Health:                                                      ││
│  │  Access Token:  Expires in 45 min   ● Healthy (auto-refresh)       ││
│  │  Refresh Token: Expires Apr 15      ● Healthy                      ││
│  │  Last used: 5 min ago               Last refreshed: 45 min ago     ││
│  │                                                                     ││
│  │  Scopes granted:                                                    ││
│  │  [Sites.Selected] [offline_access] [User.Read]                      ││
│  │                                                                     ││
│  │  [Re-authenticate]  [Revoke Token]                                  ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Connection Diagnostics ───────────────────────────────── [Issue #15]│
│  │                                                                     ││
│  │  [Run Full Diagnostic]                                              ││
│  │                                                                     ││
│  │  Last diagnostic: Mar 22, 2:30 PM                                   ││
│  │  ✅ Azure AD token valid                                            ││
│  │  ✅ Graph API reachable (latency: 45ms)                             ││
│  │  ✅ Sites.Selected permission confirmed                             ││
│  │  ✅ Can enumerate granted sites (3 sites)                           ││
│  │  ⚠️ Directory.Read.All not granted (group resolution unavailable)  ││
│  │  ✅ Webhook endpoint reachable from Microsoft                       ││
│  │  ✅ Token refresh working                                           ││
│  │                                                                     ││
│  │  [Download Diagnostic Report]  [Copy as JSON]                       ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ App Registration ─────────────────────────────────────────────────┐│
│  │  Client ID:  a1b2c3d4-...  [Copy]                                  ││
│  │  Tenant ID:  e5f6g7h8-...  [Copy]                                  ││
│  │  Permission model: Sites.Selected                                   ││
│  │  Admin consent: ✅ Granted (Mar 20, 2026)                          ││
│  │  [Edit App Registration]                                            ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 2: Scope

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Scope — What to Sync                                                   │
│                                                                         │
│  ┌─ Sites ────────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  Permission model: Sites.Selected                                   ││
│  │  Showing sites where this app has been granted access.              ││
│  │                                                                     ││
│  │  [Discover Sites]  [Grant Access to New Site ->]  (Issue #7)        ││
│  │                                                                     ││
│  │  ┌────┬──────────────────┬───────┬────────┬──────────┬──────────┐  ││
│  │  │ ☑  │ Site             │ Files │ Size   │ Updated  │ Status   │  ││
│  │  ├────┼──────────────────┼───────┼────────┼──────────┼──────────┤  ││
│  │  │ ☑  │ Marketing Hub    │  42   │ 3.2 GB │ 2 days   │ ● Synced │  ││
│  │  │ ☑  │ Engineering Wiki │ 128   │ 1.1 GB │ today    │ ● Synced │  ││
│  │  │ ☑  │ Sales Team Site  │  67   │ 5.4 GB │ 1 week   │ ● Synced │  ││
│  │  │ ☐  │ Executive Comms  │  12   │ 0.2 GB │ 3 months │ — Excluded││ ││
│  │  └────┴──────────────────┴───────┴────────┴──────────┴──────────┘  ││
│  │                                                                     ││
│  │  Streaming discovery: Loading sites 1-50 of ~200...  [Cancel]       ││
│  │  ████████████░░░░░░░░  50 sites loaded    (Issue #5)               ││
│  │                                                                     ││
│  │  Pagination: [< Prev]  Page 1 of 4  [Next >]  Show [50 v] per page││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Libraries ────────────────────────────────────────────────────────┐│
│  │  (●) All libraries in selected sites                                ││
│  │  ( ) Select specific libraries                                      ││
│  │  ( ) Exclude specific libraries                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Content Types ────────────────────────────────────────────────────┐│
│  │  ☑ Document libraries (files)                                       ││
│  │  ☑ SharePoint Pages                                                 ││
│  │  ☐ List items                                                       ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Schema Discovery ────────────────────────────────── (Issue #16) ──┐│
│  │                                                                     ││
│  │  SharePoint custom columns detected in selected sites:              ││
│  │  [Discover Custom Fields]                                           ││
│  │                                                                     ││
│  │  ┌──────────────────┬────────────┬───────────┬──────────────────┐  ││
│  │  │ Field            │ Type       │ Found In  │ Map To           │  ││
│  │  ├──────────────────┼────────────┼───────────┼──────────────────┤  ││
│  │  │ Department       │ Choice     │ 3 sites   │ [metadata.dept▾] │  ││
│  │  │ ProjectCode      │ Text       │ 2 sites   │ [metadata.proj▾] │  ││
│  │  │ Sensitivity      │ Choice     │ 3 sites   │ [metadata.sens▾] │  ││
│  │  │ ReviewDate       │ DateTime   │ 1 site    │ [-- unmapped -- ]│  ││
│  │  │ CostCenter       │ Number     │ 2 sites   │ [-- unmapped -- ]│  ││
│  │  └──────────────────┴────────────┴───────────┴──────────────────┘  ││
│  │                                                                     ││
│  │  Mapped fields become available as filter fields and search facets. ││
│  │  [+ Add Custom Mapping]                                             ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 3: Filters

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Filters                                                                │
│                                                                         │
│  ┌─ Pipeline View ───────────────────────────────────── (Issue #14) ──┐│
│  │                                                                     ││
│  │  Source ──> Scope ──> File Type ──> Folder ──> Metadata ──> Index  ││
│  │  252 docs   3 sites   27 types     -2 folders  -0 rules    ~220   ││
│  │             ↓ 180     ↓ 175        ↓ 173       ↓ 173       docs   ││
│  │                                                                     ││
│  │  Each stage shows document count reduction. Hover for details.      ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ File Types ───────────────────────────────────────────────────────┐│
│  │  Using: SharePoint defaults (27 types)  [Customize]                 ││
│  │                                                                     ││
│  │  Documents: pdf docx pptx xlsx odt rtf                              ││
│  │  Text:      txt csv tsv md html xml json yaml                       ││
│  │  Email:     eml msg                                                 ││
│  │  Other:     sql log rst                                             ││
│  │                                                                     ││
│  │  Your content: 60% PDF, 25% DOCX, 10% PPTX, 5% other              ││
│  │  Unsupported found: 3 .vsdx, 2 .mp4 (will be skipped)             ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Folder Rules ─────────────────────────────────────────────────────┐│
│  │  Include patterns:                                                   ││
│  │  ┌────────────────────────────────────────────────┐  [+ Add]        ││
│  │  │ /Projects/2024/**                              │  [x]            ││
│  │  └────────────────────────────────────────────────┘                  ││
│  │  Exclude patterns:                                                   ││
│  │  ┌────────────────────────────────────────────────┐  [+ Add]        ││
│  │  │ /Archive/**                                    │  [x]            ││
│  │  │ /Backup/**                                     │  [x]            ││
│  │  └────────────────────────────────────────────────┘                  ││
│  │                                                                      ││
│  │  Quick templates: [Exclude Archives] [Exclude Backups]              ││
│  │                   [Last 90 Days Only] [Skip >50MB]                  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Metadata Conditions ──────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  Rule 1: [contentType ▾] [not equals ▾] [.exe          ] [x]      ││
│  │    AND                                                              ││
│  │  Rule 2: [sizeBytes   ▾] [less than  ▾] [52428800      ] [x]      ││
│  │    AND                                                              ││
│  │  Rule 3: [Department  ▾] [in list    ▾] [Marketing,Eng ] [x]      ││
│  │          (custom field from Schema Discovery)                       ││
│  │                                                                     ││
│  │  [+ Add Rule]  [+ Add Group (OR)]                                   ││
│  │                                                                     ││
│  │  > CEL Expression (power users)                                     ││
│  │    metadata.sharepoint.sensitivity != "confidential"                ││
│  │    && sizeBytes < 50000000                                          ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Filter Dry-Run ──────────────────────────────────── (Issue #10) ──┐│
│  │                                                                     ││
│  │  [Preview Matching Documents]                                       ││
│  │                                                                     ││
│  │  Showing 25 of ~173 matching documents (sample):                    ││
│  │                                                                     ││
│  │  ┌──────────────────────────┬──────┬────────┬───────────┬────────┐ ││
│  │  │ Document                 │ Type │ Size   │ Site      │ Match  │ ││
│  │  ├──────────────────────────┼──────┼────────┼───────────┼────────┤ ││
│  │  │ Q4-Report.pdf            │ PDF  │ 2.1 MB │ Marketing │ ✅ Pass│ ││
│  │  │ Architecture.docx        │ DOCX │ 450 KB │ Eng Wiki  │ ✅ Pass│ ││
│  │  │ Old-Budget.xlsx          │ XLSX │ 1.2 MB │ Sales     │ ❌ Excl│ ││
│  │  │   Reason: folder /Archive/** excluded                │        │ ││
│  │  │ Video-Intro.mp4          │ MP4  │ 45 MB  │ Marketing │ ❌ Excl│ ││
│  │  │   Reason: unsupported file type                      │        │ ││
│  │  └──────────────────────────┴──────┴────────┴───────────┴────────┘ ││
│  │                                                                     ││
│  │  Summary: 173 included, 52 excluded, 27 unsupported                 ││
│  │  [Export Preview as CSV]                                            ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 4: Schedule

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Schedule                                                               │
│                                                                         │
│  ┌─ Sync Schedule ────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  (●) Every hour    ( ) Every 6 hours    ( ) Daily                   ││
│  │  ( ) Custom cron   ( ) Manual only                                  ││
│  │                                                                     ││
│  │  Custom cron: ┌───────────────────────────────┐                     ││
│  │               │ 0 */2 * * *  (every 2 hours)  │                     ││
│  │               └───────────────────────────────┘                     ││
│  │  Next scheduled: Mar 22, 3:00 PM (in 28 min)                       ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Real-Time (Webhooks) ─────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  ☑ Enable webhook notifications                                     ││
│  │                                                                     ││
│  │  Subscriptions:                                                     ││
│  │  Drive: Marketing Docs    ● Active   Expires: 23h   [Renew]        ││
│  │  Drive: Engineering Wiki  ● Active   Expires: 23h   [Renew]        ││
│  │  Drive: Sales Assets      ⚠ Failed   Last error: 403 [Retry]       ││
│  │                                                                     ││
│  │  Webhook URL: https://your-domain.com/api/webhooks/sharepoint       ││
│  │  Fallback: If webhook fails 3x, falls back to scheduled sync.      ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Sync Controls ────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  [▶ Sync Now]  [▶ Delta Sync]  [⏸ Pause Schedule]  [🔄 Full Resync]││
│  │                                                                     ││
│  │  Auto-pause: After [5] consecutive failures, pause sync and notify. ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Sync History ─────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  ┌───────────────────┬──────┬──────┬────────┬────────┬──────────┐  ││
│  │  │ Time              │ Type │ Docs │ Failed │ Dur.   │ Status   │  ││
│  │  ├───────────────────┼──────┼──────┼────────┼────────┼──────────┤  ││
│  │  │ Mar 22, 2:00 PM   │Delta │ +3   │ 0      │ 12s    │ ✅ Done  │  ││
│  │  │ Mar 22, 1:00 PM   │Delta │ +1   │ 0      │ 8s     │ ✅ Done  │  ││
│  │  │ Mar 22, 10:00 AM  │Full  │ 237  │ 4      │ 3m 12s │ ⚠ Partial│  ││
│  │  │ Mar 21, 10:00 PM  │Delta │ +5   │ 0      │ 15s    │ ✅ Done  │  ││
│  │  └───────────────────┴──────┴──────┴────────┴────────┴──────────┘  ││
│  │                                                                     ││
│  │  [Load More]                                                        ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 5: Permissions

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Permissions                                                            │
│                                                                         │
│  ┌─ Permission Mode ──────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  (●) Disabled — all synced content searchable by all KB users       ││
│  │  ( ) Simplified — 95% accuracy, lower API usage                     ││
│  │  ( ) Full — 100% accuracy, crawls document-level ACLs               ││
│  │                                                                     ││
│  │  Current app permissions:                                           ││
│  │  ✅ Sites.Selected                    Available                     ││
│  │  ✅ offline_access                    Available                     ││
│  │  ⬚ Sites.FullControl.All            Needed for Full mode           ││
│  │  ⬚ Directory.Read.All               Needed for group resolution    ││
│  │                                                                     ││
│  │  To enable Full permission sync:                                    ││
│  │  [Download Permission Request Document]                             ││
│  │  [Generate Admin Consent URL]                                       ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Sites.Selected Grants ─────────────────────────── (Issue #7) ─────┐│
│  │                                                                     ││
│  │  Per-site permission grants for this app:                           ││
│  │                                                                     ││
│  │  ┌──────────────────┬──────────────┬──────────────┬──────────────┐ ││
│  │  │ Site             │ Permission   │ Granted By   │ Granted At   │ ││
│  │  ├──────────────────┼──────────────┼──────────────┼──────────────┤ ││
│  │  │ Marketing Hub    │ Read         │ admin@co.com │ Mar 20, 2026 │ ││
│  │  │ Engineering Wiki │ Read         │ admin@co.com │ Mar 20, 2026 │ ││
│  │  │ Sales Team Site  │ Read         │ admin@co.com │ Mar 20, 2026 │ ││
│  │  └──────────────────┴──────────────┴──────────────┴──────────────┘ ││
│  │                                                                     ││
│  │  To add a new site, an Azure AD admin must run:                     ││
│  │  POST /sites/{siteId}/permissions with role: read                   ││
│  │  [Copy Graph API Call]  [Open Graph Explorer ->]                    ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Permission Crawl Status ──────────────────────────────────────────┐│
│  │                                                                     ││
│  │  Status: Disabled (permission mode = disabled)                      ││
│  │  Last crawl: Never                                                  ││
│  │  Schedule: Sundays at 2 AM (when enabled)                           ││
│  │                                                                     ││
│  │  [Trigger Permission Crawl]  (disabled — enable Full mode first)   ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Security Data Flow ──────────────────────────────── (Issue #11) ──┐│
│  │                                                                     ││
│  │  Data flow diagram:                                                 ││
│  │                                                                     ││
│  │  SharePoint ──[Graph API/TLS]──> SearchAI ──> MongoDB (encrypted)  ││
│  │       │                              │             │                 ││
│  │       │                              │        AES-256-GCM           ││
│  │       │                              v        (tokens at rest)      ││
│  │       │                         Neo4j (ACLs)                        ││
│  │       │                              │                              ││
│  │       │                              v                              ││
│  │       │                         Vector Store                        ││
│  │       │                         (embeddings)                        ││
│  │                                                                     ││
│  │  Data retention:                                                    ││
│  │  • OAuth tokens: encrypted, auto-expire, revocable                 ││
│  │  • Document content: stored during sync, chunked, then deleted     ││
│  │  • Embeddings: retained until connector deleted                     ││
│  │  • ACL graph: refreshed weekly, deleted with connector              ││
│  │                                                                     ││
│  │  Revocation: [Revoke All Access] deletes tokens + ACLs + vectors   ││
│  │                                                                     ││
│  │  [Download Full Security Document]                                  ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 6: Advanced

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Advanced                                                               │
│                                                                         │
│  ┌─ Configuration as Code ────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  [Export JSON]  [Export YAML]  [Import Config]                       ││
│  │                                                                     ││
│  │  Version: v3 (current)  [View History]  [Compare Versions]          ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ API Quota ────────────────────────────────────── (Issue #13) ─────┐│
│  │                                                                     ││
│  │  Microsoft Graph API usage (this connector):                        ││
│  │                                                                     ││
│  │  Today:      ████████░░░░░░░░░░░░  800 / 10,000 requests           ││
│  │  This week:  ████████████░░░░░░░░  3,200 / 50,000 requests         ││
│  │  This month: ██████░░░░░░░░░░░░░░  12,800 / 200,000 requests       ││
│  │                                                                     ││
│  │  Throttling events: 2 this week (429 responses)                     ││
│  │  Last throttled: Mar 21, 3:45 PM — retried after 30s               ││
│  │                                                                     ││
│  │  Estimated monthly usage: ~15,000 requests                          ││
│  │  (based on 3 sites, hourly delta, weekly full sync)                 ││
│  │                                                                     ││
│  │  Multi-app support: Using 1 of 1 registered app.                    ││
│  │  [Register Additional App] — distribute quota across apps           ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Delta Tokens ─────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  ┌──────────────────┬───────────────────┬──────────────────────┐   ││
│  │  │ Drive            │ Last Delta        │ Token Age            │   ││
│  │  ├──────────────────┼───────────────────┼──────────────────────┤   ││
│  │  │ Marketing Docs   │ Mar 22, 2:00 PM   │ 32 min               │   ││
│  │  │ Eng Wiki Files   │ Mar 22, 2:00 PM   │ 32 min               │   ││
│  │  │ Sales Assets     │ Mar 22, 10:00 AM  │ 4h 32min             │   ││
│  │  └──────────────────┴───────────────────┴──────────────────────┘   ││
│  │                                                                     ││
│  │  [Reset All Delta Tokens]  (forces full re-enumeration on next sync)││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Debug ────────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  Connector ID: conn_abc123def456                                    ││
│  │  Source ID: src_789ghi012jkl                                        ││
│  │  Index ID: idx_345mno678pqr                                         ││
│  │  Created: Mar 20, 2026 by john@contoso.com                         ││
│  │  Config source: template:sharepoint-standard (modified)             ││
│  │                                                                     ││
│  │  [View Raw Config JSON]  [View Sync Logs]  [View Worker Logs]       ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Template System (Issue #9)

### Predefined Templates

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Start from Template                                                    │
│                                                                         │
│  ┌─ SharePoint Standard ──────────────────────────────────────────────┐│
│  │  Sites.Read.All · All sites · 27 file types · Hourly sync          ││
│  │  Webhooks enabled · No permission sync · No folder restrictions    ││
│  │  Best for: Quick setup, internal teams, dev/test                    ││
│  │  [Use Template]  [Preview JSON]                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ SharePoint Minimal (Read-Only) ───────────────────────────────────┐│
│  │  Sites.Selected · Selected sites only · 10 doc types (PDF, DOCX,   ││
│  │  PPTX, XLSX, TXT, MD, HTML, CSV, JSON, XML) · Daily sync          ││
│  │  No webhooks · No permission sync · Exclude /Archive/**            ││
│  │  Best for: Small KBs, specific site access, low API quota          ││
│  │  [Use Template]  [Preview JSON]                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ SharePoint Full (with Permissions) ───────────────────────────────┐│
│  │  Sites.Read.All + Sites.FullControl.All + Directory.Read.All       ││
│  │  All sites · 27 types · Hourly + webhooks · Full permission sync   ││
│  │  Auto-pause after 5 failures · Weekly permission recrawl           ││
│  │  Best for: Multi-team, compliance-sensitive, production            ││
│  │  [Use Template]  [Preview JSON]                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Custom Templates ─────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  my-org-standard     Created Mar 15   Based on: Standard  [Use]    ││
│  │  compliance-strict   Created Mar 10   Based on: Full      [Use]    ││
│  │                                                                     ││
│  │  [+ Save Current Config as Template]                                ││
│  │  [Import Template from JSON]                                        ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Template JSON Structure

```json
{
  "templateId": "sharepoint-standard",
  "version": "1.0.0",
  "name": "SharePoint Standard",
  "connector": {
    "type": "sharepoint",
    "permissionStrategy": "Sites.Read.All",
    "authMethod": "device_code"
  },
  "scope": {
    "siteSelection": "all",
    "libraries": "all",
    "contentTypes": ["files", "pages"]
  },
  "filters": {
    "fileTypes": "sharepoint-defaults-27",
    "folderRules": [],
    "metadataConditions": [],
    "celExpression": null
  },
  "schedule": {
    "interval": "hourly",
    "webhooksEnabled": true,
    "autoPauseAfterFailures": 5
  },
  "permissions": {
    "mode": "disabled",
    "recrawlSchedule": null
  }
}
```

---

## 7. Configuration as Code (Issue #9)

### Export / Import

Every connector configuration can be exported as JSON or YAML. The export includes everything except secrets (tokens, client secrets).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Export Configuration                                                   │
│                                                                         │
│  Format: (●) JSON  ( ) YAML                                            │
│                                                                         │
│  Include:                                                               │
│  ☑ Scope (sites, libraries, content types)                              │
│  ☑ Filters (file types, folder rules, metadata conditions)             │
│  ☑ Schedule (sync interval, webhooks, auto-pause)                      │
│  ☑ Permissions (mode, recrawl schedule)                                │
│  ☑ Schema mappings (custom field mappings)                             │
│  ☐ Connection details (client ID, tenant ID — no secrets)              │
│                                                                         │
│  [Export]  [Copy to Clipboard]                                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Version History + Diff

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Version History                                                        │
│                                                                         │
│  ┌─────┬───────────────────┬──────────────────┬────────────┬─────────┐│
│  │ Ver │ Date              │ Changed By       │ Changes    │ Actions ││
│  ├─────┼───────────────────┼──────────────────┼────────────┼─────────┤│
│  │ v3  │ Mar 22, 2:15 PM   │ john@contoso.com │ +2 filters │ Current ││
│  │ v2  │ Mar 21, 10:00 AM  │ john@contoso.com │ +1 site    │ [Diff]  ││
│  │ v1  │ Mar 20, 3:00 PM   │ john@contoso.com │ Initial    │ [Diff]  ││
│  └─────┴───────────────────┴──────────────────┴────────────┴─────────┘│
│                                                                         │
│  ┌─ Diff: v2 → v3 ───────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  filters.folderRules:                                               ││
│  │  - []                                                               ││
│  │  + [{"type": "exclude", "pattern": "/Archive/**"}]                  ││
│  │  + [{"type": "exclude", "pattern": "/Backup/**"}]                   ││
│  │                                                                     ││
│  │  filters.metadataConditions:                                        ││
│  │  - []                                                               ││
│  │  + [{"field": "sizeBytes", "op": "lt", "value": 52428800}]         ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  [Rollback to v2]  [Export v2 JSON]                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Dry-Run Mode (Issue #6)

Yext-style: run the entire sync pipeline, store results in a staging area, let the user review before committing to the index.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Dry-Run Preview                                              [Close]  │
│                                                                         │
│  ┌─ Status ───────────────────────────────────────────────────────────┐│
│  │  ● Dry-run in progress...                                          ││
│  │  ████████████████░░░░  Phase: Extracting   156 / 237 docs          ││
│  │  Elapsed: 2m 15s   ETA: ~1m remaining                    [Cancel]  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  (After completion:)                                                    │
│                                                                         │
│  ┌─ Dry-Run Results ─────────────────────────────────────────────────┐ │
│  │                                                                     │ │
│  │  Pipeline: Source(252) → Filter(173) → Extract(168) → Chunk(168)  │ │
│  │            → Embed(168) → Ready to Index(168)                      │ │
│  │                                                                     │ │
│  │  ┌────────────┬─────────────────────────────────────────────┐      │ │
│  │  │  168       │  Documents ready to index                    │      │ │
│  │  │   5        │  Extraction failures (password, timeout)     │      │ │
│  │  │  52        │  Excluded by filters                         │      │ │
│  │  │  27        │  Unsupported file types                      │      │ │
│  │  │ ~4,200     │  Chunks generated                            │      │ │
│  │  │  1.2 GB    │  Total content processed                     │      │ │
│  │  │  ~$0.42    │  Estimated embedding cost                    │      │ │
│  │  └────────────┴─────────────────────────────────────────────┘      │ │
│  │                                                                     │ │
│  │  Browse results:                                                    │ │
│  │  [All Documents]  [Failures]  [Excluded]  [Chunks Preview]         │ │
│  │                                                                     │ │
│  │  ┌──────────────────────┬──────┬────────┬────────┬──────────┐      │ │
│  │  │ Document             │ Type │ Chunks │ Size   │ Status   │      │ │
│  │  ├──────────────────────┼──────┼────────┼────────┼──────────┤      │ │
│  │  │ Q4-Report.pdf        │ PDF  │ 24     │ 2.1 MB │ ✅ Ready │      │ │
│  │  │ Architecture.docx    │ DOCX │ 12     │ 450 KB │ ✅ Ready │      │ │
│  │  │ Budget.xlsb          │ XLSB │ —      │ 3.2 MB │ ❌ Timeout│     │ │
│  │  │ Secret-Report.pdf    │ PDF  │ —      │ 1.1 MB │ ❌ Locked │     │ │
│  │  └──────────────────────┴──────┴────────┴────────┴──────────┘      │ │
│  │                                                                     │ │
│  │  This dry-run expires in 6 days, 23 hours.                         │ │
│  │                                                                     │ │
│  │  [Abandon Dry-Run]           [Approve & Index →]                   │ │
│  │                                                                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Dry-Run Lifecycle

1. User clicks "Save & Dry-Run" from any tab
2. System runs full pipeline: enumerate, filter, download, extract, chunk, embed — but stores results in a staging collection (not the live index)
3. Results available for review for 7 days
4. User can browse every document, see chunks, check failures
5. "Approve & Index" promotes staging to live index
6. "Abandon" discards staging data
7. User can adjust filters and re-run without affecting live index

---

## 9. Multi-Connector Dashboard (Issue #17)

Full-page dashboard view showing all connectors in a matrix.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Connectors Dashboard                                                   │
│                                                                         │
│  [+ New Connector]  [Bulk Actions ▾]  [Import JSON]  [Refresh]         │
│                                                                         │
│  ┌─ Health Summary ───────────────────────────────────────────────────┐│
│  │  Total: 6 connectors   ● 4 Healthy  ⚠ 1 Warning  ❌ 1 Error      ││
│  │  Docs indexed: 1,247   Last sync: 5 min ago   API calls today: 3.2K││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌──────────────────┬────────┬───────────┬──────┬────────┬──────┬─────┐│
│  │ Connector        │ Status │ Last Sync │ Docs │ Failed │Token │Quota││
│  ├──────────────────┼────────┼───────────┼──────┼────────┼──────┼─────┤│
│  │☑ SP: Marketing   │ ● OK   │ 5 min ago │  237 │   4    │ 23d  │ 8%  ││
│  │☑ SP: Engineering │ ● OK   │ 12min ago │  412 │   2    │ 23d  │ 12% ││
│  │☐ SP: Sales       │ ⚠ Warn │ 2h ago    │  156 │  12    │ 3d   │ 45% ││
│  │☐ SP: Legal       │ ● OK   │ 1h ago    │  289 │   0    │ 15d  │ 5%  ││
│  │☐ SP: Executive   │ ❌ Err  │ Failed    │   43 │  43    │ Exp! │ 2%  ││
│  │☐ SP: HR Portal   │ ● OK   │ 30min ago │  110 │   1    │ 20d  │ 3%  ││
│  └──────────────────┴────────┴───────────┴──────┴────────┴──────┴─────┘│
│                                                                         │
│  Token: days until expiry. Quota: % of daily Graph API limit used.     │
│                                                                         │
│  Legend: ● Healthy  ⚠ >5 failures or token <7d  ❌ Auth expired/paused │
│                                                                         │
│  Selected: 2   [Bulk Sync Now]  [Bulk Re-auth]  [Bulk Export]          │
│                [Clone Selected]  [Delete Selected]                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Bulk Operations (Issue #9)

### Create from Template

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Bulk Create from Template                                              │
│                                                                         │
│  Template: [SharePoint Standard ▾]                                      │
│                                                                         │
│  Create connectors for:                                                 │
│  ┌──────────────────────────────────────────┐                           │
│  │ ☑ Marketing Hub         (Site ID: ...)   │                           │
│  │ ☑ Engineering Wiki      (Site ID: ...)   │                           │
│  │ ☑ Sales Team Site       (Site ID: ...)   │                           │
│  │ ☑ Legal Department      (Site ID: ...)   │                           │
│  │ ☐ Executive Comms       (Site ID: ...)   │                           │
│  └──────────────────────────────────────────┘                           │
│                                                                         │
│  Each selected site becomes a separate connector with:                  │
│  - Same filter config from template                                    │
│  - Same schedule and permission settings                                │
│  - Independent sync state and monitoring                                │
│                                                                         │
│  Naming: [Site Name - SharePoint ▾]                                     │
│  Auth: All connectors share the same OAuth token.                       │
│                                                                         │
│                              [Cancel]  [Create 4 Connectors]           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Clone Existing

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Clone Connector                                                        │
│                                                                         │
│  Source: SP: Marketing Hub (v3)                                         │
│                                                                         │
│  What to clone:                                                         │
│  ☑ Filter configuration                                                │
│  ☑ Schedule settings                                                   │
│  ☑ Permission settings                                                 │
│  ☑ Schema mappings                                                     │
│  ☐ Connection (re-authenticate for new clone)                          │
│                                                                         │
│  New name: ┌──────────────────────────────────────┐                     │
│            │ SP: Marketing Hub (Copy)              │                     │
│            └──────────────────────────────────────┘                     │
│                                                                         │
│                                         [Cancel]  [Clone]              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Batch Re-authenticate

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Batch Re-authenticate                                                  │
│                                                                         │
│  Selected connectors sharing the same app registration:                 │
│  • SP: Marketing Hub     Token expires: Apr 15                          │
│  • SP: Engineering Wiki  Token expires: Apr 15                          │
│  • SP: Sales Team Site   Token expires: Apr 15                          │
│                                                                         │
│  Re-authenticating updates the token for all 3 connectors.             │
│                                                                         │
│  Method: Device Code                                                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────┐                   │
│  │  Enter this code at microsoft.com/devicelogin:   │                   │
│  │                                                  │                   │
│  │          WXYZ-1234          [Copy Code]          │                   │
│  │                                                  │                   │
│  │  [Open Microsoft Login ->]                       │                   │
│  │  [Share Authentication Request]                  │                   │
│  │                                                  │                   │
│  │  Code expires in 13:42              ● Waiting... │                   │
│  └──────────────────────────────────────────────────┘                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 11. API Quota Dashboard (Issue #13)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  API Quota Dashboard                                                    │
│                                                                         │
│  ┌─ Graph API Usage (All Connectors) ─────────────────────────────────┐│
│  │                                                                     ││
│  │  Daily limit: 10,000 requests per app registration                  ││
│  │                                                                     ││
│  │  Today        ████████████░░░░░░░░   3,200 / 10,000   (32%)        ││
│  │  Yesterday    ██████████████████░░   7,800 / 10,000   (78%)        ││
│  │  2 days ago   ████████████████░░░░   6,100 / 10,000   (61%)        ││
│  │                                                                     ││
│  │  By connector:                                                      ││
│  │  Marketing    ████████░░░░░░░░░░░░   1,200                          ││
│  │  Engineering  ██████░░░░░░░░░░░░░░     800                          ││
│  │  Sales        ██████████░░░░░░░░░░     900                          ││
│  │  Other (3)    ██░░░░░░░░░░░░░░░░░░     300                          ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Throttling Events ────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  This week: 5 throttle events (HTTP 429)                            ││
│  │                                                                     ││
│  │  ┌───────────────────┬──────────────┬─────────┬───────────────────┐││
│  │  │ Time              │ Connector    │ Retry   │ Request           │││
│  │  ├───────────────────┼──────────────┼─────────┼───────────────────┤││
│  │  │ Mar 22, 3:45 PM   │ Marketing    │ 30s     │ GET /drive/items  │││
│  │  │ Mar 22, 3:44 PM   │ Marketing    │ 30s     │ GET /drive/items  │││
│  │  │ Mar 21, 10:12 AM  │ Engineering  │ 60s     │ GET /sites        │││
│  │  └───────────────────┴──────────────┴─────────┴───────────────────┘││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─ Registered Apps ──────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │  App: Marketing KB App (a1b2c3...)   Connectors: 4   Usage: 78%    ││
│  │  App: Sales KB App (d4e5f6...)       Connectors: 2   Usage: 22%    ││
│  │                                                                     ││
│  │  [+ Register Additional App]                                        ││
│  │  Distribute connectors across apps to increase total quota.         ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Schema Discovery (Issue #16)

Integrated into the Scope tab. Discovers SharePoint custom columns (site columns, content type fields) and makes them available for filtering and search facets.

### Discovery Flow

```
1. User clicks [Discover Custom Fields] on Scope tab
2. System enumerates content types and site columns for selected sites
3. Presents discovered fields with type, frequency, and sample values
4. User maps fields to metadata keys
5. Mapped fields appear in Filters tab condition builder
6. Mapped fields stored in connector config and synced with documents
```

### Field Mapping Detail

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Map Custom Field: Department                                           │
│                                                                         │
│  SharePoint field: Department (internal: Department0)                   │
│  Type: Choice                                                           │
│  Found in: Marketing Hub, Engineering Wiki, Sales Team                  │
│  Sample values: "Marketing", "Engineering", "Sales", "Legal", "HR"     │
│                                                                         │
│  Map to metadata key:                                                   │
│  ┌────────────────────────────────────────────────────────┐             │
│  │ metadata.sharepoint.department                         │             │
│  └────────────────────────────────────────────────────────┘             │
│                                                                         │
│  ☑ Make available as filter field                                       │
│  ☑ Include in search facets                                            │
│  ☐ Use as document tag                                                 │
│                                                                         │
│                                            [Cancel]  [Save Mapping]    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Error States — Comprehensive Error Catalog (Issue #4)

### Error Categories and Wireframes

#### Authentication Errors

```
┌─ Error: Token Expired ────────────────────────────────────────────────┐
│                                                                        │
│  ❌ Authentication Failed                                              │
│                                                                        │
│  Your OAuth token has expired and could not be automatically           │
│  refreshed. This usually means the refresh token has also expired      │
│  (90-day Microsoft default).                                           │
│                                                                        │
│  Impact: All syncs are paused. No new content will be indexed.         │
│                                                                        │
│  Resolution:                                                           │
│  1. Click [Re-authenticate] to get a new token                         │
│  2. If someone else authenticated, share the device code with them     │
│                                                                        │
│  [Re-authenticate]  [Share Device Code]                                │
│                                                                        │
│  Error details:                                                        │
│  Code: OAUTH_REFRESH_FAILED                                            │
│  Message: "AADSTS700082: The refresh token has expired due to          │
│  inactivity. The token was issued on 2025-12-22."                      │
│  Time: Mar 22, 2026, 2:15 PM                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### Permission Errors

```
┌─ Error: Insufficient Permissions ─────────────────────────────────────┐
│                                                                        │
│  ⚠️ Permission Denied for Site: Executive Comms                        │
│                                                                        │
│  Your app does not have access to this site. With Sites.Selected,      │
│  each site must be explicitly granted.                                  │
│                                                                        │
│  Resolution:                                                           │
│  An Azure AD admin must grant access via Graph API:                    │
│  POST /sites/{siteId}/permissions                                      │
│  { "roles": ["read"], "grantedToIdentities": [{"application":         │
│    {"id": "{clientId}"}}] }                                            │
│                                                                        │
│  [Copy Graph API Call]  [Open Graph Explorer ->]                       │
│  [Remove Site from Scope]                                              │
│                                                                        │
│  Code: GRAPH_403_SITE_ACCESS_DENIED                                    │
│  Site ID: sites/contoso.sharepoint.com:/sites/executive                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### Sync Errors

```
┌─ Error: Sync Failed ──────────────────────────────────────────────────┐
│                                                                        │
│  ❌ Full Sync Failed (attempt 3 of 5)                                  │
│                                                                        │
│  The sync failed due to a Graph API error. The system will retry       │
│  automatically. After 5 consecutive failures, sync will be paused.     │
│                                                                        │
│  Error: HTTP 503 — Service Unavailable                                 │
│  "The service is temporarily unavailable. Please retry."               │
│                                                                        │
│  Consecutive failures: 3                                               │
│  Auto-pause threshold: 5                                               │
│  Next retry: in 5 minutes (exponential backoff)                        │
│                                                                        │
│  [Retry Now]  [Pause Sync]  [View Sync Logs]                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### Discovery Errors

```
┌─ Error: Discovery Timeout ────────────────────────────────────────────┐
│                                                                        │
│  ⚠️ Discovery timed out after 5 minutes                                │
│                                                                        │
│  Your tenant has a large number of sites. Discovery found 847          │
│  sites before timing out. You can:                                     │
│                                                                        │
│  ( ) Use the 847 sites found so far                                    │
│  ( ) Retry with a longer timeout (15 minutes)                          │
│  ( ) Enter site URLs manually instead of discovering                   │
│                                                                        │
│  [Continue with Partial Results]  [Retry Discovery]                    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Complete Error Catalog

| Code                           | Category   | Severity | User Message                    | Resolution                   |
| ------------------------------ | ---------- | -------- | ------------------------------- | ---------------------------- |
| `OAUTH_REFRESH_FAILED`         | Auth       | Critical | Token expired, refresh failed   | Re-authenticate              |
| `OAUTH_CONSENT_REQUIRED`       | Auth       | Critical | Admin consent not granted       | Share admin consent URL      |
| `OAUTH_DEVICE_CODE_EXPIRED`    | Auth       | High     | Device code expired (15 min)    | Restart auth flow            |
| `GRAPH_401_UNAUTHORIZED`       | Auth       | Critical | Token invalid or revoked        | Re-authenticate              |
| `GRAPH_403_SITE_ACCESS_DENIED` | Permission | High     | No access to specific site      | Grant via Graph API          |
| `GRAPH_403_INSUFFICIENT_SCOPE` | Permission | High     | Missing required permission     | Add permission + reconsent   |
| `GRAPH_429_THROTTLED`          | Quota      | Medium   | Rate limited by Graph API       | Auto-retry with backoff      |
| `GRAPH_503_UNAVAILABLE`        | Transient  | Medium   | SharePoint temporarily down     | Auto-retry                   |
| `GRAPH_504_TIMEOUT`            | Transient  | Medium   | Graph API timeout               | Auto-retry                   |
| `DISCOVERY_TIMEOUT`            | Discovery  | Medium   | Too many sites, timed out       | Use partial or retry         |
| `SYNC_LOCK_CONFLICT`           | Sync       | Low      | Another sync already running    | Wait or cancel other         |
| `SYNC_CONSECUTIVE_FAILURES`    | Sync       | High     | 5+ failures, auto-paused        | Investigate + resume         |
| `EXTRACTION_TIMEOUT`           | Content    | Low      | File took >120s to process      | Retry or exclude             |
| `EXTRACTION_PASSWORD`          | Content    | Low      | File is password-protected      | Remove password or exclude   |
| `EXTRACTION_CORRUPT`           | Content    | Low      | File is corrupted               | Re-upload at source          |
| `WEBHOOK_SUBSCRIPTION_FAILED`  | Webhook    | Medium   | Could not create subscription   | Check endpoint accessibility |
| `WEBHOOK_RENEWAL_FAILED`       | Webhook    | Medium   | Subscription renewal failed     | Falls back to scheduled sync |
| `CONFIG_IMPORT_INVALID`        | Config     | Medium   | Imported JSON is malformed      | Fix JSON and retry           |
| `CONFIG_VERSION_CONFLICT`      | Config     | Low      | Config modified by another user | Merge or overwrite           |
| `DRYRUN_EXPIRED`               | Dry-run    | Low      | 7-day window expired            | Re-run dry-run               |

---

## 14. Empty States (Issue #18)

### No Connectors Yet

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Connectors Dashboard                                                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │             No enterprise connectors configured                   │   │
│  │                                                                   │   │
│  │  Connect SharePoint, Jira, Confluence, or other enterprise        │   │
│  │  data sources to automatically sync content into this             │   │
│  │  knowledge base.                                                  │   │
│  │                                                                   │   │
│  │  [+ New Connector]  [Import from JSON]                            │   │
│  │                                                                   │   │
│  │  Or start from a template:                                        │   │
│  │  [SharePoint Standard]  [SharePoint Minimal]  [SharePoint Full]   │   │
│  │                                                                   │   │
│  │  Prerequisites:                                                   │   │
│  │  • Azure App Registration with Client ID and Tenant ID            │   │
│  │  • API permissions granted (Sites.Read.All or Sites.Selected)     │   │
│  │  • Admin consent from Azure AD Global Administrator               │   │
│  │  [View Setup Guide ->]                                            │   │
│  │                                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### No Sites Discovered

```
┌─ Scope Tab ───────────────────────────────────────────────────────────┐
│                                                                        │
│  No sites discovered                                                   │
│                                                                        │
│  This can happen if:                                                   │
│  • Your app registration has Sites.Selected but no sites are granted  │
│  • Your token does not have site read permissions                      │
│  • Your tenant has no SharePoint sites                                 │
│                                                                        │
│  For Sites.Selected: Ask an Azure AD admin to grant per-site access.  │
│  [How to grant site access ->]                                         │
│                                                                        │
│  Or switch to Sites.Read.All for broader access.                       │
│  [Change Permission Strategy]                                          │
│                                                                        │
│  [Retry Discovery]                                                     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### No Sync History

```
┌─ Schedule Tab — Sync History ─────────────────────────────────────────┐
│                                                                        │
│  No syncs yet                                                          │
│                                                                        │
│  This connector has not run a sync. Configure your scope and           │
│  filters, then run a dry-run or start your first sync.                │
│                                                                        │
│  [Run Dry-Run]  [Start First Sync]                                     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### No Custom Fields Found

```
┌─ Schema Discovery ────────────────────────────────────────────────────┐
│                                                                        │
│  No custom columns found                                               │
│                                                                        │
│  The selected sites use only default SharePoint columns. Custom        │
│  site columns and content type fields will appear here when present.  │
│                                                                        │
│  You can still filter on standard fields (name, size, date,            │
│  contentType, author) in the Filters tab.                              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 15. Loading States (Issue #19)

### Discovery Loading (with streaming and cancel)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Discovering sites...                                                   │
│                                                                         │
│  ████████████░░░░░░░░  Loading sites 47 of ~200                        │
│  Elapsed: 45s                                              [Cancel]    │
│                                                                         │
│  Sites found so far (streaming in):                                     │
│  ┌──────────────────┬───────┬────────┐                                 │
│  │ Marketing Hub    │  42   │ 3.2 GB │  (details loading...)           │
│  │ Engineering Wiki │ 128   │ 1.1 GB │                                 │
│  │ Sales Team Site  │  --   │ --     │  Profiling...                   │
│  │ Legal Dept       │  --   │ --     │  Queued                         │
│  │ ... 43 more loading                                                 │
│  └──────────────────┴───────┴────────┘                                 │
│                                                                         │
│  Sites appear as they are discovered. You can select sites before      │
│  discovery completes.                                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Sync Loading

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sync in progress...                                                    │
│                                                                         │
│  ████████████████░░░░  Phase: Downloading   156 / 237 files            │
│  Elapsed: 2m 15s   Rate: ~52 docs/min   ETA: ~1m 30s                  │
│                                                                         │
│  Current: Architecture-v3.pdf (2.1 MB)               [Cancel Sync]    │
│                                                                         │
│  By site:                                                               │
│  Marketing Hub     ████████████████████  42/42   ✅ Done               │
│  Engineering Wiki  ████████████████░░░░  98/128  Downloading...        │
│  Sales Team Site   ░░░░░░░░░░░░░░░░░░░░   0/67   Queued               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Connection Diagnostic Loading

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Running diagnostics...                                                 │
│                                                                         │
│  ✅ Azure AD token valid                                (200ms)        │
│  ✅ Graph API reachable                                 (45ms)         │
│  ● Checking permissions...                                              │
│  ○ Webhook endpoint check                                               │
│  ○ Token refresh test                                                   │
│                                                                         │
│                                                          [Cancel]      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 16. Multi-Tenant Support (Issue #20)

```
Tenant (Azure AD) ──> App Registrations ──> Connectors ──> Projects

┌─────────────────────────────────────────────────────────────────────────┐
│  Tenant: contoso.onmicrosoft.com                                        │
│                                                                         │
│  App Registrations:                                                     │
│  ┌───────────────────────┬──────────────┬──────────────┬──────────┐   │
│  │ App                   │ Connectors   │ Quota Used   │ Status   │   │
│  ├───────────────────────┼──────────────┼──────────────┼──────────┤   │
│  │ Marketing KB App      │ 4 connectors │ 78% daily    │ ● OK     │   │
│  │ Sales KB App          │ 2 connectors │ 22% daily    │ ● OK     │   │
│  │ HR Portal App         │ 1 connector  │ 5% daily     │ ● OK     │   │
│  └───────────────────────┴──────────────┴──────────────┴──────────┘   │
│                                                                         │
│  A connector belongs to exactly one project (knowledge base).           │
│  Multiple connectors can share the same app registration and token.    │
│  Quota is tracked per app registration, not per connector.              │
│                                                                         │
│  Cross-tenant: Each tenant has independent app registrations.           │
│  A project can have connectors from multiple tenants.                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 17. Competitive Positioning (Issue #12)

| Capability                | Glean         | Coveo          | Elastic             | Microsoft Copilot  | **Design C (Ours)**                   |
| ------------------------- | ------------- | -------------- | ------------------- | ------------------ | ------------------------------------- |
| Setup complexity          | Low (managed) | Medium (4-tab) | High (config-heavy) | Low (admin center) | Medium (templates reduce to low)      |
| Permission model          | Managed       | Manual         | Manual              | Managed            | **Sites.Selected first-class**        |
| Filter power              | Low           | High           | High (CEL)          | Low                | **High (pipeline view + CEL)**        |
| Dry-run preview           | No            | No             | No                  | No                 | **Yes (full Yext-style)**             |
| Config as code            | No            | Partial (API)  | Yes                 | No                 | **Yes (JSON/YAML + version history)** |
| Bulk operations           | No            | Partial        | Yes (API)           | No                 | **Yes (template + clone + batch)**    |
| Multi-connector dashboard | No            | Yes            | Yes                 | Partial            | **Yes (health matrix)**               |
| API quota visibility      | No            | No             | No                  | No                 | **Yes (per-connector + aggregate)**   |
| Schema discovery          | No            | Yes            | Yes                 | Managed            | **Yes (custom field mapping)**        |
| Webhook real-time         | Managed       | Yes            | Yes                 | Managed            | **Yes (with fallback)**               |
| Error transparency        | Low           | Medium         | High                | Low                | **High (full error catalog)**         |
| Version history           | No            | No             | Partial             | No                 | **Yes (diff + rollback)**             |

**Honest assessment:** Glean and Microsoft win on zero-config managed setup. Coveo has the most mature enterprise connector UI. We differentiate on: dry-run, config-as-code, API quota visibility, and Sites.Selected as a first-class citizen. We are NOT trying to be Glean (fully managed) — we are the tool for teams that want full control.

---

## 18. Backend Requirements

### New API Endpoints

| #   | Endpoint                                      | Purpose                                                             | Effort |
| --- | --------------------------------------------- | ------------------------------------------------------------------- | ------ |
| 1   | `POST /connectors/:id/validate-prerequisites` | Validate app registration, permissions, admin consent               | M      |
| 2   | `POST /connectors/:id/diagnose`               | Run full connection diagnostic (token, Graph, permissions, webhook) | M      |
| 3   | `GET /connectors/:id/versions`                | List config version history                                         | S      |
| 4   | `GET /connectors/:id/versions/:v/diff`        | Diff two config versions                                            | S      |
| 5   | `POST /connectors/:id/versions/:v/rollback`   | Rollback to a previous version                                      | S      |
| 6   | `POST /connectors/:id/export`                 | Export config as JSON/YAML                                          | S      |
| 7   | `POST /connectors/import`                     | Import config from JSON/YAML                                        | M      |
| 8   | `POST /connectors/:id/dry-run`                | Start dry-run (staging sync)                                        | L      |
| 9   | `GET /connectors/:id/dry-run/status`          | Get dry-run status and results                                      | S      |
| 10  | `POST /connectors/:id/dry-run/approve`        | Promote staging to live index                                       | M      |
| 11  | `POST /connectors/:id/dry-run/abandon`        | Discard staging data                                                | S      |
| 12  | `GET /connectors/:id/documents/stats`         | Aggregate by status, type, site, size                               | S      |
| 13  | `GET /connectors/:id/schema/discover`         | Discover custom SharePoint columns                                  | M      |
| 14  | `POST /connectors/:id/schema/mappings`        | Save custom field mappings                                          | S      |
| 15  | `GET /connectors/:id/quota`                   | Get API usage stats and throttling events                           | M      |
| 16  | `GET /connectors/dashboard`                   | Multi-connector health matrix                                       | S      |
| 17  | `POST /connectors/bulk/create`                | Bulk create from template                                           | M      |
| 18  | `POST /connectors/:id/clone`                  | Clone connector config                                              | S      |
| 19  | `POST /connectors/bulk/sync`                  | Trigger sync for multiple connectors                                | S      |
| 20  | `POST /connectors/bulk/reauth`                | Batch re-authenticate shared token                                  | S      |
| 21  | `GET /connectors/templates`                   | List available templates (built-in + custom)                        | S      |
| 22  | `POST /connectors/templates`                  | Save custom template                                                | S      |
| 23  | `POST /connectors/:id/admin-consent/url`      | Generate admin consent URL                                          | XS     |
| 24  | `POST /connectors/:id/admin-consent/verify`   | Verify admin consent status                                         | S      |

### New Models

| Model                    | Purpose               | Fields                                                                                      |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `ConnectorConfigVersion` | Version history       | `connectorId, version, config, changedBy, changedAt, changeDescription`                     |
| `SyncRun`                | Sync history          | `connectorId, type, startedAt, completedAt, durationMs, docsProcessed, docsFailed, status`  |
| `DryRunResult`           | Staging sync results  | `connectorId, status, startedAt, expiresAt, results, stagingCollectionId`                   |
| `ConnectorTemplate`      | Custom templates      | `tenantId, name, config, basedOn, createdBy, createdAt`                                     |
| `ApiQuotaLog`            | API usage tracking    | `connectorId, appId, date, requestCount, throttleCount, requests[]`                         |
| `SchemaMapping`          | Custom field mappings | `connectorId, sharepointField, metadataKey, fieldType, enabledForFilters, enabledForFacets` |

### Existing Backend to Wire Up

| #   | What                        | Current State                       | Work                           |
| --- | --------------------------- | ----------------------------------- | ------------------------------ |
| 1   | `startScheduledJobs()`      | Never called                        | Add call in `server.ts`        |
| 2   | Delta sync scheduler        | Stub (only updates timestamp)       | Enqueue real sync job          |
| 3   | Webhook routes              | Dead code (not mounted)             | Mount in `server.ts`           |
| 4   | Webhook notification worker | Dead code (not started)             | Add to `startWorkers()`        |
| 5   | Webhook renewal             | Uses mock token                     | Replace with real token lookup |
| 6   | Auto-pause on failures      | Field exists, no logic              | Add threshold check            |
| 7   | Filter preview API          | Exists, no UI                       | Wire to Filter tab dry-run     |
| 8   | Permission recrawl API      | Exists, no UI                       | Wire to Permissions tab        |
| 9   | `SyncProgressPublisher`     | Exists, connector sync does not use | Publish from sync worker       |

---

## 19. Issues Addressed — Complete Checklist

| #   | Issue                                          | Severity | How Addressed                                                                                                                              |
| --- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | No Azure App Registration guidance             | CRITICAL | Prerequisites checklist with automated validation, step-by-step instructions, "Validate App Registration" button                           |
| 2   | Device code != admin consent                   | CRITICAL | Modeled as separate explicit steps in prerequisites. Admin consent has its own URL generator, verification button, and shareable link      |
| 3   | Sites.FullControl.All mitigation misleading    | CRITICAL | Sites.Selected is the PRIMARY recommended option. Sites.Read.All is secondary. FullControl only mentioned for permission sync mode         |
| 4   | Error states completely unspecified            | CRITICAL | Full error catalog (19 error codes) with wireframes for auth, permission, sync, discovery, config, and dry-run errors                      |
| 5   | Discovery timeout for 1000+ sites              | CRITICAL | Streaming discovery with pagination (50 per page), cancel button, partial results option, timeout recovery UX                              |
| 6   | No dry-run/preview before sync                 | CRITICAL | Full Yext-style dry-run: staging pipeline, 7-day review window, approve/abandon, browsable results with chunk preview                      |
| 7   | Sites.Selected not supported                   | CRITICAL | First-class support: permission strategy selection in prerequisites, per-site grant tracking in Permissions tab, Graph API call generator  |
| 8   | This design uses tabs, not a proposal metaphor | HIGH     | Explicitly tab-based: 6 tabs (Connection, Scope, Filters, Schedule, Permissions, Advanced) on a full-page view                             |
| 9   | Bulk/clone/template for multi-connector        | HIGH     | 3 templates, custom template save, clone existing, bulk create from template, JSON import/export, batch re-auth                            |
| 10  | Filter dry-run with sample data                | HIGH     | Filter dry-run in Filters tab shows matching/excluded docs with reasons. Full dry-run in staging pipeline mode                             |
| 11  | Security doc = full data flow diagram          | HIGH     | Security Data Flow section in Permissions tab: data flow diagram, retention policy, revocation controls, downloadable security document    |
| 12  | Honest competitive positioning                 | HIGH     | Competitive matrix with honest assessment. We win on control/transparency, not on zero-config managed setup                                |
| 13  | Graph API throttling                           | HIGH     | API Quota Dashboard: per-connector usage bars, throttle event log, multi-app support, estimated monthly usage                              |
| 14  | Filter evaluation as pipeline stages           | HIGH     | Pipeline view at top of Filters tab: Source -> Scope -> File Type -> Folder -> Metadata -> Index with document count at each stage         |
| 15  | Connection validation = diagnostic tool        | HIGH     | Full diagnostic tool in Connection tab: 7-point check (token, Graph, permissions, sites, webhooks, refresh, latency)                       |
| 16  | Custom SharePoint metadata                     | HIGH     | Schema Discovery in Scope tab: discovers custom columns, type-aware mapping, fields feed into Filters condition builder                    |
| 17  | Multi-connector dashboard                      | HIGH     | Health matrix: rows = connectors, columns = status, last sync, docs, failures, token health, API quota. Bulk actions on selection          |
| 18  | Empty states with actionable guidance          | HIGH     | 4 empty state wireframes: no connectors, no sites, no sync history, no custom fields. Each with specific actions and explanations          |
| 19  | Loading states with progress + cancel          | HIGH     | 3 loading state wireframes: discovery (streaming + cancel), sync (per-site progress + cancel), diagnostics (step-by-step). All cancellable |
| 20  | Multi-tenant as first-class concept            | HIGH     | Tenant -> App Registration -> Connector -> Project hierarchy. Cross-tenant support. Quota tracked per app registration                     |
| 21  | Full-page connector management, not dialogs    | HIGH     | All connector management is full-page with tabs. No dialogs for configuration. Only modals for confirmations (delete, rollback)            |

---

## 20. Design C Summary

**What makes this design different from Design B (Smart Proposal):**

- Design B is **one scrollable proposal** — the system does the thinking, you review
- Design C is **6 organized tabs** — you have full control over every aspect

**Who this is for:** Platform teams managing 5-50 SharePoint connectors across multiple tenants. Teams that version-control their configuration. Teams that want dry-runs before production changes. Teams that need API quota visibility.

**What this is NOT:** This is not a zero-config managed experience. If you want "connect and forget", use Glean. If you want "full control with power tools", this is your design.

**Implementation priority:**

1. Prerequisites + Connection tab (unblocks everything)
2. Scope + Filters tabs (core configuration)
3. Schedule tab + wire existing backend (scheduler, webhooks)
4. Multi-connector dashboard (management at scale)
5. Dry-run mode (highest differentiator, most backend work)
6. Config as code + version history (power user features)
7. Schema discovery (advanced feature)
8. API quota dashboard (operational visibility)
9. Bulk operations (scale management)
10. Templates (accelerated setup)
