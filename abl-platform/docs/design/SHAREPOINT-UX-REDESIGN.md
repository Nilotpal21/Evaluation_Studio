# SharePoint Connector UX Redesign — Design Specification

**Date:** 2026-03-22
**Version:** 2.0 — Revised with "Smart Proposal" philosophy
**Context:** Deep-dive (11 agents, 4 review rounds) + capability heat map (32 questions) + market research (Glean, Coveo, Elastic, Microsoft) + filter system analysis (14 operators, 8 templates, OData translation, folder globs, advanced conditions)

---

## Core Philosophy: Smart Proposal

The system is intelligent AND transparent — at the same time.

It **auto-detects** everything it can (permissions, sites, content types, sizes, recommended filters), then **presents a configuration proposal** — a readable document the user reviews, adjusts, and approves. Like reviewing a PR, not filling out a form.

```
NOT this:  Step 1 → Step 2 → Step 3 → Step 4 → Step 5  (wizard)
NOT this:  ✅ Connected! We'll handle the rest.           (black box)

THIS:      "Here's what I found and what I recommend.
            Review, adjust, approve."                     (smart proposal)
```

**Why this beats every competitor:**

- Glean/Elastic: Static forms. User configures everything manually.
- Coveo: 4-tab panel with dozens of options. Powerful but user does the work.
- Microsoft: Admin center. IT-oriented, not user-oriented.
- **Us: The system does the thinking, shows its work, user reviews.**

---

## Design Principles

1. **Smart AND Transparent** — Auto-configure, but show the proposal. Never hide what's happening.
2. **Permission-Aware** — Detect what permissions exist, adapt the proposal, explain what's possible and what's not.
3. **Integrated** — SharePoint is a source in the Data tab, not a separate universe.
4. **Progressive Power** — Simple proposal by default. Advanced rules (CEL, folder globs, metadata conditions) available for users who need them.
5. **Separation of Duties** — App developer configures, security team authenticates. The system supports this natively.

---

## The Flow: Connect → Propose → Review → Monitor

### Phase 1: CONNECT (inline in Add Source dialog)

User clicks "Add Source" → selects SharePoint → inline connection panel.

```
┌─────────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint                                 [X]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Azure App Registration                                         │
│  ┌────────────────────────────────────┐                         │
│  │ Client ID                          │  ℹ️                     │
│  └────────────────────────────────────┘                         │
│  ┌────────────────────────────────────┐                         │
│  │ Tenant ID (Directory ID)           │  ℹ️                     │
│  └────────────────────────────────────┘                         │
│                                                                 │
│  Authentication method                                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ (●) Device Code                                          │  │
│  │     Share a code with whoever needs to authenticate      │  │
│  │                                                          │  │
│  │ ( ) Browser Login                                        │  │
│  │     Sign in with your Microsoft account now              │  │
│  │                                                          │  │
│  │ ( ) App-Only (Client Credentials)                        │  │
│  │     Automated setup with client secret                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▸ What permissions does our app need? (expandable)             │
│    Shows required Azure AD permissions based on auth method     │
│                                                                 │
│                                          [Cancel]  [Connect →]  │
└─────────────────────────────────────────────────────────────────┘
```

**On Connect →**: Creates connector, initiates OAuth, shows auth status inline.

**Device Code (delegated auth first-class):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Authenticate with Microsoft                                    │
│                                                                 │
│  Enter this code at microsoft.com/devicelogin:                  │
│                                                                 │
│         ┌──────────────┐                                        │
│         │  ABCD-EFGH   │   [📋 Copy Code]                      │
│         └──────────────┘                                        │
│                                                                 │
│  [Open Microsoft Login ↗]                                       │
│                                                                 │
│  ─── Need someone else to do this? ───                          │
│                                                                 │
│  [📤 Share Authentication Request]                              │
│  Copies: "Please authenticate our SharePoint connector.         │
│   Go to microsoft.com/devicelogin and enter code ABCD-EFGH.    │
│   This code expires in 14 minutes."                             │
│                                                                 │
│  ⏱️ Code expires in 13:42                          ● Waiting... │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**On auth success → system immediately starts discovery + permission probing in background → transitions to Phase 2.**

---

