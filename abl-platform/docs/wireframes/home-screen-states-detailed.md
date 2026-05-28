# Home Screen Redesign - Detailed Wireframes

## All States & Variations

**Version**: 2.0  
**Date**: 2026-04-10  
**Status**: Review - Do Not Implement Yet

---

## Table of Contents

1. [State Machine](#state-machine)
2. [State 1: Empty (New KB)](#state-1-empty-new-kb)
3. [State 2: First Source Added](#state-2-first-source-added)
4. [State 3: Active with Manual Sources](#state-3-active-with-manual-sources)
5. [State 4: Active with Connectors](#state-4-active-with-connectors)
6. [State 5: Mixed Sources](#state-5-mixed-sources)
7. [State 6: With Errors](#state-6-with-errors)
8. [Mobile Responsive Views](#mobile-responsive-views)
9. [Component Library](#component-library)
10. [Interaction Patterns](#interaction-patterns)

---

## State Machine

```
┌──────────────┐
│   EMPTY      │  No sources, no documents
│   (Setup)    │
└──────┬───────┘
       │ User adds first source
       ↓
┌──────────────────┐
│  FIRST SOURCE    │  1 source, 0 documents (syncing/uploading)
│  (Onboarding)    │  Show upload in progress
└──────┬───────────┘
       │ Documents arrive
       ↓
┌─────────────────────┐
│   ACTIVE            │  Has documents, can add more
│   (Operations)      │  Main working state
└─────────────────────┘
       │
       ├─→ Manual only (upload-focused actions)
       ├─→ Connectors only (sync-focused actions)
       └─→ Mixed (both upload + sync actions)
```

**Key Change**: Remove "Waiting" state completely. Go straight from Setup → Operations.

---

## State 1: Empty (New KB)

### Full Screen Wireframe

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] New Knowledge Base        0 Sources  0 Documents  0 Chunks    [Settings] ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


                    ┌────────────────────────────────────┐
                    │     🎯 Get Started                 │
                    │                                    │
                    │  Add your first data source to     │
                    │  start building your knowledge base│
                    └────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                          CHOOSE YOUR PATH                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
  │                                  │    │                                  │
  │          📄                      │    │          🔌                      │
  │     Upload Files                 │    │    Connect a Source              │
  │                                  │    │                                  │
  │  Drop files here or click        │    │  Sync from SharePoint,           │
  │  to browse                       │    │  databases, APIs, or             │
  │                                  │    │  crawl web pages                 │
  │  ┌─────────────────────────┐    │    │                                  │
  │  │  [Browse Files...]      │    │    │  ┌─────────────────────────┐    │
  │  └─────────────────────────┘    │    │  │ [Browse Connectors...] │    │
  │                                  │    │  └─────────────────────────┘    │
  │  Perfect for:                    │    │                                  │
  │  • PDFs, docs, presentations     │    │  Perfect for:                    │
  │  • Quick testing                 │    │  • Auto-sync from systems        │
  │  • One-time uploads              │    │  • Large document sets           │
  │                                  │    │  • Regular updates               │
  └──────────────────────────────────┘    └──────────────────────────────────┘


  💡 Tip: You can always add more sources later. Start simple!
```

**Design Notes:**

- Large, equal-weight cards (no bias toward either option)
- Clear value props for each path
- File drop zone is VISUAL (not hidden)
- "Browse Connectors" doesn't immediately show connector list - opens a chooser

---

## State 2: First Source Added

**Scenario**: User uploaded files OR added a connector, documents syncing

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] New Knowledge Base        1 Sources  0 Documents  0 Chunks    [Settings] ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS                                                              ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃  ┌────────────────────────────┐  ┌────────────────────────────┐              ┃
┃  │  📄  Upload More Files     │  │  🔌  Add Another Source    │              ┃
┃  │                            │  │                            │              ┃
┃  │  Drop files or browse      │  │  Connect more data sources │              ┃
┃  └────────────────────────────┘  └────────────────────────────┘              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATUS                                                      ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ┃
┃  │   🗂️  Sources      │  │  📄  Documents     │  │  🧩  Chunks        │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │         1          │  │         0          │  │         0          │     ┃
┃  │   ───────          │  │   ───────          │  │   ───────          │     ┃
┃  │  Manual: 1         │  │  ⏳ Processing...  │  │  Waiting for docs  │     ┃
┃  │  Connectors: 0     │  │                    │  │                    │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │  [View All →]      │  │                    │  │                    │     ┃
┃  └────────────────────┘  └────────────────────┘  └────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                              [View All →]   ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  Default                                                         │     ┃
┃  │  Manual Upload                                                       │     ┃
┃  │                                                                      │     ┃
┃  │  ⏳ Processing your files...                                        │     ┃
┃  │  ├─ 3 files uploaded                                                │     ┃
┃  │  └─ Estimated time: ~2 minutes                                      │     ┃
┃  │                                                                      │     ┃
┃  │                              [📤 Upload More]  [❌ Cancel Upload]   │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  ✨  Great start!                                                    │     ┃
┃  │                                                                      │     ┃
┃  │  While your files are processing, you can:                          │     ┃
┃  │  • Upload more files                                                │     ┃
┃  │  • Add a connector to auto-sync from SharePoint, databases, etc.    │     ┃
┃  │  • Configure your indexing pipeline                                 │     ┃
┃  │                                                                      │     ┃
┃  │                       [🔌 Add Connector]                            │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Design Notes:**

- Quick Actions visible immediately (solving #12)
- Processing status shown in source card (transparent progress)
- Encouragement card suggests next steps (progressive onboarding)
- Cancel option available (user control)
- NO separate "waiting" screen (solving #13)

---

## State 3: Active with Manual Sources

**Scenario**: User has uploaded files, documents indexed, actively using for Q&A

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] My Resume Database       2 Sources  47 Documents  234 Chunks  [Settings] ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS (sticky on scroll)                                          ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃  ┌────────────────────────────┐  ┌────────────────────────────┐              ┃
┃  │  📄  Upload Files          │  │  🔌  Add Source            │              ┃
┃  │  Drop or browse            │  │  Connect data sources      │              ┃
┃  └────────────────────────────┘  └────────────────────────────┘              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATS                                                       ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ┃
┃  │   🗂️  Sources      │  │  📄  Documents     │  │  🧩  Chunks        │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │         2          │  │        47          │  │       234          │     ┃
┃  │   ───────          │  │   ───────          │  │   ───────          │     ┃
┃  │  📁 Manual: 2      │  │  ✅ Indexed: 46    │  │  📊 Avg size: 5.2  │     ┃
┃  │  🔌 Connectors: 0  │  │  ⏳ Processing: 1  │  │  ⏱️ Last: 12m ago  │     ┃
┃  │                    │  │  ❌ Failed: 0      │  │  💯 Coverage: 98%  │     ┃
┃  │  [View All →]      │  │  [View All →]      │  │  [View All →]      │     ┃
┃  └────────────────────┘  └────────────────────┘  └────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                              [View All →]   ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  Resumes                                                         │     ┃
┃  │  Manual Upload                                  ✅ Active            │     ┃
┃  │                                                                      │     ┃
┃  │  ├─ 35 documents                                                    │     ┃
┃  │  ├─ 182 chunks                                                      │     ┃
┃  │  └─ Last updated: 12 minutes ago                                    │     ┃
┃  │                                                                      │     ┃
┃  │                              [📤 Upload More]  [⚙️ Manage]  [🗑️]     │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  Cover Letters                                                   │     ┃
┃  │  Manual Upload                                  ✅ Active            │     ┃
┃  │                                                                      │     ┃
┃  │  ├─ 12 documents                                                    │     ┃
┃  │  ├─ 52 chunks                                                       │     ┃
┃  │  └─ Last updated: 3 days ago                                        │     ┃
┃  │                                                                      │     ┃
┃  │                              [📤 Upload More]  [⚙️ Manage]  [🗑️]     │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  💡  Level up with connectors                                       │     ┃
┃  │                                                                      │     ┃
┃  │  Auto-sync from SharePoint, Google Drive, databases, or crawl       │     ┃
┃  │  websites to keep your knowledge base always up-to-date.            │     ┃
┃  │                                                                      │     ┃
┃  │                       [🔌 Browse Connectors]                        │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┌───────────────────────────────────┐  ┌────────────────────────────────────┐
│ ⚠️  Needs Attention               │  │ 📝  Recent Activity                │
├───────────────────────────────────┤  ├────────────────────────────────────┤
│                                   │  │                                    │
│  ✅ All systems healthy           │  │  • 1 document indexed              │
│     Your knowledge base is        │  │    12 minutes ago                  │
│     running smoothly.             │  │                                    │
│                                   │  │  • Source "Resumes" updated        │
│  [View Diagnostics →]             │  │    12 minutes ago                  │
│                                   │  │                                    │
└───────────────────────────────────┘  │  • Query performed                 │
                                       │    1 hour ago                      │
                                       │                                    │
                                       │  [View All Activity →]             │
                                       └────────────────────────────────────┘
```

**Design Notes:**

- Multiple manual sources shown as separate cards
- Each source has per-source actions (Upload More, Manage, Delete)
- Stats differentiate manual (📁) vs connectors (🔌)
- Encouragement card for connectors (upsell without being pushy)
- Quick Actions remain visible (solving #12)

---

## State 4: Active with Connectors

**Scenario**: User has SharePoint connector, auto-syncing documents

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] Company Docs            1 Sources  1,247 Documents  8,934 Chunks [Settings]┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS                                                              ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃  ┌────────────────────────────┐  ┌────────────────────────────┐              ┃
┃  │  📄  Upload Files          │  │  🔌  Add Source            │              ┃
┃  │  Add ad-hoc documents      │  │  Connect more sources      │              ┃
┃  └────────────────────────────┘  └────────────────────────────┘              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATS                                                       ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ┃
┃  │   🗂️  Sources      │  │  📄  Documents     │  │  🧩  Chunks        │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │         1          │  │      1,247         │  │      8,934         │     ┃
┃  │   ───────          │  │   ───────          │  │   ───────          │     ┃
┃  │  📁 Manual: 0      │  │  ✅ Indexed: 1,240 │  │  📊 Avg size: 7.2  │     ┃
┃  │  🔌 Connectors: 1  │  │  ⏳ Processing: 5  │  │  ⏱️ Last: 5m ago   │     ┃
┃  │                    │  │  ❌ Failed: 2      │  │  💯 Coverage: 100% │     ┃
┃  │  [View All →]      │  │  [View All →]      │  │  [View All →]      │     ┃
┃  └────────────────────┘  └────────────────────┘  └────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                              [View All →]   ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Company SharePoint                                              │     ┃
┃  │  SharePoint Connector                           🔄 Syncing...       │     ┃
┃  │                                                                      │     ┃
┃  │  ├─ 1,247 documents                                                 │     ┃
┃  │  ├─ 8,934 chunks                                                    │     ┃
┃  │  ├─ Last sync: 5 minutes ago                                        │     ┃
┃  │  └─ Next sync: in 55 minutes (every hour)                           │     ┃
┃  │                                                                      │     ┃
┃  │  📊 Sync Health: 99.8% success rate (last 30 days)                 │     ┃
┃  │                                                                      │     ┃
┃  │                    [🔄 Sync Now]  [⚙️ Configure]  [📊 View Logs]    │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  💡  Add more connectors or upload ad-hoc files                     │     ┃
┃  │                                                                      │     ┃
┃  │  • Connect more SharePoint sites, Teams channels, or drives         │     ┃
┃  │  • Add manual uploads for files that aren't in SharePoint           │     ┃
┃  │  • Set up web crawler for public documentation                      │     ┃
┃  │                                                                      │     ┃
┃  │         [🔌 Add Connector]         [📄 Upload Files]               │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┌───────────────────────────────────┐  ┌────────────────────────────────────┐
│ ⚠️  Needs Attention               │  │ 📝  Recent Activity                │
├───────────────────────────────────┤  ├────────────────────────────────────┤
│                                   │  │                                    │
│  ⚠️  2 documents failed           │  │  • 5 new documents synced          │
│     SharePoint connection error   │  │    5 minutes ago                   │
│                                   │  │                                    │
│  [View Failed Docs →]             │  │  • SharePoint sync completed       │
│                                   │  │    5 minutes ago                   │
└───────────────────────────────────┘  │                                    │
                                       │  • 1,240 documents indexed         │
                                       │    1 hour ago                      │
                                       │                                    │
                                       │  [View All Activity →]             │
                                       └────────────────────────────────────┘
```

**Design Notes:**

- Connector card shows rich sync metadata (next sync time, success rate)
- Actions appropriate for connectors (Sync Now, Configure, View Logs)
- Failed documents surfaced in Needs Attention
- Encouragement to add manual uploads as complement to connectors
- Quick Actions still visible (solving #12)

---

## State 5: Mixed Sources

**Scenario**: Power user with both manual uploads AND connectors

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] Production Docs         5 Sources  2,847 Documents  18,234 Chunks [Settings]┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS                                                              ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃  ┌────────────────────────────┐  ┌────────────────────────────┐              ┃
┃  │  📄  Upload Files          │  │  🔌  Add Source            │              ┃
┃  │  Drop or browse            │  │  Connect data sources      │              ┃
┃  └────────────────────────────┘  └────────────────────────────┘              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATS                                                       ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ┃
┃  │   🗂️  Sources      │  │  📄  Documents     │  │  🧩  Chunks        │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │         5          │  │      2,847         │  │     18,234         │     ┃
┃  │   ───────          │  │   ───────          │  │   ───────          │     ┃
┃  │  📁 Manual: 2      │  │  ✅ Indexed: 2,830 │  │  📊 Avg size: 6.4  │     ┃
┃  │  🔌 Connectors: 3  │  │  ⏳ Processing: 15 │  │  ⏱️ Last: 2m ago   │     ┃
┃  │                    │  │  ❌ Failed: 2      │  │  💯 Coverage: 100% │     ┃
┃  │  [View All →]      │  │  [View All →]      │  │  [View All →]      │     ┃
┃  └────────────────────┘  └────────────────────┘  └────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                    [Filter ▾]  [View All →] ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  📊 Source Breakdown:                                                         ┃
┃      📁 Manual (2) contributing 847 docs  •  🔌 Connectors (3) contributing 2,000 docs│
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Company SharePoint                         🔄 Syncing... (3m)  │     ┃
┃  │  SharePoint Connector                                                │     ┃
┃  │  ├─ 1,580 documents  •  Last sync: 2 minutes ago                    │     ┃
┃  │                    [🔄 Sync Now]  [⚙️ Configure]  [📊 Logs]  [📍]   │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  API Documentation                               ✅ Active       │     ┃
┃  │  Manual Upload                                                       │     ┃
┃  │  ├─ 420 documents  •  Last updated: 2 days ago                      │     ┃
┃  │                    [📤 Upload More]  [⚙️ Manage]  [🗑️]  [📍]        │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Product Database                               ✅ Active       │     ┃
┃  │  PostgreSQL Connector                                                │     ┃
┃  │  ├─ 267 documents  •  Last sync: 1 hour ago (hourly)                │     ┃
┃  │                    [🔄 Sync Now]  [⚙️ Configure]  [📊 Logs]  [📍]   │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  Compliance Docs                                 ✅ Active       │     ┃
┃  │  Manual Upload                                                       │     ┃
┃  │  ├─ 427 documents  •  Last updated: 1 week ago                      │     ┃
┃  │                    [📤 Upload More]  [⚙️ Manage]  [🗑️]  [📍]        │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Help Center                                     ✅ Active       │     ┃
┃  │  Web Crawler                                                         │     ┃
┃  │  ├─ 153 documents  •  Last crawl: 6 hours ago (daily)               │     ┃
┃  │                    [🔄 Crawl Now]  [⚙️ Configure]  [📊 Logs]  [📍]  │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Design Notes:**

- Source breakdown summary at top (manual vs connectors contribution)
- Filter dropdown to show "Manual only" or "Connectors only"
- Pin icon (📍) to mark favorite sources
- Mixed source types shown with appropriate icons and actions
- Stats clearly show breakdown (2 manual, 3 connectors)

---

## State 6: With Errors

**Scenario**: Some documents failed, connector auth expired

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] Support KB              3 Sources  1,523 Documents  9,847 Chunks [Settings]┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                                 │
└──────────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS                                                              ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃  ┌────────────────────────────┐  ┌────────────────────────────┐              ┃
┃  │  📄  Upload Files          │  │  🔌  Add Source            │              ┃
┃  │  Drop or browse            │  │  Connect data sources      │              ┃
┃  └────────────────────────────┘  └────────────────────────────┘              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATS                                                       ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ┃
┃  │   🗂️  Sources      │  │  📄  Documents     │  │  🧩  Chunks        │     ┃
┃  │                    │  │                    │  │                    │     ┃
┃  │         3          │  │      1,523         │  │      9,847         │     ┃
┃  │   ───────          │  │   ───────          │  │   ───────          │     ┃
┃  │  📁 Manual: 1      │  │  ✅ Indexed: 1,498 │  │  📊 Avg size: 6.5  │     ┃
┃  │  🔌 Connectors: 2  │  │  ⏳ Processing: 8  │  │  ⏱️ Last: 10m ago  │     ┃
┃  │  ⚠️ 1 needs fix    │  │  ❌ Failed: 17     │  │  💯 Coverage: 98%  │     ┃
┃  │  [View All →]      │  │  [Fix Errors →]    │  │  [View All →]      │     ┃
┃  └────────────────────┘  └────────────────────┘  └────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️  ACTION REQUIRED                                                           ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  ❌  SharePoint connection expired                                   │     ┃
┃  │                                                                      │     ┃
┃  │  Your SharePoint connector "Company Docs" needs re-authorization.   │     ┃
┃  │  Last successful sync: 3 days ago                                   │     ┃
┃  │                                                                      │     ┃
┃  │                           [🔑 Reconnect Now]                        │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  ⚠️  17 documents failed to index                                   │     ┃
┃  │                                                                      │     ┃
┃  │  Common issues: corrupted files, unsupported formats, size limits   │     ┃
┃  │                                                                      │     ┃
┃  │                      [View Failed Docs →]  [Dismiss]               │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                              [View All →]   ┃
┠───────────────────────────────────────────────────────────────────────────────┨
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Company Docs                                 ❌ Auth Expired    │     ┃
┃  │  SharePoint Connector                                                │     ┃
┃  │                                                                      │     ┃
┃  │  ⚠️ Connection lost - needs re-authorization                        │     ┃
┃  │  ├─ 1,248 documents (outdated)                                      │     ┃
┃  │  └─ Last sync: 3 days ago                                           │     ┃
┃  │                                                                      │     ┃
┃  │                           [🔑 Reconnect]  [⚙️ Configure]             │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  📁  Support Articles                                ✅ Active       │     ┃
┃  │  Manual Upload                                                       │     ┃
┃  │  ├─ 127 documents  •  Last updated: 2 hours ago                     │     ┃
┃  │  └─ ⚠️ 17 documents failed to index                                 │     ┃
┃  │                                                                      │     ┃
┃  │              [📤 Upload More]  [⚠️ Fix Errors]  [⚙️ Manage]          │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┃                                                                               ┃
┃  ┌─────────────────────────────────────────────────────────────────────┐     ┃
┃  │  🔌  Help Desk DB                                    ✅ Active       │     ┃
┃  │  PostgreSQL Connector                                                │     ┃
┃  │  ├─ 148 documents  •  Last sync: 10 minutes ago                     │     ┃
┃  │                    [🔄 Sync Now]  [⚙️ Configure]  [📊 Logs]          │     ┃
┃  └─────────────────────────────────────────────────────────────────────┘     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Design Notes:**

- "Action Required" section elevated above source cards (priority)
- Failed documents shown with clear CTA (View Failed Docs, Fix Errors)
- Auth expired shown prominently with Reconnect button
- Stats reflect issues (1 source needs fix, 17 docs failed)
- Individual source cards show inline errors
- Quick Actions still visible (can still add more while fixing issues)

---

## Mobile Responsive Views

### Mobile - Active State (375px width)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [☰] testscreens          [⋮]        ┃
┃                                      ┃
┃ 1 Sources  2 Docs  1 Chunks          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search]│
└──────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS                     ┃
┠──────────────────────────────────────┨
┃  ┌────────────────────────────────┐  ┃
┃  │  📄  Upload Files              │  ┃
┃  └────────────────────────────────┘  ┃
┃  ┌────────────────────────────────┐  ┃
┃  │  🔌  Add Source                │  ┃
┃  └────────────────────────────────┘  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 STATS                             ┃
┠──────────────────────────────────────┨
┃                                      ┃
┃  ┌────────────────────────────────┐  ┃
┃  │   🗂️  Sources          1      │  ┃
┃  │   Manual: 1  •  Connectors: 0  │  ┃
┃  └────────────────────────────────┘  ┃
┃                                      ┃
┃  ┌────────────────────────────────┐  ┃
┃  │   📄  Documents        2       │  ┃
┃  │   Indexed: 2  •  Processing: 0 │  ┃
┃  └────────────────────────────────┘  ┃
┃                                      ┃
┃  ┌────────────────────────────────┐  ┃
┃  │   🧩  Chunks           1       │  ┃
┃  │   Last: 2h ago  •  100% coverage  ┃
┃  └────────────────────────────────┘  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  SOURCES              [View All]┃
┠──────────────────────────────────────┨
┃  ┌────────────────────────────────┐  ┃
┃  │  📁  Default                   │  ┃
┃  │  Manual Upload  •  2 docs      │  ┃
┃  │  Last: 2h ago                  │  ┃
┃  │                                │  ┃
┃  │  [Upload] [Manage] [⋮]         │  ┃
┃  └────────────────────────────────┘  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Mobile Design Notes:**

- Stack everything vertically
- Quick Actions full-width buttons (easier tap targets)
- Stats cards stack (not side-by-side)
- Source cards simplified (fewer details, overflow menu)
- Bottom navigation for primary tabs

---

## Component Library

### Quick Action Button

```
┌────────────────────────────┐
│  [Icon]  Label             │
│  Subtitle/description      │
└────────────────────────────┘

States:
- Default: border-default, hover → border-accent
- Loading: spinner icon, disabled
- Disabled: opacity-50, cursor-not-allowed
```

### Stat Card

```
┌────────────────────┐
│   [Icon]  Title    │
│                    │
│       Value        │
│   ───────          │
│  Line 1 breakdown  │
│  Line 2 breakdown  │
│  Line 3 breakdown  │
│                    │
│  [View All →]      │
└────────────────────┘

States:
- Clickable: hover → shadow, cursor-pointer
- Loading: skeleton animation
- Error: red border, error icon
```

### Source Card

```
┌─────────────────────────────────────────┐
│  [Icon]  Name              [Badge]      │
│  Type                                   │
│                                         │
│  ├─ Detail line 1                      │
│  ├─ Detail line 2                      │
│  └─ Detail line 3                      │
│                                         │
│  [Action 1] [Action 2] [Action 3] [⋮]  │
└─────────────────────────────────────────┘

Variants:
- Manual Upload: 📁 icon, "Upload More" action
- Connector: 🔌 icon, "Sync Now" + "Configure" actions
- Syncing: 🔄 spinning icon, progress indicator
- Error: ❌ badge, "Fix" action, red border
- Auth expired: 🔑 "Reconnect" action, warning color
```

---

## Interaction Patterns

### 1. Upload Flow

```
Click "Upload Files" button
    ↓
Dialog opens with:
  - Source selector dropdown (if multiple manual sources exist)
  - File drag-drop zone
  - Browse button
  - Upload progress bar (after selecting files)
    ↓
Files upload
    ↓
Dialog shows success + "Upload More" option
    ↓
User can close dialog → returns to Home
    ↓
Source card shows "Processing..." state
    ↓
Auto-updates to "Indexed" when done
```

### 2. Add Source Flow

```
Click "Add Source" button
    ↓
Slide-out panel with source types:
  - Manual Upload (create new upload bucket)
  - SharePoint
  - PostgreSQL
  - Web Crawler
  - ... more connectors
    ↓
User selects type
    ↓
Configuration wizard (varies by type)
    ↓
Source created → appears in source cards
    ↓
If manual → prompt to upload files
If connector → start initial sync
```

### 3. Stat Card Click

```
Click "Documents" stat card
    ↓
Navigate to Data tab
    ↓
Pre-filter to "Documents" view
    ↓
If stat showed "Failed: 17" → apply failed filter
```

### 4. Source Card Actions

```
Manual Upload:
  - "Upload More" → Opens upload dialog with this source pre-selected
  - "Manage" → Opens source settings (rename, delete, permissions)
  - "Delete" → Confirmation dialog

Connector:
  - "Sync Now" → Triggers immediate sync (shows spinner)
  - "Configure" → Opens connector settings
  - "View Logs" → Shows sync history and errors
```

---

## Design Validation Questions

**Before implementation, answer these:**

1. **Quick Actions Visibility**
   - [ ] Are Quick Actions visible on ALL states (empty, first source, active, error)?
   - [ ] Do they remain visible when scrolling? (sticky position)
   - [ ] Are they large enough to be obvious CTAs?

2. **Source Differentiation**
   - [ ] Can user instantly tell manual uploads from connectors? (icons, labels, actions)
   - [ ] Are source-specific actions appropriate? (Upload More for manual, Sync Now for connectors)
   - [ ] Is source health/status clear? (syncing, active, error badges)

3. **No Dead Ends**
   - [ ] Is "waiting" state removed completely?
   - [ ] Can user always add more sources/files regardless of current state?
   - [ ] Are error states actionable? (clear CTAs to fix issues)

4. **Context & Breakdown**
   - [ ] Do stats show breakdown (manual vs connectors, indexed vs processing)?
   - [ ] Is source contribution visible (which source has most docs)?
   - [ ] Are failed documents/sync errors surfaced prominently?

5. **Mobile Usability**
   - [ ] Do Quick Actions stack vertically on mobile?
   - [ ] Are tap targets at least 44x44px?
   - [ ] Is content readable without zooming?

---

## Next Steps

1. **Review these wireframes** with:
   - Product team (validate problem/solution fit)
   - Design team (visual polish, accessibility)
   - Engineering team (feasibility, effort estimate)

2. **Get user feedback**:
   - Show to 3-5 existing users
   - Ask: "Which state matches your usage?"
   - Validate: "Would Quick Actions being always visible help you?"

3. **Refine based on feedback**:
   - Adjust information hierarchy
   - Add/remove details from source cards
   - Simplify/enhance stat breakdowns

4. **Create high-fidelity mockups** (Figma):
   - Add actual design system colors/spacing
   - Create interactive prototype
   - Test with clickable prototype

5. **Implementation plan**:
   - Phase 1: Quick Actions + Remove waiting state (Quick win)
   - Phase 2: Enhanced stats with breakdown
   - Phase 3: Source cards section
   - Phase 4: Polish + mobile optimization

---

## Open Questions

1. **Source Card Ordering**: Default alphabetical, by doc count, by last updated, or user-defined?
2. **Filter/Sort Options**: Should source list be filterable (Manual/Connector/All)?
3. **Pagination**: How many source cards before "View All" takes over?
4. **Real-time Updates**: Should sync progress update in real-time or on refresh?
5. **Favoriting**: Should users be able to pin favorite sources to top?

---

**Status**: ✅ Ready for review
**Next Action**: Schedule review with PM + Design + Eng
