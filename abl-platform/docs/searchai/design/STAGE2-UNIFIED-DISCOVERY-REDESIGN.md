# Stage 2 — Unified Discovery Redesign

> **Date**: 2026-05-04
> **Status**: DRAFT — Rev 3 (PM + UX review feedback incorporated)
> **Drives**: P1 (terminology), P2 (choice card), P3 (two paths), P4 (TC1 escalation)
> **Reference**: UNIFIED-EXPLORE-DISCOVERY-DESIGN.md, DISCOVERY-PANEL-DESIGN.md
> **Findings**: `.claude/agent-memory-local/architect/project_crawler_ux_findings.md`

---

## 1. Problem Summary

Stage 2 ("Review Sections") has two disconnected discovery panels (BrowserDiscoveryInline
and ExplorePanel) that create a jarring UX when the system transitions between discovery
methods. Users are asked to make technical decisions ("Continue to HTTP Discovery?") they
can't meaningfully make. 46 i18n strings leak internal terminology.

**Root cause**: The implementation built two separate panels instead of the single unified
panel specified in the canonical design. The choice card between them fires unconditionally
for all strategies.

---

## 2. Design Principles

1. **One panel, layered discovery** — the user sees one discovery experience. The system
   chains methods automatically: navigation scan → link search → deeper search.