### Phase 2: PROPOSE (the smart proposal)

This is the heart of the redesign. After auth, the system:

1. Probes the token to detect granted permissions
2. Discovers sites, drives, content profiles
3. Generates a complete **Configuration Proposal**

The user sees a **loading state** while this happens (~30-60 seconds):

```
┌─────────────────────────────────────────────────────────────────┐
│  Analyzing your SharePoint environment...                       │
│                                                                 │
│  ✅ Permissions detected                                        │
│  ✅ 5 sites discovered                                          │
│  ████████████░░░░░░  Profiling content...  3 of 5 sites         │
│  ░░░░░░░░░░░░░░░░░  Generating recommendations...              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Then the **Configuration Proposal** appears — a single reviewable document:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Configuration Proposal                                      [X]   │
│  Review and adjust before syncing                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ ┌─ 🔐 Permissions & Capabilities ────────────────────────────────┐ │
│ │                                                                 │ │
│ │  Your app has: Sites.Read.All, offline_access                   │ │
│ │                                                                 │ │
│ │  ✅ Read & sync documents         Available                     │ │
│ │  ✅ Discover sites & drives        Available                     │ │
│ │  ✅ Delta sync (incremental)       Available                     │ │
│ │  ✅ Webhook notifications          Available                     │ │
│ │  ⬚ Permission-based search        Needs Sites.FullControl.All  │ │
│ │  ⬚ Group membership resolution    Needs Directory.Read.All     │ │
│ │                                                                 │ │
│ │  You can sync content now. To enable permission-based search:   │ │
│ │  [📄 Download Permission Request Document]                      │ │
│ │                                                                 │ │
│ │  Or enable later from the source settings.                      │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ 📂 What to Sync ──────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  Sites    (●) All 5 sites  ( ) Selected  ( ) Exclude specific  │ │
│ │                                                                 │ │
│ │  ┌─────────────────────────────────────────────────────────┐   │ │
│ │  │  Site                    Files   Size    Updated   Rec  │   │ │
│ │  │  ☑ Marketing Hub          42    3.2 GB   2 days   ⭐   │   │ │
│ │  │  ☑ Engineering Wiki      128    1.1 GB   today    ⭐   │   │ │
│ │  │  ☑ Sales Team Site        67    5.4 GB   1 week   ⭐   │   │ │
│ │  │  ☑ Executive Comms        12    0.2 GB   3 months      │   │ │
│ │  │  ☑ IT Infrastructure       3    0.1 GB   6 months      │   │ │
│ │  └─────────────────────────────────────────────────────────┘   │ │
│ │  ⭐ Recommended: active content with rich document types       │ │
│ │                                                                 │ │
│ │  Libraries  (●) All libraries  ( ) Selected  ( ) Exclude       │ │
│ │                                                                 │ │
│ │  Content types  ☑ Files  ☑ SharePoint Pages                    │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ 📄 File Types ────────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  Using: SharePoint defaults (27 types)        [Customize ✏️]    │ │
│ │                                                                 │ │
│ │  Documents  pdf docx pptx xlsx odt rtf                         │ │
│ │  Text       txt csv tsv md html xml json yaml                  │ │
│ │  Email      eml msg                                            │ │
│ │  Other      sql log rst                                        │ │
│ │                                                                 │ │
│ │  ℹ️ 27 types included · Executables always blocked             │ │
│ │                                                                 │ │
│ │  Your content: 60% PDF, 25% DOCX, 10% PPTX, 5% other         │ │
│ │  Unsupported in your data: 3 .vsdx, 2 .mp4 (will be skipped) │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ 📁 Folder Rules ─────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  Using: No folder restrictions (sync everything)  [Add rules]  │ │
│ │                                                                 │ │
│ │  Quick templates:                                               │ │
│ │  [Exclude Archives]  [Exclude Backup folders]                  │ │
│ │                                                                 │ │
│ │  Or add custom paths:                                           │ │
│ │  Include: /Projects/2024/**    Exclude: /Archive/**            │ │
│ │  Supports: * (segment) ** (recursive) ? (single char)          │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ ⚡ Advanced Rules ────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  No advanced rules configured                     [Add rule]   │ │
│ │                                                                 │ │
│ │  Build conditions on any document field:                        │ │
│ │  ┌─────────────────────────────────────────────────────────┐   │ │
│ │  │ [Field ▾]  [Operator ▾]  [Value          ]  [+ Add]    │   │ │
│ │  └─────────────────────────────────────────────────────────┘   │ │
│ │                                                                 │ │
│ │  Fields: name, contentType, sizeBytes, modifiedAt, createdAt,  │ │
│ │  metadata.sharepoint.createdBy, metadata.sharepoint.author,    │ │
│ │  metadata.sharepoint.lastModifiedBy                            │ │
│ │                                                                 │ │
│ │  Operators: equals, not equals, contains, starts with,         │ │
│ │  ends with, greater than, less than, in list, exists, regex    │ │
│ │                                                                 │ │
│ │  Combine with AND/OR logic and grouping.                       │ │
│ │                                                                 │ │
│ │  ▸ CEL expression (power users)                                │ │
│ │    Write custom filter expressions using Common Expression     │ │
│ │    Language for complex metadata-based rules.                   │ │
│ │    Example: metadata.sharepoint.sensitivity != "confidential"  │ │
│ │             && sizeBytes < 50000000                            │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ 🔄 Sync Schedule ────────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  (●) Every hour    ( ) Every 6 hours    ( ) Daily              │ │
│ │  ( ) Manual only                                                │ │
│ │                                                                 │ │
│ │  Recommended: Every hour (your content updates daily)           │ │
│ │                                                                 │ │
│ │  ▸ Real-time updates via webhooks                              │ │
│ │    ☑ Enable webhook notifications                               │ │
│ │    SharePoint will notify us when content changes.              │ │
│ │    Requires: App registration allows subscription creation.     │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ 🔒 Permission Sync ──────────────────────────────────────────┐ │
│ │                                                                 │ │
│ │  ⚠️ Not available with current permissions                     │ │
│ │                                                                 │ │
│ │  Permission sync ensures search results respect SharePoint      │ │
│ │  access controls. Users only see documents they have access to. │ │
│ │                                                                 │ │
│ │  To enable, your Azure app needs:                               │ │
│ │  • Sites.FullControl.All (for item permissions)                │ │
│ │  • Directory.Read.All (for group membership — optional)        │ │
│ │                                                                 │ │
│ │  ( ) Skip for now — all synced content will be searchable       │ │
│ │      by all users in this knowledge base                        │ │
│ │  ( ) I'll add permissions and re-authenticate later             │ │
│ │  ( ) Download permission request for security review            │ │
│ │                                                                 │ │
│ │  [📄 Download Security Review Document]                         │ │
│ │  Includes: required permissions, justification, risk assessment │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌──────────────────────────────────────────────────────────────────┐│
│ │  📋 Proposal Summary                                            ││
│ │                                                                  ││
│ │  5 sites · 252 files · ~10.0 GB                                 ││
│ │  27 file types · No folder restrictions · No advanced rules     ││
│ │  Sync: Every hour · Webhooks: Enabled                           ││
│ │  Permissions: Skipped (all content searchable by KB users)      ││
│ │                                                                  ││
│ │  Estimated first sync: ~5 minutes                               ││
│ │  Estimated API calls/month: ~2,400                              ││
│ └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│                               [Cancel]  [✅ Approve & Start Sync]  │
└─────────────────────────────────────────────────────────────────────┘
```

