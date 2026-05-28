# Design B: Transparent Proposal (Evolved)

## SharePoint Connector — Full-Page Proposal Experience

**Date:** 2026-03-22
**Version:** 1.0
**Based on:** Deep Dive (sections 1-8) + v2 "Smart Proposal" UX Redesign + 3 review rounds (21 issues)

---

## 1. Philosophy Statement

The system generates a real reviewable document — like a PR diff with per-section Accept/Modify/Skip decisions — not a form with good defaults. The Proposal IS the product: it serves as configuration, security review, dry-run preview, and audit artifact all in one exportable document.

---

## 2. User Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         SHAREPOINT CONNECTOR FLOW                        │
│                                                                          │
│  ┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐       │
│  │  1. CONNECT  │────▶│ 2. HEALTH    │────▶│  3. PROPOSAL        │       │
│  │  (inline     │     │    CHECK     │     │     GENERATION      │       │
│  │   panel)     │     │  (6-axis)    │     │  (background)       │       │
│  └─────────────┘     └──────┬───────┘     └──────────┬──────────┘       │
│                              │                        │                  │
│                        ┌─────▼─────┐          ┌──────▼──────────┐       │
│                        │  FAIL:    │          │  4. REVIEW       │       │
│                        │  Fix &    │          │     PROPOSAL     │       │
│                        │  Retry    │          │  (full page,     │       │
│                        └───────────┘          │   per-section    │       │
│                                               │   decisions)     │       │
│                                               └──────┬──────────┘       │
│                                                      │                  │
│                                               ┌──────▼──────────┐       │
│                                               │  5. APPROVE      │       │
│                                               │  & START SYNC    │       │
│                                               └──────┬──────────┘       │
│                                                      │                  │
│                                               ┌──────▼──────────┐       │
│                                               │  6. MONITOR      │       │
│                                               │  (source panel)  │       │
│                                               └─────────────────┘       │
│                                                                          │
│  At any point:                                                           │
│  - Export proposal as PDF (security review)                              │
│  - Clone proposal for another connector                                  │
│  - Revisit/modify approved proposal from Monitor                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Screen-by-Screen Wireframes

### Screen 1: Add Source — SharePoint Selected (Inline Panel)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Data Sources                                                    [+ Add]│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌── Add Source ──────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Source type: [SharePoint ▾]                                       │ │
│  │                                                                    │ │
│  │  ┌─ Azure App Registration ─────────────────────────────────────┐ │ │
│  │  │                                                               │ │ │
│  │  │  Don't have an App Registration?                              │ │ │
│  │  │  [View Setup Guide ↗]  — Step-by-step with screenshots       │ │ │
│  │  │                                                               │ │ │
│  │  │  Tenant ID (Directory ID)                                     │ │ │
│  │  │  ┌──────────────────────────────────────────────────────┐    │ │ │
│  │  │  │ e.g. 72f988bf-86f1-41af-91ab-2d7cd011db47           │    │ │ │
│  │  │  └──────────────────────────────────────────────────────┘    │ │ │
│  │  │  ℹ Azure Portal > Azure AD > Overview > Tenant ID            │ │ │
│  │  │                                                               │ │ │
│  │  │  Client ID (Application ID)                                   │ │ │
│  │  │  ┌──────────────────────────────────────────────────────┐    │ │ │
│  │  │  │ e.g. 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d           │    │ │ │
│  │  │  └──────────────────────────────────────────────────────┘    │ │ │
│  │  │                                                               │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  │  ┌─ Authentication ─────────────────────────────────────────────┐ │ │
│  │  │                                                               │ │ │
│  │  │  Who will authenticate?                                       │ │ │
│  │  │                                                               │ │ │
│  │  │  (●) I'll do it now (Browser Login)                           │ │ │
│  │  │      Sign in with your Microsoft account                      │ │ │
│  │  │                                                               │ │ │
│  │  │  ( ) Someone else needs to (Device Code)                      │ │ │
│  │  │      Generate a code to share with your IT/security team      │ │ │
│  │  │                                                               │ │ │
│  │  │  ( ) App-only access (Client Credentials)                     │ │ │
│  │  │      No user sign-in needed — uses client secret              │ │ │
│  │  │      ┌──────────────────────────────────────────────────┐    │ │ │
│  │  │      │ Client Secret                                    │    │ │ │
│  │  │      └──────────────────────────────────────────────────┘    │ │ │
│  │  │                                                               │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  │                                         [Cancel]  [Connect →]      │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key differences from v2:**