2. **Transparent operations, hidden methods** — show WHAT the system is doing ("Scanning
   navigation menus...", "Following links from 12 hub pages..."), not HOW ("Browser
   discovery", "HTTP crawl").
3. **Time-honest** — discovery takes 1-5 minutes. Don't hide it. Show a phase indicator
   with estimated time remaining and make it productive (sections appear as they're found).
4. **System handles failures, user handles decisions** — two-tier model. Tier 1: system
   silently auto-remediates (retry, slow down, switch mode) and logs a one-line entry.
   Tier 2: system escalates to user ONLY when stuck (persistent blocking, login walls).
   On completion, a failure summary recommends crawl settings based on what was learned.
5. **User steers, system drives** — decision cards ask "What content do you want?" not
   "What technology should we use?"

---

## 3. Terminology Rename Map

| Internal Term                        | User-Facing Term                                                                 | Where Used          |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------- |
| Browser Discovery                    | **Exploring site**                                                               | Panel title, status |
| HTTP Discovery                       | **Searching for pages**                                                          | Timeline step       |
| Browser discovery complete           | **Exploration complete**                                                         | Status badge        |
| Continue to HTTP Discovery           | _(removed — auto-chains)_                                                        | —                   |
| Use browser results only             | _(removed — auto-chains)_                                                        | —                   |
| Try browser discovery                | **Discover more pages**                                                          | Sidebar link        |
| No matching pages found via HTTP     | **No matching pages found**                                                      | TC1 card            |
| Try browser mode for JS-hidden links | **Searching deeper...**                                                          | Auto-action         |
| Start Browser Discovery              | **Search deeper**                                                                | TC1 action          |
| JavaScript rendering                 | _(removed)_                                                                      | —                   |
| JS-hidden                            | _(removed)_                                                                      | —                   |
| Opens the page in a real browser     | **Navigates the site like a visitor**                                            | Description         |
| HTTP only                            | **Standard**                                                                     | Configure rendering |
| Browser only                         | **Full rendering**                                                               | Configure rendering |
| Hybrid — HTTP + browser              | **Adaptive** _(subtitle: "Standard for most pages, full rendering when needed")_ | Configure rendering |
| Explore with Browser                 | **Explore site**                                                                 | Button              |
| HTTP link-following                  | **Link search**                                                                  | Description         |
| browser results                      | **explored pages**                                                               | Description         |
| browser mode                         | **deeper search**                                                                | Description         |

---

## 4. User Journeys — Redesigned

### Journey 1: Good Sitemap → "Use Sitemap"

No discovery needed. Unchanged except terminology in reasoning strings.

```
URL → Profile → Sections from sitemap → Configure → Crawl
```

### Journey 2: Guided Discovery → Unified Pipeline

```
URL → Profile → "Guided Discovery" → Sample URLs → Start
→ "Scanning site navigation..." (browser, 30-120s)
   └─ Tree grows, sections auto-grouped and auto-added
→ AUTO: "Searching for more pages..." (HTTP fan-out, 10-60s)
   └─ Uses browser's verified URLs as seeds
   └─ Results merge into same tree/sections (no page transition)
→ AUTO (if API patterns): "Following catalog links..." (deepen)
   └─ Results continue merging
→ Panel evolves to completion view — same container, no reload
→ Configure → Crawl
```

The entire discovery runs inside ONE persistent panel. Phase transitions are
collapsed summaries, not page navigations. The activity log is continuous —
user can scroll back to any point.

### Journey 3: "Discover More" from Sitemap

```
URL → Profile → Sitemap sections shown
→ User clicks "Discover more pages" in sidebar
→ Opens same unified discovery panel inline (no separate screen)
→ Sample URL is OPTIONAL — system can auto-explore using sitemap URLs as seeds
→ Same pipeline as Journey 2
→ New pages merge into existing sections (counts update, [NEW] on new sections)
→ Back to section review with updated sections
```

**Section merge rules**: When discovery finds pages that match an existing
section's URL pattern, the page count updates in-place. When a new URL pattern
is detected, a new section appears with a [NEW] badge. Overlapping patterns
resolve by longest-prefix match. Existing section selections (checked/unchecked)
are preserved — only new sections are auto-checked.

---

## 5. Screen-by-Screen Wireframes

### Screen A: Analysis Complete — Strategy Selection

No changes to this screen except strategy reasoning text.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓ Enter URL  ── ❷ Review Sections ── 3 Configure ── 4 Crawl      │
│                                                                     │
│  ✅ Discovering pages                                               │
│     6 pages found across 1 sections                                 │
│  ✅ Finding content sections                                        │
│     1 sections found                                                │
│  ✅ Analysis complete                                               │
│                                                                     │
│  How would you like to discover content?                            │
│  Choose a strategy based on your site's characteristics             │
│                                                                     │
│  ┌─────────────────────────┐  ┌────────────────────────────────┐   │
│  │ 📄 Crawl Full Sitemap   │  │ 🧭 Guided Discovery  ✓ Recommended│
│  │ 6 pages in sitemap      │  │ Steer the system to find       │   │
│  │                         │  │ what you need                   │   │
│  │ Sitemap coverage is     │  │ Deeper exploration will find    │   │
│  │ limited — deeper        │  │ more content                    │   │
│  │ exploration may find    │  │                                 │   │
│  │ more                    │  │                                 │   │
│  └─────────────────────────┘  └────────────────────────────────┘   │
│                                                                     │
│  1 sections to review                                               │
│  ┌─ Search sections... ──────────────────── Select all │ Unselect ┐│
│  │ □ ▸ Global  /global/{slug}                    6 pages ~12s     ││
│  └────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

**Changed from current**: Strategy reasoning no longer mentions "browser discovery".

---

### Screen B: Guided Discovery — Sample URL Input

After user clicks "Guided Discovery":

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓ Enter URL  ── ❷ Review Sections ── 3 Configure ── 4 Crawl      │
│                                                                     │
│  [StrategySelector: "Guided Discovery" selected, Sitemap dimmed]   │
│                                                                     │
│  ┌─ Discover more pages ───────────────────────────────────────────┐│
│  │                                                                  ││
│  │  The sitemap returned 6 pages in 1 section. This looks          ││
│  │  incomplete — most websites have content across many areas      ││
│  │  (products, support articles, FAQs) that sitemaps often         ││
│  │  don't list.                                                    ││
│  │                                                                  ││
│  │  Paste a page URL you expected to find but don't see in the     ││
│  │  sections below — for example, a product page, help article,    ││
│  │  or FAQ.                                                        ││
│  │                                                                  ││
│  │  ┌──────────────────────────────────────────────────────────┐   ││
│  │  │ e.g. https://epson.com/products/specific-product         │   ││
│  │  └──────────────────────────────────────────────────────────┘   ││
│  │  + Add another example                                          ││
│  │                                                                  ││
│  │  ▸ Advanced settings                                            ││
│  │                                                                  ││
│  │  [ 🧭 Start Discovery ]                                        ││
│  │                                                                  ││
│  │  ⏱ Usually takes 1-3 minutes. Sections appear as they're found. ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  1 sections to review                                               │
│  [section checklist...]                                             │
└─────────────────────────────────────────────────────────────────────┘
```

**What changed**: Added time expectation at the bottom ("Usually takes 1-3 minutes.
Sections appear as they're found."). This sets the right mental model before starting.

---

### Screen C: Unified Discovery Panel (One Continuous Container)

This is the core redesigned experience. **Screens C, D, and E are NOT separate
pages** — they are states of ONE persistent panel that evolves as discovery
progresses. Phase transitions happen via collapsing summaries, not page
navigations. The activity log is continuous and scrollable across all phases.

**Element hierarchy (consistent across all states):**

Every state of the discovery panel has the same element order from top to bottom.
Elements change visibility/content but NEVER change position:

1. Phase summary lines (collapsed completed phases)
2. Active phase label + progress bar (hidden when complete)
3. Activity log (expanded when running, collapsed toggle when complete)
4. Discovery summary table (running totals → final totals)
5. Action buttons (Stop/Background → Not enough?/Configure)

A **pulsing LED dot** (●) appears next to the active phase label to indicate
the system is working — visible even when the progress bar hasn't updated or
the log is quiet for a few seconds. The dot pulses at ~1Hz (like a recording
indicator). It disappears when the phase completes (replaced by ✅).
**Accessibility**: Respects `prefers-reduced-motion` — when reduced motion is
preferred, the dot is static (solid green) with an `aria-label="In progress"`
and visible text "running" next to it.

---

**State 1 — Navigation scan running:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓ Enter URL  ── ❷ Review Sections ── 3 Configure ── 4 Crawl      │
│                                                                     │
│  ┌─ Discovery ──────────────────────────────────────────────────────┐
│  │                                                                  │
│  │  ● Scanning site navigation · 45s · ~1-2m remaining              │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░░░  12/50 pages          │
│  │                                                                  │
│  │  ┌─ Activity Log ──────────────────────────── [Show details] ─┐ │
│  │  │ 14:32:01  Scanning /Support/Printers/ — found 32 links     │ │
│  │  │ 14:32:05  ✅ New section "ET-Series" (8 pages)             │ │
│  │  │ 14:32:08  Scanning /Support/Scanners/ — 6 pages found      │ │
│  │  │ 14:32:10  ⚠ /Support/Projectors/ timed out — retrying      │ │
│  │  │ 14:32:15  ✅ /Support/Projectors/ recovered — 4 pages      │ │
│  │  └────────────────────── scroll ──────────────────────────────┘ │
│  │                                                                  │
│  │  (Discovery summary table hidden during single-phase — appears   │
│  │   in State 2 when multi-phase comparison is meaningful)          │
│  │                                                                  │
│  │  [ ■ Stop — keep what's found ]       [ ↓ Run in background ]   │
│  └──────────────────────────────────────────────────────────────────┘
│                                                                      │
│  3 sections to review  (growing as discovery finds content)          │
│  ☑ ET-Series /Support/Printers/.../ET-Series/*   8 pages [NEW]      │
│  ☑ Scanners  /Support/Scanners/*                 6 pages [NEW]      │
│  ☑ Projectors /Support/Projectors/*              4 pages [NEW]      │
└──────────────────────────────────────────────────────────────────────┘
```

**State 2 — Link search auto-chained (same panel, no page transition):**

Navigation scan collapses to a summary line. Link search takes over the
progress bar. The activity log continues seamlessly — user can scroll up
to see navigation scan entries. Same element order throughout.

```
│  ┌─ Discovery ──────────────────────────────────────────────────────┐
│  │                                                                  │
│  │  ✅ Scanned navigation — 38 pages, 3 sections (1m 45s)          │
│  │                                                                  │
│  │  ● Searching for more pages · 12s · ~30s-1m remaining             │
│  │  ━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░░░░░░░░░░░  127/500 links       │
│  │                                                                  │
│  │  ┌─ Activity Log ──────────────────────────── [Show details] ─┐ │
│  │  │ 14:34:01  Navigation scan complete — 38 pages, 3 sections  │ │
│  │  │ 14:34:02  Searching for more pages using discovered links  │ │
│  │  │ 14:34:05  Found 14 new pages in /Support/Printers/         │ │
│  │  │ 14:34:08  Rate: 6 new pages/second                         │ │
│  │  │ 14:34:12  ✅ New section "FAQ" (42 pages)                  │ │
│  │  │                 ↑ scroll up for navigation scan log ↑       │ │
│  │  └────────────────────────────────────────────────────────────┘ │
│  │                                                                  │
│  │  ┌─ Discovery summary ───────────────────────────────────────┐  │
│  │  │  Navigation scan    38 pages    3 sections   ✅ 1m 45s    │  │
│  │  │  Link search        +57 pages   +1 section   ● running    │  │
│  │  │  ─────────────────────────────────────────────────────     │  │
│  │  │  Total              95 pages    4 sections                 │  │
│  │  └────────────────────────────────────────────────────────────┘  │
│  │                                                                  │
│  │  [ ■ Stop — keep what's found ]       [ ↓ Run in background ]   │
│  └──────────────────────────────────────────────────────────────────┘
```

**State 3 — Discovery complete (same panel, same element order):**

Progress bar disappears. Activity log collapses to a toggle (same position).
Discovery summary becomes the final summary (same position). Action buttons
change from Stop/Background to Not enough?/Configure (same position).

```
│  ┌─ Discovery complete ──────────────────────── 2m 34s total ──────┐
│  │                                                                  │
│  │  ✅ Scanned navigation — 38 pages, 3 sections (1m 45s)          │
│  │  ✅ Searched for more pages — +57 pages, 1 new section (49s)    │
│  │                                                                  │
│  │  ▸ Activity log (click to expand full history)                   │
│  │                                                                  │
│  │  ┌─ Discovery summary ───────────────────────────────────────┐  │
│  │  │  Navigation scan    38 pages    3 sections   ✅ 1m 45s    │  │
│  │  │  Link search        +57 pages   +1 section   ✅ 49s       │  │
│  │  │  ─────────────────────────────────────────────────────     │  │
│  │  │  Total              95 pages    4 sections   2m 34s        │  │
│  │  │                                                            │  │
│  │  │  Sources: 6 from sitemap · 38 from navigation ·            │  │
│  │  │           57 from link search                              │  │
│  │  └────────────────────────────────────────────────────────────┘  │
│  │                                                                  │
│  │  ┌─ We found 4 sections. There may be more. ───────────────────┐ │
│  │  │                                                              │ │
│  │  │  3 areas of the site we saw but didn't explore yet:          │ │
│  │  │  • Inkjet Printers — found in navigation at /Printers/Inkjet │ │
│  │  │  • Photo Products — found in navigation at /Printers/Photo   │ │
│  │  │  • Large-Format — found in navigation at /Printers/LFP       │ │
│  │  │                                                              │ │
│  │  │  Exploring these usually takes 1-2 more minutes. Already     │ │
│  │  │  visited pages won't be re-scanned.                          │ │
│  │  │                                                              │ │
│  │  │  [ 🔍 Explore these areas ]  [ + Add a different URL ]      │ │
│  │  └──────────────────────────────────────────────────────────────┘ │
│  └──────────────────────────────────────────────────────────────────┘
│                                                                      │
│  4 sections to review                                                │
│  [full section checklist]                                            │
│                                                                      │
│  [ Configure Crawl (95 pages) ]                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key design elements:**

- **Consistent element hierarchy**: Elements are ALWAYS in the same order — summary
  lines, progress bar, activity log, discovery summary, action buttons. The only
  changes between states are: visibility (progress bar hides on complete), content
  (summary updates), and expand/collapse (activity log). No element shuffling.
- **Pulsing LED indicator (●)**: A green pulsing dot (~1Hz) appears next to the
  active phase label ("● Scanning site navigation"). Gives immediate feedback that
  the system is alive, even during quiet moments when the progress bar and log
  haven't updated. Disappears when phase completes (replaced by ✅). Respects
  `prefers-reduced-motion` (static dot + "running" text).
- **One container, three states**: The discovery panel is a single React component
  that transitions through scanning → searching → complete. No route changes, no
  re-mounts, no flashing. The DOM container stays mounted throughout.
- **Progressive collapse**: When a phase finishes, it collapses from a full progress
  bar + active log into a single "✅ summary" line. The next phase slides in below.
  This feels like a continuous flow, not three separate screens.
- **Continuous activity log**: One scrollable log across all phases. Entries from
  navigation scan remain visible when link search starts — user scrolls up to see
  earlier entries. On completion, the log collapses to a "▸ Activity log" toggle
  (same position) that expands the full history.
- **Discovery summary evolves in-place**: Hidden during State 1 (single row is
  redundant). Appears in State 2 with completed row + running row + total. On
  completion, all rows show ✅ with final numbers + failure summary + recommended
  crawl settings.
- **Phase labels without "of N"**: Descriptive labels: "Scanning site navigation",
  "Searching for more pages", "Following catalog links". No moving finish line.
- **Dynamic time estimate as range**: "45s · ~1-2m remaining" recalculates based on
  queue size and average time per page. Hidden for first 20% of progress, shown as
  a range (not point estimate) to avoid false precision.
- **Two-level activity log**: Default shows milestones + failures. "Show details"
  toggle expands to every-page-visit level. Toggle persists for the session.
- **Sections auto-grouped**: Discovered pages are automatically grouped into sections
  based on URL patterns. Sections appear in the checklist below with [NEW] badges.
- **Stop keeps everything**: "Stop — keep what's found" explicitly tells the user
  their results are preserved. No ambiguity about data loss.

---

### Screen D: Two-Tier Failure Handling

Failures during discovery use a **two-tier model** that lets the system handle
what it can and only escalates to the user when genuinely stuck.

**Tier 1 — System handles silently (90% of failures):**

Rate limiting, timeouts, retries, speed adjustment — the system already knows
what to do. These appear as **one-line log entries**, not action cards. No
buttons, no interruption. The user sees the system is smart.

```
│  ┌─ Activity Log ──────────────────────────── [Show details] ─┐ │
│  │                                                              │ │
│  │ 14:32:01  Scanning /Support/Printers/ — found 32 links      │ │
│  │ 14:32:05  ✅ New section "ET-Series" (8 pages)              │ │
│  │ 14:32:08  ⚠ /Support/Downloads/ timed out — retrying        │ │
│  │ 14:32:12  ✅ /Support/Downloads/ recovered — 3 pages        │ │
│  │ 14:32:15  ⚠ Rate limited — auto-slowed to 1 req/sec         │ │
│  │ 14:32:18  Scanning /Support/Scanners/ — 6 pages found       │ │
│  │ 14:32:22  ⚠ /Support/Software/ returned 500 — retrying      │ │
│  │ 14:32:25  ⚠ /Support/Software/ retry failed — skipped       │ │
│  │ 14:32:28  ✅ New section "Scanners" (6 pages)               │ │
│  └────────────────────── scroll ──────────────────────────────┘ │
```

**Tier 1 failure types (system auto-remediates, log entry only):**

- **Rate limiting (429)**: Auto-slows, pauses, resumes. Log: "⚠ Rate limited — auto-slowed to 1 req/sec"
- **Timeout**: Auto-retries once with longer timeout. Log: "⚠ /path/ timed out — retrying"
- **Site errors (500)**: Auto-retries up to 3x with backoff. Log: "⚠ /path/ returned 500 — retrying"
- **Connection refused**: Logs and moves on. Log: "⚠ /path/ — connection refused, skipped"
- **Retry success**: Log: "✅ /path/ recovered — N pages found"
- **Retry exhausted**: Log: "⚠ /path/ — failed after 3 attempts, skipped"

**Batching rule**: Repeated failures of the same type from the same section are
collapsed into a single log line: "⚠ Rate limited 4 times in /Support/ — auto-adjusted speed"

**Tier 2 — Escalate to user ONLY when system is stuck:**

The system surfaces an escalation card only when it has exhausted automatic
options and user input would change the outcome. These are rare.

```
│  ┌─ Activity Log ──────────────────────────── [Show details] ─┐ │
│  │                                                              │ │
│  │ 14:33:10  ✅ New section "Products" (22 pages)              │ │
│  │                                                              │ │
│  │ 14:33:15  ❌ Blocked — /members/ requires login              │ │
│  │           ┌──────────────────────────────────────────────┐  │ │
│  │           │ 12 pages in this area are behind a login       │  │ │
│  │           │ wall. The system can't access them.            │  │ │
│  │           │                                               │  │ │
│  │           │ [ ⏭ Skip these pages ]                        │  │ │
│  │           └──────────────────────────────────────────────┘  │ │
│  │                                                              │ │
│  │ 14:33:30  ❌ Persistent blocking — site rejecting access     │ │
│  │           ┌──────────────────────────────────────────────┐  │ │
│  │           │ Multiple sections returned "access denied"     │  │ │
│  │           │ after retries and mode switches. The site may  │  │ │
│  │           │ be blocking automated visitors.                │  │ │
│  │           │                                               │  │ │
│  │           │ [ ⏭ Skip blocked areas ]                      │  │ │
│  │           │ [ ■ Stop — keep what's found ]                │  │ │
│  │           └──────────────────────────────────────────────┘  │ │
│  └────────────────────── scroll ──────────────────────────────┘ │
```

**Tier 2 escalation triggers (only these get action cards):**

- **Persistent blocking**: 3+ retries failed AND mode switch didn't help.
  Actions: Skip blocked areas, Stop discovery.
- **Login wall** (V2 — requires backend detection): Pages behind authentication.
  Actions: Skip these pages. _(No "coming soon" — login wall detection ships
  when the backend classifier is ready.)_
- **Budget exhaustion with low results**: 80%+ budget used, <5 pages found.
  Actions: Add more example URLs, Continue anyway.

**Failure summary on completion (State 3):**

When discovery finishes, the discovery summary table includes a failure row
and recommends crawl settings based on what was learned:

```
│  ┌─ Discovery summary ───────────────────────────────────────┐  │
│  │  Navigation scan    38 pages    3 sections   ✅ 1m 45s    │  │
│  │  Link search        +57 pages   +1 section   ✅ 49s       │  │
│  │  ─────────────────────────────────────────────────────     │  │
│  │  Total              95 pages    4 sections   2m 34s        │  │
│  │                                                            │  │
│  │  ⚠ Issues: Rate limited 4x · 12 pages behind login ·      │  │
│  │            1 section unreachable                            │  │
│  │                                                            │  │
│  │  Recommended crawl settings:                               │  │
│  │  • Speed: Slow (1 req/sec) — this site rate-limits         │  │
│  │  • Rendering: Adaptive — some sections need full rendering │  │
│  │  [ ⚙ Review crawl settings ]                              │  │
│  └────────────────────────────────────────────────────────────┘  │
```

The "Review crawl settings" button leads directly to the Configure step
with the recommended settings pre-applied. The system learned during
discovery and carries that knowledge forward to the crawl configuration.

---

### Screen E: Empty State — Nothing Found

When discovery finds zero content (common with Cloudflare/Akamai-protected
sites), show a helpful empty state instead of a dead end:

```
│  ┌─ Discovery complete ──────────────────────── 1m 12s total ──────┐
│  │                                                                  │
│  │  ✅ Scanned navigation — 0 pages found (52s)                    │
│  │  ✅ Searched for more pages — 0 pages found (20s)               │
│  │                                                                  │
│  │  ▸ Activity log — see what was attempted                        │
│  │                                                                  │
│  │  ┌─ No content found ────────────────────────────────────────┐  │
│  │  │                                                            │  │
│  │  │  We explored the site but couldn't find any matching       │  │
│  │  │  content. This usually happens when:                       │  │
│  │  │                                                            │  │
│  │  │  • The site blocks automated visitors (bot protection)     │  │
│  │  │  • Content is loaded dynamically after login               │  │
│  │  │  • The example URLs don't match the site's actual paths    │  │
│  │  │                                                            │  │
│  │  │  What you can try:                                         │  │
│  │  │  [ 🔗 Try different example URLs ]                         │  │
│  │  │  [ 🐢 Retry with slower speed ]                            │  │
│  │  │  [ 📋 Paste URLs manually ]  (if you have a list)          │  │
│  │  └────────────────────────────────────────────────────────────┘  │
│  └──────────────────────────────────────────────────────────────────┘
│                                                                      │
│  0 sections to review                                                │
│  No content sections found yet. Try the options above.               │
└──────────────────────────────────────────────────────────────────────┘
```

**Key design elements:**

- **Not a dead end**: Three concrete actions the user can take
- **Explains why**: Common causes in plain language
- **Activity log in same position**: Collapsed toggle, same slot as running states
- **"Paste URLs manually"**: Escape hatch for users who have a URL list from another
  source (spreadsheet, other tool). Bypasses discovery entirely.

**"Paste URLs manually" expanded view:**

When user clicks "Paste URLs manually", an inline input area opens in the
same panel (no navigation):

```
│  ┌─ Paste URLs ─────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  Paste page URLs you want to include — one per line.           │  │
│  │  The system will auto-group them into sections.                │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐ │  │
│  │  │ https://epson.com/Support/Printers/All-In-Ones           │ │  │
│  │  │ https://epson.com/Support/Scanners                       │ │  │
│  │  │ https://epson.com/faq/printers                           │ │  │
│  │  │ https://epson.com/faq/scanners                           │ │  │
│  │  │                                                          │ │  │
│  │  └──────────────────────────────────────────────────────────┘ │  │
│  │  4 URLs entered                                                │  │
│  │                                                                │  │
│  │  [ Create sections from these URLs ]       [ Cancel ]          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Preview (updates as you paste):                                     │
│  ☑ Support/Printers  (1 URL)                                        │
│  ☑ Support/Scanners  (1 URL)                                        │
│  ☑ FAQ               (2 URLs)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Paste URLs behavior:**

- Simple textarea, one URL per line. No CSV upload needed for V1.
- As user pastes, a live preview shows how URLs will be auto-grouped into
  sections using the same URL-pattern logic used by discovery.
- "Create sections from these URLs" creates sections and transitions to the
  section checklist — the user can then proceed to Configure Crawl.
- Invalid URLs (not matching the base domain, malformed) are highlighted
  inline with a warning.
- This bypasses discovery entirely — no scanning, no waiting.

---

### Screen F: Background Mode

When user clicks "Run in background", the discovery panel collapses to a
persistent activity bar at the top of the KB layout. The bar stays visible
across all KB tabs (Data, Search, Settings) until discovery completes.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [KB Tabs: Home | Data | Search | Settings]                         │
│                                                                     │
│  ┌─ ● Discovery running ────────────────────────────────────────┐  │
│  │  Searching for more pages · 1m 12s · ~30s-1m                  │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░ 312/500 · 67 pages found     │  │
│  │                              [ View details ]  [ ■ Stop ]      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  [normal KB content...]                                             │
└──────────────────────────────────────────────────────────────────────┘

After discovery completes in background:
┌─────────────────────────────────────────────────────────────────────┐
│  ┌─ ✅ Discovery complete ──────────────────────────────────────┐  │
│  │  95 pages found across 4 sections · 2m 34s                    │  │
│  │                              [ View results ]                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Re-entry behavior:**

- **"View details"** (while running) or **"View results"** (after complete):
  Navigates back to Step 2 of the crawl flow with the discovery panel in its
  current state. If still running, user sees State 1/2. If completed, user
  lands on State 3.
- **Completion notification**: A toast notification fires when discovery
  finishes in background: "Discovery complete — 95 pages found". Ensures the
  user notices even if scrolled down or on another KB tab.
- **SSE connection drops** (network blip, proxy timeout): Auto-reconnect with
  exponential backoff (1s, 2s, 4s, max 30s). The bar shows "⚠ Reconnecting..."
  during the gap. If reconnect fails after 60s, show "Connection lost —
  discovery may still be running. [Reconnect] [View results]".
- **User navigates away from KB entirely** (different project, account settings):
  Background bar is not visible outside the KB. When user returns, the bar
  reappears with current state (SSE reconnects).

---

### Sidebar "Discover More" Entry Point

The sidebar "Discover more pages" link (previously "Try browser discovery") no longer
needs its own screen. It triggers the same unified discovery panel (Screen C) inline:

```
RIGHT SIDEBAR:
┌─ Discovery Summary ─────────────┐
│  Sitemap                    4s   │
│  6 pages found                   │
│  1 sections                      │
│                                  │
│  🔍 Discover more pages          │
└──────────────────────────────────┘
```

**Clicking "Discover more pages":**

1. Opens the unified discovery panel inline (same as Journey 2)
2. Sample URL input is **optional** — user can start immediately and the system
   uses existing sitemap URLs as seeds for exploration
3. Sets `pipelinePhase` and `strategy` correctly (fixes current sidebar bug)
4. The same continuous panel (State 1 → 2 → 3) runs as in Journey 2

No separate screen needed — this is just an entry point into the unified flow.

---

## 6. Auto-Chain Logic

The critical behavioral change: **no more choice cards**. When Phase 1 (navigation scan /
browser discovery) completes, the system automatically decides what to do next.

```
Browser discovery completes
  │
  ├─ verifiedLinks > 0 AND warm/projected URLs exist?
  │   YES → Auto-start Phase 2 (HTTP fan-out)
  │          Seeds: browser's verified URLs as sampleUrls
  │          Targets: warm URLs + API-intercepted URLs
  │          Log: "Navigation scan complete. Searching for more pages..."
  │
  ├─ verifiedLinks > 0 AND no warm URLs?
  │   → Skip Phase 2, go to complete
  │   Log: "Navigation scan complete — no additional search needed."
  │
  ├─ verifiedLinks === 0 AND links > 0?
  │   → Auto-start Phase 2 with broader seeds
  │   Log: "Navigation scan found links but none matched your pattern.
  │          Searching more broadly..."
  │
  └─ verifiedLinks === 0 AND links === 0?
      → Go to complete, show "Not enough?" card
      Log: "Navigation scan found no content. Try adding different
            example URLs or checking the site URL."
```

**Phase 2 completes:**

```
HTTP fan-out completes
  │
  ├─ API patterns found from browser interception?
  │   YES → Auto-start Phase 3 (deepen with API URLs)
  │          Log: "Found catalog patterns. Following catalog links..."
  │
  └─ No API patterns?
      → Go to complete
```

---

## 7. Code Changes Summary

### State2Analysis.tsx

- Remove `showBrowserCompleteChoice` state — delete L438, L1542-1571 (choice card)
- Fix `handleBrowserLayerComplete` — auto-chain to HTTP discover instead of choice card
- Fix sidebar "Discover more" — set `pipelinePhase` and `strategy` when clicked
- Rename `PipelinePhase` values — `'browser-running'` → `'scanning'`, `'http-running'` → `'searching'`
- Replace "Phase N of M" with descriptive labels — "Scanning site navigation", "Searching for more pages"
- Add progressive collapse — completed phases become summary lines, same container
- Add discovery summary table — per-phase contribution (replaces choice card)
- Merge results inline — HTTP results feed into same tree/section list
- Add two-tier failure handling — Tier 1 silent log lines, Tier 2 escalation cards only when stuck
- Add failure summary on completion with recommended crawl settings
- Add empty state — "No content found" with three recovery options + paste URLs manually
- Add "Not enough?" card with concrete unexplored areas from discovery tree
- Make sample URL optional for sidebar entry — system auto-explores with sitemap URLs
- Hide discovery summary table in State 1 (single phase — redundant with phase label)
- Add background mode re-entry, completion notification, SSE reconnect handling

### BrowserDiscoveryInline.tsx

| Change        | What                                                  |
| ------------- | ----------------------------------------------------- |
| Title         | "Browser Discovery" → "Exploring site"                |
| Description   | Remove "JavaScript navigation" / "browser" language   |
| Status badges | "Browser discovery complete" → "Exploration complete" |

### ExplorePanel.tsx

| Change                 | What                                                         |
| ---------------------- | ------------------------------------------------------------ |
| Not rendered as panel  | HTTP crawl logic called programmatically from State2Analysis |
| TC1 block removed      | Auto-chaining replaces manual escalation                     |
| SampleUrlInput removed | Uses State2Analysis's sample URLs                            |

### StrategySelector.tsx

| Change            | What                                                    |
| ----------------- | ------------------------------------------------------- |
| Reasoning strings | Remove "browser discovery" from all 6 reasoning strings |

### i18n (studio.json)

| Change             | What                                                      |
| ------------------ | --------------------------------------------------------- |
| ~30 string renames | Per terminology map in section 3                          |
| ~10 new strings    | Phase indicators, time estimates, auto-chain log messages |
| ~5 removed strings | Choice card strings, TC1 escalation strings               |

### State3Configure (rendering modes)

| Change          | What                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| 3 label renames | "HTTP only"→"Standard", "Browser only"→"Full rendering", "Hybrid"→"Adaptive" |

---

## 8. What Stays Unchanged

- DiscoveryPanel (tree, console, decision cards) — the rich transparency UX
- DiscoveryTree — interactive tree with live growth
- DiscoveryTimeline — step-by-step progress (but with renamed labels)
- Section checklist — all selection/editing features
- Background mode / activity bar
- File type discovery (O7)
- robots.txt card (O8)
- Crawl speed slider
- Test extraction
- Draft persistence and resume
- All backend endpoints — zero backend changes

---

## 9. Design Decisions (Resolved)

1. **Phase time display**: Descriptive label + elapsed time + dynamic progress bar.
   No "Phase N of M" numbering (phase count is variable and the "finish line" moving
   frustrates users). Instead: "Scanning site navigation · 45s · ~1-2m remaining".
   Show estimate as a range, not a point. Hide the estimate for the first 20% of
   progress (not enough data), then show once it stabilizes.

2. **Activity log verbosity**: Two-level system.
   - **Default**: Milestones + failures — new sections found, retries, errors, batch
     summaries ("Scanned /Support/Printers/ — found 12 products").
   - **Detail mode**: User clicks "Show details" toggle to see every page visit.
     Toggle defaults to collapsed. Persists across phase transitions within the same
     discovery run. On State 3 completion, expanding the log respects whatever detail
     level the user had selected.
   - **On completion**: Log collapses to "▸ Activity log" toggle — click to expand
     full history across all phases.
   - **Max height during running state**: 4-5 visible lines with scroll. Prevents the
     log from pushing the section checklist below the fold.

3. **"Not enough?" resume behavior**: Resume context — "Explore these areas" picks up
   where Phase 1 left off using the browser discovery `resumeContext` parameter.
   Already-visited pages are skipped.

4. **"Not enough?" card data source**: The unexplored areas come from the browser
   discovery tree — projected nodes that were seen in navigation menus but not visited
   (budget ran out or lower priority). No backend changes needed — the data is already
   in the browser discovery response. The card shows: area name (from link text), URL
   path, and how it was found ("found in navigation"). When zero projected nodes exist,
   the card doesn't appear. When 10+, show top 5 by navigation depth with "+N more".

5. **Continuous panel, not separate screens**: Discovery is one mounted component
   that transitions through states (scanning → searching → complete). No route
   changes, no re-mounts. Phase transitions are collapse animations — completed
   phase shrinks to a summary line, next phase appears below.

6. **Two-tier failure handling**: Tier 1 (90% of failures) — system auto-remediates
   and logs a one-line entry. No action cards, no interruption. Tier 2 (rare) —
   system escalates to user only when stuck (persistent blocking after all retries,
   login walls). On completion, a failure summary recommends crawl settings based on
   what was learned. Login wall detection deferred to V2 (needs backend classifier).

7. **Section auto-grouping & merge rules**: Discovered pages auto-group into sections
   by URL pattern. When discovery finds pages matching an existing section, the count
   updates in-place. New patterns create new sections with [NEW] badges. Overlapping
   patterns resolve by longest-prefix match. Existing checked/unchecked state is
   preserved — only new sections are auto-checked.

8. **Sidebar "Discover more" is not a separate screen**: It triggers the same unified
   discovery panel inline. Sample URL input is optional — the system can auto-explore
   using existing sitemap URLs as seeds.

9. **Discovery summary table visibility**: Hidden during State 1 (single phase — the
   one-row table is redundant with the phase label). Appears from State 2 onward when
   multi-phase comparison is meaningful.

---

## 10. Accessibility Specification

**Activity log:**

- Container: `role="log"` with `aria-live="polite"`
- Milestone entries (new sections, phase completions): announced automatically
- Failure entries: `role="alert"` for Tier 2 escalation cards (immediate announcement)
- Tier 1 failure log lines: announced as part of normal `aria-live="polite"` flow
- Detail-level entries (when "Show details" is on): NOT announced (too noisy).
  The detail log is a static scrollable region navigated on demand.

**Progress bar:**

- `role="progressbar"` with `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax`
- `aria-label` uses the phase label: "Scanning site navigation: 12 of 50 pages"
- When indeterminate (queue size unknown): `aria-valuetext="In progress"`

**Pulsing LED dot:**

- `aria-label="In progress"` on the dot element
- `prefers-reduced-motion`: static solid dot with visible text "running"
- Color is supplemented by the text label — not color-only

**Discovery tree:**

- Arrow keys for navigation (up/down between nodes, left/right to collapse/expand)
- Enter to expand/collapse
- New nodes appearing in real-time do NOT steal focus
- `aria-expanded`, `aria-level`, `aria-setsize`, `aria-posinset` on tree items

**Failure escalation cards (Tier 2):**

- `role="alert"` for immediate screen reader announcement
- Buttons inside cards in natural tab order
- Cards do NOT auto-focus (disorienting during active discovery)
- Reachable via normal tab navigation

**Discovery summary table:**

- Semantic `<table>` with `<th>` column headers: Phase, Pages, Sections, Status
- `aria-live="polite"` on the total row so updates are announced

---

## 11. Micro-Interaction Specifications

**New section appearance:**

- Section fades in with a subtle slide-down (200ms ease-out)
- [NEW] badge has a brief highlight pulse (one cycle, not continuous)
- `prefers-reduced-motion`: instant appearance, static [NEW] badge

**Activity log scroll behavior:**

- Auto-scrolls to bottom while user has NOT manually scrolled
- If user scrolls up: auto-scroll pauses, "Jump to latest ↓" pill appears
  at bottom of log area
- Auto-scroll resumes when user clicks pill or scrolls to bottom
- Same pattern as terminal emulators and chat applications

**"Show details" toggle:**

- Expand/collapse with 150ms height transition
- Expanding preserves scroll position relative to the current milestone entry
- New detail entries don't cause jarring jumps

**"Stop — keep what's found" confirmation:**

- No modal dialog (button text already communicates results are kept)
- Button text changes to "Stopping..." with spinner for 1-2 seconds
- Panel transitions to State 3 (complete) with whatever was found

**Phase collapse animation:**

- Completed phase: progress bar + active label collapse smoothly (300ms)
  into the summary line ("✅ Scanned navigation — 38 pages, 3 sections")
- 200ms pause after collapse before next phase appears
- Total transition: ~500ms. Gives user a moment to register the change.
- `prefers-reduced-motion`: instant collapse, no delay

**Progress bar:**

- Indeterminate shimmer when queue size is unknown (early discovery)
- Smooth transition from indeterminate to determinate when queue size is known
- No snapping — the bar fills smoothly