### What Makes This a "Smart Proposal"

1. **Permissions section adapts to what you actually have** — It probes the token, shows green checkmarks for available features, warns about unavailable ones, and offers 3 clear paths: skip, upgrade later, or download security review doc.

2. **File types show YOUR actual content** — "60% PDF, 25% DOCX" comes from discovery profiling. "3 .vsdx will be skipped" warns about unsupported files in YOUR data, not abstract documentation.

3. **Recommendations are contextual** — "Recommended: Every hour (your content updates daily)" is based on discovery's `updateFrequency` analysis, not a generic default.

4. **Folder rules start simple, go deep** — Quick templates ("Exclude Archives") for 90% of users. Glob patterns (`/Projects/2024/**`) for power users. Always visible what's being included/excluded.

5. **Advanced rules are available but not pushed** — Condition builder + CEL for users who need metadata-based filtering. Hidden until clicked. No one is forced to see this complexity.

6. **Summary is always visible** — Bottom bar shows the complete proposal in one line. Updates live as user toggles anything.

7. **Security Review Document** — Downloadable PDF/doc that the developer can give to their security team. Contains: required permissions, why each is needed, what data will be accessed, risk assessment. This solves the "take it to security team" scenario.

---

### The Three Permission Scenarios (Your Examples)

**Scenario 1: "I need more permissions, let me get security approval"**

