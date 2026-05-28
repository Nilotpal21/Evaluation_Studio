# Design A: Zero-Config Smart — SharePoint Connector

**Date:** 2026-03-22
**Philosophy:** The system does everything it can automatically. The user connects, approves, and monitors. Configuration exists for power users but is never required.

Inspired by ChatGPT Enterprise and Glean: minimize user input, maximize system intelligence. Every decision the system can make automatically, it should. The user's job is to connect and approve, not configure.

---

## 1. Philosophy Statement

**The best configuration is the one the user never has to make.** The system connects, discovers, recommends, and syncs with a single approval step. Advanced settings exist on a separate page for the 10% who need them, but the default path is: connect, approve, done.

**Transparency without burden.** The system shows what it found and what it will do, but as a confirmation screen, not a form. The user sees a summary and clicks "Start Sync" — not a multi-section proposal they must review line by line.

---

## 2. User Flow Diagram

```
                              ┌─────────────────────┐
                              │   Add Source > SP    │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Role Detection      │
                              │  "Are you the Azure  │
                              │   AD admin?"         │
                              └───┬─────────────┬────┘
                                  │             │
                          ┌───────▼───┐   ┌─────▼──────────┐
                          │ YES: Self │   │ NO: Invite      │
                          │  Setup    │   │  IT Admin       │
                          └───────┬───┘   └─────┬──────────┘
                                  │             │
                                  │     ┌───────▼──────────┐
                                  │     │ Email/link sent   │
                                  │     │ to IT admin with  │
                                  │     │ setup guide       │
                                  │     └───────┬──────────┘
                                  │             │
                              ┌───▼─────────────▼───┐
                              │  App Registration    │
                              │  (guided or pasted)  │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Permission Choice   │
                              │  Sites.Selected      │◄── default (least priv)
                              │  Sites.Read.All      │
                              │  Sites.FullControl   │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Authenticate        │
                              │  (OAuth / Device     │
                              │   Code / Creds)      │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Auto-Discovery      │
                              │  (streaming results) │
                              │  Cancel anytime      │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Confirmation Screen │
                              │  "Here's what we     │
                              │   found. Start sync?"│
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Dry-Run Preview     │
                              │  (mandatory first    │
                              │   time — 25 samples) │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Sync Running        │
                              │  → Monitor Dashboard │
                              └─────────────────────┘
```

---

## 3. Screen-by-Screen Wireframes

### Screen 1: Add Source — Role Detection