- "Don't have an App Registration?" prominent at top (solves issue #1)
- Auth framed as "who will authenticate" not "method" — separates the human question from the protocol (solves issue #2)
- Device Code explicitly says "share with IT/security" — makes delegation a first-class concept
- No expandable "what permissions" — that comes in the Health Check

### Screen 1a: App Registration Setup Guide (Expandable / Linked Page)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SharePoint App Registration — Setup Guide                       [X]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  This guide walks through creating an Azure App Registration.           │
│  Time: ~5 minutes. Requires: Azure Portal access.                       │
│                                                                         │
│  Step 1 of 5: Navigate to App Registrations                             │
│  ─────────────────────────────────────────                              │
│  1. Go to portal.azure.com                                              │
│  2. Search "App registrations" in the top bar                           │
│  3. Click "+ New registration"                                          │
│                                                                         │
│  Step 2 of 5: Register the App                                          │
│  ────────────────────────────                                           │
│  Name: "ABL Platform — SharePoint Connector"                            │
│  Supported account types: "Single tenant" (your org only)               │
│  Redirect URI: Web → https://<your-abl-domain>/api/connectors/callback  │
│  Click "Register"                                                       │
│                                                                         │
│  Step 3 of 5: Copy IDs                                                  │
│  ──────────────────                                                     │
│  From the Overview page, copy:                                          │
│  - Application (client) ID → paste into "Client ID" field              │
│  - Directory (tenant) ID → paste into "Tenant ID" field                │
│                                                                         │
│  Step 4 of 5: Add API Permissions                                       │
│  ──────────────────────────────                                         │
│  Go to "API permissions" > "Add a permission" > "Microsoft Graph"       │
│                                                                         │
│  Minimum permissions (read-only sync):                                  │
│    Delegated: Sites.Read.All, offline_access, User.Read                 │
│  OR                                                                     │
│    Application: Sites.Read.All (for app-only access)                    │
│                                                                         │
│  Full permissions (with permission-aware search):                        │
│    Add: Sites.FullControl.All, Directory.Read.All                       │
│                                                                         │
│  ⚠ You can start with minimum and upgrade later.                        │
│    Our system detects your permissions and adapts.                       │
│                                                                         │
│  Step 5 of 5: Admin Consent                                             │
│  ──────────────────────────                                             │
│  ⚠ This is a SEPARATE step from authenticating.                         │
│                                                                         │
│  An Azure AD admin must click "Grant admin consent for [org]"           │
│  on the API permissions page.                                           │
│                                                                         │
│  This is NOT the same as signing in. Admin consent approves the         │
│  app to access data. Signing in (in the next step) authorizes a         │
│  specific user's session.                                               │
│                                                                         │
│  If you're not an admin:                                                │
│  [Copy Admin Consent Request Email ↗]                                   │
│  Pre-written email to send to your Azure AD administrator.              │
│                                                                         │
│                                                       [Done — Go Back]  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Screen 1b: Device Code — Delegation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Authenticate with Microsoft                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Share this code with the person who will authenticate:                  │
│                                                                         │
│           ┌──────────────────┐                                          │
│           │    ABCD-EFGH     │  [Copy Code]                             │
│           └──────────────────┘                                          │
│                                                                         │
│  They should go to: microsoft.com/devicelogin                           │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Quick share options:                                            │   │
│  │                                                                  │   │
│  │  [Copy as Message]  [Copy as Email]                              │   │
│  │                                                                  │   │
│  │  Message preview:                                                │   │
│  │  "Hi — please authenticate our SharePoint connector for the      │   │
│  │   ABL Platform. Go to microsoft.com/devicelogin and enter        │   │
│  │   code ABCD-EFGH. This code expires in 14 minutes.              │   │
│  │   This requires Azure AD admin consent on the app."             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ⏱ Code expires in 13:42                                  ● Waiting...  │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────────  │
│  ℹ Important: The person authenticating must also have admin consent    │
│    granted on the app registration. If they see "AADSTS65001: The user  │
│    or admin has not consented," admin consent is still needed.           │
│  [What is admin consent? ↗]                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Screen 2: Connection Health Check (6-Axis Validation)

After authentication succeeds, the system runs a health check BEFORE generating the proposal. This is a full-page view.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                                                 │
│                                                                         │
│  SharePoint Connection Health Check                                     │
│  Running 6 validation checks before generating your proposal...         │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  1. Authentication          ✅ PASS                              │   │
│  │     Token acquired, valid for 60 minutes                         │   │
│  │     Authenticated by: john@contoso.com                           │   │
│  │     Method: Device Code (delegated)                              │   │
│  │                                                                  │   │
│  │  2. Permissions             ✅ PASS (partial)                    │   │
│  │     Granted: Sites.Read.All, offline_access, User.Read           │   │
│  │     Missing: Sites.FullControl.All, Directory.Read.All           │   │
│  │     Impact: Can sync content, cannot enforce per-doc permissions  │   │
│  │     ℹ You can proceed now and upgrade permissions later.         │   │
│  │                                                                  │   │
│  │  3. Connectivity            ✅ PASS                              │   │
│  │     Microsoft Graph API reachable (142ms latency)                │   │
│  │     Tenant: Contoso (contoso.onmicrosoft.com)                    │   │
│  │                                                                  │   │
│  │  4. Site Access             ✅ PASS                              │   │
│  │     5 sites accessible with current permissions                  │   │
│  │     0 sites denied (would require Sites.Selected grants)         │   │
│  │                                                                  │   │
│  │  5. Rate Limit Headroom     ✅ PASS                              │   │
│  │     Graph API throttle budget: ~10,000 requests/10min            │   │
│  │     Estimated usage for discovery: ~200 requests                 │   │
│  │                                                                  │   │
│  │  6. Platform Readiness      ✅ PASS                              │   │
│  │     Ingestion pipeline: operational                              │   │
│  │     Vector store: connected                                      │   │
│  │     Available disk: 42 GB                                        │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  All critical checks passed.                                            │
│                                                                         │
│                                [Cancel]  [Generate Proposal →]          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Screen 2a: Health Check — Failure State

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                                                 │
│                                                                         │
│  SharePoint Connection Health Check                                     │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  1. Authentication          ✅ PASS                              │   │
│  │     Token acquired, valid for 58 minutes                         │   │
│  │                                                                  │   │
│  │  2. Permissions             ❌ FAIL                              │   │
│  │     Granted: User.Read, offline_access                           │   │
│  │     Missing: Sites.Read.All (REQUIRED)                           │   │
│  │                                                                  │   │
│  │     Without Sites.Read.All, we cannot read any SharePoint        │   │
│  │     content. This is the minimum required permission.            │   │
│  │                                                                  │   │
│  │     How to fix:                                                  │   │
│  │     1. Go to Azure Portal > App Registrations > [your app]      │   │
│  │     2. API Permissions > Add > Microsoft Graph                   │   │
│  │     3. Delegated > Sites.Read.All                                │   │
│  │     4. Click "Grant admin consent"                               │   │
│  │     5. Come back and re-authenticate                             │   │
│  │                                                                  │   │
│  │     [Copy Fix Instructions]  [Re-authenticate]                   │   │
│  │                                                                  │   │
│  │  3. Connectivity            ✅ PASS                              │   │
│  │  4. Site Access             ⏭ SKIPPED (blocked by #2)            │   │
│  │  5. Rate Limit Headroom     ✅ PASS                              │   │
│  │  6. Platform Readiness      ✅ PASS                              │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ❌ 1 critical check failed. Fix required before proceeding.            │
│                                                                         │
│  [Re-run Health Check]                                       [Cancel]   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Screen 3: Proposal Generation (Loading State with Cancel)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                                                 │
│                                                                         │
│  Generating Your Configuration Proposal                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Discovering sites and content...                                │   │
│  │                                                                  │   │
│  │  Sites found:                                                    │   │
│  │    ✅ Marketing Hub (42 files, 3.2 GB)                           │   │
│  │    ✅ Engineering Wiki (128 files, 1.1 GB)                       │   │
│  │    ✅ Sales Team Site (67 files, 5.4 GB)                         │   │
│  │    ████████████░░░░  Profiling: Executive Comms...               │   │
│  │    ░░░░░░░░░░░░░░░░  Queued: IT Infrastructure                  │   │
│  │                                                                  │   │
│  │  Elapsed: 0:24 / ~1:30 estimated                                │   │
│  │                                                                  │   │
│  │  ℹ Sites appear as they're discovered. Large tenants with        │   │
│  │    1000+ sites may take several minutes.                         │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  [Cancel Discovery]                                                     │
│  Cancelling keeps already-discovered sites. You can generate a          │
│  partial proposal or restart discovery later.                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The Proposal Format — Full Page, Per-Section Decisions

This is the core of Design B. The proposal is a FULL PAGE (not a dialog), structured as a reviewable document. Each section has three actions: Accept (use recommendation as-is), Modify (edit the recommendation), Skip (exclude this section entirely).

### Screen 4: The Proposal (Full Page)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                    [Export as PDF]  [Clone]     │
│                                                                         │
│  ══════════════════════════════════════════════════════════════════════  │
│  CONFIGURATION PROPOSAL                                                 │
│  SharePoint → Marketing KB                                              │
│  Generated: Mar 22, 2026 · Based on: 5 sites, 252 documents            │
│  ══════════════════════════════════════════════════════════════════════  │
│                                                                         │
│  Progress: 2 of 7 sections reviewed                                     │
│  [■■□□□□□]  Permissions · Scope · Filters · Types · Schedule ·          │
│             Permissions Sync · Sample Preview                           │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 1: PERMISSIONS & CAPABILITIES                                  │
│  Status: [✅ Accepted]                                                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Your app registration has these Microsoft Graph permissions:    │   │
│  │                                                                  │   │
│  │  GRANTED                                                         │   │
│  │  ✅ Sites.Read.All          Read all site content                │   │
│  │  ✅ offline_access          Token refresh (no re-login)          │   │
│  │  ✅ User.Read               Identify authenticated user          │   │
│  │                                                                  │   │
│  │  NOT GRANTED (optional upgrades)                                 │   │
│  │  ○ Sites.FullControl.All   Read per-document permissions         │   │
│  │    → Unlocks: Permission-aware search (users only see docs       │   │
│  │      they have access to in SharePoint)                          │   │
│  │    → Risk: App gains full control scope. In practice, we only    │   │
│  │      READ permissions — we never write. But the scope itself     │   │
│  │      is broad. Microsoft does not offer a read-only permission   │   │
│  │      scope for item-level ACLs.                                  │   │
│  │    → Alternative: Sites.Selected (grants per-site, but our       │   │
│  │      platform cannot use it yet — requires admin-granted         │   │
│  │      site-level permissions via PowerShell/Graph admin API)      │   │
│  │                                                                  │   │
│  │  ○ Directory.Read.All      Resolve group memberships             │   │
│  │    → Unlocks: Group-based permission resolution (if a            │   │
│  │      SharePoint doc is shared with "Marketing Team" group,       │   │
│  │      we can resolve who's in that group)                         │   │
│  │    → Risk: App can read Azure AD directory (users, groups)       │   │
│  │                                                                  │   │
│  │  RECOMMENDATION                                                  │   │
│  │  Proceed with current permissions. Sync content now, add         │   │
│  │  permission-aware search later if needed. Most teams start       │   │
│  │  with content sync and evaluate permission needs after.          │   │
│  │                                                                  │   │
│  │  [✅ Accept]  [✏️ Modify]  [⏭ Skip]                               │   │
│  │                                                                  │   │
│  │  ✅ Accepted — proceeding with Sites.Read.All (content only).    │   │
│  │  Upgrade anytime from source settings.                           │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 2: SYNC SCOPE                                                  │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  I found 5 SharePoint sites accessible with your permissions.    │   │
│  │  Here's what I recommend syncing:                                │   │
│  │                                                                  │   │
│  │  RECOMMENDED (active, rich content)                              │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  ☑ Marketing Hub                                          │  │   │
│  │  │    42 files · 3.2 GB · Last updated: 2 days ago           │  │   │
│  │  │    Top types: PDF (60%), DOCX (25%), PPTX (15%)           │  │   │
│  │  │    Libraries: Documents, Shared Documents                  │  │   │
│  │  │    Why recommended: Active site, diverse document types    │  │   │
│  │  │                                                            │  │   │
│  │  │  ☑ Engineering Wiki                                        │  │   │
│  │  │    128 files · 1.1 GB · Last updated: today                │  │   │
│  │  │    Top types: MD (45%), HTML (30%), PDF (15%), other (10%) │  │   │
│  │  │    Libraries: Wiki Pages, Technical Docs                   │  │   │
│  │  │    Why recommended: Most active site, high text content    │  │   │
│  │  │                                                            │  │   │
│  │  │  ☑ Sales Team Site                                         │  │   │
│  │  │    67 files · 5.4 GB · Last updated: 1 week ago            │  │   │
│  │  │    Top types: PPTX (50%), PDF (30%), XLSX (20%)            │  │   │
│  │  │    Libraries: Presentations, Contracts                     │  │   │
│  │  │    Why recommended: Active, business-critical content      │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  OPTIONAL (low activity or small)                                │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  ☐ Executive Comms                                         │  │   │
│  │  │    12 files · 0.2 GB · Last updated: 3 months ago          │  │   │
│  │  │    Why not recommended: Stale content (90+ days inactive)  │  │   │
│  │  │                                                            │  │   │
│  │  │  ☐ IT Infrastructure                                       │  │   │
│  │  │    3 files · 0.1 GB · Last updated: 6 months ago           │  │   │
│  │  │    Why not recommended: Minimal content, very stale        │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  Summary: 3 sites selected · 237 files · 9.7 GB                 │   │
│  │                                                                  │   │
│  │  [✅ Accept]  [✏️ Modify]  [⏭ Skip — sync all sites]             │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 3: CONTENT FILTERS                                             │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Based on profiling your content, I recommend syncing            │   │
│  │  237 of 252 documents. 15 would be excluded:                     │   │
│  │                                                                  │   │
│  │  EXCLUDED (with reasons)                                         │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │  3 files   Executable/binary (.exe, .dll, .msi)           │  │   │
│  │  │            Platform policy: executables always blocked     │  │   │
│  │  │                                                            │  │   │
│  │  │  8 files   In /Archive/** folders                          │  │   │
│  │  │            Recommendation: exclude archived content        │  │   │
│  │  │            Matched template: "exclude-archives"            │  │   │
│  │  │            Files: Q1-Report-OLD.pdf, Budget-2023.xlsx...   │  │   │
│  │  │            [Show all 8 files]                               │  │   │
│  │  │                                                            │  │   │
│  │  │  4 files   Over 50 MB each                                 │  │   │
│  │  │            Recommendation: large files slow ingestion      │  │   │
│  │  │            Files: Training-Video.mp4 (245 MB),             │  │   │
│  │  │            Full-Catalog.pdf (67 MB)...                     │  │   │
│  │  │            [Show all 4 files]                               │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  INCLUDED                                                        │   │
│  │  237 files across 3 sites                                        │   │
│  │  PDF: 112 · DOCX: 67 · PPTX: 34 · HTML: 14 · Other: 10         │   │
│  │  Total size: 8.8 GB · Avg: 37 MB                                │   │
│  │                                                                  │   │
│  │  ACTIVE FILTER RULES                                             │   │
│  │  1. Block executables (.exe, .dll, .msi, .bat, .cmd, .ps1)      │   │
│  │  2. Exclude folders matching: /Archive/**, /Backup/**, /Old/**   │   │
│  │  3. Exclude files over 50 MB                                     │   │
│  │                                                                  │   │
│  │  Where rules are evaluated:                                      │   │
│  │  Pre-fetch (reduces API calls): rules 1, 3 → OData filter       │   │
│  │  During enumeration: rule 2 → folder path matching               │   │
│  │  Estimated API calls saved: ~40% fewer than unfiltered           │   │
│  │                                                                  │   │
│  │  [✅ Accept]  [✏️ Modify]  [⏭ Skip — no filtering]               │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 4: FILE TYPES                                                  │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Supported types found in your content:                          │   │
│  │  ✅ pdf (112)  ✅ docx (67)  ✅ pptx (34)  ✅ html (14)          │   │
│  │  ✅ xlsx (4)   ✅ txt (3)    ✅ csv (2)     ✅ md (1)             │   │
│  │                                                                  │   │
│  │  Unsupported types found in your content:                        │   │
│  │  ⚠ vsdx (3) — Visio diagrams, not extractable                   │   │
│  │  ⚠ mp4 (2) — Video files, not extractable                       │   │
│  │  These 5 files will be skipped during sync.                      │   │
│  │                                                                  │   │
│  │  Full type allowlist: 27 types (Documents + Text + Email)        │   │
│  │  [Show all 27 types]                                             │   │
│  │                                                                  │   │
│  │  [✅ Accept]  [✏️ Modify]  [⏭ Skip — accept all file types]      │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 5: SYNC SCHEDULE                                               │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  RECOMMENDATION: Sync every hour                                 │   │
│  │  Why: Your most active site (Engineering Wiki) was updated       │   │
│  │  today. Hourly sync keeps content fresh without excessive        │   │
│  │  API usage.                                                      │   │
│  │                                                                  │   │
│  │  Estimated API usage per sync cycle:                             │   │
│  │    Full sync: ~2,400 requests (first time only)                  │   │
│  │    Delta sync: ~50-200 requests (ongoing, only changes)          │   │
│  │    Monthly total: ~15,000 requests (well within Graph limits)    │   │
│  │                                                                  │   │
│  │  Webhook notifications:                                          │   │
│  │  ☑ Enable — get notified within seconds when content changes     │   │
│  │    (Supplements scheduled sync. Subscriptions auto-renewed.)     │   │
│  │                                                                  │   │
│  │  [✅ Accept]  [✏️ Modify]  [⏭ Skip — manual sync only]           │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 6: PERMISSION-AWARE SEARCH                                     │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ⚠ Not available with current permissions.                       │   │
│  │                                                                  │   │
│  │  What this does:                                                 │   │
│  │  When users search this knowledge base, results are filtered     │   │
│  │  to only show documents they have access to in SharePoint.       │   │
│  │  Without this, all synced content is visible to all KB users.    │   │
│  │                                                                  │   │
│  │  Requirements:                                                   │   │
│  │  ○ Sites.FullControl.All — read document-level ACLs              │   │
│  │    (This scope name is misleading — Microsoft requires "full     │   │
│  │     control" even for read-only permission checks. There is      │   │
│  │     no narrower scope. We use it READ-ONLY. We never modify      │   │
│  │     any SharePoint content or permissions.)                      │   │
│  │  ○ Directory.Read.All — resolve group memberships (optional)     │   │
│  │                                                                  │   │
│  │  Sites.Selected alternative:                                     │   │
│  │  Microsoft offers Sites.Selected for per-site scoping, but it    │   │
│  │  requires an Azure AD admin to grant site-level permissions      │   │
│  │  via PowerShell (Set-SPOSite) or Graph admin API for each        │   │
│  │  site individually. Our platform does not yet support this       │   │
│  │  flow. If your org requires least-privilege, contact us to       │   │
│  │  discuss Sites.Selected integration.                             │   │
│  │                                                                  │   │
│  │  [✅ Accept — skip for now]  [✏️ Request permissions]             │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ────────────────────────────────────────────────────────────────────── │
│                                                                         │
│  SECTION 7: SAMPLE DOCUMENTS (DRY RUN)                                  │
│  Status: [Pending review]                                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Preview: here are 15 documents that would be synced             │   │
│  │  (sampled across sites and types to show variety)                │   │
│  │                                                                  │   │
│  │  ┌───────────────────────────────────────────────────────────┐  │   │
│  │  │ #  Name                    Site            Type  Size     │  │   │
│  │  │ 1  Q4-Strategy.pdf         Marketing Hub   PDF   2.1 MB  │  │   │
│  │  │ 2  API-Reference.md        Engineering     MD    340 KB  │  │   │
│  │  │ 3  Sales-Playbook.pptx     Sales Team      PPTX  8.7 MB  │  │   │
│  │  │ 4  Brand-Guidelines.pdf    Marketing Hub   PDF   5.2 MB  │  │   │
│  │  │ 5  Sprint-Retro-W12.docx   Engineering     DOCX  45 KB   │  │   │
│  │  │ 6  Pricing-Sheet.xlsx      Sales Team      XLSX  1.2 MB  │  │   │
│  │  │ 7  Onboarding-Guide.pdf    Marketing Hub   PDF   890 KB  │  │   │
│  │  │ 8  Architecture-v3.html    Engineering     HTML  210 KB  │  │   │
│  │  │ 9  Contract-Template.docx  Sales Team      DOCX  78 KB   │  │   │
│  │  │10  Release-Notes.md        Engineering     MD    56 KB   │  │   │
│  │  │    ... and 227 more documents                              │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  Metadata detected (available for filtering):                    │   │
│  │  • Author (67% of docs)                                         │   │
│  │  • Department (custom column, 45% of docs)                      │   │
│  │  • Sensitivity label (23% of docs: Internal, Confidential)      │   │
│  │  • Created date, Modified date, Size (100% of docs)             │   │
│  │                                                                  │   │
│  │  [✅ Accept — looks good]  [✏️ Modify filters]  [⏭ Skip preview] │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ══════════════════════════════════════════════════════════════════════  │
│                                                                         │
│  PROPOSAL SUMMARY                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Scope:     3 sites · 237 files · 8.8 GB                        │   │
│  │  Filters:   Exclude archives, executables, >50 MB               │   │
│  │  Types:     27 supported (8 found in your content)              │   │
│  │  Schedule:  Every hour + webhooks                                │   │
│  │  Perms:     Content only (permission sync skipped)              │   │
│  │  Est. time: ~5 min first sync · ~30s ongoing deltas             │   │
│  │  API usage: ~15,000 requests/month                              │   │
│  │                                                                  │   │
│  │  Sections: 4 accepted · 1 modified · 1 skipped · 1 pending     │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  [Export as PDF]  [Save Draft]      [Cancel]  [✅ Approve & Start Sync] │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Section Modify Mode (Example: Modifying Filters)

When the user clicks "Modify" on Section 3 (Content Filters):

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SECTION 3: CONTENT FILTERS  [editing]                                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Current rules:                                                  │   │
│  │                                                                  │   │
│  │  ┌ Rule 1 ─────────────────────────────────────────────────┐    │   │
│  │  │ Block executables (.exe, .dll, .msi, .bat, .cmd, .ps1)  │    │   │
│  │  │ Type: Platform policy (cannot remove)                    │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                  │   │
│  │  ┌ Rule 2 ─────────────────────────────────────────────────┐    │   │
│  │  │ Exclude folders: /Archive/**, /Backup/**, /Old/**       │    │   │
│  │  │ [Edit paths]  [Remove rule]                              │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                  │   │
│  │  ┌ Rule 3 ─────────────────────────────────────────────────┐    │   │
│  │  │ Exclude files over 50 MB                                 │    │   │
│  │  │ [Change limit: 50 ▾ MB]  [Remove rule]                  │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                  │   │
│  │  [+ Add rule]                                                    │   │
│  │                                                                  │   │
│  │  Quick templates:                                                │   │
│  │  [Recent files only (90 days)]  [Small files (<10 MB)]           │   │
│  │  [Exclude drafts]  [Specific author]                             │   │
│  │                                                                  │   │
│  │  ▸ Advanced: CEL expression                                      │   │
│  │    Write custom filter logic using Common Expression Language     │   │
│  │    ┌─────────────────────────────────────────────────────────┐  │   │
│  │    │ metadata.sharepoint.sensitivity != "confidential"       │  │   │
│  │    │ && sizeBytes < 50000000                                 │  │   │
│  │    └─────────────────────────────────────────────────────────┘  │   │
│  │    [Validate expression]                                         │   │
│  │                                                                  │   │
│  │  ── Live impact ──                                               │   │
│  │  With current rules: 237 of 252 documents (15 excluded)          │   │
│  │  [Preview excluded files]                                        │   │
│  │                                                                  │   │
│  │  [Save changes]  [Discard]                                       │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Permission Negotiation Model

The proposal treats permissions as a negotiation, not a requirement gate:

```
┌──────────────────────────────────────────────────────────────────────┐
│                    PERMISSION NEGOTIATION FLOW                        │
│                                                                      │
│  DETECTED PERMISSIONS                                                │
│  ┌────────────────────┐                                              │
│  │ Sites.Read.All     │──── Enables: content sync, discovery         │
│  │ offline_access      │──── Enables: token refresh                   │
│  │ User.Read           │──── Enables: user identification             │
│  └────────────────────┘                                              │
│         │                                                            │
│         ▼                                                            │
│  PROPOSAL ADAPTS:                                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  "Here's what you CAN do now:"                               │    │
│  │  ✅ Sync all document content                                │    │
│  │  ✅ Discover sites and libraries                              │    │
│  │  ✅ Delta sync (track changes)                                │    │
│  │  ✅ Webhook notifications                                     │    │
│  │                                                               │    │
│  │  "Here's what you'd UNLOCK with more permissions:"           │    │
│  │  ○ Permission-aware search (needs Sites.FullControl.All)      │    │
│  │  ○ Group membership resolution (needs Directory.Read.All)     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│         │                                                            │
│         ▼                                                            │
│  USER CHOOSES PATH:                                                  │
│                                                                      │
│  Path A: "Good enough, proceed"                                      │
│  → Accept permission section                                         │
│  → Section 6 (Permission Sync) auto-set to "Skipped"               │
│  → Proposal summary shows "All content searchable by KB users"      │
│                                                                      │
│  Path B: "I want those features, I'll get approval"                  │
│  → Click [Request permissions] in Section 6                          │
│  → System generates Security Review Document (PDF)                   │
│  → User takes PDF to security team                                   │
│  → Meanwhile, approves rest of proposal and starts sync              │
│  → Later: re-authenticate with upgraded permissions                  │
│  → System auto-detects new permissions, prompts upgrade              │
│                                                                      │
│  Path C: "I can grant these myself"                                  │
│  → Click [Request permissions] → [I'll add them now]                 │
│  → Goes to Azure Portal, adds permissions, grants consent            │
│  → Returns, clicks [Re-authenticate]                                 │
│  → Health check re-runs, detects new scopes                         │
│  → Proposal regenerates with permission sync enabled                 │
│                                                                      │
│  Path D: "I need Sites.Selected (least privilege)"                   │
│  → Proposal explains: Sites.Selected requires per-site admin         │
│    grants and is not yet integrated in our platform                  │
│  → Offers: [Contact support for Sites.Selected setup]               │
│  → User proceeds with current scope or waits for integration        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Filter Presentation — Results, Not Form Fields

Filters in Design B are NEVER presented as empty form fields to fill in. They are always presented as the RESULT of analysis:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ANTI-PATTERN (v2 and every competitor):                             │
│                                                                      │
│  Folder exclusions: [                    ]  [+ Add]                  │
│  File size limit:   [No limit ▾]                                     │
│  Date range:        [Any ▾]                                          │
│                                                                      │
│  ^ User stares at blank fields. What should they type?               │
│    What are the folders? How big are the files?                      │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│  DESIGN B PATTERN:                                                   │
│                                                                      │
│  "I recommend syncing 237 of 252 documents."                         │
│                                                                      │
│  "15 excluded because:"                                              │
│  3 executables (platform blocked)                                    │
│  8 in /Archive/** (template: exclude-archives)                       │
│  4 over 50 MB (recommendation: large-file-exclusion)                │
│                                                                      │
│  "Here are the 8 archived files I'd exclude:"                        │
│  Q1-Report-OLD.pdf, Budget-2023.xlsx, ...                            │
│                                                                      │
│  [Accept]  [Modify exclusions]  [Skip — sync everything]            │
│                                                                      │
│  ^ User sees WHAT will happen, not WHAT TO CONFIGURE.                │
│    Modify mode opens the rule editor (shown in Section 4 above).     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Filter dry-run is built INTO the proposal. The "237 of 252" number comes from running the filter preview API (`POST /filters/preview`) with the recommended rules during proposal generation. Every rule shows:

1. How many files it affects
2. Which specific files (expandable)
3. Where the rule is evaluated (pre-fetch OData vs. post-fetch local)
4. Whether it saves API calls

---

## 7. Connection Health Check — 6-Axis Validation

Inspired by the Moveworks 6-axis connection validation pattern. Each axis is independently testable and has clear pass/fail criteria with remediation.

| Axis                  | What It Tests                                  | Pass Criteria                          | Fail Remediation                                               |
| --------------------- | ---------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| 1. Authentication     | Token was acquired and is valid                | Token present, not expired             | Re-authenticate, check app registration                        |
| 2. Permissions        | Graph scopes granted to the app                | Sites.Read.All minimum                 | Add permissions in Azure Portal, grant admin consent           |
| 3. Connectivity       | Network path to Microsoft Graph API            | GET /v1.0/me returns 200, <500ms       | Check firewall, proxy, DNS. Show exact error.                  |
| 4. Site Access        | Can enumerate and read at least one site       | GET /v1.0/sites returns >0 results     | Check site permissions, tenant configuration                   |
| 5. Rate Limit         | Sufficient API budget for discovery + sync     | Retry-After not present, <50% of quota | Reduce concurrent connectors, increase sync interval           |
| 6. Platform Readiness | Internal services (vector store, disk, queues) | All downstream services healthy        | Check Docker services, disk space, Redis/MongoDB/vector status |

```
Health Check Evaluation Logic:

  Axis 1 FAIL → Block. Cannot proceed without valid auth.
  Axis 2 FAIL → Block if no Sites.Read.All. Warn if missing optional scopes.
  Axis 3 FAIL → Block. Network issue must be resolved.
  Axis 4 FAIL → Block. No accessible sites means nothing to sync.
  Axis 5 WARN → Allow with warning. "Discovery may be slow due to throttling."
  Axis 6 FAIL → Block. Internal platform issue, user cannot fix from UI.
             → Show: "Platform services are unavailable. Contact your admin."
```

---

## 8. Dry-Run / Sample Documents

The proposal includes a sample document preview as Section 7. This is NOT a separate feature — it is part of the proposal itself.

**How it works technically:**

1. During proposal generation, after discovery + profiling completes, the system selects a representative sample of 15-20 documents
2. Selection strategy: proportional to site size, covers all file types found, includes both large and small files
3. For each sample document, the system fetches metadata only (no content download) — name, type, size, modified date, author, custom metadata columns
4. Custom SharePoint metadata columns are detected during profiling (e.g., "Department", "Sensitivity") and surfaced in the "Metadata detected" section
5. The sample serves as: (a) proof that sync will work, (b) preview of what users will find in search, (c) validation that filters are correct

```
Sample Document Selection Algorithm:

  total_sample = 15
  per_site = total_sample / num_selected_sites  (proportional to file count)

  For each site:
    Pick 1 of each unique file type found (up to per_site allocation)
    Fill remaining slots with random selection weighted toward recent files
    Include the largest file in the site (to surface size concerns)

  Apply current filter rules to the sample:
    Mark excluded files as "would be excluded by Rule X"
    This validates filters against real data
```

**Metadata discovery:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Custom SharePoint metadata detected:                                   │
│                                                                         │
│  Column Name     Coverage    Example Values        Available for Filter │
│  Department       45%        "Marketing", "Sales"  ✅ Yes                │
│  Sensitivity      23%        "Internal", "Conf."   ✅ Yes                │
│  ProjectCode      12%        "PRJ-001", "PRJ-042"  ✅ Yes                │
│  ApprovalStatus    8%        "Draft", "Approved"    ✅ Yes                │
│                                                                         │
│  These columns are available in Advanced Rules (Section 3 → Modify)     │
│  Example: metadata.sharepoint.Department == "Marketing"                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Error States

### Error: Discovery Timeout (1000+ Sites)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                                                 │
│                                                                         │
│  Generating Your Configuration Proposal                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ⚠ Discovery is taking longer than expected.                     │   │
│  │                                                                  │   │
│  │  Found so far: 847 sites (still scanning...)                     │   │
│  │  Elapsed: 3:45 · Your tenant has a large number of sites.       │   │
│  │                                                                  │   │
│  │  Options:                                                        │   │
│  │                                                                  │   │
│  │  [Continue waiting]                                              │   │
│  │  Discovery will complete eventually. Large tenants can take      │   │
│  │  5-10 minutes.                                                   │   │
│  │                                                                  │   │
│  │  [Generate partial proposal with 847 sites]                      │   │
│  │  Stop scanning and work with what we've found. You can           │   │
│  │  re-discover later to find remaining sites.                      │   │
│  │                                                                  │   │
│  │  [Cancel and start over]                                         │   │
│  │  Delete this connector and try again.                            │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Error: Authentication Expired During Proposal Review

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CONFIGURATION PROPOSAL                                                 │
│                                                                         │
│  ┌─ ⚠ Session Warning ────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Your authentication token expires in 8 minutes.                 │   │
│  │  The proposal is saved — you won't lose your work.              │   │
│  │                                                                  │   │
│  │  [Re-authenticate now]  [Continue — I'll re-auth before approve]│   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ... (rest of proposal continues below) ...                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Error: Graph API Throttling During Discovery

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ┌─ ⚠ Rate Limit Reached ─────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Microsoft Graph API is throttling our requests.                 │   │
│  │  This is normal for tenants with many sites/files.               │   │
│  │                                                                  │   │
│  │  Discovery paused. Resuming automatically in 47 seconds...       │   │
│  │  (Microsoft asks us to wait via Retry-After header)              │   │
│  │                                                                  │   │
│  │  Completed: 3 of 5 sites profiled                                │   │
│  │  Remaining: ~2 minutes after cooldown                            │   │
│  │                                                                  │   │
│  │  [Generate partial proposal]  [Keep waiting]                     │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Error: Sync Failure After Approval

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Source: SharePoint (Marketing KB)                                      │
│                                                                         │
│  ┌─ ❌ Sync Failed ───────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  First sync failed after processing 42 of 237 documents.        │   │
│  │                                                                  │   │
│  │  Error: Token expired during sync (60 min limit exceeded)        │   │
│  │                                                                  │   │
│  │  What happened:                                                  │   │
│  │  Large files in Sales Team Site took longer to download than     │   │
│  │  expected. The OAuth token expired before sync completed.        │   │
│  │                                                                  │   │
│  │  42 documents were successfully synced and are searchable.       │   │
│  │  195 documents remain pending.                                   │   │
│  │                                                                  │   │
│  │  [Re-authenticate & Resume]                                      │   │
│  │  Continues from where it stopped (checkpoint saved)              │   │
│  │                                                                  │   │
│  │  [Re-authenticate & Restart]                                     │   │
│  │  Starts sync from scratch                                        │   │
│  │                                                                  │   │
│  │  [View Proposal] — review/modify configuration                   │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Consecutive failures: 1 of 5 (auto-pauses at 5)                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Error: Connector Deleted From Azure Side

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ┌─ ❌ Connection Lost ───────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Cannot connect to Microsoft Graph.                              │   │
│  │  Error: AADSTS700016 — Application not found in tenant.          │   │
│  │                                                                  │   │
│  │  This usually means the Azure App Registration was deleted       │   │
│  │  or the Client ID is incorrect.                                  │   │
│  │                                                                  │   │
│  │  Steps to resolve:                                               │   │
│  │  1. Verify the App Registration exists in Azure Portal           │   │
│  │  2. Check Client ID: 1a2b3c4d-... matches Azure Portal          │   │
│  │  3. If deleted, create a new App Registration                    │   │
│  │                                                                  │   │
│  │  [Update Client ID]  [Delete Connector]                          │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Empty States

### No SharePoint Sites Found

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                                                 │
│                                                                         │
│  SharePoint Connection Health Check                                     │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  4. Site Access             ⚠ WARNING                            │   │
│  │     0 sites found with current permissions.                      │   │
│  │                                                                  │   │
│  │     Possible causes:                                             │   │
│  │     • No SharePoint sites exist in this tenant                   │   │
│  │     • Your permissions don't include any sites                   │   │
│  │     • Sites.Selected is configured but no sites are granted      │   │
│  │                                                                  │   │
│  │     Verify in SharePoint admin center that sites exist           │   │
│  │     and the authenticated user has access.                       │   │
│  │                                                                  │   │
│  │     [Open SharePoint Admin Center ↗]  [Re-authenticate]          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Site With Zero Indexable Documents

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SECTION 2: SYNC SCOPE                                                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ☐ IT Infrastructure                                             │   │
│  │    0 indexable files · 3 files total · 0.1 GB                    │   │
│  │    All files are unsupported types: .vsdx (2), .dwg (1)         │   │
│  │    No content would be synced from this site.                    │   │
│  │    ℹ If you need Visio/CAD support, contact us.                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### No Connectors Yet (Data Tab)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Data Sources                                                    [+ Add]│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                                                                         │
│                     No data sources yet                                  │
│                                                                         │
│       Add files, URLs, or connect enterprise sources                    │
│       like SharePoint to populate your knowledge base.                  │
│                                                                         │
│       [Upload Files]  [Add URL]  [Connect SharePoint]                   │
│                                                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Sync Complete But Zero Documents Indexed

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Source: SharePoint (Marketing KB)                                      │
│                                                                         │
│  ┌─ Sync Complete — 0 documents indexed ──────────────────────────┐   │
│  │                                                                  │   │
│  │  Sync ran successfully but no documents were indexed.            │   │
│  │                                                                  │   │
│  │  252 documents scanned:                                          │   │
│  │  • 237 excluded by filters                                       │   │
│  │  • 12 unsupported file types                                     │   │
│  │  • 3 empty files (0 bytes)                                       │   │
│  │  • 0 indexed                                                     │   │
│  │                                                                  │   │
│  │  Your filter rules may be too aggressive.                        │   │
│  │  [Review Proposal]  [Reset Filters to Defaults]                  │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Multi-Connector Story

### Cloning a Proposal

When a user has one working connector and wants to add another (e.g., a second SharePoint tenant or a different site selection for a different KB):

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Data Sources                    [Export as PDF]  [Clone]     │
│                                                                         │
│  ┌── Clone Proposal ──────────────────────────────────────────────┐    │
│  │                                                                 │    │
│  │  Clone this proposal as a starting point for a new connector.   │    │
│  │                                                                 │    │
│  │  What to clone:                                                 │    │
│  │  ☑ Filter rules (exclude archives, >50 MB, executables)         │    │
│  │  ☑ File type allowlist (27 types)                               │    │
│  │  ☑ Sync schedule (hourly + webhooks)                            │    │
│  │  ☐ Site selection (new connector will need its own sites)       │    │
│  │  ☐ Authentication (new connector needs its own auth)            │    │
│  │                                                                 │    │
│  │  Target:                                                        │    │
│  │  ( ) Same tenant, different sites                               │    │
│  │  ( ) Different tenant (e.g., subsidiary, partner)               │    │
│  │  ( ) Same settings, different knowledge base                    │    │
│  │                                                                 │    │
│  │  [Clone & Start Setup]  [Cancel]                                │    │
│  │                                                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Multi-Connector Monitoring Dashboard

When a KB has multiple SharePoint connectors:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Data Sources                                                    [+ Add]│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  SharePoint Connectors (3)                          [View All Health]   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ● Marketing KB (Contoso)                                        │   │
│  │    3 sites · 237 docs · Last sync: 12 min ago · ● Healthy        │   │
│  │                                                                  │   │
│  │  ● Engineering Docs (Contoso)                                    │   │
│  │    1 site · 128 docs · Last sync: 45 min ago · ● Healthy         │   │
│  │                                                                  │   │
│  │  ⚠ Partner Portal (Fabrikam)                                     │   │
│  │    2 sites · 89 docs · Last sync: 3 days ago · ⚠ Token expiring │   │
│  │    Token expires in 2 days. [Re-authenticate]                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Combined: 6 sites · 454 docs · 15.2 GB indexed                        │
│                                                                         │
│  Other Sources                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ● Uploaded Files — 23 files · 45 MB                             │   │
│  │  ● Web Crawl (docs.company.com) — 156 pages · 12 MB              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Multiple Tenants in One KB

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint                                                │
│                                                                         │
│  ┌── Tenant Configuration ────────────────────────────────────────┐    │
│  │                                                                 │    │
│  │  You already have a SharePoint connector for Contoso.           │    │
│  │                                                                 │    │
│  │  ( ) Add sites from Contoso (same tenant, same auth)            │    │
│  │      → Modifies existing connector's site selection             │    │
│  │                                                                 │    │
│  │  (●) Connect a different tenant                                 │    │
│  │      → Creates a new connector with separate authentication     │    │
│  │      → Each tenant has its own App Registration                 │    │
│  │                                                                 │    │
│  │  Tenant ID (Directory ID)                                       │    │
│  │  ┌──────────────────────────────────────────────────────┐      │    │
│  │  │ e.g. different-tenant-guid                           │      │    │
│  │  └──────────────────────────────────────────────────────┘      │    │
│  │                                                                 │    │
│  │  ℹ Cross-tenant search: Documents from all tenants appear      │    │
│  │    in the same KB search results. Permission-aware search       │    │
│  │    is per-connector (each tenant enforces its own ACLs).        │    │
│  │                                                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Security Review = Export Proposal

The proposal IS the security review document. Maria (security reviewer) receives an exported PDF that is the annotated proposal with security-relevant details highlighted.

### Export Flow

```
User clicks [Export as PDF] on any proposal (draft or approved)

┌─────────────────────────────────────────────────────────────────────────┐
│  Export Configuration Proposal                                          │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Export format:                                                   │   │
│  │  (●) Security Review (includes risk assessments, justifications) │   │
│  │  ( ) Technical Summary (compact, for team reference)             │   │
│  │                                                                  │   │
│  │  Include in export:                                               │   │
│  │  ☑ Permission details with risk assessments                      │   │
│  │  ☑ Data scope (sites, document count, types)                     │   │
│  │  ☑ Filter rules and exclusions                                   │   │
│  │  ☑ Sync schedule and API usage estimates                         │   │
│  │  ☑ Sample documents preview                                      │   │
│  │  ☑ Health check results                                          │   │
│  │  ☑ Data handling policy (retention, encryption, deletion)        │   │
│  │  ☑ Azure AD app registration details                             │   │
│  │  ☑ Admin consent instructions                                    │   │
│  │                                                                  │   │
│  │  [Download PDF]                                                  │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Exported Security Review Document (PDF Content)

```
══════════════════════════════════════════════════════════════════════
SHAREPOINT CONNECTOR — SECURITY REVIEW DOCUMENT
══════════════════════════════════════════════════════════════════════

Generated:    March 22, 2026
Application:  ABL Platform — Marketing Knowledge Base
Requested by: john@contoso.com
Connector:    SharePoint → Contoso tenant

──────────────────────────────────────────────────────────────────────
1. AZURE AD APP REGISTRATION
──────────────────────────────────────────────────────────────────────

App Name:     ABL Platform — SharePoint Connector
Client ID:    1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d
Tenant ID:    72f988bf-86f1-41af-91ab-2d7cd011db47
Auth Method:  Device Code (delegated)
Authenticated by: john@contoso.com

──────────────────────────────────────────────────────────────────────
2. PERMISSIONS — CURRENT & REQUESTED
──────────────────────────────────────────────────────────────────────

CURRENTLY GRANTED:
✅ Sites.Read.All (Delegated)
   Purpose: Read content from SharePoint sites
   Scope: All sites the authenticated user has access to
   Risk: LOW — read-only access to site content

✅ offline_access (Delegated)
   Purpose: Refresh tokens without re-authentication
   Scope: Token management
   Risk: LOW — standard OAuth requirement

✅ User.Read (Delegated)
   Purpose: Identify the authenticated user
   Scope: Current user profile only
   Risk: LOW — minimal scope

ADDITIONAL PERMISSIONS REQUESTED:
☐ Sites.FullControl.All (Application)
   Purpose: Read document-level permission ACLs
   Scope: Full control over all sites (BROAD)
   Risk: HIGH scope — the permission name implies write access,
   but our application uses it READ-ONLY to enumerate
   document-level permissions for search filtering.
   Microsoft does not offer a narrower scope for reading
   item-level permissions. We never create, modify, or delete
   any SharePoint content or permissions.
   Mitigation: Application code is read-only. Audit logs track
   all Graph API calls. No write endpoints are called.
   Alternative: Sites.Selected (per-site, requires admin PowerShell
   grants) — not yet supported by our platform.

☐ Directory.Read.All (Application)
   Purpose: Resolve Azure AD group memberships
   Scope: Read all users and groups in directory
   Risk: MEDIUM — exposes organizational structure
   Mitigation: Only group membership is queried. User profile
   details (phone, address, etc.) are not accessed.

──────────────────────────────────────────────────────────────────────
3. DATA ACCESS SCOPE
──────────────────────────────────────────────────────────────────────

Sites accessed:
• Marketing Hub (42 files, 3.2 GB)
• Engineering Wiki (128 files, 1.1 GB)
• Sales Team Site (67 files, 5.4 GB)

Total: 237 documents, 8.8 GB
File types: PDF, DOCX, PPTX, XLSX, HTML, MD, TXT, CSV

──────────────────────────────────────────────────────────────────────
4. DATA HANDLING
──────────────────────────────────────────────────────────────────────

Storage: Documents are downloaded, processed (text extraction,
chunking, embedding), then stored as:
• Raw content: Encrypted at rest (AES-256), stored in platform
  object storage with tenant isolation
• Embeddings: Vector store (tenant-isolated index)
• Metadata: MongoDB (tenant-isolated collection)

Retention: Content is retained as long as the connector is active.
Deleting the connector removes all synced content, metadata, and
embeddings within 24 hours (cleanup job).

Encryption: TLS 1.3 in transit. AES-256-GCM at rest.
OAuth tokens: AES-256-GCM encrypted, stored in MongoDB.

Data minimization: Only document content and metadata required for
search are stored. User PII from SharePoint is not retained beyond
permission ACL entries.

Token revocation: Revoking the Azure AD app registration or the
user's consent immediately invalidates all access. Existing synced
content remains until manually deleted.

──────────────────────────────────────────────────────────────────────
5. APPROVAL
──────────────────────────────────────────────────────────────────────

To approve additional permissions:
1. Go to Azure Portal > App Registrations
2. Find app: 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d
3. API Permissions > Add a permission > Microsoft Graph
4. Add: Sites.FullControl.All (Application), Directory.Read.All
5. Click "Grant admin consent for [organization]"

☐ Approved by: ______________________  Date: ______________

══════════════════════════════════════════════════════════════════════
```

---

## 13. Backend Requirements

### New APIs Required

| #   | Endpoint                                         | Method | Purpose                                       | Priority |
| --- | ------------------------------------------------ | ------ | --------------------------------------------- | -------- |
| 1   | `POST /connectors/:id/health-check`              | POST   | Run 6-axis validation, return results         | MUST     |
| 2   | `GET /connectors/:id/proposal`                   | GET    | Get generated proposal (or generation status) | MUST     |
| 3   | `POST /connectors/:id/proposal/generate`         | POST   | Trigger proposal generation (async)           | MUST     |
| 4   | `PUT /connectors/:id/proposal/sections/:section` | PUT    | Update section decision (accept/modify/skip)  | MUST     |
| 5   | `POST /connectors/:id/proposal/approve`          | POST   | Approve proposal and start sync               | MUST     |
| 6   | `GET /connectors/:id/proposal/sample-documents`  | GET    | Get sample documents for dry-run preview      | MUST     |
| 7   | `POST /connectors/:id/proposal/export`           | POST   | Generate PDF export of proposal               | SHOULD   |
| 8   | `POST /connectors/:id/proposal/clone`            | POST   | Clone proposal settings to new connector      | SHOULD   |
| 9   | `GET /connectors/:id/metadata-columns`           | GET    | Discover custom SharePoint metadata columns   | SHOULD   |

### New Models

| Model               | Fields                                                                                                                                                                | Purpose                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `ConnectorProposal` | `connectorId`, `status` (draft/approved/expired), `sections[]`, `healthCheckResult`, `generatedAt`, `approvedAt`, `exportedAt`                                        | Stores the proposal document |
| `ProposalSection`   | `type` (permissions/scope/filters/types/schedule/permSync/sample), `decision` (pending/accepted/modified/skipped), `recommendation`, `userModifications`, `reasoning` | Per-section state            |
| `HealthCheckResult` | `axes[]` (auth/permissions/connectivity/siteAccess/rateLimit/platform), each with `status`, `details`, `remediation`                                                  | 6-axis validation results    |

### Changes to Existing APIs

| Existing Endpoint                      | Change                                                |
| -------------------------------------- | ----------------------------------------------------- |
| `POST /connectors/:id/discover`        | Add streaming SSE support for site-by-site progress   |
| `POST /connectors/:id/filters/preview` | Already exists — wire into proposal generation        |
| `GET /connectors/:id/sync/status`      | Add `consecutiveFailures` count and `autoPausedAt`    |
| Discovery worker                       | Add custom metadata column detection during profiling |

### Existing APIs That Need to Be Wired

| Item                             | Current State                                 | Needed For            |
| -------------------------------- | --------------------------------------------- | --------------------- |
| `startScheduledJobs()`           | Never called from `server.ts`                 | Sync schedule         |
| `webhooks.ts` routes             | Never mounted in `server.ts`                  | Webhook notifications |
| `webhook-notification-worker.ts` | Never started in `workers/`                   | Webhook processing    |
| Auto-pause logic                 | `consecutiveFailures` tracked but not checked | Sync reliability      |
| Permission probing               | Not implemented                               | Health check axis 2   |

### Effort Estimates

| Priority | Items                                                                              | Effort        |
| -------- | ---------------------------------------------------------------------------------- | ------------- |
| MUST     | Health check API, proposal CRUD, section decisions, generation worker, sample docs | L (2-3 weeks) |
| MUST     | Wire scheduler, wire webhooks, auto-pause, permission probing                      | M (1 week)    |
| SHOULD   | PDF export, clone, metadata discovery, streaming discovery                         | M (1 week)    |
| NICE     | CEL expression editor, multi-tenant awareness, Sites.Selected support              | L (future)    |

---

## 14. Issues Addressed — Full Checklist

| #   | Issue                                             | Severity | How Design B Addresses It                                                                                                                                                       |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No Azure App Registration guidance                | CRITICAL | Screen 1a: Full step-by-step setup guide with "Don't have an App Registration?" link. Includes admin consent instructions and email template for requesting consent from admin. |
| 2   | Device code != admin consent conflated            | CRITICAL | Screen 1a Step 5 explicitly separates admin consent from authentication. Device code screen (1b) warns about AADSTS65001 consent errors.                                        |
| 3   | Sites.FullControl.All mitigation misleading       | CRITICAL | Section 1 and Section 6 of proposal explain honestly: scope is broad, we use read-only, Microsoft offers no narrower option. Security export includes full risk assessment.     |
| 4   | Error states completely unspecified               | CRITICAL | Section 9: Six error wireframes covering auth expiry, throttling, sync failure, discovery timeout, connection lost, and consent errors.                                         |
| 5   | Discovery timeout for 1000+ sites                 | CRITICAL | Screen 3: Streaming discovery with per-site progress. Timeout offers "generate partial proposal" with already-discovered sites. Cancel available at all times.                  |
| 6   | No dry-run/preview before sync                    | CRITICAL | Section 7 of proposal: Sample Documents showing 15 real documents with metadata. Filter section shows exactly which files are included/excluded with counts and names.          |
| 7   | Sites.Selected not supported                      | CRITICAL | Section 1 and Section 6 acknowledge Sites.Selected exists, explain why it's not yet supported (requires per-site admin PowerShell grants), offer "contact support" path.        |
| 8   | "Proposal" was a pre-filled form                  | HIGH     | THIS IS THE CORE FIX. Proposal is a full-page document with 7 sections, each with Accept/Modify/Skip. Per-section reasoning. Progress bar. Export as PDF. Clone capability.     |
| 9   | No bulk/clone/template for multi-connector        | HIGH     | Section 11: Clone proposal flow. Checkboxes for what to clone (filters, schedule, types). Target selection (same tenant, different tenant, different KB).                       |
| 10  | No filter dry-run/preview                         | HIGH     | Section 3 of proposal shows "237 of 252 documents" with exact exclusion counts per rule. Modify mode has "Live impact" counter. Preview excluded files expandable.              |
| 11  | Security doc missing data handling/retention      | HIGH     | Section 12: Exported PDF includes Section 4 "Data Handling" with storage, retention, encryption, minimization, and token revocation policies.                                   |
| 12  | Competitive claims overstated                     | HIGH     | Removed from design doc. No competitor comparison claims. Design stands on its own merits.                                                                                      |
| 13  | Graph API throttling unaddressed                  | HIGH     | Health check axis 5 (Rate Limit Headroom). Error state for throttling during discovery with Retry-After countdown. Proposal shows estimated API usage per sync.                 |
| 14  | Pre-fetch/post-fetch leaks implementation details | HIGH     | Filter section uses "Where rules are evaluated" with user-friendly language: "reduces API calls" for pre-fetch, "evaluates locally" for post-fetch. No OData terminology.       |
| 15  | No connection validation checklist (6-axis)       | HIGH     | Screen 2: Full 6-axis health check with pass/fail per axis, remediation instructions, and blocking logic. Runs BEFORE proposal generation.                                      |
| 16  | Custom SharePoint metadata not discoverable       | HIGH     | Section 8: Metadata discovery during profiling. Shows column name, coverage %, example values, and "Available for Filter" indicator. Feeds into advanced rules.                 |
| 17  | No multi-connector monitoring dashboard           | HIGH     | Section 11: Multi-connector view in Data Sources tab. Combined stats. Per-connector health status. Token expiry warnings.                                                       |
| 18  | Empty states undefined                            | HIGH     | Section 10: Five empty state wireframes — no sites, no indexable docs, no connectors, zero-result sync, and site with unsupported types only.                                   |
| 19  | Loading states incomplete                         | HIGH     | Screen 3: Streaming discovery with per-site progress, elapsed/estimated time, cancel option. Health check shows per-axis completion. Throttle cooldown countdown.               |
| 20  | Multiple tenants in one KB not addressed          | HIGH     | Section 11: Explicit multi-tenant flow. "Connect a different tenant" option. Cross-tenant search explanation. Per-connector permission enforcement.                             |
| 21  | Proposal should be full page, not dialog          | HIGH     | Screen 4: Proposal is a FULL PAGE with navigation breadcrumb. Section progress bar. Scrollable document with sticky summary footer. Export and Clone in header.                 |