```
User connects with Sites.Read.All
  → Proposal shows: ⚠️ Permission sync not available
  → User clicks [📄 Download Security Review Document]
  → Document generated:

    ┌─────────────────────────────────────────────────────┐
    │  SharePoint Connector — Permission Request          │
    │                                                     │
    │  App: Marketing KB Connector                        │
    │  Tenant: contoso.onmicrosoft.com                    │
    │  Requested by: john@contoso.com                     │
    │  Date: 2026-03-22                                   │
    │                                                     │
    │  CURRENT PERMISSIONS                                │
    │  ✅ Sites.Read.All — Read site content              │
    │                                                     │
    │  ADDITIONAL PERMISSIONS REQUESTED                   │
    │  ☐ Sites.FullControl.All                            │
    │    Why: Read document-level permissions to enforce   │
    │    access controls in search results                │
    │    Risk: App can read all site permissions           │
    │    Mitigation: Read-only usage, no write operations │
    │                                                     │
    │  ☐ Directory.Read.All                               │
    │    Why: Resolve group memberships for accurate       │
    │    permission enforcement                            │
    │    Risk: App can read user/group directory           │
    │    Mitigation: Only group membership is read         │
    │                                                     │
    │  APPROVE IN AZURE AD                                │
    │  1. Go to Azure Portal > App Registrations          │
    │  2. Find app: [Client ID]                           │
    │  3. API Permissions > Add > Microsoft Graph          │
    │  4. Add the permissions above                        │
    │  5. Grant admin consent                              │
    │                                                     │
    │  After approval, the connector will auto-detect     │
    │  the new permissions on next sync.                  │
    └─────────────────────────────────────────────────────┘

  → User takes this to security team
  → User clicks [Skip for now — proceed with read-only]
  → Sync starts with content only (no permission enforcement)
  → LATER: Security team grants permissions
  → Next sync auto-detects new permissions
  → System shows: "New permissions detected! Enable permission sync?"
```

**Scenario 2: "I understand the permissions, let me grant/delegate and proceed"**

```
User connects with Sites.Read.All
  → Sees permission proposal
  → Knows they can grant permissions themselves (or has security team on call)
  → Clicks [I'll add permissions and re-authenticate later]
  → Goes to Azure Portal, adds Sites.FullControl.All + Directory.Read.All
  → Comes back, clicks [Re-authenticate] in the Connection section
  → Re-authenticates (or shares device code with security team)
  → System re-probes token: "✅ All permissions available!"
  → Permission sync section now shows full options:
    (●) Simplified (95% accurate)  ( ) Full (100% accurate)
  → User approves updated proposal
```

**Scenario 3: "I understand but I opt out — don't need those features"**

```
User connects with Sites.Read.All
  → Sees permission proposal
  → Reads: "Permission sync ensures search results respect access controls"
  → Decides: "This is an internal team KB, everyone should see everything"
  → Selects: (●) Skip for now — all content searchable by KB users
  → No warning, no nagging — the system respects the choice
  → Proposal summary updates: "Permissions: Skipped (all content searchable)"
  → User approves, sync starts immediately
  → If they change their mind later: Source settings > Permissions > Enable
```

---

### Phase 3: MONITOR (enhanced source detail panel)

After approval, the source appears in the Data tab's `SourcesTable`. Clicking opens the enhanced detail panel. This is the same design from v1 of the redesign but with one critical addition — **the proposal is always revisitable**:

