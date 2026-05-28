# 08 — Knowledge Library

**Implements BRD §9.10, §9.10.1 (the Knowledge Library expansion). CU Admin surface.**

The Knowledge Library is the tenant-scoped store of knowledge sources available to all apps. Process Owners *attach* knowledge to their apps in Review Studio (`03-review-studio.md`); the Library is where the CU Admin (or delegated Knowledge Editor) *manages* the sources themselves.

**Route:** `/knowledge`

## Page header

- H1: *"Knowledge Library"*
- Sub: *"12 sources · 3,124 documents · 18,452 chunks indexed · last sync 2 min ago"*
- Right side:
  - **Add source** primary button (Lucide `Plus`)
  - Kebab menu: "Run quality check on all," "Export inventory," "Settings"

## Filter / search row

- Search input (filters by name, provider, tag)
- Mode filter chips: `All` · `Upload` · `Connector` · `Crawl` · `Authored` · `API`
- Status filter chips: `All` · `Active` · `Syncing` · `Stale` · `Deprecated` · `Error`
- "Sort by" dropdown: Last synced (default) · Name · Documents · Apps consuming

## Source list

A table or a card grid (card grid recommended for visual richness):

Each card:
- **Header**: provider icon + source name + mode chip (Upload / Confluence / SharePoint / Salesforce Knowledge / Google Drive / S3 / Crawl / Authored / API)
- **Status dot + label**: Active (green) / Syncing (info) / Stale (warning) / Deprecated (subtle) / Error (red)
- **Stats row**: documents · chunks · apps consuming
- **Tags row**: chips for `reg-e`, `pii`, `regulator-only`, `member-facing`, etc. (max 4 visible, "+N more" overflow)
- **Last synced**: relative time
- **Owner**: small avatar
- **Click**: routes to `/knowledge/[sourceId]` for detail view (or opens a Sheet for the prototype's simpler path)
- **Hover actions**: "Test retrieval" (opens a small Popover with the retrieval tester), "Sync now" (icon button), kebab → "Pause," "Deprecate," "Remove"

## Source detail (Sheet or route)

When a card is clicked, a Sheet opens (or full page if routed). Contents:

### Identity panel
- Source name (editable inline)
- Mode + provider
- Source URL or path (if applicable)
- Owner
- Tags (editable chip-input)
- Sensitive-data tags (separate chip-input with red border styling)

### Sync panel
- Refresh model: push / pull / real-time / manual (radio)
- Refresh cadence (if pull): dropdown — 5 min / 15 min / 1 hour / 6 hours / daily
- Last sync: timestamp + status
- Next scheduled sync (if applicable)
- "Sync now" button

### Permissions panel (FR-KM-10)
- *"This source inherits permissions from Confluence. Restricted pages will not surface to apps whose audience does not include the page's group."*
- Group mapping preview (mocked): *"Confluence group 'VP+' → not visible to member-facing apps"*

### Content preview panel
- A list of 4–6 sample document titles indexed from this source (mocked)
- Each: title, page count or chunk count, last updated
- Click → shows a preview Sheet-in-Sheet with mocked content

### Apps consuming panel
- List of apps using this source (with link to each app)
- Per app: "Used 412 times in last 24h"

### Quality check panel (FR-KM-18)
- Latest Knowledge Quality Check run timestamp
- Flag counts: `Blocker` · `Warning` · `Suggestion`
- Top 3 flags listed with severity + plain-language explanation + "Acknowledge / Discuss with Helper" actions

### Audit panel
- Last 5 audit entries for this source (link to full audit log filtered by this source)

### Dry-run retrieval tester (FR-KM-16)
- Title: *"Test retrieval"*
- A search input: *"What would this source return for…"*
- On submit (decorative): show 3 mocked retrieved chunks with relevance scores + source attribution + "Open passage" links

## Add source dialog

Triggered by the **Add source** button. A multi-step Dialog (or wider Sheet for clarity):

### Step 1 — Choose mode

A four-card chooser:
1. **Upload file(s)** (Lucide `Upload`) — *"PDF, DOCX, MD, HTML, TXT, XLSX, PPTX"*
2. **Connect a service** (Lucide `Plug`) — *"Confluence, SharePoint, Salesforce Knowledge, Zendesk Guide, Google Drive, OneDrive, Box, ServiceNow, Notion, Bloomfire, Guru, NetDocuments, iManage"*
3. **Crawl a URL** (Lucide `Globe`) — *"Public KB, member portal, policy pages, sitemap"*
4. **Author in-platform** (Lucide `PenLine`) — *"FAQ entries, glossary terms, policy snippets"*

### Step 2 — Configure (varies by mode)

- **Upload**: file picker (decorative; just goes to step 3 after a fake parse)
- **Connector**:
  - Provider picker (icons grid: Confluence, SharePoint, Salesforce Knowledge, etc.)
  - Auth method picker: OAuth (default) · API token · SSO-federated
  - Mock "Connect" button → 2s loader → "Connected as Admin"
  - Scope picker: spaces / folders / categories to include
- **Crawl**: URL input + scope rules (single page / sitemap / domain) + robots.txt respect toggle (on by default)
- **Authored**: a list editor for FAQ / glossary entries — title + body fields

### Step 3 — Tag and route

- Tags chip input (free-text)
- Sensitive-data tags (PII / NPI / regulator-only)
- Refresh cadence
- "Apps consuming this source by default" — multi-select (all apps by default; can restrict to specific apps)

### Step 4 — Confirm

Summary card + **Add to Knowledge Library** primary button. Toast confirmation + new card appears in the list.

## Click model summary

| Element | Action |
|---|---|
| Add source | Opens multi-step Dialog |
| Source card click | Opens detail Sheet (or routes if implemented as page) |
| Sync now | 2s loader → updates last-sync timestamp |
| Card kebab → Pause / Deprecate / Remove | Confirmation Dialog → status changes |
| Test retrieval (hover Popover) | Inline mock retrieval test |
| Detail "Discuss with Helper" | Opens Helper with source context |

## States to render

- **Healthy (default)** — 12 sources, mix of statuses, mostly active.
- **One stale** — at least one source with `stale` status, surfacing a Warning Quality Check flag.
- **One error** — at least one source with `error` status (sync failed); the card shows an error tint and an inline "Retry sync" button.
- **Empty filter** — show a friendly "No sources match your filters" state.

## Out of scope

- Real ingestion or indexing.
- Real connector OAuth.
- Real document preview content (mock placeholder content).
- Real retrieval testing.
- Source-level access control beyond mocked permission inheritance.

## Acceptance criteria

- 12 source cards render with correct mode/provider/status/tags.
- Filter chips and search filter the list client-side.
- Source detail Sheet renders all 7 panels with mock content.
- Add source Dialog walks through 4 steps and adds a new card on confirm.
- Stale and error states surface in cards with correct tinting.
- Test retrieval Popover renders mock chunks.