When the user selects SharePoint from the source picker, the first thing we ask is their role. This determines the entire flow.

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint                               [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SharePoint connects your Microsoft 365 documents to this   │
│  knowledge base. It requires an Azure App Registration.     │
│                                                              │
│  Who will set up the Azure connection?                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  (●) I'll do it myself                                 │  │
│  │      I have access to Azure Portal or my IT team       │  │
│  │      already created an App Registration for me.       │  │
│  │                                                        │  │
│  │  ( ) I need help from my IT admin                      │  │
│  │      Send setup instructions to your IT team.          │  │
│  │      They'll create the App Registration and share     │  │
│  │      the credentials back with you.                    │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                                        [Cancel]  [Next ->]   │
└──────────────────────────────────────────────────────────────┘
```

### Screen 1b: Invite IT Admin Flow

If the user selects "I need help from my IT admin":

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Invite IT Admin             [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Send setup instructions to your IT admin                    │
│                                                              │
│  IT Admin's email                                            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ admin@contoso.com                                    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Optional message                                            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Hi — I'm setting up SharePoint search for our       │    │
│  │ Marketing KB. Can you create the app registration?   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  What they'll receive:                                       │
│  - Step-by-step Azure App Registration guide                 │
│  - Required API permissions (Sites.Selected by default)      │
│  - A secure link to paste the Client ID and Tenant ID        │
│  - The link expires in 7 days                                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Or copy the setup guide link to share manually:     │    │
│  │  https://app.abl.ai/setup/sp/abc123   [Copy Link]   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│                                 [<- Back]  [Send Invite ->]  │
└──────────────────────────────────────────────────────────────┘
```

### Screen 1c: IT Admin Landing Page (accessed via invite link)

```
┌──────────────────────────────────────────────────────────────┐
│  ABL Platform — SharePoint App Registration Setup            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  John from your team is setting up SharePoint search.        │
│  Please create an Azure App Registration with these steps:   │
│                                                              │
│  Step 1: Create App Registration                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  1. Go to Azure Portal > App Registrations             │  │
│  │  2. Click "New Registration"                           │  │
│  │  3. Name: "ABL SharePoint Connector"                   │  │
│  │  4. Supported account types: Single tenant             │  │
│  │  5. Redirect URI: https://app.abl.ai/auth/callback     │  │
│  │                                                        │  │
│  │  [Open Azure Portal ->]                                │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Step 2: Add API Permissions                                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Microsoft Graph > Application permissions:            │  │
│  │                                                        │  │
│  │  RECOMMENDED (least privilege):                        │  │
│  │  [x] Sites.Selected — Access only approved sites       │  │
│  │                                                        │  │
│  │  OPTIONAL (broader access):                            │  │
│  │  [ ] Sites.Read.All — Read all sites                   │  │
│  │  [ ] Sites.FullControl.All — Needed for permission     │  │
│  │      sync (access-controlled search results)           │  │
│  │  [ ] Directory.Read.All — Needed for group membership  │  │
│  │                                                        │  │
│  │  Click "Grant admin consent" after adding permissions.  │  │
│  │                                                        │  │
│  │  NOTE: Device code flow authenticates a user — it      │  │
│  │  does NOT grant admin consent. Admin consent must be   │  │
│  │  granted separately in Azure Portal.                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Step 3: Share Credentials                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Client ID (Application ID)                            │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │                                                  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  Tenant ID (Directory ID)                              │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │                                                  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  Which permissions did you grant?                      │  │
│  │  [x] Sites.Selected                                   │  │
│  │  [ ] Sites.Read.All                                   │  │
│  │  [ ] Sites.FullControl.All                            │  │
│  │  [ ] Directory.Read.All                               │  │
│  │                                                        │  │
│  │                                  [Submit Credentials]  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  This link expires in 6 days, 14 hours.                      │
│  Data is encrypted end-to-end.                               │
└──────────────────────────────────────────────────────────────┘
```

### Screen 2: App Registration (Self-Setup Path)

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Connect                     [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Azure App Registration                                      │
│                                                              │
│  Don't have one? [Follow our setup guide ->]                 │
│                                                              │
│  Client ID (Application ID)                                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                                                      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Tenant ID (Directory ID)                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                                                      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Permission level                                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  (●) Sites.Selected (recommended)                      │  │
│  │      Most restrictive. You approve each site           │  │
│  │      individually in Azure Portal.                     │  │
│  │      Best for: security-conscious orgs, pilot setups   │  │
│  │                                                        │  │
│  │  ( ) Sites.Read.All                                    │  │
│  │      Read access to all SharePoint sites.              │  │
│  │      Best for: broad content ingestion                 │  │
│  │                                                        │  │
│  │  ( ) Sites.FullControl.All + Directory.Read.All        │  │
│  │      Full access. Enables permission-aware search      │  │
│  │      (users only see docs they have access to).        │  │
│  │      Best for: enterprise with strict access control   │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Authentication method                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  (●) Browser Login — sign in now with your Microsoft   │  │
│  │      account (easiest)                                 │  │
│  │                                                        │  │
│  │  ( ) Device Code — share a code with whoever needs     │  │
│  │      to authenticate (good for delegation)             │  │
│  │                                                        │  │
│  │  ( ) App-Only (Client Credentials) — automated setup   │  │
│  │      with client secret (no user context)              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                                  [<- Back]  [Connect ->]     │
└──────────────────────────────────────────────────────────────┘
```

### Screen 2b: Setup Guide (expandable inline or separate page)

```
┌──────────────────────────────────────────────────────────────┐
│  Azure App Registration — Quick Setup Guide            [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Estimated time: 5 minutes                                   │
│                                                              │
│  1. Open Azure Portal                                        │
│     [Open Azure Portal ->]                                   │
│     Go to "App Registrations" > "New Registration"           │
│                                                              │
│  2. Register the app                                         │
│     Name: ABL SharePoint Connector (or any name)             │
│     Account type: Accounts in this org directory only        │
│     Redirect URI: Web > https://app.abl.ai/auth/callback     │
│                                                              │
│  3. Copy credentials                                         │
│     From the Overview page, copy:                            │
│     - Application (client) ID                                │
│     - Directory (tenant) ID                                  │
│                                                              │
│  4. Add permissions                                          │
│     Go to "API Permissions" > "Add a permission"             │
│     > Microsoft Graph > Application permissions              │
│                                                              │
│     For Sites.Selected (recommended):                        │
│       Add: Sites.Selected                                    │
│       Then grant access to specific sites via:               │
│       Graph API or SharePoint Admin Center                   │
│                                                              │
│     For Sites.Read.All:                                      │
│       Add: Sites.Read.All                                    │
│                                                              │
│     Click "Grant admin consent for [Your Org]"               │
│                                                              │
│  5. (Optional) Create a client secret                        │
│     Only needed for App-Only auth method.                    │
│     Go to "Certificates & secrets" > "New client secret"     │
│                                                              │
│  IMPORTANT: "Grant admin consent" is a separate action       │
│  from authentication. An admin must click this button        │
│  in Azure Portal. The device code flow only authenticates    │
│  a user — it does NOT grant admin consent.                   │
│                                                              │
│  [Download as PDF]                          [Close]          │
└──────────────────────────────────────────────────────────────┘
```

### Screen 3: Authentication — Device Code

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Authenticate                [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Sign in with Microsoft                                      │
│                                                              │
│  Enter this code at microsoft.com/devicelogin:               │
│                                                              │
│         ┌──────────────┐                                     │
│         │  ABCD-EFGH   │   [Copy Code]                       │
│         └──────────────┘                                     │
│                                                              │
│  [Open Microsoft Login ->]                                   │
│                                                              │
│  --- Need someone else to authenticate? ---                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  [Share via Email]  [Copy Message]                     │  │
│  │                                                        │  │
│  │  Pre-written message:                                  │  │
│  │  "Please authenticate our SharePoint connector.        │  │
│  │   Go to microsoft.com/devicelogin and enter code       │  │
│  │   ABCD-EFGH. This code expires in 14 minutes.         │  │
│  │                                                        │  │
│  │   NOTE: This authenticates your user account for       │  │
│  │   read access. It does NOT grant admin consent         │  │
│  │   for the app — that must be done separately           │  │
│  │   in Azure Portal > App Registrations."                │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Code expires in 13:42                        * Waiting...   │
│                                                              │
│                                             [<- Back]        │
└──────────────────────────────────────────────────────────────┘
```

### Screen 4: Auto-Discovery (streaming results)

After authentication succeeds, discovery starts automatically. Results stream in as they are found, with a cancel button always visible.

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Discovering...              [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Analyzing your SharePoint environment...                    │
│                                                              │
│  Permissions detected: Sites.Read.All                        │
│  [x] Read documents    [x] Discover sites    [x] Delta sync │
│  [ ] Permission sync (needs Sites.FullControl.All)           │
│                                                              │
│  ── Sites found (streaming) ─────────────────────────────    │
│                                                              │
│  [x] Marketing Hub          42 files    3.2 GB   Active     │
│  [x] Engineering Wiki      128 files    1.1 GB   Active     │
│  [x] Sales Team Site        67 files    5.4 GB   Active     │
│  [x] Executive Comms        12 files    0.2 GB   Stale      │
│  ... discovering more sites                                  │
│                                                              │
│  ████████████░░░░░░░░  Profiling 4 of ? sites...            │
│                                                              │
│  TIP: You can uncheck sites you don't need.                  │
│  The system auto-selects sites with recent activity.         │
│                                                              │
│                    [Cancel Discovery]  [Skip — use defaults]  │
└──────────────────────────────────────────────────────────────┘
```

**After discovery completes (or user clicks Skip):**

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Discovering...              [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Discovery complete                                          │
│                                                              │
│  Permissions: Sites.Read.All                                 │
│  [x] Read documents    [x] Discover sites    [x] Delta sync │
│  [ ] Permission sync — [Learn how to enable ->]              │
│                                                              │
│  ── 5 sites found ───────────────────────────────────────    │
│                                                              │
│  [x] Marketing Hub          42 files    3.2 GB   2 days     │
│  [x] Engineering Wiki      128 files    1.1 GB   today      │
│  [x] Sales Team Site        67 files    5.4 GB   1 week     │
│  [ ] Executive Comms        12 files    0.2 GB   3 months   │
│  [ ] IT Infrastructure       3 files    0.1 GB   6 months   │
│                                                              │
│  The system deselected 2 stale sites (no updates in 90+     │
│  days). You can select them if needed.                       │
│                                                              │
│  3 sites selected -- 237 files -- 9.7 GB                     │
│  File types: 27 standard types included                      │
│  Sync: Every hour + webhooks (auto-detected)                 │
│                                                              │
│                    [Advanced Settings]  [Continue ->]         │
└──────────────────────────────────────────────────────────────┘
```

### Screen 4b: Discovery Cancelled / Timeout

If the user has 1000+ sites and discovery takes too long:

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Discovery                   [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Discovery found 247 sites so far (still running).           │
│                                                              │
│  Large SharePoint environments can take several minutes      │
│  to fully scan. You have three options:                      │
│                                                              │
│  (●) Use what we found so far (247 sites)                    │
│      You can add more sites later from settings.             │
│                                                              │
│  ( ) Keep waiting                                            │
│      Estimated: ~3 more minutes for full scan.               │
│                                                              │
│  ( ) Enter site URLs manually                                │
│      Paste SharePoint site URLs if you know them.            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Search sites:  [________________] [Search]            │  │
│  │                                                        │  │
│  │  [x] Marketing Hub        42 files    3.2 GB          │  │
│  │  [x] Engineering Wiki    128 files    1.1 GB          │  │
│  │  [x] Sales Team Site      67 files    5.4 GB          │  │
│  │  ... 244 more sites (scroll or search)                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                                          [Continue ->]       │
└──────────────────────────────────────────────────────────────┘
```

### Screen 5: Confirmation + Dry-Run Preview (mandatory first sync)

This is the Zero-Config Smart differentiator. Instead of a multi-section proposal, the user sees a compact confirmation with a mandatory dry-run preview showing sample documents.

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Confirm                     [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Ready to sync SharePoint                                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  WHAT WE'LL SYNC                                       │  │
│  │                                                        │  │
│  │  3 sites -- 237 files -- ~9.7 GB                       │  │
│  │  Marketing Hub, Engineering Wiki, Sales Team Site      │  │
│  │                                                        │  │
│  │  File types: 27 standard types (PDF, DOCX, PPTX...)   │  │
│  │  Folders: Everything (no exclusions)                   │  │
│  │  Schedule: Every hour + real-time webhooks             │  │
│  │  Permissions: Not synced (all KB users see all docs)   │  │
│  │                                                        │  │
│  │  Estimated first sync: ~5 minutes                      │  │
│  │                                                        │  │
│  │  [Change Sites]  [Advanced Settings]                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ── Preview: Sample Documents ───────────────────────────    │
│                                                              │
│  These are 25 real documents that will be synced:            │
│                                                              │
│  #   Name                    Site             Type   Size    │
│  1   Q4-Revenue-Report.pdf   Marketing Hub    PDF    2.1 MB │
│  2   API-Architecture.docx   Engineering      DOCX   450 KB │
│  3   Sales-Playbook.pptx     Sales Team       PPTX   8.3 MB │
│  4   Sprint-Retro.md         Engineering      MD     12 KB  │
│  5   Brand-Guidelines.pdf    Marketing Hub    PDF    15 MB  │
│  ... (20 more — scroll to see all)                           │
│                                                              │
│  3 files will be skipped:                                    │
│  - Architecture.vsdx (unsupported format)                    │
│  - Video-Intro.mp4 (unsupported format)                      │
│  - Q3-Report.xlsx (password protected — detected)            │
│                                                              │
│                         [<- Back]  [Approve & Start Sync ->] │
└──────────────────────────────────────────────────────────────┘
```

### Screen 6: Advanced Settings (separate page, not inline)

Accessible from the confirmation screen or later from the connector detail panel. This is where power users configure filters, rules, and schedules.

```
┌──────────────────────────────────────────────────────────────┐
│  SharePoint Connector > Advanced Settings             [X]    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [Sites]  [File Types]  [Folders]  [Schedule]  [Permissions] │
│  ─────────────────────────────────────────────────────────   │
│                                                              │
│  FILE TYPES                                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Currently: 27 standard types                          │  │
│  │                                                        │  │
│  │  Documents   [x] pdf [x] docx [x] pptx [x] xlsx      │  │
│  │  Text        [x] txt [x] csv  [x] md   [x] html      │  │
│  │  Email       [x] eml [x] msg                          │  │
│  │  Data        [x] json [x] xml [x] yaml                │  │
│  │  Other       [x] sql [x] log [x] rst                  │  │
│  │                                                        │  │
│  │  Your content breakdown:                               │  │
│  │  PDF 60%  DOCX 25%  PPTX 10%  Other 5%               │  │
│  │                                                        │  │
│  │  Always blocked: .exe .dll .bat .cmd .msi .scr         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  FOLDER RULES                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  No folder restrictions (syncing everything)           │  │
│  │                                                        │  │
│  │  Quick exclusions:                                     │  │
│  │  [+ Exclude Archives] [+ Exclude Backups]              │  │
│  │  [+ Exclude temp/draft folders]                        │  │
│  │                                                        │  │
│  │  Custom rules:                                         │  │
│  │  Include: [________________________________] [+ Add]   │  │
│  │  Exclude: [________________________________] [+ Add]   │  │
│  │                                                        │  │
│  │  Supports: * (any segment) ** (recursive) ? (char)     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ADVANCED CONDITIONS                                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  No conditions configured                              │  │
│  │                                                        │  │
│  │  [+ Add Condition]                                     │  │
│  │  [Field v]  [Operator v]  [Value___________]           │  │
│  │                                                        │  │
│  │  Fields: name, contentType, sizeBytes, modifiedAt,     │  │
│  │  createdAt, SharePoint metadata (author, sensitivity,  │  │
│  │  department, etc.)                                     │  │
│  │                                                        │  │
│  │  > CEL expression (expert)                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  FILTER PREVIEW                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  [Run Preview]                                         │  │
│  │                                                        │  │
│  │  Shows which files match your current filter config    │  │
│  │  without actually syncing. Useful after adding rules.  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                           [Cancel]  [Save & Return ->]       │
└──────────────────────────────────────────────────────────────┘
```

### Screen 7: Sync Running + Connector Dashboard

After the user approves, the dialog closes and they see the connector in the Data tab. Clicking it opens the monitoring panel.

```
┌──────────────────────────────────────────────────────────────┐
│  Data Sources                                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Source                Type         Status     Docs    Size  │
│  ─────────────────────────────────────────────────────────   │
│  SharePoint (3 sites)  SharePoint   Syncing    52/237  2.1G │
│  Training Docs         File Upload  Complete   45      120M │
│  Support Articles      Web Crawl    Complete   312     85M  │
│                                                              │
│                                            [+ Add Source]    │
└──────────────────────────────────────────────────────────────┘
```

### Screen 8: Connector Detail Panel (monitoring)

```
┌─ SharePoint (Marketing Hub + 2 sites) ───────────────────────┐
│                                                               │
│  ┌─ Status ───────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  ● Syncing — first sync in progress                     │  │
│  │  ████████████████░░░░░░░░  156 of 237 docs  (66%)      │  │
│  │  Elapsed: 2m 45s · Est. remaining: ~1m 30s              │  │
│  │                                                         │  │
│  │  [Pause]  [Stop]                                        │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Connection ───────────────────────────────────────────┐  │
│  │  ● Connected                       [Re-authenticate]    │  │
│  │  Method: Browser Login                                   │  │
│  │  Authenticated by: john@contoso.com · Mar 22, 2026       │  │
│  │  Token expires: Apr 15 (24 days) · Last used: now        │  │
│  │  Scopes: Sites.Read.All, offline_access                  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Content ──────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐       │  │
│  │  │  237   │  │  156   │  │   78   │  │    3   │       │  │
│  │  │ Total  │  │Indexed │  │Pending │  │ Failed │       │  │
│  │  └────────┘  └────────┘  └────────┘  └────────┘       │  │
│  │                                                         │  │
│  │  By site:                                                │  │
│  │  Marketing Hub ████████████████░░  42 docs   3.2 GB     │  │
│  │  Engineering   ████████░░░░░░░░░░ 128 docs   1.1 GB     │  │
│  │  Sales Team    ████░░░░░░░░░░░░░░  67 docs   5.4 GB     │  │
│  │                                                         │  │
│  │  By type: PDF 112 · DOCX 67 · PPTX 34 · Other 24      │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Issues (3) ───────────────────────────────────────────┐  │
│  │  Architecture.vsdx      Unsupported format (.vsdx)      │  │
│  │  Q3-Report.xlsx         Password protected              │  │
│  │  Video-Intro.mp4        Unsupported format (.mp4)       │  │
│  │                                          [Retry All]    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  > Sync History                                               │
│  > Configuration (3 sites, 27 types, no folder rules)         │
│  > Permissions (disabled — enable anytime)                     │
│  > Webhooks (3 subscriptions active)                           │
│  > Advanced Settings                                          │
│  > Throttle Status (Graph API: 245/600 calls used this min)   │
└───────────────────────────────────────────────────────────────┘
```

### Screen 9: Permission Upgrade Path

When the user wants to enable permission-aware search later:

```
┌──────────────────────────────────────────────────────────────┐
│  SharePoint > Permissions                              [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Permission-Aware Search                                     │
│                                                              │
│  Currently: DISABLED                                         │
│  All synced documents are searchable by all KB users.        │
│                                                              │
│  When enabled, search results respect SharePoint access      │
│  controls — users only see documents they have access to     │
│  in SharePoint.                                              │
│                                                              │
│  Requirements:                                               │
│  [ ] Sites.FullControl.All — read document permissions       │
│  [ ] Directory.Read.All — resolve group memberships          │
│  [ ] Admin consent granted in Azure Portal                   │
│                                                              │
│  NOTE: Sites.FullControl.All grants read AND write access    │
│  to all site data in the Graph API. Our connector only       │
│  reads permissions — it never modifies site content.         │
│  However, the token itself has write capability. Rotate       │
│  the token immediately if it is ever exposed.                │
│                                                              │
│  Options:                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  [Download Security Review Document]                   │  │
│  │  PDF with permission justifications, risk assessment,  │  │
│  │  and step-by-step Azure Portal instructions.           │  │
│  │  Give this to your security team for approval.         │  │
│  │                                                        │  │
│  │  [Invite IT Admin to Grant Permissions]                │  │
│  │  Send a guided link to your Azure AD admin.            │  │
│  │                                                        │  │
│  │  [I've Already Granted Permissions]                    │  │
│  │  Re-authenticate to pick up new permissions.           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                                                    [Close]   │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Permission Model

### Three Tiers with Upgrade Paths

| Permission Level             | What It Enables                                      | Who Should Use It                   | Discovery Behavior              |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------- | ------------------------------- |
| **Sites.Selected** (default) | Read only approved sites; must approve each in Azure | Security-first orgs, pilot projects | Only approved sites appear      |
| **Sites.Read.All**           | Read all sites; discover everything; delta sync      | Broad ingestion, most common        | All sites discovered            |
| **Sites.FullControl.All**    | Everything above + permission-aware search           | Enterprise with strict ACLs         | All sites + permissions crawled |

### Sites.Selected Support (Issue #7)

Sites.Selected is the Microsoft-recommended least-privilege permission. When selected:

1. Discovery only returns sites the app has been granted access to (via Graph API `POST /sites/{site-id}/permissions` or SharePoint Admin Center).
2. The confirmation screen explains: "Only sites you've approved in Azure Portal will appear. To add more sites, grant access in Azure Portal and re-run discovery."
3. If zero sites appear (app not approved for any), the system shows a clear error with instructions (see Error States below).

### Admin Consent vs. Authentication (Issue #2)

The system explicitly separates these concepts everywhere they appear:

- **Authentication** = proving who you are (device code, browser login). Any user can do this.
- **Admin consent** = granting the app permission to access data. Only an Azure AD admin can do this, and it must be done in Azure Portal.
- The device code sharing flow includes the note: "This authenticates your user account. It does NOT grant admin consent."
- The IT admin invite flow includes the explicit "Grant admin consent" step.

### Sites.FullControl.All Honesty (Issue #3)

The permission upgrade screen includes an honest risk disclosure:

> "Sites.FullControl.All grants read AND write access to all site data in the Graph API. Our connector only reads permissions — it never modifies site content. However, the token itself has write capability. Rotate the token immediately if it is ever exposed."

No misleading "read-only usage" mitigation claim. The risk is stated plainly.

---

## 5. Filter Architecture

### Zero-Config Defaults (covers 90% of users)

When a user completes the default flow without touching Advanced Settings, they get:

| Filter Layer     | Default                    | Rationale                                      |
| ---------------- | -------------------------- | ---------------------------------------------- |
| Sites            | Active sites auto-selected | Stale sites (90+ days inactive) deselected     |
| File types       | 27 standard types          | Covers all processable document formats        |
| Folder rules     | None (sync everything)     | Most users want everything from selected sites |
| Size limit       | 100 MB per file            | Prevents runaway large files                   |
| Date restriction | None                       | All content regardless of age                  |
| Advanced rules   | None                       | Power users only                               |

### Filter Evaluation Pipeline (transparent to users)

Filters are evaluated in order. The Advanced Settings page shows which filters run where:

```
Stage 1: Site/Drive Selection       (pre-fetch — no API calls for excluded sites)
Stage 2: OData Pre-fetch Filters    (sent to SharePoint — reduces API calls)
         - File type, name, size, date
Stage 3: Folder Glob Matching       (during enumeration — skips excluded paths)
Stage 4: Post-fetch Evaluation      (local — for metadata not in OData)
         - Custom SharePoint metadata, CEL expressions
Stage 5: Content Validation         (after download — password detection, format check)
```

### Filter Dry-Run / Preview (Issue #10)

The Advanced Settings page includes a "Run Preview" button that calls `POST /filters/preview`. This returns:

- Count of files that would be included/excluded per filter stage
- Sample of 25 included and 10 excluded files with reasons
- Estimated API calls per sync cycle

The preview runs against real SharePoint data using the current filter config without actually syncing.

### Custom SharePoint Metadata (Issue #16)

During discovery, the system probes for custom metadata columns on document libraries. Any discovered custom fields appear in the Advanced Conditions field dropdown alongside standard fields. If no custom metadata is found, the dropdown only shows standard fields. Custom metadata fields are prefixed with `metadata.sharepoint.` to distinguish them from system fields.

---

## 6. Error States

### Error: Invalid or Missing Azure Credentials

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Connect                     [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ! Connection failed                                   │  │
│  │                                                        │  │
│  │  Could not connect to Azure AD with the provided       │  │
│  │  credentials.                                          │  │
│  │                                                        │  │
│  │  Error: AADSTS700016 — Application not found in        │  │
│  │  directory 'contoso.onmicrosoft.com'                    │  │
│  │                                                        │  │
│  │  Common causes:                                        │  │
│  │  - Client ID is incorrect or has a typo                │  │
│  │  - Tenant ID doesn't match the app registration        │  │
│  │  - App registration was deleted                        │  │
│  │                                                        │  │
│  │  [Check Azure Portal ->]  [Try Again]                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Client ID (Application ID)                                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ a1b2c3d4-...                            ! Invalid    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Error: Admin Consent Not Granted

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Authenticate                [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ! Admin consent required                              │  │
│  │                                                        │  │
│  │  Authentication succeeded, but the app does not have   │  │
│  │  admin consent for the requested permissions.          │  │
│  │                                                        │  │
│  │  Authenticated as: john@contoso.com                    │  │
│  │  Permissions requested: Sites.Read.All                 │  │
│  │  Permissions granted: (none)                           │  │
│  │                                                        │  │
│  │  An Azure AD administrator must grant consent:         │  │
│  │  1. Go to Azure Portal > App Registrations             │  │
│  │  2. Find your app (Client ID: a1b2c3d4-...)            │  │
│  │  3. API Permissions > "Grant admin consent"            │  │
│  │                                                        │  │
│  │  [Invite IT Admin]  [Download Instructions PDF]        │  │
│  │                                                        │  │
│  │  Already granted? [Re-check Permissions]               │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Error: Device Code Expired

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Authenticate                [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ! Device code expired                                 │  │
│  │                                                        │  │
│  │  The authentication code was not used within 15        │  │
│  │  minutes and has expired.                              │  │
│  │                                                        │  │
│  │  [Generate New Code]                                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Error: Sites.Selected with No Sites Approved

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Discovering...              [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ! No accessible sites found                           │  │
│  │                                                        │  │
│  │  Your app uses Sites.Selected permissions, but no      │  │
│  │  sites have been approved for this app yet.            │  │
│  │                                                        │  │
│  │  To grant access to specific sites:                    │  │
│  │                                                        │  │
│  │  Option A: SharePoint Admin Center                     │  │
│  │  1. Go to admin.microsoft.com > SharePoint             │  │
│  │  2. Site Settings > Site Permissions                   │  │
│  │  3. Add your app (Client ID: a1b2c3d4-...)            │  │
│  │                                                        │  │
│  │  Option B: Graph API (for developers)                  │  │
│  │  POST /sites/{site-id}/permissions                     │  │
│  │  Body: { "roles": ["read"], "grantedTo":              │  │
│  │         { "application": { "id": "a1b2c3..." } } }    │  │
│  │                                                        │  │
│  │  Option C: Switch to Sites.Read.All                    │  │
│  │  Broader access but no per-site approval needed.       │  │
│  │  [Switch to Sites.Read.All ->]                         │  │
│  │                                                        │  │
│  │  [Invite IT Admin]  [Re-run Discovery]                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Error: Graph API Throttling (Issue #13)

```
┌─ SharePoint (Marketing Hub + 2 sites) ───────────────────────┐
│                                                               │
│  ┌─ Status ───────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  ! Sync paused — Microsoft throttling                   │  │
│  │                                                         │  │
│  │  Microsoft Graph API is rate-limiting requests.         │  │
│  │  The connector will automatically retry in 45 seconds.  │  │
│  │                                                         │  │
│  │  Progress: 156 of 237 docs synced before throttle.      │  │
│  │  Retry-After: 45s · Throttle count today: 3             │  │
│  │                                                         │  │
│  │  This is normal for large syncs. The connector uses     │  │
│  │  exponential backoff and respects Microsoft's limits.   │  │
│  │                                                         │  │
│  │  [Continue Waiting]  [Pause Sync]                       │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Error: Token Expired During Sync

```
┌─ SharePoint (Marketing Hub + 2 sites) ───────────────────────┐
│                                                               │
│  ┌─ Status ───────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  ! Sync stopped — authentication expired                │  │
│  │                                                         │  │
│  │  The OAuth token could not be refreshed.                │  │
│  │  Last successful sync: Mar 22, 2:15 PM (156 docs)      │  │
│  │                                                         │  │
│  │  Progress is saved — sync will resume from where it     │  │
│  │  stopped after re-authentication.                       │  │
│  │                                                         │  │
│  │  [Re-authenticate Now]  [Share Auth Request (IT Admin)] │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Error: Sync Failed 5 Consecutive Times (Auto-Pause)

```
┌─ SharePoint (Marketing Hub + 2 sites) ───────────────────────┐
│                                                               │
│  ┌─ Status ───────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  !! Auto-paused after 5 consecutive failures            │  │
│  │                                                         │  │
│  │  The last 5 sync attempts failed. The connector has     │  │
│  │  been automatically paused to prevent wasted resources. │  │
│  │                                                         │  │
│  │  Last errors:                                           │  │
│  │  Mar 22 3:00 PM  NetworkError: ECONNREFUSED             │  │
│  │  Mar 22 2:00 PM  NetworkError: ECONNREFUSED             │  │
│  │  Mar 22 1:00 PM  GraphApiError: 503 Service Unavail...  │  │
│  │  Mar 22 12:00 PM GraphApiError: 503 Service Unavail...  │  │
│  │  Mar 22 11:00 AM GraphApiError: 503 Service Unavail...  │  │
│  │                                                         │  │
│  │  [Connection Checklist]  [Resume Sync]  [Contact Support]│  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Error: Connection Validation Checklist (Issue #15)

```
┌──────────────────────────────────────────────────────────────┐
│  SharePoint > Connection Checklist                     [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Running connectivity checks...                              │
│                                                              │
│  [x] Azure AD reachable              OK (45ms)               │
│  [x] Token valid                     Expires in 24 days      │
│  [x] Token refresh working           Last refresh: 2h ago    │
│  [x] Graph API reachable             OK (120ms)              │
│  [ ] Sites accessible                FAILED                  │
│      Error: 403 — App not authorized for site                │
│      "Marketing Hub"                                         │
│  [x] Webhook endpoint reachable      OK                      │
│  [x] Rate limit headroom             245/600 calls used      │
│                                                              │
│  1 issue found:                                              │
│  "Marketing Hub" returned 403. The app may have lost         │
│  access. Check site permissions in SharePoint Admin Center.  │
│                                                              │
│                                [Re-run Checks]  [Close]      │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Empty States

### Empty State: No Sources Yet

```
┌──────────────────────────────────────────────────────────────┐
│  Data Sources                                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│                  No data sources yet                          │
│                                                              │
│         Add your first source to start building              │
│         your knowledge base.                                 │
│                                                              │
│         [+ Add SharePoint]   [+ Upload Files]                │
│         [+ Crawl Website]                                    │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Empty State: SharePoint Connected but Zero Documents

```
┌─ SharePoint (Marketing Hub) ─────────────────────────────────┐
│                                                               │
│  ┌─ Content ──────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │            No documents synced yet                      │  │
│  │                                                         │  │
│  │  The sync completed but no documents matched your       │  │
│  │  current filter configuration.                          │  │
│  │                                                         │  │
│  │  Possible causes:                                       │  │
│  │  - The selected sites have no supported file types      │  │
│  │  - Folder exclusion rules are too restrictive           │  │
│  │  - File size limits exclude all files                   │  │
│  │                                                         │  │
│  │  [Review Filter Settings]  [Run Filter Preview]         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Empty State: Discovery Returns Zero Sites

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint > Discovery                   [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│              No SharePoint sites found                        │
│                                                              │
│  The authenticated account does not have access to any       │
│  SharePoint sites, or the tenant has no sites.               │
│                                                              │
│  If you're using Sites.Selected:                             │
│  Your Azure AD admin must grant the app access to            │
│  specific sites first. [See instructions ->]                 │
│                                                              │
│  If you're using Sites.Read.All:                             │
│  Ensure admin consent has been granted in Azure Portal.      │
│  [Invite IT Admin]  [Re-authenticate]                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Empty State: Sync History (no syncs yet)

```
┌─ SharePoint > Sync History ──────────────────────────────────┐
│                                                               │
│              No sync history yet                              │
│                                                               │
│  Sync history will appear here after the first sync          │
│  completes. Your first sync is currently in progress.        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Empty State: Issues List (no errors)

```
┌─ SharePoint > Issues ────────────────────────────────────────┐
│                                                               │
│              No issues found                                  │
│                                                               │
│  All 237 documents were synced successfully.                  │
│  Issues will appear here if any files fail to process         │
│  during future syncs.                                        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 8. Multi-Connector Story

### Design: Org-Level Connector Management, Project-Level Consumption

For organizations with 15+ connectors (Issue #9, #17):

**Concept:** Connectors are created at the **organization** level and consumed at the **project/KB** level. An admin connects SharePoint once for the org. Individual KB owners pick which sites/drives to include in their KB.

### Connector Dashboard (org-level)

```
┌──────────────────────────────────────────────────────────────┐
│  Organization > Data Connectors                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │
│  │   4    │  │   3    │  │   1    │  │  2,847 │            │
│  │Healthy │  │Syncing │  │ Error  │  │ Docs   │            │
│  └────────┘  └────────┘  └────────┘  └────────┘            │
│                                                              │
│  Connector          Tenant          Status    Docs   KBs    │
│  ──────────────────────────────────────────────────────────  │
│  SP - Marketing     contoso.com     Syncing   842    3      │
│  SP - Engineering   contoso.com     Healthy   1,205  2      │
│  SP - Sales         contoso.com     Healthy   567    1      │
│  SP - Legal         fabrikam.com    Healthy   233    1      │
│  Jira - Eng         N/A             Error     0      1      │
│  Confluence          N/A             Syncing   1,200  4      │
│  Google Drive        N/A             Syncing   800    2      │
│  Box                 N/A             Healthy   450    1      │
│                                                              │
│  [+ Add Connector]  [Clone Existing]  [Import Template]      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Multi-Tenant Support (Issue #20)

Each connector belongs to exactly one Microsoft tenant. An org can have multiple SharePoint connectors pointing at different tenants:

- "SP - Marketing" → contoso.com
- "SP - Legal" → fabrikam.com (acquired company)

Each connector has its own credentials, permissions, and sync schedule. They appear as separate rows in the dashboard.

### Bulk / Clone / Template (Issue #9)

```
┌──────────────────────────────────────────────────────────────┐
│  Clone Connector                                       [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Clone from: SP - Marketing                                  │
│                                                              │
│  What to copy:                                               │
│  [x] Azure credentials (Client ID, Tenant ID)               │
│  [x] Filter configuration (file types, folder rules)         │
│  [x] Sync schedule                                           │
│  [ ] Site selection (you'll pick new sites)                   │
│  [ ] Authentication (you'll need to re-authenticate)         │
│                                                              │
│  New connector name:                                         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ SP - Engineering                                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│                                  [Cancel]  [Clone ->]        │
└──────────────────────────────────────────────────────────────┘
```

### KB-Level Connector Selection

When adding a source to a KB, the user can pick from existing org-level connectors:

```
┌──────────────────────────────────────────────────────────────┐
│  Add Source > SharePoint                               [X]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Use an existing connector or create a new one               │
│                                                              │
│  EXISTING CONNECTORS                                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  (●) SP - Marketing (contoso.com)                      │  │
│  │      842 docs · 3 sites · Healthy                      │  │
│  │                                                        │  │
│  │  ( ) SP - Engineering (contoso.com)                    │  │
│  │      1,205 docs · 8 sites · Healthy                    │  │
│  │                                                        │  │
│  │  ( ) SP - Sales (contoso.com)                          │  │
│  │      567 docs · 2 sites · Healthy                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ( ) Create new connector                                    │
│                                                              │
│  When using an existing connector, you choose which          │
│  sites and filters apply to this KB.                         │
│                                                              │
│                                  [Cancel]  [Continue ->]     │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Competitive Positioning — Honest Assessment

| Capability                      | Glean                | ChatGPT Enterprise   | Coveo                   | ABL (Design A)                   |
| ------------------------------- | -------------------- | -------------------- | ----------------------- | -------------------------------- |
| **Setup complexity**            | Admin-guided, ~30min | IT-managed, opaque   | 4-tab config, ~45min    | Role-adaptive, ~10min            |
| **Auto-discovery**              | Yes (basic)          | Yes (opaque)         | Yes (manual trigger)    | Yes (streaming + smart defaults) |
| **Permission-aware search**     | Yes (built-in)       | Partial              | Yes (configurable)      | Yes (opt-in, honest about scope) |
| **Filter granularity**          | Basic (type/path)    | None visible         | Advanced (many options) | Progressive (basic to CEL)       |
| **Delegation (IT admin flow)**  | Built-in admin panel | IT-managed centrally | Admin Center            | Native invite flow               |
| **Dry-run preview**             | No                   | No                   | No                      | Yes (mandatory first sync)       |
| **Real-time sync (webhooks)**   | Yes                  | Unknown              | Yes                     | Stubbed (needs wiring)           |
| **Multi-tenant**                | Yes                  | Yes                  | Yes                     | Yes (per-connector)              |
| **Error transparency**          | Minimal              | None                 | Moderate                | Full (every error state defined) |
| **Sites.Selected support**      | No                   | No                   | No                      | Yes (default)                    |
| **Graph API throttle handling** | Yes (mature)         | Yes (mature)         | Yes (mature)            | Needs implementation             |

### Where We Win

- **Dry-run preview** — no competitor shows you sample documents before syncing
- **Sites.Selected** as default — genuinely least-privilege, no competitor does this
- **Role-adaptive onboarding** — detects non-tech users and offers IT admin delegation
- **Error transparency** — every error state has a defined wireframe and remediation path
- **Progressive filter depth** — from zero config to CEL expressions, without forcing complexity

### Where We Lag (Honestly)

- **Real-time sync** — Glean/Coveo have production webhook integrations; ours is stubbed code that needs wiring
- **Scale maturity** — Glean handles 100K+ sites routinely; we haven't been tested beyond discovery sampling
- **Permission sync** — requires Sites.FullControl.All, which is genuinely broad; Glean/Coveo have more granular approaches
- **Graph API throttling** — competitors have years of production tuning; we need exponential backoff, retry-after header respect, and burst limiting

---

## 10. Backend Requirements

### Must Have (blocks this design)

| #   | Requirement                              | Why                                                       | Effort | Existing Code?        |
| --- | ---------------------------------------- | --------------------------------------------------------- | ------ | --------------------- |
| 1   | Permission probing after auth            | Auto-detect granted scopes for confirmation screen        | S      | No                    |
| 2   | Streaming discovery (WebSocket/SSE)      | Stream site results during discovery (Issue #5)           | M      | Partial               |
| 3   | Discovery cancellation                   | User can cancel long-running discovery (Issue #5)         | S      | No                    |
| 4   | Dry-run preview endpoint                 | Sample 25 docs matching current config (Issue #6)         | M      | Filter preview exists |
| 5   | Document stats aggregation endpoint      | Per-connector, per-site, per-type breakdowns              | S      | Data in DB            |
| 6   | IT admin invite flow (backend)           | Generate invite link, track completion, secure cred share | M      | No                    |
| 7   | Sites.Selected discovery support         | Handle limited discovery when only approved sites visible | S      | Partial               |
| 8   | Connection validation checklist endpoint | Run 7 connectivity checks and return results              | M      | No                    |
| 9   | Graph API throttle handling              | Respect Retry-After headers, exponential backoff          | M      | Basic in http-client  |

### Should Have

| #   | Requirement                               | Why                                       | Effort | Existing Code? |
| --- | ----------------------------------------- | ----------------------------------------- | ------ | -------------- |
| 10  | Wire scheduler (`startScheduledJobs()`)   | Automated delta sync and webhook renewal  | S      | Code exists    |
| 11  | Fix delta sync scheduler (actual enqueue) | Scheduled incremental syncs               | S      | Stub exists    |
| 12  | Mount webhook routes + start worker       | Real-time sync from SharePoint            | S      | Code exists    |
| 13  | Fix webhook renewal (real token)          | Webhook subscriptions auto-renew          | S      | Stub exists    |
| 14  | Auto-pause after 5 consecutive failures   | Prevent runaway broken sync               | S      | Field exists   |
| 15  | SyncRun history model                     | Full sync timeline in monitor panel       | M      | No             |
| 16  | Persist sync durationMs                   | Show sync duration in history             | S      | Data in result |
| 17  | Security Review Document generator        | Downloadable PDF for security team        | M      | No             |
| 18  | Permission change detection               | Alert when new scopes granted             | S      | No             |
| 19  | Track `authenticatedBy` on token          | Show who authenticated in UI              | XS     | Field missing  |
| 20  | Connector clone API                       | Copy config from existing connector       | S      | No             |
| 21  | Org-level connector model                 | Connectors shared across KBs              | L      | No             |
| 22  | Custom metadata discovery                 | Probe SharePoint columns during discovery | M      | No             |

### New API Endpoints Needed

| Endpoint                                  | Method | Purpose                         |
| ----------------------------------------- | ------ | ------------------------------- |
| `POST /connectors/:id/validate`           | POST   | Connection validation checklist |
| `GET /connectors/:id/documents/stats`     | GET    | Aggregated content statistics   |
| `POST /connectors/:id/dry-run`            | POST   | Sample documents preview        |
| `POST /connectors/invite`                 | POST   | Generate IT admin invite link   |
| `POST /connectors/invite/:token/complete` | POST   | IT admin submits credentials    |
| `GET /connectors/:id/throttle-status`     | GET    | Current Graph API usage/limits  |
| `POST /connectors/:id/clone`              | POST   | Clone connector config          |
| `GET /connectors/:id/custom-metadata`     | GET    | Discovered custom SP columns    |

### New/Modified Models

| Model                   | Change                                                 |
| ----------------------- | ------------------------------------------------------ |
| `ConnectorConfig`       | Add `organizationId`, `authenticatedBy`, `clonedFrom`  |
| `ConnectorInvite` (new) | IT admin invite tracking (token, expiry, status)       |
| `SyncRun` (new)         | Per-sync history (startedAt, duration, counts, errors) |
| `EndUserOAuthToken`     | Add `authenticatedBy` (email of who authed)            |
| `ConnectorConfig`       | Add `autoResumeAfter` for throttle recovery            |

---

## 11. Issues Addressed — Complete Checklist

### CRITICAL (7/7 addressed)

| #   | Issue                                       | How Addressed                                                                                                                                                                      |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No Azure App Registration guidance          | Setup guide (Screen 2b) with step-by-step Azure Portal instructions. IT admin invite flow with guided landing page. Downloadable PDF. Role detection at entry.                     |
| 2   | Device code ≠ admin consent conflated       | Explicitly separated everywhere. Device code sharing message includes "does NOT grant admin consent" disclaimer. Admin consent is a separate step in all flows.                    |
| 3   | Sites.FullControl.All mitigation misleading | Honest disclosure in permission upgrade screen: "token has write capability, rotate immediately if exposed." No misleading "read-only" claims.                                     |
| 4   | Error states completely unspecified         | 8 error wireframes: invalid creds, no admin consent, device code expired, no sites (Sites.Selected), Graph throttling, token expired, 5x failure auto-pause, validation checklist. |
| 5   | Discovery timeout for 1000+ sites           | Streaming discovery with cancel button. "Use what we found so far" option. Search/filter for large site lists. Manual URL entry fallback.                                          |
| 6   | No dry-run/preview before sync              | Mandatory dry-run on first sync showing 25 sample documents + skipped files with reasons. Filter preview in Advanced Settings.                                                     |
| 7   | Sites.Selected not supported                | Default permission tier. Setup guide explains how to grant per-site access. Discovery adapts to show only approved sites. Clear error if no sites approved.                        |

### HIGH (14/14 addressed)

| #   | Issue                                             | How Addressed                                                                                                                                                         |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | "Proposal" was a pre-filled form                  | Replaced with compact confirmation screen. Not called a "proposal." It is a summary the user approves, with a "Change Sites" link and "Advanced Settings" for tweaks. |
| 9   | No bulk/clone/template for multi-connector        | Clone connector flow. Org-level connector dashboard with bulk management. Import/export templates.                                                                    |
| 10  | No filter dry-run/preview                         | "Run Preview" button in Advanced Settings calls existing `POST /filters/preview`. Shows included/excluded counts + samples.                                           |
| 11  | Security doc missing data handling/retention      | Security Review Document download includes permission justifications, risk assessment, data handling scope, and token rotation guidance.                              |
| 12  | Competitive claims overstated                     | Honest competitive table. Explicit "Where We Lag" section acknowledging Glean/Coveo maturity in webhooks, scale, and throttling.                                      |
| 13  | Graph API throttling unaddressed                  | Throttle error state wireframe. Throttle status in connector dashboard. Backend requirement for Retry-After header handling + exponential backoff.                    |
| 14  | Pre-fetch/post-fetch leaks implementation details | Removed from default flow. Only visible in Advanced Settings filter preview, labeled by user impact ("reduces API calls" vs "evaluates locally") not implementation.  |
| 15  | No connection validation checklist                | Dedicated "Connection Checklist" screen running 7 automated checks with pass/fail and remediation for each.                                                           |
| 16  | Custom SharePoint metadata not discoverable       | Backend probes custom metadata columns during discovery. Custom fields appear in Advanced Conditions dropdown prefixed with `metadata.sharepoint.`.                   |
| 17  | No multi-connector monitoring dashboard           | Org-level Connector Dashboard with health/status/docs/KBs at a glance for all connectors.                                                                             |
| 18  | Empty states undefined                            | 5 empty state wireframes: no sources, zero documents, zero sites, no sync history, no issues.                                                                         |
| 19  | Loading states incomplete                         | Streaming discovery with progressive results. Sync progress bar with ETA. Connection validation with per-check progress.                                              |
| 20  | Multiple tenants in one KB not addressed          | Each connector belongs to one tenant. Org dashboard shows tenant per connector. KB-level selector picks from available connectors across tenants.                     |
| 21  | Proposal in dialog too complex                    | Replaced with compact confirmation screen (summary + dry-run preview). Advanced Settings on a separate page with tabs, never inline in a dialog.                      |