```
┌─ Source: SharePoint (Marketing Hub + 2 sites) ──────────────────────┐
│                                                                     │
│  [📋 View Current Configuration]  [✏️ Edit Configuration]           │
│  Opens the proposal view in read-only / edit mode                   │
│                                                                     │
│  ┌─ Connection ─────────────────────────────────────────────────┐  │
│  │  ● Connected                          [Re-authenticate]      │  │
│  │  Method: Device Code                                          │  │
│  │  Authenticated by: security@contoso.com · Mar 22, 2026        │  │
│  │  Token: Expires Apr 15 (24 days) · Last used: 5 min ago      │  │
│  │  Scopes: Sites.Read.All, offline_access                       │  │
│  │                                                               │  │
│  │  ℹ️ New permissions available since setup                     │  │
│  │  Sites.FullControl.All was added to your app.                 │  │
│  │  [Enable Permission Sync →]                                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Sync ───────────────────────────────────────────────────────┐  │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │  │
│  │  │  252   │  │  237   │  │   11   │  │    4   │            │  │
│  │  │ Total  │  │Indexed │  │Pending │  │ Failed │            │  │
│  │  └────────┘  └────────┘  └────────┘  └────────┘            │  │
│  │                                                              │  │
│  │  Last: 45 min ago (3m 12s) · Schedule: Every hour            │  │
│  │  Delta: +3 added, 1 modified since last full sync            │  │
│  │                                                              │  │
│  │  [▶ Sync Now]  [⏸ Pause]  [🔄 Full Re-sync]                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Content ────────────────────────────────────────────────────┐  │
│  │  By Site:                                                     │  │
│  │  Marketing Hub ████████████████░░  156 docs  3.2 GB           │  │
│  │  Engineering   ████████░░░░░░░░░░   67 docs  1.1 GB           │  │
│  │  Sales Team    ██░░░░░░░░░░░░░░░░   14 docs  0.4 GB           │  │
│  │                                                               │  │
│  │  By Type: PDF 112 · DOCX 67 · PPTX 34 · HTML 14 · Other 10 │  │
│  │  Total: 9.2 GB · Avg: 39 MB · Largest: 245 MB               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Issues (4) ─────────────────────────────────────────────────┐  │
│  │  Q3-Report.xlsx      Password protected                      │  │
│  │  Architecture.vsdx   Unsupported format (.vsdx)              │  │
│  │  Budget.xlsb         Extraction timeout (120s)               │  │
│  │  Video-Intro.mp4     Unsupported format (.mp4)               │  │
│  │                                              [Retry All]     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ▸ Sync History                                                     │
│  ▸ Permissions (Skipped — enable anytime)                           │
│  ▸ Filters & Rules (27 file types, no folder rules, no conditions) │
│  ▸ Webhooks (Enabled, 3 drive subscriptions, next renewal in 11h)  │
│  ▸ Advanced (Delta tokens, checkpoint status, debug info)           │
└─────────────────────────────────────────────────────────────────────┘
```

Key: The **Connection section auto-detects permission changes** — if security team grants new permissions after setup, the system proactively suggests enabling the newly available features.

---

## The Filter Architecture (for the design)

Our filter system is already powerful — 6 evaluation stages, 14 operators, 8 templates, OData pre-fetch optimization, folder globs. The UX challenge is exposing this progressively.

### Filter Layers in the Proposal

| Layer                   | Shown By Default?                  | Who Uses It                     | What It Covers                                                                                                                |
| ----------------------- | ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Sites & Libraries**   | Yes                                | Everyone                        | Which sites/drives to sync. Checkbox selection from discovery.                                                                |
| **File Types**          | Collapsed, shows summary           | Most users                      | 27 defaults shown. Customize to allowlist/denylist specific extensions.                                                       |
| **Folder Rules**        | Collapsed, shows "no restrictions" | Users with organized SharePoint | Glob patterns: `/Archive/**`, `/Projects/2024/**`. Quick templates for common exclusions.                                     |
| **Date/Size Limits**    | Inside folder rules section        | Users with large/old content    | Modified after, created after, max file size. Templates: "Last 90 days", "Last year", "Skip >50MB".                           |
| **Advanced Conditions** | Collapsed, shows "no rules"        | Power users                     | Condition builder: field + operator + value. 14 operators. AND/OR grouping. Any DriveItem metadata field.                     |
| **CEL Expressions**     | Inside advanced, collapsed         | Expert users                    | Free-form expressions for complex metadata logic. `metadata.sharepoint.sensitivity != "confidential" && sizeBytes < 50000000` |

### What Gets Evaluated Where

The proposal transparently shows this when advanced rules are configured:

```
┌─ Rule Evaluation ─────────────────────────────────────────────────┐
│                                                                    │
│  Pre-fetch (fast — reduces API calls):                            │
│  ✅ name contains "report"                                        │
│  ✅ lastModifiedDateTime > 2025-01-01                             │
│  ✅ size < 52428800                                               │
│                                                                    │
│  Post-fetch (applied after download — evaluates locally):         │
│  ⚠️ metadata.sharepoint.author endsWith "@marketing.com"          │
│     This rule can't be sent to SharePoint, so all files are       │
│     fetched first, then filtered. May use more API quota.         │
│                                                                    │
│  Folder rules (during enumeration):                               │
│  ✅ Exclude /Archive/** /Backup/** /Old/**                        │
│                                                                    │
│  Est. API calls: ~800/sync (vs ~2,400 without pre-fetch rules)   │
└────────────────────────────────────────────────────────────────────┘
```

This transparency is the competitive edge — no other platform explains WHERE and HOW filters are applied.

---

## Webhook & Real-Time Configuration

In the proposal under "Sync Schedule":

```
┌─ 🔄 Sync Schedule ──────────────────────────────────────────────┐
│                                                                   │
│  Scheduled sync:                                                  │
│  (●) Every hour  ( ) Every 6h  ( ) Daily  ( ) Manual only        │
│                                                                   │
│  Real-time notifications:                                         │
│  ☑ Enable webhooks — get notified when SharePoint content changes │
│                                                                   │
│  How it works: We subscribe to change notifications from          │
│  Microsoft Graph for each document library. When a file is        │
│  added, modified, or deleted, SharePoint notifies us and          │
│  we trigger an incremental sync within seconds.                   │
│                                                                   │
│  ℹ️ Webhook subscriptions expire every 24 hours and are          │
│  automatically renewed. If renewal fails 3 times, we fall         │
│  back to scheduled sync.                                          │
│                                                                   │
│  Status after setup:                                              │
│  Drive: Marketing Docs    ● Active   Expires: 24h   [Renew]     │
│  Drive: Engineering Wiki  ● Active   Expires: 24h   [Renew]     │
│  Drive: Sales Assets      ● Active   Expires: 24h   [Renew]     │
└───────────────────────────────────────────────────────────────────┘
```

---

## New Backend Requirements (Updated)

### Must Have (blocks redesign)

| #   | What                                                                                             | Why                                  | Effort |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------ | ------ |
| 1   | **Permission probing** — After auth, call `GET /me` + test `GET /sites` to detect granted scopes | Powers the permission-aware proposal | S      |
| 2   | `GET /connectors/:id/documents/stats` — aggregate by status, contentType, sourceMetadata.driveId | Powers content breakdown             | S      |
| 3   | Wire `startScheduledJobs()` + fix delta sync scheduler                                           | Enables sync schedule options        | S      |
| 4   | Mount webhook routes + start webhook worker                                                      | Enables real-time sync               | S      |
| 5   | Add `processingError` to documents list response                                                 | Powers failed documents list         | XS     |
| 6   | Persist sync `durationMs` + doc counts to syncState or SyncRun model                             | Powers sync history                  | M      |

### Should Have

| #   | What                                                                                            | Why                                      | Effort |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| 7   | **Security Review Document generator** — Template with app details, permissions, justifications | The "take to security team" flow         | M      |
| 8   | **Permission change detection** — On each sync, re-probe token scopes and flag changes          | "New permissions available" notification | S      |
| 9   | `SyncRun` history model                                                                         | Full sync timeline in monitor panel      | M      |
| 10  | Track `authenticatedBy` identity on EndUserOAuthToken                                           | Shows who authenticated                  | XS     |
| 11  | `FileExtensionRegistry` API endpoint                                                            | Dynamic file type list                   | S      |
| 12  | Auto-pause after 5 consecutive failures                                                         | Prevents runaway broken sync             | S      |
| 13  | Fix webhook renewal mock token                                                                  | Webhook renewal actually works           | S      |

### Future (CEL & Advanced)

| #   | What                                        | Why                           | Effort |
| --- | ------------------------------------------- | ----------------------------- | ------ |
| 14  | **CEL expression evaluator** integration    | Power user metadata filtering | L      |
| 15  | Permission access report (who can see what) | Security admin visibility     | M      |
| 16  | Auth audit trail (implement `onAuthEvent`)  | Compliance                    | M      |
| 17  | Vector store cleanup job                    | Removes stale embeddings      | M      |

---

## Design System Components

| Component                  | DS Primitives                                                | Notes                          |
| -------------------------- | ------------------------------------------------------------ | ------------------------------ |
| Proposal view              | `Card` sections + progressive disclosure                     | One scrollable panel, not tabs |
| Permission capability list | `Badge` (success/warning) + description text                 | Adapts to detected permissions |
| Site selector table        | `DataTable` + checkboxes + `Badge` (star)                    | Evolve existing `SiteSelector` |
| File type summary          | Inline `Badge` list + "Customize" edit mode                  | Show all 27, group by category |
| Folder rule editor         | `Input` with glob syntax + quick templates as `Button` pills | Include/exclude pattern lists  |
| Advanced condition builder | Field `Select` + Operator `Select` + Value `Input`           | AND/OR group nesting           |
| CEL editor                 | Monospace `Input` or code editor                             | Only in advanced section       |
| Summary bar                | `Card` with live-updating text                               | Always visible at bottom       |
| Security review download   | `Button` (secondary) + document template                     | Generates markdown/PDF         |

**No new dependencies.** No charting library. CSS-only bar charts for content breakdown.

---

## Migration Path

| Current Component                           | Action                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `EnterpriseConnectorWizard.tsx` (760 lines) | **Replace** with `ConnectorConnectPanel` + `ConnectorProposal`                 |
| `ConnectorDetailPanel.tsx` (765 lines)      | **Enhance** with content breakdown, issues, sync history, permission detection |
| `ConnectorsTab.tsx` (647 lines)             | **Delete** — dead code                                                         |
| `SiteSelector.tsx` (295 lines)              | **Evolve** — add file counts, sizes, recommendation stars, inline in proposal  |
| `ConnectorFilterSection.tsx` (691 lines)    | **Evolve** — restructure as proposal sections with progressive disclosure      |
| `SyncProgress.tsx` (352 lines)              | **Keep** — works well                                                          |
| `AddSourceButton.tsx` (419 lines)           | **Modify** — SharePoint opens inline connect panel                             |

### New Components

| Component                       | Purpose                                           | Size |
| ------------------------------- | ------------------------------------------------- | ---- |
| `ConnectorProposal.tsx`         | The smart proposal view (Phase 2)                 | L    |
| `ConnectorContentBreakdown.tsx` | Per-site/type visualization                       | S    |
| `ConnectorIssuesList.tsx`       | Failed docs with errors + retry                   | S    |
| `ConnectorSyncHistory.tsx`      | Timeline of past syncs                            | S    |
| `ConnectorConnectionCard.tsx`   | Token health + permission detection               | S    |
| `PermissionCapabilityList.tsx`  | Checkmark list of available/unavailable features  | S    |
| `SecurityReviewGenerator.ts`    | Generate downloadable permission request document | S    |

---

## Sources

- [Microsoft Graph Permissions Reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Sites.FullControl.All Permission Details](https://graphpermissions.merill.net/permission/Sites.FullControl.All)
- [CEL — Common Expression Language](https://cel.dev/)
- [Elastic CEL Input for Search](https://www.elastic.co/search-labs/blog/common-expression-language-elasticsearch)
- [Glean SharePoint Setup](https://docs.glean.com/connectors/native/sharepoint/setup)
- [Coveo SharePoint Online Source](https://docs.coveo.com/en/1739/)
- [Elastic Workplace Search SharePoint](https://www.elastic.co/guide/en/workplace-search/current/workplace-search-sharepoint-online-connector.html)
- [Microsoft Copilot Connectors Overview](https://learn.microsoft.com/en-us/microsoftsearch/connectors-overview)
- [Enterprise UX Design Guide 2026](https://fuselabcreative.com/enterprise-ux-design-guide-2026-best-practices/)
