# Unified Explore & Discovery — Complete Design

> **Purpose:** Complete design for sample-guided URL discovery with layered escalation
> (HTTP → Browser → API interception → Fan-out). Replaces the current disconnected
> ExplorePanel + Browser Discovery with a single unified panel.
>
> **Integrates with:** [crawl-user-journey.md](../specs/crawl-user-journey.md) Steps 1-2,
> [CRAWLER-SYSTEM-ARCHITECTURE.md](./CRAWLER-SYSTEM-ARCHITECTURE.md) discovery chain,
> [project_crawler_discovery_design memory] TC1/TC2 test cases.
>
> **Date:** 2026-04-17

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Entry Points](#2-entry-points)
3. [The Unified Explore Panel](#3-the-unified-explore-panel)
4. [Phase 1: Pattern Learning](#4-phase-1-pattern-learning)
5. [Phase 2: HTTP Recursive Crawl (Layer 2)](#5-phase-2-http-recursive-crawl-layer-2)
6. [Phase 2→3: TC1 Escalation Trigger](#6-phase-23-tc1-escalation-trigger)
7. [Phase 3: Browser Discovery (Layer 3)](#7-phase-3-browser-discovery-layer-3)
8. [Phase 4: Pattern Scoring & Seed Extraction](#8-phase-4-pattern-scoring--seed-extraction)
9. [Phase 5: API Interception & Catalog Exhaustion](#9-phase-5-api-interception--catalog-exhaustion)
10. [Phase 6: HTTP Fan-Out (Second Pass)](#10-phase-6-http-fan-out-second-pass)
11. [Validation Gates](#11-validation-gates)
12. [Section Creation & Merge](#12-section-creation--merge)
13. [User Guidance Points (Transparency)](#13-user-guidance-points-transparency)
14. [Discovery Audit Trail](#14-discovery-audit-trail)
15. [Draft Persistence & Resume](#15-draft-persistence--resume)
16. [Complete Data Flow](#16-complete-data-flow)
17. [UX Wireframes — Full Journey](#17-ux-wireframes--full-journey)
18. [Backend Changes](#18-backend-changes)
19. [Frontend Changes](#19-frontend-changes)
20. [Epson End-to-End Walkthrough](#20-epson-end-to-end-walkthrough)

---

## 1. Design Principles

1. **One panel, one input** — user enters sample URLs once. All discovery layers use them.
2. **Layered escalation, not parallel tools** — HTTP first (cheap), browser if needed (expensive), API if found (best).
3. **Pattern is intelligence** — every discovered URL is scored against the learned pattern. Score drives priority, filtering, and "getting warmer" feedback.
4. **Transparent at every step** — user sees what's happening, what worked, what didn't, and can guide the system at every decision point.
5. **Never generate URLs** — only discover URLs that exist as real links in HTML/DOM or API responses. Pattern scores filter and prioritize, never construct.
6. **Validate before counting** — every URL must pass pattern score → HTTP HEAD → content validation before appearing in a section.
7. **Default narrow, prompt to expand** (from user journey v3.1) — start with pattern-matched URLs only, offer unmatched as opt-in.

---

## 2. Entry Points

### Good Sitemap (≥20 pages)

Section list is primary. Below the section list:

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Can't find what you're looking for?                          │
│  Paste example URLs and we'll search deeper.                     │
└──────────────────────────────────────────────────────────────────┘
```

Click → ExplorePanel opens inline below sections.

### Thin/No Sitemap (<20 pages)

ExplorePanel is PRIMARY. Sitemap results shown as a collapsed note above.

```
┌─ Note ───────────────────────────────────────────────────────────┐
│  Sitemap found 6 pages in 2 sections.              [Sitemap ●]   │
└──────────────────────────────────────────────────────────────────┘

┌─ ExplorePanel (open, primary) ───────────────────────────────────┐
│  ...                                                             │
└──────────────────────────────────────────────────────────────────┘
```

### Known JS-Heavy Site

If site profile returns `jsRequired: true` or platform is a known SPA framework:

```
┌─ Note ───────────────────────────────────────────────────────────┐
│  ℹ️ This site uses JavaScript for navigation.                    │
│  Browser discovery will be used automatically.                   │
└──────────────────────────────────────────────────────────────────┘
```

ExplorePanel opens with a hint that browser mode may be needed. HTTP crawl still runs first (it might work for link-following even on JS sites), but TC1 threshold is lower.

---

## 3. The Unified Explore Panel

### Idle State — Sample URL Input

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                              ✕  │
│                                                                  │
│  Paste 1-3 example URLs of pages you want to find:              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ https://epson.com/Support/Printers/All-In-Ones/ET-Seri... │  │
│  └────────────────────────────────────────────────────────────┘  │
│  + Add another (max 3)                                           │
│                                                                  │
│  ▸ Advanced (max pages: 1000, max depth: 3)                      │
│                                                                  │
│  [ 🧭 Start Exploring ]                                         │
│  Paste at least 1 example URL                                    │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** User chooses what kind of pages they want by example.
No jargon. No "HTTP" or "browser mode" selection. System picks strategy.

---

## 4. Phase 1: Pattern Learning

Instant, client-side. Shows immediately after user pastes URLs.

### Single Sample

```
┌─ Pattern ────────────────────────────────────────────────────────┐
│  ✨ Pattern detected from your example                           │
│                                                                  │
│  Template: /Support/Printers/{*}/{*}/{*}/s/SPT_{*}              │
│  Scope:    epson.com/Support/Printers/*                          │
│  Confidence: Low (1 sample — add more for better accuracy)       │
│                                                                  │
│  We'll search for pages matching this pattern.                   │
└──────────────────────────────────────────────────────────────────┘
```

### Multiple Samples (2-3)

```
┌─ Pattern ────────────────────────────────────────────────────────┐
│  ✨ Pattern detected from 3 examples                             │
│                                                                  │
│  Template: /Support/Printers/{category}/{series}/{model}/s/SPT_… │
│  Scope:    epson.com/Support/Printers/*                          │
│  Confidence: High (3 samples, consistent structure)              │
│                                                                  │
│  Variable segments detected:                                     │
│    {category}: All-In-Ones, Inkjet, Laser                        │
│    {series}:   ET-Series, WF-Series, XP-Series                   │
│    {model}:    product-specific identifier                        │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** User can see if the pattern looks right. If they see
`{category}` showing only "All-In-Ones" but they also want "Laser", they know
to add another sample from a different category.

---

## 5. Phase 2: HTTP Recursive Crawl (Layer 2)

System starts HTTP link-following from the base URL. Every discovered URL is
scored against the learned pattern (0-100).

### Progress UI — Active Crawl

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                                 │
│                                                                  │
│  ┌─ Pattern ──────────────────────────────────────────────────┐  │
│  │ /Support/Printers/{*}/{*}/{*}/s/SPT_{*}                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Step 1 of 2: Following links...                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 47/1000                     │
│                                                                  │
│     47           312          28            0                     │
│   Found        Visited      Queued     ✨ Matched                 │
│                                                                  │
│  ┌─ Discovery method ────────────────────────────────────────┐   │
│  │ 🔗 HTTP link-following                          Active ●  │   │
│  │    Following <a href> links from static HTML              │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Live feed ────────────────────────────────────────────────┐  │
│  │ ● /Support/Printers/sh/s1                      score: 42  │  │
│  │ ○ /For-Home/Printers/c/h1                      score: 18  │  │
│  │ ○ /support/wa00903a                            score: 8   │  │
│  │ ○ /corporate/about-us                          score: 3   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Depth: d1 [8]  d2 [24]  d3 [15]                                │
│                                                                  │
│  [ ■ Stop ]                                                      │
└──────────────────────────────────────────────────────────────────┘
```

**Key transparency elements:**

- **✨ Matched counter** — prominently shows how many URLs match the pattern.
  If this stays at 0, user can see the problem forming in real-time.
- **Score per URL** in live feed — user sees the system's "intelligence" working.
  High scores light up, low scores fade.
- **Discovery method badge** — user knows we're using HTTP link-following.
- **"Step 1 of 2"** — user knows there's a fallback if this doesn't work.

**TC2 (auto-pattern detection):** During crawl, if URLs score 40-79 ("getting warmer"),
highlight them in the live feed with an amber indicator:

```
│ ◉ /Support/Printers/All-In-Ones/ET-Series/       score: 65 🔥 │
│   Getting warmer — following this branch first                  │
```

This shows the user the system is learning and prioritizing intelligently.

### Phase 2 Complete — Matches Found

If `matched > 0`, sections are auto-applied but the panel stays open showing
the discovery audit and browser escalation options:

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                                 │
│                                                                  │
│  ✅ Complete — 12 matched of 47 pages discovered                 │
│                                                                  │
│  ┌─ Discovery audit ─────────────────────────────────────────┐   │
│  │     47          12          312          35                │   │
│  │   Found      Matched     Visited    Unmatched             │   │
│  │                                                            │   │
│  │  Depth: d1 [8]  d2 [24]  d3 [15]                          │   │
│  │  35 unmatched pages added as unselected sections           │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  🖥️ Expecting more? Try browser mode for JS-hidden links        │
│                                                                  │
│  [ Done — close panel ]                                          │
└──────────────────────────────────────────────────────────────────┘
```

**Key behaviors:**

- **Panel stays open** after auto-apply — user sees metrics and can escalate
- **Matched pages** → `included: true` sections (auto-selected)
- **Unmatched pages** → `included: false` sections (visible but unselected)
- **User controls everything** — can toggle unmatched sections back on, or escalate to browser

**Browser escalation tiers** (all within ExplorePanel, one panel one input):

- `matched === 0` → prominent TC1 warning card with browser CTA
- `matched 1-19` → accent link: "Expecting more? Try browser mode..."
- `matched ≥ 20` → quiet link: "Some sites hide content behind JavaScript menus."

**Source of truth:** `progress.matched` counter (not the mid-crawl `no-matches` event).
The counter updates with every SSE progress tick and reflects the final state at completion.

---

## 6. Phase 2→3: TC1 Escalation Trigger

### Automatic Trigger (matched === 0)

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                                 │
│                                                                  │
│  ⚠️ Step 1 complete — Found 47 pages but none match your         │
│     examples                                                     │
│                                                                  │
│  ┌─ Discovery audit ─────────────────────────────────────────┐   │
│  │ 🔗 HTTP link-following:  47 found, 0 matched, 312 visited │   │
│  │                                                            │   │
│  │ Why no matches?                                            │   │
│  │ The pages you're looking for may be loaded by JavaScript   │   │
│  │ (dropdown menus, tabs, or single-page navigation).         │   │
│  │ HTTP link-following only sees static HTML links.           │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Recommended next step ───────────────────────────────────┐   │
│  │                                                            │   │
│  │  🖥️ Browser Mode                                          │   │
│  │                                                            │   │
│  │  We'll open the page in a real browser and click through   │   │
│  │  menus, dropdowns, and expandable sections to find hidden  │   │
│  │  links. Takes 2-3 minutes.                                 │   │
│  │                                                            │   │
│  │  Your example pattern will be used to filter results.      │   │
│  │                                                            │   │
│  │  [ 🖥️ Start Browser Discovery ]                           │   │
│  │                                                            │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Or: [ Use the 47 pages found anyway ]  [ Close ]               │
└──────────────────────────────────────────────────────────────────┘
```

**Transparency:**

- Explains WHY HTTP didn't work (JS navigation)
- Shows the audit trail (47 found, 0 matched)
- Makes clear that browser mode uses the same example pattern
- Gives user choice: escalate, use what's there, or close

### Auto-Escalation for Known JS Sites

If profile says `jsRequired: true`, skip the prompt — go directly to browser
with a brief notification:

```
│  ℹ️ This site uses JavaScript navigation.                        │
│  Skipping link-following — starting browser mode directly.       │
```

---

## 7. Phase 3: Browser Discovery (Layer 3)

Runs Playwright with `linkFilter` derived from the learned pattern regex.
Network interception runs simultaneously to capture API calls.

### Progress UI — Browser Active

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                                 │
│                                                                  │
│  ┌─ Pattern ──────────────────────────────────────────────────┐  │
│  │ /Support/Printers/{*}/{*}/{*}/s/SPT_{*}                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Step 2 of 2: Browser discovery                                  │
│                                                                  │
│  ┌─ Discovery method ────────────────────────────────────────┐   │
│  │ 🖥️ Browser rendering + navigation                Active ●│   │
│  │    Opening page in real browser, clicking through menus    │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  🖥️ Exploring navigation...                                     │
│                                                                  │
│  Expandables:  24 / 41 clicked                                   │
│  Links found:  237 total                                         │
│  ✨ Matched:    89 match your pattern                             │
│  🔥 Warm:       34 partial matches (category/series pages)       │
│  APIs found:    3 network requests captured                      │
│                                                                  │
│  Current: clicking "All-In-Ones > ET Series > ..."              │
│                                                                  │
│  ┌─ Navigation tree (live) ──────────────────────────────────┐   │
│  │ ▾ Printers                                                │   │
│  │   ▾ All-In-Ones                          12 products found│   │
│  │     ▾ ET-Series ✅                        8 matched       │   │
│  │     ▸ WF-Series ⏳                        exploring...    │   │
│  │   ▸ Inkjet                                                │   │
│  │   ▸ Laser                                                 │   │
│  │   ▸ Photo                                                 │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [ ■ Stop ]                                                      │
└──────────────────────────────────────────────────────────────────┘
```

**Key transparency elements:**

- **Navigation tree (live)** — user sees the site structure being explored in
  real-time. They can see which categories have been explored (✅), which are
  in progress (⏳), and which are pending.
- **Three counters:** Total links, pattern-matched, and "warm" partial matches.
  User can see the system filtering intelligently.
- **APIs found** — if network interception captures API calls, show the count.
  This gives user confidence that we found a shortcut.
- **Current element** — shows what's being clicked, so user understands the
  exploration is systematic.

**User guidance point:** If user sees the tree and notices a category is missing
(e.g., "I also need Scanners but it's only showing Printers"), they can:

```
│  Missing a category? [ + Add another example URL ]               │
│  We'll expand the pattern to include it.                         │
```

This lets the user guide the system mid-discovery without restarting.

### Phase 3 Complete

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Explore Site                                                 │
│                                                                  │
│  ✅ Browser discovery complete                                   │
│                                                                  │
│  ┌─ Results summary ─────────────────────────────────────────┐   │
│  │                                                            │   │
│  │  237 links found → pattern scored:                         │   │
│  │                                                            │   │
│  │  ✨ 89 direct matches (score ≥80)    → creating sections   │   │
│  │  🔥 34 partial matches (score 40-79) → seeds for deeper    │   │
│  │     search                                                 │   │
│  │  ── 114 unrelated (score <40)        → excluded            │   │
│  │                                                            │   │
│  │  🔌 3 API patterns captured          → can find more       │   │
│  │     products without browser                               │   │
│  │                                                            │   │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ What's next ─────────────────────────────────────────────┐   │
│  │                                                            │   │
│  │  We found 89 matching pages, but your site likely has      │   │
│  │  more. We captured 3 API patterns and 34 category pages    │   │
│  │  that can lead to more products.                           │   │
│  │                                                            │   │
│  │  [ 🔍 Search deeper — find all products ]                  │   │
│  │     Uses captured APIs + follows links from category pages │   │
│  │     Estimated: ~60 seconds                                 │   │
│  │                                                            │   │
│  │  [ ✅ Use these 89 pages ]                                 │   │
│  │     Create sections from what we found                     │   │
│  │                                                            │   │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** User decides whether 89 pages is enough or they want
the system to search deeper. This is the "default narrow, prompt to expand"
principle — we show what we have, user opts UP.

---

## 8. Phase 4: Pattern Scoring & Seed Extraction

When user clicks "Search deeper", the system processes browser results through
the pattern matcher.

### Pattern Refinement

```
Before browser (1 sample):
  Pattern: /Support/Printers/{*}/{*}/{*}/s/SPT_{*}
  Confidence: Low

After browser (89 matched examples):
  Pattern: /Support/Printers/{category}/{series}/{model}/s/SPT_{sku}
  Known values:
    category: [All-In-Ones, Inkjet, Laser, Photo, Large-Format, Receipt, Label, Dot-Matrix]
    series: [ET-Series, WF-Series, XP-Series, Expression-Series, AcuLaser-Series, ...]
  Confidence: High (89 consistent examples)
```

### Scoring All 237 URLs

```
Score ≥80 (Direct matches — 89 URLs):
  These ARE the target pages. Use for sections.

  /Support/Printers/All-In-Ones/ET-Series/Epson-ET-1913/s/SPT_C11CL65201   → 95
  /Support/Printers/Inkjet/XP-Series/Epson-XP-4200/s/SPT_C11CK65201       → 92

Score 40-79 (Partial matches — 34 URLs):
  These share the prefix path but are intermediate pages.
  They are SEEDS — crawling them leads to more product pages.

  /Support/Printers/All-In-Ones/ET-Series/                                  → 65
  /Support/Printers/Inkjet/XP-Series/                                       → 62
  /Support/Printers/Laser/                                                  → 48

Score <40 (Unrelated — 114 URLs):
  Different part of the site. Discard without HTTP cost.

  /For-Home/Printers/c/h1                                                   → 20
  /corporate/about-us                                                       → 5
```

### Secondary Pattern Discovery

While scoring, also detect NEW patterns from links found on matched pages.
Example: each product page has FAQ links:

```
From matched page /Support/Printers/.../Epson-ET-1913/s/SPT_C11CL65201:
  Found link: /faq/SPT_C11CL65201~faq-00004fe?faq_cat=faq-topFaqs
  Found link: /faq/SPT_C11CL65201~faq-00012ab?faq_cat=faq-wireless

Secondary pattern detected:
  /faq/SPT_{sku}~{faq-id}?faq_cat={category}
  Related to primary pattern via shared {sku} segment.
```

This secondary pattern is shown to user for confirmation:

```
┌─ Related content discovered ─────────────────────────────────────┐
│                                                                  │
│  While exploring product pages, we found a related pattern:      │
│                                                                  │
│  📋 FAQ Pages: /faq/SPT_{sku}~{faq-id}                          │
│     ~65 FAQ links per product page (11 categories)               │
│     Estimated total: ~5,000+ FAQ pages                           │
│                                                                  │
│  [ ☑ Include FAQ pages ]  [ ☐ Skip — products only ]            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** User decides which related content to include.
System found it automatically, user approves or skips.

---

## 9. Phase 5: API Interception & Catalog Exhaustion

During browser discovery, Playwright intercepts XHR/fetch requests. If the JS
dropdowns are backed by an API, we capture the pattern.

### What Gets Captured

```
Browser clicks "All-In-Ones" dropdown
  → Intercept: GET /api/support/products?type=all-in-ones
  → Response: JSON [{sku, name, url}, ...]

Browser clicks "ET-Series" sub-dropdown
  → Intercept: GET /api/support/products?type=all-in-ones&series=et-series
  → Response: JSON [{sku, name, url}, ...]
```

### API Exhaustion

Using captured API pattern + known parameter values from browser discovery:

```
API: /api/support/products?type={type}&series={series}

Known types (from browser):
  [all-in-ones, inkjet, laser, photo, large-format, receipt, label, dot-matrix]

Known series per type (from browser):
  all-in-ones: [et-series, wf-series, ...]
  inkjet: [xp-series, expression-series, ...]

For each type × series combination:
  Call API → get product list → extract URLs
  Each call: ~200ms, returns structured JSON

Result: Complete product catalog (500+ products)
```

### Progress UI — API Exhaustion

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Searching deeper...                                         │
│                                                                  │
│  ┌─ Discovery methods ───────────────────────────────────────┐   │
│  │ 🔗 HTTP link-following                         ✅ 0 matched│  │
│  │ 🖥️ Browser discovery                          ✅ 89 matched│  │
│  │ 🔌 API discovery                               Active ●   │  │
│  │    Querying product catalog API...                         │  │
│  │    16 API calls, 480 products found                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ API progress ────────────────────────────────────────────┐   │
│  │ All-In-Ones / ET-Series     ✅  45 products               │  │
│  │ All-In-Ones / WF-Series     ✅  30 products               │  │
│  │ Inkjet / XP-Series          ✅  25 products               │  │
│  │ Inkjet / Expression-Series  ✅  18 products               │  │
│  │ Laser / AcuLaser-Series     ⏳  querying...               │  │
│  │ Photo / ...                     pending                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Products found: 480 (was 89 from browser)                       │
│  Validating URLs...                                              │
└──────────────────────────────────────────────────────────────────┘
```

**Transparency:** User sees each API call and its result. They can see the
catalog being exhausted systematically. If an API call fails, it's shown.

### When No API Is Found

If network interception captures no relevant APIs, skip this phase and go
directly to HTTP fan-out from partial-match seeds.

```
│  ℹ️ No catalog API found. Using category pages to search deeper. │
```

---

## 10. Phase 6: HTTP Fan-Out (Second Pass)

Using the complete product catalog (from API or from browser's 89), HTTP crawl
each product page to discover linked content (FAQs, manuals, downloads).

### What Triggers Fan-Out

Fan-out runs when:

1. User opted to "Include FAQ pages" (secondary pattern confirmed)
2. There are partial-match seed URLs to explore (and no API found them)
3. Pattern scoring found "getting warmer" pages worth crawling

### Progress UI — Fan-Out

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 Searching deeper...                                         │
│                                                                  │
│  ┌─ Discovery methods ───────────────────────────────────────┐   │
│  │ 🔗 HTTP link-following  (pass 1)               ✅ 0 matched│  │
│  │ 🖥️ Browser discovery                          ✅ 89 matched│  │
│  │ 🔌 API discovery                              ✅ 480 products│ │
│  │ 🔗 HTTP link-following  (pass 2)               Active ●   │  │
│  │    Following links from 480 product pages                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Following links from product pages...                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 240/480 pages               │
│                                                                  │
│  Content discovered:                                             │
│    📋 FAQ pages:         4,200 found                             │
│    📖 Manual pages:        380 found                             │
│    📥 Download pages:      290 found                             │
│                                                                  │
│  ┌─ Live feed ────────────────────────────────────────────────┐  │
│  │ ● /faq/SPT_C11CL65201~faq-00004fe    FAQ: Top FAQs       │  │
│  │ ○ /faq/SPT_C11CL65201~faq-00012ab    FAQ: Wireless       │  │
│  │ ○ /Support/.../Epson-ET-1913/manuals  Manuals             │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [ ■ Stop — I have enough ]                                      │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** User can stop at any time. "I have enough" — system
uses whatever has been found so far. No all-or-nothing.

---

## 11. Validation Gates

Every discovered URL passes through 3 gates before being added to a section.

```
Link discovered (from HTML, API, or DOM)
         │
    Gate 1: Pattern Score (instant, no HTTP)
         │  Score ≥ threshold? → proceed
         │  Score < threshold? → discard (no HTTP cost)
         │
         │  Threshold varies by context:
         │    Direct match: ≥80
         │    Fan-out seed: ≥40
         │    Secondary pattern: ≥70 against secondary pattern
         │
    Gate 2: HTTP HEAD Check (cheap, 1 request per URL)
         │  200 OK? → proceed
         │  301/302? → follow redirect, re-check final URL
         │  404/410? → dead link, discard
         │  Soft 404? (200 but generic error page body) → discard
         │  Timeout? → mark as uncertain, try once more later
         │
    Gate 3: Content Validation (during actual crawl, not during discovery)
         │  Meaningful content? (not just nav/footer)
         │  Content length > minimum threshold?
         │  Not a duplicate? (SimHash)
         │  QualityGate score acceptable?
         │
         ▼
    ✅ Valid page → add to section with validated status
```

### UI for Validation

During discovery, show validation status:

```
│  Products: 480 found → 460 validated (20 returned 404)           │
│  FAQs:    4,200 found → validating... (3,800 of 4,200 checked)  │
```

---

## 12. Section Creation & Merge

All validated URLs go through `cluster-urls` to create sections. Sections from
all discovery methods merge into the same list.

### Section Source Badges

Each section shows which discovery method(s) contributed:

```
┌──────────────────────────────────────────────────────────────────┐
│  ☑  Product Support    /Support/Printers/{*}/.../s/SPT_{*}      │
│     460 pages  ~15m                                              │
│     [Sitemap 0] [HTTP 0] [Browser 89] [API 371]                 │
│                                                                  │
│  ☑  Product FAQs       /faq/SPT_{*}~{*}                         │
│     7,600 pages  ~4h                                             │
│     [Sitemap 0] [HTTP 7,600] [Browser 0] [API 0]                │
│                                                                  │
│  ☑  Manuals            /Support/.../manuals                      │
│     380 pages  ~12m                                              │
│     [Sitemap 0] [HTTP 380] [Browser 0] [API 0]                  │
│                                                                  │
│  ☐  Support Hub        /Support/{*}/sh/s{*}                      │
│     6 pages  ~12s                      [Sitemap 6]               │
└──────────────────────────────────────────────────────────────────┘
```

**Transparency:** User sees exactly where each section's URLs came from.
If a section says [API 371], user knows the system found a catalog API.
If it says [HTTP 7,600], user knows those were found by following links
from product pages.

---

## 13. User Guidance Points (Transparency)

Every phase has a point where the user can see what's happening and intervene.

| Phase              | What User Sees                                                   | How User Can Guide                      |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------- |
| Pattern learning   | Template + confidence + known variable values                    | Add more samples to improve pattern     |
| HTTP crawl         | Live scores, matched count, "getting warmer" highlights          | Stop early if matched count looks good  |
| TC1 trigger        | Explanation of why HTTP didn't find matches                      | Choose browser mode or use what's there |
| Browser discovery  | Navigation tree, expandables clicked, matched vs total           | Add more example URLs mid-discovery     |
| Pattern scoring    | Breakdown: matched / warm / unrelated with counts                | — (automatic, brief)                    |
| API exhaustion     | Each API call with category/series and result count              | — (automatic, fast)                     |
| Secondary patterns | Related content discovered (FAQs, manuals) with estimated counts | Include or skip each related pattern    |
| HTTP fan-out       | Content type breakdown (FAQ/manual/download counts)              | Stop when satisfied                     |
| Validation         | Validated vs 404 counts per content type                         | — (automatic)                           |
| Section creation   | Source badges showing which method found what                    | Toggle sections, review per-section     |

### Mid-Discovery User Actions

At any point during discovery, user can:

1. **Stop** — use whatever has been found so far
2. **Add example URL** — refine or broaden the pattern
3. **Skip to sections** — accept current results, don't search deeper
4. **Retry** — if browser or HTTP failed, try again

These are always visible as buttons at the bottom of the panel.

---

## 14. Discovery Audit Trail

After all discovery phases complete, show a complete audit trail.

```
┌─ Discovery Audit Trail ─────────────────────────────────────────┐
│                                                                  │
│  Method              │ Found │ Matched │ Validated │ Sections    │
│  ────────────────────┼───────┼─────────┼───────────┼──────────── │
│  Sitemap             │     6 │       6 │         6 │ Support Hub │
│  HTTP (pass 1)       │    47 │       0 │         — │ —           │
│  Browser             │   237 │      89 │        85 │ Products    │
│  API interception    │   480 │     480 │       460 │ Products    │
│  HTTP (pass 2: FAQs) │ 4,200 │   4,200 │     3,800 │ Product FAQs│
│  HTTP (pass 2: manuals)│ 380 │     380 │       370 │ Manuals     │
│  ────────────────────┼───────┼─────────┼───────────┼──────────── │
│  Total               │ 5,350 │   5,155 │     4,721 │ 4 sections  │
│                                                                  │
│  Time: 4m 32s (HTTP: 45s, Browser: 2m 50s, API: 8s, Fan-out: 49s)│
│  Pattern confidence: High (460 consistent examples)              │
│                                                                  │
│  ▸ View all 629 discarded URLs (score < 40)                      │
│  ▸ View 20 failed validations (404s)                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**User guidance point:** If user sees "629 discarded URLs" and suspects some
were valid, they can expand the list and manually include specific URLs or
adjust the pattern.

---

## 15. Draft Persistence & Resume

Every state change auto-saves to draft:

| What            | When Saved       | How Restored                      |
| --------------- | ---------------- | --------------------------------- |
| Sample URLs     | On input change  | Pre-filled in ExplorePanel        |
| Learned pattern | After Phase 1    | Shown in pattern card             |
| HTTP results    | After Phase 2    | Skip to TC1 decision              |
| Browser results | After Phase 3    | Skip to "Search deeper?" decision |
| API patterns    | After Phase 5    | Re-run API calls (fast, <10s)     |
| Validated URLs  | After each phase | Skip directly to sections         |
| Sections        | After creation   | Shown in section list             |
| Discovery audit | After completion | Shown in audit trail              |

**Resume behavior:**

- If draft has validated URLs + sections → skip to section review
- If draft has browser results but no fan-out → show "Search deeper?" decision
- If draft has only HTTP results (0 matched) → show TC1 prompt
- If draft has only sample URLs → restart from Phase 2

---

## 16. Complete Data Flow

```
User pastes 1-3 sample URLs
         │
         ▼
┌─ Phase 1: Pattern Learning (instant) ────────────────────────────┐
│  Client-side pattern detection from samples                       │
│  Output: urlTemplate, pathPrefix, confidence                      │
│  → Pattern card shown to user                                     │
└───────────────────────────┬──────────────────────────────────────┘
                            │
              ┌─────────────┴──── jsRequired? ────┐
              │ NO                                 │ YES
              ▼                                    │
┌─ Phase 2: HTTP Recursive Crawl ──────┐           │
│  Crawl from base URL                 │           │
│  Score each URL (0-100) vs pattern   │           │
│  Priority queue: high scores first   │           │
│  Track matchCount (≥80)              │           │
│                                      │           │
│  IF matchCount > 0:                  │           │
│    → cluster → sections → DONE       │           │
│    → offer "Search deeper" if low    │           │
│                                      │           │
│  IF matchCount === 0:                │           │
│    → TC1 trigger                     │           │
└──────────────┬───────────────────────┘           │
               │ TC1                               │
               ▼                                   ▼
┌─ Phase 3: Browser Discovery ─────────────────────────────────────┐
│  Playwright renders page                                         │
│  Click expandables (dropdowns, accordions, tabs)                 │
│  linkFilter = pattern regex                                      │
│  Network interception captures API calls                         │
│  Output: links[], apiPatterns[], navigationTree                  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌─ Phase 4: Pattern Scoring ───────────────────────────────────────┐
│  Score all browser links (0-100)                                 │
│  ≥80: direct matches → section URLs                              │
│  40-79: partial matches → fan-out seeds                          │
│  <40: discard                                                    │
│  Refine pattern from direct matches (1 → 89 examples)           │
│  Detect secondary patterns (FAQs, manuals)                       │
│  → User confirms: "Include FAQ pages? Manuals?"                  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
              ┌─────────────┴──── APIs captured? ──┐
              │ YES                                │ NO
              ▼                                    │
┌─ Phase 5: API Exhaustion ─────────┐              │
│  Call captured API for all known   │              │
│  parameter combinations            │              │
│  type × series → product list     │              │
│  Extract URLs from JSON responses │              │
│  Output: complete product catalog │              │
└──────────────┬────────────────────┘              │
               │                                   │
               └────────────┬──────────────────────┘
                            │
                            ▼
┌─ Phase 6: HTTP Fan-Out (second pass) ────────────────────────────┐
│  For each matched product URL:                                   │
│    HTTP GET → extract links                                      │
│    Score against secondary patterns (FAQ, manual)                │
│    Collect validated URLs                                        │
│                                                                  │
│  For each partial-match seed (if no API found):                  │
│    HTTP crawl depth=2, score new URLs                            │
│    "Getting warmer" → prioritize in queue                        │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌─ Validation Gates ───────────────────────────────────────────────┐
│  Gate 1: Pattern score ≥ threshold (already applied above)       │
│  Gate 2: HTTP HEAD → 200 OK (not 404, not soft 404)             │
│  Gate 3: Content validation (during actual crawl later)          │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌─ Section Creation ───────────────────────────────────────────────┐
│  All validated URLs → cluster-urls → sections                    │
│  Source badges per section                                       │
│  Discovery audit trail                                           │
│  Auto-save to draft                                              │
│  → Merge into main section list in State2Analysis                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 17. UX Wireframes — Full Journey

### State 2 Layout with Unified Explore (Thin Sitemap)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back                                      Crawl: epson.com    │
├──────────────────────────────────────────────────────┬───────────┤
│                                                      │           │
│  ✅ Discovering pages                                │ Site      │
│  ✅ Finding sections                                 │ Profile   │
│  ✅ Analysis complete — 6 pages in 2 sections        │           │
│                                                      │ domain    │
│  ┌─ Sitemap results (collapsed) ─────────────────┐   │ tech      │
│  │  6 pages in 2 sections           [Sitemap ●]  │   │ pages     │
│  └───────────────────────────────────────────────┘   │ sections  │
│                                                      │           │
│  ╔══════════════════════════════════════════════════╗ ├───────────┤
│  ║  🧭 Explore Site                             ✕  ║ │           │
│  ║                                                  ║ │ Estimated │
│  ║  (Current explore phase UI here)                 ║ │ Plan      │
│  ║                                                  ║ │           │
│  ║  [phases render inside this panel as described    ║ │ pages     │
│  ║   in sections 4-10 above]                        ║ │ time      │
│  ║                                                  ║ │           │
│  ╚══════════════════════════════════════════════════╝ │           │
│                                                      │           │
│  ┌─ Sections ────────────────────────────────────┐   │           │
│  │ 🔍 Search sections...        Select all | None│   │           │
│  │                                                │   │           │
│  │ ☑ Product Support  460 pages  ~15m             │   │           │
│  │   [Browser 89] [API 371]                       │   │           │
│  │                                                │   │           │
│  │ ☑ Product FAQs     7,600 pages  ~4h            │   │           │
│  │   [HTTP 7,600]                                 │   │           │
│  │                                                │   │           │
│  │ ☑ Manuals          380 pages  ~12m             │   │           │
│  │   [HTTP 380]                                   │   │           │
│  │                                                │   │           │
│  │ ☐ Support Hub      6 pages  ~12s               │   │           │
│  │   [Sitemap 6]                                  │   │           │
│  └────────────────────────────────────────────────┘   │           │
│                                                      │           │
│  ▸ Discovery audit trail                             │           │
│                                                      │           │
│  ▸ Test extraction (paste URL to preview)            │           │
│                                                      │           │
│  [ Continue → ]                                      │           │
│                                                      │           │
└──────────────────────────────────────────────────────┴───────────┘
```

### State 2 Layout with Unified Explore (Good Sitemap)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back                                      Crawl: epson.com    │
├──────────────────────────────────────────────────────┬───────────┤
│                                                      │           │
│  ✅ Discovering pages                                │ Site      │
│  ✅ Finding sections                                 │ Profile   │
│  ✅ Analysis complete — 2,847 pages in 5 sections    │           │
│                                                      │           │
│  ┌─ Sections (primary) ─────────────────────────┐    │           │
│  │ 🔍 Search sections...       Select all | None│    │           │
│  │                                               │    │           │
│  │ ☑ Products       847 pages  ~28m              │    │           │
│  │   ⚠️ Has accordions, tabs                     │    │           │
│  │ ☑ Product FAQs   312 pages  ~10m              │    │           │
│  │   ⚠️ Expandable answers                       │    │           │
│  │ ☐ Categories      24 pages  ~48s              │    │           │
│  │ ☐ Blog          1,203 pages  ~40m             │    │           │
│  │ ☐ Support Hub      89 pages  ~3m              │    │           │
│  └───────────────────────────────────────────────┘    │           │
│                                                      │           │
│  🧭 Can't find what you're looking for?              │           │
│  Paste example URLs and we'll search deeper.         │           │
│                                                      │           │
│  (clicking opens ExplorePanel inline here)           │           │
│                                                      │           │
│  ▸ Test extraction                                   │           │
│                                                      │           │
│  [ Continue → ]                                      │           │
│                                                      │           │
└──────────────────────────────────────────────────────┴───────────┘
```

---

## 18. Backend Changes

| #   | Change                                                               | File(s)                                                           | Effort                |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| B1  | Add `matchedCount` to discover crawler progress events               | `apps/search-ai/src/workers/discover-crawler.ts`                  | LOW                   |
| B2  | Pattern matcher `scoreUrl()` returns 0-100 instead of boolean        | `packages/crawler/src/intelligence/algorithms/pattern-matcher.ts` | LOW                   |
| B3  | Accept `linkFilter` in browser explore endpoint                      | `apps/search-ai/src/routes/crawl-browser-discover.ts`             | LOW                   |
| B4  | Pass `linkFilter` to Navigation Explorer config                      | `apps/crawler-mcp-server/src/explore/navigation-explorer.ts`      | LOW (already in type) |
| B5  | Network interception in Navigation Explorer                          | `apps/crawler-mcp-server/src/explore/navigation-explorer.ts`      | MEDIUM                |
| B6  | API pattern detection from intercepted requests                      | NEW: `apps/crawler-mcp-server/src/explore/api-interceptor.ts`     | MEDIUM                |
| B7  | API exhaustion endpoint (call discovered APIs with all param combos) | NEW: `apps/search-ai/src/routes/crawl-api-exhaust.ts`             | MEDIUM                |
| B8  | Secondary pattern detection from matched page links                  | `packages/crawler/src/intelligence/algorithms/pattern-matcher.ts` | MEDIUM                |
| B9  | HEAD validation batch endpoint                                       | `apps/search-ai/src/routes/crawl-validate.ts`                     | LOW                   |
| B10 | Fan-out orchestrator (browser results → API/HTTP → sections)         | NEW: `apps/search-ai/src/routes/crawl-deepen.ts`                  | HIGH                  |

### Build Order

```
Phase A (Low effort, immediate):
  B1 + B2 + B3 + B4 → matchedCount in progress + linkFilter in browser

Phase B (Medium effort):
  B5 + B6 → network interception during browser discovery
  B8 → secondary pattern detection
  B9 → HEAD validation

Phase C (Medium-high effort):
  B7 + B10 → API exhaustion + fan-out orchestrator
```

---

## 19. Frontend Changes

| #   | Change                                                           | File(s)                                  | Effort               |
| --- | ---------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| F1  | Move browser discovery state/handlers INTO ExplorePanel          | `ExplorePanel.tsx`, `State2Analysis.tsx` | MEDIUM               |
| F2  | Add `matchedCount` display during HTTP crawl                     | `ExplorePanel.tsx`                       | LOW                  |
| F3  | TC1 nudge UI (0 matches → suggest browser)                       | `ExplorePanel.tsx`                       | LOW                  |
| F4  | Manual TC1 trigger ("Expecting more?" link)                      | `State2Analysis.tsx`                     | LOW                  |
| F5  | Pass `linkFilter` to `startBrowserExplore`                       | `ExplorePanel.tsx`, `api/crawl.ts`       | LOW                  |
| F6  | Navigation tree visualization during browser discovery           | `ExplorePanel.tsx`                       | MEDIUM               |
| F7  | Pattern scoring results UI (matched/warm/unrelated breakdown)    | `ExplorePanel.tsx`                       | LOW                  |
| F8  | Secondary pattern confirmation dialog                            | `ExplorePanel.tsx`                       | LOW                  |
| F9  | API exhaustion progress UI                                       | `ExplorePanel.tsx`                       | MEDIUM               |
| F10 | HTTP fan-out progress UI                                         | `ExplorePanel.tsx`                       | LOW (reuse existing) |
| F11 | Discovery audit trail expandable                                 | `State2Analysis.tsx`                     | MEDIUM               |
| F12 | Section source badges [Sitemap] [HTTP] [Browser] [API]           | `State2Analysis.tsx`                     | LOW                  |
| F13 | Remove standalone `renderBrowserDiscovery()` from State2Analysis | `State2Analysis.tsx`                     | LOW                  |
| F14 | "Add example URL" mid-discovery                                  | `ExplorePanel.tsx`                       | LOW                  |
| F15 | Draft auto-save for all discover phases                          | `CrawlFlowV5.tsx`                        | LOW (mostly done)    |

### Build Order

```
Wave 1 (Wire existing pieces together):
  F1 + F2 + F3 + F4 + F5 + F13 → unified panel with TC1

Wave 2 (Pattern intelligence UI):
  F7 + F8 + F11 + F12 → scoring breakdown, audit trail, source badges

Wave 3 (Deep discovery UI):
  F6 + F9 + F10 + F14 → nav tree, API progress, fan-out progress

Wave 4 (Polish):
  F15 → complete draft persistence for all phases
```

---

## 20. Epson End-to-End Walkthrough

### Timeline

```
0:00  User pastes: epson.com/Support/Printers/All-In-Ones/ET-Series/Epson-ET-1913/s/SPT_C11CL65201
      Pattern: /Support/Printers/{*}/{*}/{*}/s/SPT_{*} (Low confidence)

0:02  [ 🧭 Start Exploring ]

0:05  Phase 2: HTTP crawl starts
      Live feed shows URLs with scores — all < 40
      "✨ Matched" counter stays at 0
      User can see this isn't working

0:30  Phase 2 complete: 47 found, 0 matched
      TC1 triggers automatically
      "Pages you're looking for may be loaded by JavaScript"
      [ 🖥️ Start Browser Discovery ] shown

0:32  User clicks "Start Browser Discovery"

0:35  Phase 3: Browser renders /Support/Printers/sh/s1
      Navigation tree appears: Printers > (categories loading...)

1:00  Browser clicking through dropdowns
      Tree: All-In-Ones > ET-Series ✅ (8 products)
      "✨ Matched: 12"  "🔥 Warm: 5"  "APIs found: 2"

2:30  Tree: 6 of 8 categories explored
      "✨ Matched: 89"  "🔥 Warm: 34"  "APIs found: 3"

3:00  Phase 3 complete
      "89 direct matches, 34 partial matches, 3 API patterns"

      "We found 89 matching pages, but your site likely has more."
      [ 🔍 Search deeper ] shown

3:02  User clicks "Search deeper"

3:03  Phase 4: Pattern scoring
      Refines pattern from 89 examples → High confidence
      Detects secondary pattern: /faq/SPT_{sku}~{faq-id}
      "While exploring product pages, we found FAQ pages (~65 per product)"
      [ ☑ Include FAQ pages ] shown — user confirms

3:05  Phase 5: API exhaustion
      Calling /api/support/products for 8 categories
      "480 products found (was 89 from browser)"

3:08  Phase 6: HTTP fan-out
      GET each of 460 validated product pages
      Following FAQ links: 4,200 found... 7,600... deduplicating...

4:00  Fan-out complete
      HEAD validation: 460 products ✅, 7,600 FAQs ✅, 370 manuals ✅

4:05  Sections created:
      ☑ Product Support  460 pages  [Browser 89] [API 371]
      ☑ Product FAQs     7,600 pages  [HTTP 7,600]
      ☑ Manuals          370 pages  [HTTP 370]
      ☐ Support Hub      6 pages  [Sitemap 6]

      Discovery audit trail:
      HTTP(1): 47/0 | Browser: 237/89 | API: 480/460 | HTTP(2): 8,170/8,430

      "Total: 8,436 validated pages across 4 sections"
      User reviews, toggles sections, continues to Step 3.
```

### What the User Understood at Each Moment

| Time | User's Mental Model                                                                     |
| ---- | --------------------------------------------------------------------------------------- |
| 0:05 | "System is following links on my site"                                                  |
| 0:15 | "Matched counter is 0 — these links aren't what I'm looking for"                        |
| 0:30 | "System explains: my pages are behind JavaScript. Makes sense."                         |
| 0:35 | "Now it's opening a real browser. I can see it clicking through menus."                 |
| 1:00 | "I can see the category tree forming — All-In-Ones, ET-Series..."                       |
| 2:30 | "89 products found so far. It also captured some API calls."                            |
| 3:00 | "System found 89 but says there might be more. Offering to search deeper."              |
| 3:03 | "It found FAQ pages too! ~65 per product. I want those."                                |
| 3:05 | "It's using the API it captured to get all products. Fast."                             |
| 3:08 | "Now following links from each product page to find FAQs. I can see the count growing." |
| 4:05 | "8,436 pages. I can see exactly where each came from. This is everything."              |

At no point is the user confused about what's happening or why.

---

## Appendix: What's NOT in This Design

These are explicitly deferred:

1. **URL construction from patterns** — we never generate URLs by filling in template variables. Only follow real links.
2. **Wayback/Common Crawl bootstrap** — deferred per memory (commercial use gray area).
3. **Multi-page browser discovery** — ~~running browser on each category page separately. API interception makes this unnecessary for most sites.~~ **Now addressed in §24 (Depth Probing).** Epson testing proved API interception alone is insufficient — JS-rendered category navigation requires visiting hub pages via breadcrumb climb.
4. **User-provided CSS selectors for expandables** — NavigationExplorer already has `expandableSelectors` config, but no UI for it yet.
5. **Crawl Together (Mode 2)** — the interactive LLM-assisted crawl from the intelligence loop HLD. This design covers Mode 1 discovery only.

---

## Next Objective: User-Guided Discovery (Transparency → Control)

**Status:** Post-implementation of current design

The current design gives the user **transparency** — they can see what the system is doing at every step (scores, matched counts, navigation tree, audit trail). The next evolution is turning that transparency into **active control** — the user doesn't just observe, they steer.

### Objective

Use every transparency surface as an input point where the user can guide the system's next action. The system proposes, the user disposes.

### Examples of Transparency → Control

| Current (Observe)                           | Next (Guide)                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| User sees matched count = 12                | User says "I expected ~500" → system auto-escalates to browser mode with adjusted expectations  |
| User sees navigation tree with categories   | User clicks a category to say "explore this one deeper" or "skip this branch"                   |
| User sees pattern score 42 on a URL         | User marks it as "yes, this is relevant" → system learns and adjusts scoring threshold          |
| User sees "APIs found: 3"                   | User can preview each API response and say "this one has all the products" vs "ignore this one" |
| User sees secondary pattern (FAQs) detected | User can edit the secondary pattern or add their own pattern manually                           |
| User sees section with [Browser 89] badge   | User can click into the section and remove/add individual URLs before crawl                     |
| User sees discovery audit trail             | User can re-run any individual phase ("try HTTP again with deeper crawl")                       |
| User sees "getting warmer" partial matches  | User can pin a partial match as a new seed URL for targeted deeper crawl                        |
| User sees live feed with URL scores         | User can flag a low-scoring URL as relevant → system recalibrates the pattern                   |

### Design Principle

Every piece of information shown to the user should answer two questions:

1. **What is the system doing?** (transparency — current design delivers this)
2. **What can I do about it?** (control — next objective)

The system should feel like pair-navigation: the system drives, the user reads the map and gives directions. Not autopilot, not manual — collaborative.

### Implementation Approach

This should be layered on top of the current design after it's working end-to-end. The transparency surfaces (matched counter, nav tree, scores, audit trail) become the foundation for interactive controls. No redesign needed — just adding click handlers, inline edit affordances, and feedback loops to what's already visible.

---

## 21. Implementation Status (as of 2026-04-22)

### Backend

| #   | Change                                                       | Status      | Notes                                                                                      |
| --- | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------ |
| B1  | `matchedCount` in discover crawler progress events           | **DONE**    | SSE streams `matched` count in progress events                                             |
| B2  | Pattern matcher `scoreUrl()` returns 0-100                   | **DONE**    | Score + match threshold at 80                                                              |
| B3  | Accept `linkFilter` in browser explore endpoint              | **DONE**    | `crawl-browser-discover.ts` passes to crawler-mcp                                          |
| B4  | Pass `linkFilter` to Navigation Explorer                     | **DONE**    | crawler-mcp `/api/explore` accepts linkFilter                                              |
| B5  | Network interception in Navigation Explorer                  | **DONE**    | Playwright page.route() captures XHR/fetch during navigation (commit eaf8d8b5c)            |
| B6  | API pattern detection from intercepted requests              | **DONE**    | api-interceptor.ts: URL template extraction, call count, pagination detection (eaf8d8b5c)  |
| B7  | API exhaustion endpoint                                      | NOT STARTED | Call discovered APIs with all param combos                                                 |
| B8  | Secondary pattern detection from matched page links          | NOT STARTED |                                                                                            |
| B9  | HEAD validation batch endpoint                               | NOT STARTED |                                                                                            |
| B10 | Fan-out orchestrator                                         | **DONE**    | `/discover/deepen` endpoint — fan-out from warm + API URLs (commit 0bcadc4d7)              |
| B11 | Pattern divergence bridge-page support in discover crawler   | **DONE**    | Added 2026-04-20. Allows same-domain bridge pages when base URL and pattern prefix diverge |
| B12 | Discover crawler uses user's base URL (not just domain root) | **DONE**    | Added 2026-04-20. Frontend sends full URL, not hostname                                    |
| B13 | Progressive retry (networkidle → domcontentloaded → commit)  | **DONE**    | Added 2026-04-20. Fallback chain with concrete timeout values in messages (34a2d5c13)      |
| B14 | Pattern scoring hot/warm/cold classification                 | **DONE**    | Added 2026-04-20. Score-based classification with configurable thresholds (afa31e585)      |

### Frontend

| #   | Change                                                   | Status      | Notes                                                                   |
| --- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| F1  | Browser discovery state/handlers in ExplorePanel         | **DONE**    | TC1 escalation flow works inside ExplorePanel                           |
| F2  | `matchedCount` display during HTTP crawl                 | **DONE**    | Progress shows matched/found/visited/queued                             |
| F3  | TC1 nudge UI (0 matches → suggest browser)               | **DONE**    | Warning + "Start Browser Discovery" button                              |
| F4  | Manual TC1 trigger ("Expecting more?" link)              | **DONE**    | Shown when matched > 0 but < 20                                         |
| F5  | Pass `linkFilter` to `startBrowserExplore`               | **DONE**    | Built from pattern.pathPrefix                                           |
| F6  | Navigation tree visualization during browser discovery   | NOT STARTED | Design doc describes live tree — not yet built                          |
| F7  | Pattern scoring results UI                               | **DONE**    | Hot/warm/cold classification with color badges (afa31e585)              |
| F8  | Secondary pattern confirmation dialog                    | NOT STARTED |                                                                         |
| F9  | API exhaustion progress UI                               | NOT STARTED | Depends on B7                                                           |
| F10 | HTTP fan-out progress UI                                 | NOT STARTED | Depends on B10                                                          |
| F11 | Discovery audit trail expandable                         | NOT STARTED |                                                                         |
| F12 | Section source badges [Sitemap] [HTTP] [Browser]         | **DONE**    | Badges on each section row                                              |
| F13 | Remove standalone `renderBrowserDiscovery()` from State2 | **DONE**    | Browser discovery lives in ExplorePanel only                            |
| F14 | "Add example URL" mid-discovery                          | NOT STARTED |                                                                         |
| F15 | Draft auto-save for all discover phases                  | PARTIAL     | Saves sections. Full phase state not persisted yet                      |
| F16 | Discovery Summary sidebar card                           | **DONE**    | Added 2026-04-20. Shows per-layer stats                                 |
| F17 | Section naming — multi-segment path derivation           | **DONE**    | Added 2026-04-20. Shared `deriveNameFromPattern()` util                 |
| F18 | Section list viewport-aware height                       | **DONE**    | Added 2026-04-20. `max-h-[calc(100vh-380px)]`                           |
| F19 | "Find more content" dual-action cards                    | **DONE**    | Added 2026-04-20. Two cards: samples + browser                          |
| F20 | Estimated Plan shows page ratio + selection bar          | **DONE**    | Added 2026-04-20. "X of Y pages" + progress bar                         |
| F21 | Continue button → "Configure Crawl (N pages)"            | **DONE**    | Added 2026-04-20                                                        |
| F22 | URL pattern as always-visible subtitle                   | **DONE**    | Added 2026-04-20. Was hover-only, now permanent                         |
| F23 | Standalone browser discovery (Option D)                  | **DONE**    | BrowserDiscoveryInline with API interception UI (b0a15f072)             |
| F24 | Section tree grouping by top-level path                  | **DONE**    | `groupedSections` map in State2Analysis, collapsible groups             |
| F25 | Smart default section selection                          | NOT STARTED | Pre-select by URL match, page count, depth                              |
| F26 | Editable section names (inline rename)                   | **DONE**    | Inline edit with `editName` state in State2Analysis                     |
| F27 | Flow stepper (URL Entry → Review → Configure → Crawl)    | NOT STARTED |                                                                         |
| F28 | API interception display in browser done state           | **DONE**    | Zap icon, URL templates, call counts, pagination badges (b0a15f072)     |
| F29 | Progressive retry messages with real values              | **DONE**    | "Timed out after 15s… retrying with domcontentloaded (30s)" (b0a15f072) |
| F30 | Fan-out from API URLs (not just warm)                    | **DONE**    | ExplorePanel fan-out uses API URLs as seeds (b0a15f072)                 |
| F31 | Discovery pipeline: browser→HTTP chain                   | **DONE**    | Single "Start Discovery" button, pipeline stepper (cce094dc0)           |
| F32 | Clickable sample URL chips                               | **DONE**    | `<a target="_blank">` + `↗` icon on sample URLs in State2Analysis       |
| F33 | Prominent sample URL input                               | NOT STARTED | Full-width input, clear guidance copy, proper font hierarchy (UX4)      |
| F34 | Discovery Tree (interactive)                             | NOT STARTED | Real-time tree with explore/skip controls per node (§24b)               |
| F35 | Breadcrumb chain display                                 | **DONE**    | BrowserDiscoveryInline shows strategy + breadcrumb chain (line 393-396) |
| F36 | Natural language activity status                         | NOT STARTED | Replace numeric counters with action descriptions + yield rate (§24b)   |
| F37 | Mid-discovery intervention controls                      | NOT STARTED | Explore/skip/add-sample/edit-samples during discovery (UX2)             |
| F38 | "Run in background" mode                                 | NOT STARTED | Collapse to banner, user configures sections while discovery continues  |
| F39 | Discovery state draft persistence                        | NOT STARTED | Persist tree, stats, samples, phase to CrawlDraft for resume (UX3)      |
| F40 | Discovery result caching                                 | NOT STARTED | Backend cache by hash(seedUrl+samples+config), 24h TTL (UX3)            |

---

## 22. Option D: Standalone Browser Discovery

### Problem

The original design (Section 3) treats browser discovery as Phase 3 inside the Explore Panel — an automatic escalation after HTTP explore fails (TC1). This creates two issues:

1. **Browser discovery is trapped inside the sample URL flow.** Users who know their site is JS-heavy must still open the Explore Panel (designed for "paste example URLs") before they can access browser discovery.
2. **Browser discovery has no relation to sample URLs.** It renders the base URL page, clicks expandable elements, and extracts links. It needs zero user input — just the base URL that's already known.

### Design Change

Browser discovery becomes a **peer action** alongside Explore Site, not a child of it.

```
State2Analysis — Main Flow Area
┌──────────────────────────────────────────────────────────────────┐
│  Find more content                                               │
│                                                                  │
│  ┌─────────────────────────┐  ┌─────────────────────────────┐   │
│  │  🧭 Paste example URLs  │  │  🖥️ Scan page navigation    │   │
│  │  I have example pages — │  │  Site uses JS menus,        │   │
│  │  find all similar pages │  │  dropdowns, or dynamic      │   │
│  │  on the site            │  │  content                    │   │
│  └─────────────────────────┘  └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

- **"Paste example URLs"** opens `ExplorePanel` (HTTP explore + internal TC1 → browser escalation)
- **"Scan page navigation"** starts `BrowserDiscoveryInline` directly (zero-input, just uses base URL)

### BrowserDiscoveryInline Component

A lightweight standalone component (NOT inside ExplorePanel) that:

- Takes: `baseUrl`, `onSectionsDiscovered`, `onLayerComplete`, `onClose`
- No sample URLs, no pattern learning, no ExplorePanel wrapper
- Renders inline in the main flow area (same position as ExplorePanel)
- Shows: page rendering → expandables found/clicked → links discovered → sections created
- Uses existing backend: `startBrowserExplore()`, `connectBrowserExploreProgress()`
- Clusters results via `clusterUrls()` and merges into sections

### Coexistence with ExplorePanel

The ExplorePanel retains its internal TC1 escalation path. When a user goes through sample URLs and HTTP explore finds 0 matches, the panel still suggests browser discovery internally. This is the "guided" path for users who don't know their site is JS-heavy.

Option D adds the "direct" path for users who already know.

Both paths produce the same output: `CrawlSection[]` merged into the section list.

### When Each Path is Appropriate

| Scenario                                  | Best Path                           |
| ----------------------------------------- | ----------------------------------- |
| User knows site is JS-heavy (SPAs, React) | **Scan page navigation** (direct)   |
| User has example URLs of desired pages    | **Paste example URLs** (guided)     |
| Sitemap found few pages, user unsure why  | Either — try browser first          |
| HTTP explore found 0 matches (TC1)        | Auto-escalation inside ExplorePanel |

---

## 23. Section UX Improvements

### Multi-Segment Naming (Implemented)

**Before:** `/Support/Printers/{brand}/{model}/s/{id}` → "S"
**After:** `/Support/Printers/{brand}/{model}/s/{id}` → "Support > Printers"

Algorithm: collect all literal (non-wildcard) path segments, join first 3 with " > ", title-case each. Single-character results get `/{char}/ Pages` suffix.

Shared utility: `crawl-flow/utils.ts → deriveNameFromPattern()`

### Tree Grouping (Planned — F24)

When section count > 20, group sections into a collapsible tree by top-level path:

```
▼ Support (47 sections, 412 pages)              [Select all]
    Printers (12 sections, 156 pages)
    Scanners (8 sections, 89 pages)
    Projectors (6 sections, 45 pages)
    ...
▼ Products (93 sections, 340 pages)              [Select all]
    ...
▶ Faq (3 sections, 3 pages)
```

- Each group has "Select all in group" checkbox
- Groups are sorted by total page count (most content first)
- Groups are collapsible — only top-level visible by default
- Individual sections visible on expand

### Smart Default Selection (Planned — F25)

Pre-select sections likely to be valuable:

- Sections whose pattern prefix matches the user's entered URL path
- Sections with highest page counts (main content areas)
- Sections at depth 1-2 (category/listing pages)
- Exclude pagination (`/page/{n}`), search (`/search/`), utility patterns

Show summary: "We pre-selected 24 sections (680 pages). Review and adjust."

### Editable Section Names (Planned — F26)

Pencil icon on hover → inline text edit. User renames "P" to "Products". Persisted in draft.

### Flow Stepper (Planned — F27)

Persistent breadcrumb at the top of the crawl flow:

```
Enter URL  →  Review Sections  →  Configure  →  Crawl
                   ●
```

Highlights current step. Clickable for navigation (back only).

---

## 24. Multi-Page Depth Probing — Sample-Guided Breadcrumb Climb

> **Date:** 2026-04-21
> **Status:** In progress — algorithm designed, implementation partially done
> **Problem:** Browser navigation explorer is single-page only. On JS-heavy sites like Epson, category navigation is rendered as interactive JS cards (not `<a>` tags), so the explorer finds 229 links but zero are the category links needed to go deeper.

### Failure Modes Discovered During Epson Testing

| #   | Failure                                 | Root Cause                                                                                       | Impact                                                                              |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| F1  | Category links NOT `<a>` tags           | Epson renders printer types as JS cards/buttons                                                  | `extractPageLinks()` finds 229 links, 198 are header/footer noise, 0 are categories |
| F2  | Grouping by parent prefix fails         | 198/221 links don't share path segments with parent URL (they're site-wide nav)                  | `groupSiblings()` forms no useful groups                                            |
| F3  | Seed exploration consumes entire budget | 300 expandable elements on Epson → 120-300s clicking them all                                    | Zero time left for actual depth probing                                             |
| F4  | Static time budgets don't work          | Fixed ratios (40%/60%) wrong for different sites                                                 | Blog needs 2s seed, Epson needs 120s — any static cap is wrong                      |
| F5  | Truncated paths 404                     | `/Support/Printers/All-In-Ones` is NOT valid — real URL is `/Support/Printers/All-In-Ones/sh/s1` | Only breadcrumbs know the real URL format                                           |
| F6  | Sample URLs are strongest signal        | User tells us exactly where content lives                                                        | Wasting time on seed page when sample URL is guaranteed to work                     |

### Core Design Principles

1. **No static caps** — auto mode adapts dynamically based on what it finds. Diminishing returns detection, not fixed click limits.
2. **Sample URL is the anchor** — it's guaranteed to work. Visit it FIRST.
3. **Breadcrumbs are navigation truth** — they contain REAL hub URLs with correct format (including site-specific suffixes like `/sh/s1`).
4. **User transparency at every step** — stream what's discovered so user can intervene.
5. **Adaptive budget** — don't pre-allocate. Explore until signal is sufficient, show user, let them decide.

### Algorithm: Adaptive Sample-Guided Breadcrumb Climb

```
Phase 1: VISIT SAMPLE URL (the one known-good URL)
├── Visit the sample page (guaranteed to work)
├── Extract breadcrumbs:
│   ├── Structured: nav[aria-label*=breadcrumb], [itemtype*=BreadcrumbList]
│   ├── Heuristic: ol/ul with sequential links matching URL depth pattern
│   └── Each breadcrumb = { text, href } — REAL hub URLs
├── Extract all links from sample page (adds to verified set)
├── Classify page: hub/leaf/mixed
└── Stream to UI: breadcrumb chain, page type, link count

Phase 2: CLIMB BREADCRUMBS (adaptive — shallowest first)
├── Merge breadcrumbs from all sample URLs
├── Sort by depth (visit hubs before leaves)
├── For each unvisited breadcrumb hub:
│   ├── Visit hub page
│   ├── Extract links → siblings at this level
│   ├── Stream to UI: tree visualization, sibling count
│   └── ADAPTIVE DECISION:
│       ├── Many siblings? → worth visiting more at this level
│       ├── Few siblings? → shallow level, move deeper
│       └── User can intervene: expand/prune/stop
└── Track: total pages visited, unique links, depth reached

Phase 3: SEED EXPLORATION (only if needed)
├── If breadcrumbs gave hierarchy → skip heavy seed scan
├── If no breadcrumbs → fall back to seed exploration
└── Click limit is DYNAMIC:
    ├── Track new-link-per-click rate
    ├── Stop when marginal yield drops below threshold
    └── NOT a fixed cap — driven by diminishing returns

Phase 4: FALLBACK (if no breadcrumbs found on any sample page)
├── Try truncated parent paths from sample URL
├── Follow redirects (truncated path may redirect to real hub)
├── If redirect lands on valid page → treat as hub
└── If 404 → skip to next parent level

Phase 5: PROJECTION (continuous, not a final step)
├── After each hub visit, project patterns immediately
├── Links found on visited hub pages = verified (real <a> tags)
├── Unvisited siblings = projected
└── Stream updated counts to user continuously
```

### User Transparency Model

**Every step shows the user what's happening and offers intervention options:**

#### Phase 1: Visit Sample

| Show                                                 | Intervention                                 |
| ---------------------------------------------------- | -------------------------------------------- |
| "Visiting your sample page..." with URL              | "Skip this sample"                           |
| Breadcrumb chain (each clickable, real URL on hover) | "These breadcrumbs are wrong" → skip/correct |
| Page classification (hub/leaf), link count           | "Add another sample URL" mid-discovery       |

#### Phase 2: Breadcrumb Climb

| Show                                                        | Intervention                               |
| ----------------------------------------------------------- | ------------------------------------------ |
| Live tree visualization (see wireframe below)               | Click tree node → "Explore this" or "Skip" |
| Running totals: pages visited, verified, projected          | "Explore all at this level"                |
| Current action: "Visiting All-In-Ones hub → 8 series found" | "Go deeper into [specific branch]"         |
|                                                             | "This level is enough, project the rest"   |
|                                                             | "Stop & use results"                       |
|                                                             | Adjust sample size / max depth mid-run     |

```
Live Tree Wireframe:
┌─────────────────────────────────────────────────┐
│  📊 Discovery Tree             4 pages | 89 ✓  │
│                                                  │
│  Printers (seed page — 229 links)               │
│  ├── ✅ All-In-Ones (hub — 8 series)            │
│  │   ├── ✅ ET-Series (15 models found)         │
│  │   ├── ○ WF-Series  [Explore] [Skip]          │
│  │   ├── ○ XP-Series  [Explore] [Skip]          │
│  │   └── ... 5 more   [Explore all]             │
│  ├── ○ Inkjet          [Explore] [Skip]          │
│  ├── ○ Label Printers  [Explore] [Skip]          │
│  └── ... 5 more        [Explore all]             │
│                                                  │
│  ─────────────────────────────────────           │
│  89 verified │ ~340 projected │ 4 pages visited  │
│  [Stop & use results]  [Run in background]       │
└─────────────────────────────────────────────────┘
```

#### Phase 3: Seed Exploration

| Show                                        | Intervention                                   |
| ------------------------------------------- | ---------------------------------------------- |
| "Scanning seed page for more navigation..." | "Skip seed scan" (breadcrumbs sufficient)      |
| Click progress, new-link-per-click rate     | "Keep scanning" (override diminishing returns) |
| "Diminishing returns detected — stopping"   |                                                |

#### Phase 4: Projection

| Show                                                            | Intervention                    |
| --------------------------------------------------------------- | ------------------------------- |
| URL pattern: `/Support/Printers/{type}/{series}/{model}/s/{id}` | "Visit a few more to verify"    |
| "Projecting 340 pages across 8 categories"                      | "Too broad — tighten"           |
| Confidence: 89 verified, 251 projected, 12 inferred             | "Looks right, proceed to crawl" |

#### Always Visible

- Progress: pages visited, links found, time elapsed
- Tree visualization (building in real-time)
- Stop button
- "Run in background" option

### Epson End-to-End Walkthrough

```
1. VISIT SAMPLE: /Support/Printers/All-In-Ones/ET-Series/Epson-ET-2850/s/SPT_xxx
   → Page type: leaf (product page)
   → Breadcrumbs found:
     Home → /
     Support → /Support/sh/s120
     Printers → /Support/Printers/sh/s1          ← already visited (seed)
     All-In-Ones → /Support/Printers/All-In-Ones/sh/s1   ← hub URL!
     ET Series → /Support/Printers/All-In-Ones/ET-Series/sh/s1  ← hub URL!
     ET-2850 → current page

2. CLIMB BREADCRUMBS (shallowest first):
   → /Support/Printers/sh/s1 — skip (already visited as seed)
   → /Support/Printers/All-In-Ones/sh/s1 — VISIT
     Found 8 series: ET-Series, WF-Series, XP-Series, ...
     Each links to /Support/Printers/All-In-Ones/{series}/sh/s1
   → /Support/Printers/All-In-Ones/ET-Series/sh/s1 — VISIT
     Found 15 models: ET-2850, ET-3850, ET-4850, ...
     Each links to /Support/Printers/All-In-Ones/ET-Series/{model}/s/SPT_{id}

3. USER SEES TREE:
   "Found 8 series in All-In-Ones, 15 models in ET-Series"
   User can: [Explore WF-Series too] [Explore all series] [Use results]

4. RESULT: ~25 verified + ~150 projected from 4 page visits in ~90s
   (vs previous broken: 229 verified, 0 projected from 1 page in 300s)
```

### Edge Cases

| Case                                     | How Algorithm Handles It                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Sample URL IS a leaf page                | Normal case — extract breadcrumbs, climb up to find hubs                    |
| Sample URL IS a hub page                 | Extract breadcrumbs AND sub-links. Hub provides siblings directly           |
| No breadcrumbs on sample page            | Fallback: try truncated paths, follow redirects                             |
| Truncated paths 404                      | Skip to next level up. If all fail, fall back to seed exploration           |
| No back navigation at all                | Fall back to seed exploration + grouping strategy                           |
| Multiple samples from different branches | Merge breadcrumbs, visit unique hubs from each branch                       |
| Breadcrumbs use JavaScript onclick       | Extract href from structured data attributes if present; otherwise fallback |
| Site uses hash routing (#/section)       | Detect SPA pattern, fall back to API interception strategy                  |

### Implementation Files

- `apps/crawler-mcp-server/src/explore/depth-prober.ts` — main orchestrator
- `apps/crawler-mcp-server/src/explore/breadcrumb-extractor.ts` — NEW: breadcrumb extraction
- `apps/crawler-mcp-server/src/explore/page-classifier.ts` — hub/leaf/mixed classification
- `apps/crawler-mcp-server/src/explore/navigation-explorer.ts` — single-page explorer (seed scan)
- `apps/crawler-mcp-server/src/server.ts` — `/api/explore-deep` endpoint
- `apps/search-ai/src/routes/crawl-browser-discover.ts` — SSE proxy with depth probing events
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — UI + tree viz

### What's Implemented vs Pending

| Component                    | Status      | Notes                                                                                            |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| depth-prober.ts orchestrator | **DONE**    | 5-phase algorithm: page classify → breadcrumb climb → fan-out → diminishing returns → projection |
| Breadcrumb extraction        | **DONE**    | `breadcrumb-extractor.ts` — 5 strategies (aria, nav, structured-data, heading, DOM)              |
| Adaptive diminishing returns | **DONE**    | Diminishing returns detection with yield tracking per hub                                        |
| Live tree visualization UI   | NOT STARTED | F6 in frontend backlog                                                                           |
| User intervention controls   | NOT STARTED | "Explore"/"Skip" buttons on tree nodes                                                           |
| "Run in background" option   | NOT STARTED | UX3c in backlog                                                                                  |
| page-classifier.ts           | DONE        | Hub/leaf/mixed via 6 DOM signals                                                                 |
| /api/explore-deep endpoint   | DONE        | SSE streaming, progress events                                                                   |
| SSE proxy (search-ai)        | DONE        | Forwards depth probing events                                                                    |
| Advanced settings UI         | DONE        | Toggle, sliders, i18n                                                                            |

---

## 24b. Experience Changes — Discovery Flow Redesign

> **Date:** 2026-04-21
> **Driven by:** UX feedback items 1-4 + depth probing transparency requirements
> **Scope:** Changes to the discovery panel UI in State2Analysis — sample URL input, browser discovery inline, and new tree visualization

### Problems with Current Experience

| #   | Problem                                        | Observed Impact                                                                              |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| UX1 | Sample URL chips are plain text, not clickable | User can't verify truncated URLs are correct                                                 |
| UX2 | No mid-discovery intervention                  | User must stop everything or wait — can't adjust depth/scope while running                   |
| UX3 | Discovery runs from scratch every time         | 2-minute wait on every retry, even for same site+samples                                     |
| UX4 | Sample URL input is too small and unclear      | Users skip it or enter wrong URLs because they don't understand what it does                 |
| UX5 | Browser discovery is a black box               | User sees "229 links found" but can't tell what was discovered or guide what to explore next |
| UX6 | Progress shows counts but no structure         | "229 verified, 0 projected" means nothing — user needs to see the SHAPE of what was found    |
| UX7 | No way to explore selectively                  | If the user only wants one branch (e.g., All-In-Ones), they can't tell the system            |
| UX8 | Font sizes and information hierarchy unclear   | Important information (what sample URLs do, what the system is doing) not prominent enough   |

### Experience Redesign: Three Zones

The discovery panel is restructured into three zones that evolve as the pipeline progresses:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ZONE 1: Intent Input                                               │
│  (What does the user want to find?)                                 │
│                                                                     │
│  Always visible. Editable even during discovery.                    │
├─────────────────────────────────────────────────────────────────────┤
│  ZONE 2: Discovery Activity                                        │
│  (What is the system doing right now?)                              │
│                                                                     │
│  Shows current phase, live progress, intervention buttons.          │
├─────────────────────────────────────────────────────────────────────┤
│  ZONE 3: Discovery Tree                                             │
│  (What has been found? What can the user do about it?)              │
│                                                                     │
│  Interactive tree with expand/skip controls. Grows in real-time.    │
└─────────────────────────────────────────────────────────────────────┘
```

### Zone 1: Intent Input (Redesigned)

**Current problem**: Sample URL input is a small text field inside a collapsible section, with unclear copy. It's treated as an advanced feature but it's actually the most important input.

**New design**: Sample URL input becomes the PRIMARY element — large, prominent, with clear guidance.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                   │
│  🔍 Find specific content                                        │
│                                                                   │
│  Paste 1-3 example pages that represent the content you want.    │
│  We'll navigate the site to find all similar pages.              │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ https://epson.com/Support/Printers/All-In-Ones/ET-Seri↗ │ ✕  │
│  └──────────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Paste another example URL...                              │    │
│  └──────────────────────────────────────────────────────────┘    │
│  + Add another example                                           │
│                                                                   │
│  ⚙ Advanced settings ▾                                           │
│                                                                   │
│  ┌─────────────┐                                                  │
│  │ ▶ Discover   │                                                 │
│  └─────────────┘                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key changes:**

- **Heading is "Find specific content"** not "Discover more content" — action-oriented
- **Copy explains the WHY**: "We'll navigate the site to find all similar pages"
- **Input is full-width**, not squeezed into a card
- **Each URL is clickable** (external link icon `↗`) — opens in new tab for verification
- **Remove button** (✕) on each URL
- **"Add another example"** link, not hidden inside "+"
- **Font size hierarchy**: Heading 18px, description 14px, input 16px
- **Advanced settings collapsed by default** but visually present (not hidden)
- **During discovery**: inputs become **read-only chips with clickable URLs** but the zone stays visible. User can click "Edit" to modify samples (pauses discovery, asks for confirmation).

### Zone 2: Discovery Activity (Redesigned)

**Current problem**: BrowserDiscoveryInline shows expandable counts and link counts — opaque numbers that don't tell the user what's happening structurally. Progress is a mystery.

**New design**: Activity zone shows the CURRENT ACTION with context, not just counts.

```
DURING SEED SCAN:
┌─────────────────────────────────────────────────────────────────┐
│  🖥️ Scanning page navigation                                    │
│                                                                   │
│  Clicking expandable elements on epson.com/Support/Printers...  │
│  Found 45 links so far (3 new links/click)                      │
│  ████████████░░░░ Yield declining — will stop when unproductive │
│                                                                   │
│  [Stop scan & use results]                                        │
└─────────────────────────────────────────────────────────────────┘

DURING SAMPLE VISIT:
┌─────────────────────────────────────────────────────────────────┐
│  📍 Visiting your sample page                                    │
│  /Support/Printers/All-In-Ones/ET-Series/Epson-ET-2850/...     │
│                                                                   │
│  ✅ Page loaded — this is a product page (leaf)                  │
│  ✅ Breadcrumb found: Support > Printers > All-In-Ones >        │
│     ET-Series > ET-2850                                          │
│  → Next: climbing breadcrumb chain to find category pages        │
│                                                                   │
│  [Stop & use results]  [Run in background]                       │
└─────────────────────────────────────────────────────────────────┘

DURING BREADCRUMB CLIMB:
┌─────────────────────────────────────────────────────────────────┐
│  🧭 Exploring site hierarchy                    Page 3 of ~10   │
│                                                                   │
│  Visiting: All-In-Ones category hub                              │
│  /Support/Printers/All-In-Ones/sh/s1                             │
│                                                                   │
│  Found 8 sub-categories with links to series pages               │
│  Rate: 8 new links/page — productive, continuing...              │
│                                                                   │
│  [Stop & use results]  [Run in background]  [Add sample URL]    │
└─────────────────────────────────────────────────────────────────┘
```

**Key changes:**

- **Natural language status** instead of numeric counters — "Visiting your sample page" not "pagesVisited: 1"
- **Rate indicator** instead of progress bar — shows links-per-click or links-per-page rate
- **Yield indicator** — "declining" / "productive" / "exhausted" — explains WHY the system continues or stops
- **Next action preview** — tells user what will happen next
- **Three action buttons always visible**: Stop, Run in background, Add sample
- **Breadcrumb chain displayed when found** — user can see the navigation structure immediately

### Zone 3: Discovery Tree (NEW)

**Current state**: Does not exist. Results are shown as a summary line ("229 links, 0 projected").

**New design**: An interactive tree that grows in real-time as the system explores. Each node can be expanded/skipped by the user.

```
DURING/AFTER EXPLORATION:
┌─────────────────────────────────────────────────────────────────┐
│  📊 Discovery Tree                                               │
│                                                                   │
│  epson.com/Support/Printers                                      │
│  │                                                               │
│  ├── ✅ All-In-Ones (visited hub — 8 series found)              │
│  │   ├── ✅ ET-Series (visited — 15 models)                     │
│  │   ├── ○ WF-Series (projected — ~12 models)                   │
│  │   │   [Explore ▶]  [Skip ✕]                                  │
│  │   ├── ○ XP-Series (projected — ~8 models)                    │
│  │   │   [Explore ▶]  [Skip ✕]                                  │
│  │   └── ... 5 more series                                       │
│  │       [Explore all ▶▶]                                        │
│  │                                                               │
│  ├── ○ Inkjet (from breadcrumb — not yet explored)              │
│  │   [Explore ▶]  [Skip ✕]                                      │
│  ├── ○ Label Printers (from breadcrumb — not yet explored)      │
│  │   [Explore ▶]  [Skip ✕]                                      │
│  └── ... 5 more categories                                       │
│      [Explore all ▶▶]                                            │
│                                                                   │
│  ─────────────────────────────────────────────────────────       │
│  89 verified  │  ~340 projected  │  4 pages visited              │
│                                                                   │
│  [Use these results]  [Explore more...]                          │
└─────────────────────────────────────────────────────────────────┘
```

**Tree node states:**
| Icon | Meaning | Action |
|------|---------|--------|
| ✅ | Visited — links extracted, count shown | Expand to see child nodes |
| ○ | Discovered but not visited | [Explore] visits it, [Skip] ignores it |
| 🔄 | Currently being visited | Spinner, auto-expands when done |
| ⊘ | Skipped by user | Greyed out, can undo |
| ⚠️ | Visit failed (404, timeout) | Shows error, can retry |

**Node information per line:**

- Name (derived from URL segment, title-cased)
- Source: "visited hub", "projected", "from breadcrumb", "from seed page"
- Count: links/pages found, or projected count
- Confidence: verified count / projected count

**Interaction model:**

- Click node name → expand/collapse children
- [Explore ▶] → system visits this URL, extracts links, adds children to tree
- [Skip ✕] → node greyed out, excluded from results
- [Explore all ▶▶] → batch-visit all unvisited siblings at this level
- Tree updates in real-time via SSE as exploration progresses

**Footer actions:**

- **"Use these results"** → proceeds to section creation with current verified+projected URLs
- **"Explore more..."** → user picks which branches to visit next

### API Interception Display (Relocated)

Currently shown inside BrowserDiscoveryInline's done state. Move to the Discovery Tree as a separate collapsible section:

```
│  📡 API Endpoints Detected (5)                    [Collapse ▾]   │
│  ├── /rest/v1/delivery (2 calls)                                 │
│  ├── /api/v3/ip.json (2 calls)                                  │
│  ├── /unified/v1/master/getSubscriptions (1 call) [paginated]   │
│  └── ... 2 more                                                  │
```

### Mid-Discovery Intervention Model

**Current**: User can only "Stop & use results" — a binary all-or-nothing choice.

**New**: Layered intervention at multiple granularities:

| Intervention             | When Available                    | Effect                                                    |
| ------------------------ | --------------------------------- | --------------------------------------------------------- |
| **Stop & use results**   | Always during discovery           | Immediate stop, use everything found so far               |
| **Run in background**    | During any phase                  | Discovery continues, user can configure existing sections |
| **Add sample URL**       | During any phase                  | New sample queued, visited when current phase completes   |
| **Edit samples**         | During any phase (pauses)         | Discovery pauses, user edits, resumes with new samples    |
| **Explore branch**       | When tree has unexplored nodes    | Visits specific hub page, adds results to tree            |
| **Skip branch**          | When tree has unexplored nodes    | Excludes branch from results                              |
| **Explore all at level** | When multiple unexplored siblings | Batch visits all siblings at same depth                   |
| **Adjust depth**         | During breadcrumb climb           | Changes how deep to go (more/fewer levels)                |

### Discovery Result Caching

**Current**: Every discovery runs from scratch. No caching.

**New**: Two-level caching:

1. **Draft-level persistence**: When the user navigates away from State2 and comes back, the discovery tree and stats are restored from the draft. No re-running needed.
   - Extend `CrawlDraft` to persist: `discoveryTree`, `discoveryStats[]`, `sampleUrls`, `apiPatterns`, `pipelinePhase`

2. **Site-level cache** (backend): When the same (seed URL + sample URLs + depth config) is requested again within 24h, return cached results instantly.
   - Key: hash(seedUrl, sorted(sampleUrls), depthConfig)
   - Store: MongoDB or Redis with TTL
   - Response: `{ cached: true, result: ... }`
   - UI: "Using cached results from 3 hours ago. [Refresh]"

### Sample URL Chip Redesign

**Current**: Plain text chips, truncated, not clickable.

**New**:

```
┌──────────────────────────────────────────────────────────────┐
│ 🔗 /Support/Printers/All-In-Ones/ET-Series/Epson-ET-28...  ↗ │ ✕ │
└──────────────────────────────────────────────────────────────┘
```

- Full URL shown on hover (tooltip)
- `↗` icon = clickable, opens in new tab
- `✕` = remove (when editable)
- Truncation: show first 20 chars + last 15 chars of path
- During discovery: chips are read-only (no ✕) but still clickable (↗)

### Font Size & Information Hierarchy

| Element                               | Current            | New                                                                    |
| ------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| Section heading ("Find more content") | text-sm (14px)     | text-lg (18px), font-semibold                                          |
| Guidance copy                         | Missing or text-xs | text-sm (14px), text-muted-foreground                                  |
| URL input                             | text-sm (14px)     | text-base (16px), monospace                                            |
| URL chips                             | text-xs (12px)     | text-sm (14px), monospace                                              |
| Discovery status messages             | text-sm mixed      | text-base (16px) for current action, text-sm for details               |
| Tree node names                       | N/A                | text-sm (14px), font-medium                                            |
| Tree node counts                      | N/A                | text-xs (12px), text-muted-foreground                                  |
| Action buttons                        | text-sm            | text-sm, but with clear visual weight (filled primary for main action) |

### "Run in Background" Mode

When the user clicks "Run in background":

1. Discovery panel collapses to a slim banner at the top of State2:
   ```
   ┌──────────────────────────────────────────────────────────┐
   │  🔄 Discovery running in background...  89 links found   │
   │  [View details]  [Stop]                                   │
   └──────────────────────────────────────────────────────────┘
   ```
2. User can now browse sections, select/deselect, configure
3. Clicking "View details" re-expands the discovery panel
4. When discovery completes, banner updates:
   ```
   ┌──────────────────────────────────────────────────────────┐
   │  ✅ Discovery complete — 340 new pages found in 3 sections│
   │  [Review results]  [Auto-add to sections]                 │
   └──────────────────────────────────────────────────────────┘
   ```
5. New sections are staged (not auto-added) until user reviews

### Component Changes Summary

| Component                    | Change Type | Description                                                                                                          |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `State2Analysis.tsx`         | MODIFY      | Replace discovery actions zone with three-zone layout. Add background mode banner. Persist discovery state to draft. |
| `BrowserDiscoveryInline.tsx` | REWRITE     | Replace with `DiscoveryPanel.tsx` — three zones, tree visualization, intervention controls                           |
| `DiscoveryTree.tsx`          | NEW         | Interactive tree component with node states, expand/skip/explore actions, real-time updates via SSE                  |
| `BreadcrumbDisplay.tsx`      | NEW         | Shows extracted breadcrumb chain with clickable links                                                                |
| `DiscoveryActivity.tsx`      | NEW         | Current-action display with natural language status, rate indicators, yield estimation                               |
| `SampleUrlInput.tsx`         | NEW/EXTRACT | Prominent URL input with validation, clickable chips, add/remove, clear guidance copy                                |
| `types.ts`                   | MODIFY      | Add `DiscoveryTreeNode`, `BreadcrumbChain`, `DiscoveryPhaseDetail` types                                             |
| `crawl.ts` (API)             | MODIFY      | Add breadcrumb extraction events, tree-node events, cache-hit response type                                          |

### SSE Event Changes (Backend → Frontend)

New event types needed for the tree visualization:

| Event               | Data                                         | When                                       |
| ------------------- | -------------------------------------------- | ------------------------------------------ | -------------- | ------------------------------- |
| `breadcrumb-found`  | `{ chain: [{text, href, depth}] }`           | After visiting sample URL                  |
| `hub-discovered`    | `{ url, name, childCount, depth, source }`   | After visiting a hub page                  |
| `node-visiting`     | `{ url, depth }`                             | When starting to visit a new page          |
| `node-complete`     | `{ url, role, linksFound, childNodes[] }`    | After extracting links from a visited page |
| `node-failed`       | `{ url, error, retryable }`                  | When a page visit fails                    |
| `projection-update` | `{ totalVerified, totalProjected, byDepth }` | After projection recalculation             |
| `yield-update`      | `{ rate, trend: 'increasing'                 | 'stable'                                   | 'declining' }` | Periodically during exploration |

---

## 25. Future / Backlog Items (was §24)

### F-BACKLOG-1: Crawler MCP Server Orphan Process Leak

**Problem:** The `crawler-mcp-server` spawns `tsx watch` child processes via Cursor's MCP integration. When Cursor reconnects or restarts the MCP session, old child processes are not killed — they accumulate as orphans. Observed 10+ zombie `tsx watch` processes holding thousands of file descriptors, eventually causing `EMFILE: too many open files` errors that crash Studio's Next.js dev server.

**Impact:** Development environment degrades over time. Studio stops serving pages (404 on all routes) until orphan processes are manually killed.

**Root cause:** MCP server startup does not register `SIGTERM`/`SIGINT` handlers to clean up child processes. Cursor's MCP client does not reliably kill the full process tree on reconnect.

**Fix direction:**

- Add signal handlers in `crawler-mcp-server` entry point to kill child processes on exit
- Consider using a process group (`setsid`) so the entire tree can be killed with one signal
- Add a startup guard that detects and kills stale instances on the same port before starting

### F-BACKLOG-2: Projected URL Validation Before Crawl

**Problem:** Phase 5 projection generates two types of URLs: (1) within-hub links extracted from real `<a>` tags on visited hub pages — high confidence, (2) template-based URLs generated by slug substitution into patterns — speculative, may 404.

**Impact:** Template-generated URLs (Strategy 1) can pollute the crawl queue with non-existent pages, wasting crawl budget and inflating estimated coverage.

**Options (pick one):**

1. **Drop template-based projection entirely** — only project URLs actually seen in the DOM (Strategy 2). Safest, simplest. Gives up cross-hub extrapolation but zero false positives.
2. **HEAD-check validation** — fire `HEAD` requests at a sample of projected URLs before including them. If >50% fail, discard that projection batch.
3. **Deferred validation** — keep projected URLs but validate lazily during crawl. Mark as `projected` so crawler handles 404s gracefully with lower retry budget.

**Recommendation:** Option 1 (DOM-only) as default. Option 2 as opt-in for power users who want aggressive coverage estimates.

---

## 26. Gap Assessment (2026-04-21)

Comprehensive assessment of all crawling problems vs. what's built. Cross-referenced against
CRAWLER-FAILURE-MODES-AND-USER-CONTROL.md, CRAWLER-BACKEND-DESIGN-RECOMMENDATION.md, and
CRAWLER-IMPLEMENTATION-PLAN.md.

### SOLVED (9)

| #   | Problem                            | How It's Solved                                                  | Commit    |
| --- | ---------------------------------- | ---------------------------------------------------------------- | --------- |
| S1  | Sitemap discovery                  | sitemap.xml/robots.txt parsing → sections                        | existing  |
| S2  | HTTP recursive crawl               | `<a href>` link following with pattern scoring                   | existing  |
| S3  | Browser/Playwright discovery       | Navigation Explorer: clicks expandables, hidden links            | existing  |
| S4  | API interception                   | Playwright page.route() captures XHR/fetch patterns              | eaf8d8b5c |
| S5  | Fan-out (search deeper)            | `/discover/deepen` recursive deepening from warm + API URLs      | 0bcadc4d7 |
| S6  | Auto-escalation HTTP→Browser (TC1) | 0-match trigger + manual "Expecting more?" link                  | existing  |
| S7  | Pattern scoring                    | Hot/warm/cold URL classification, color badges                   | afa31e585 |
| S8  | Progressive retry                  | networkidle → domcontentloaded → commit with real timeout values | 34a2d5c13 |
| S9  | Discovery pipeline                 | Browser→HTTP chain, single "Start Discovery" button              | cce094dc0 |

### PARTIALLY SOLVED (6)

| #   | Problem                      | What Works                                                                                                           | What's Missing                                                                                                                     | Ref                                         |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P1  | Sample-guided crawl priority | Pattern matcher scores URLs 0-100                                                                                    | No priority queue in frontier — URLs crawled FIFO, not by score. High-score URLs should be crawled first                           | CRAWLER-BACKEND-DESIGN-RECOMMENDATION.md §4 |
| P2  | URL deduplication            | Basic URL normalization                                                                                              | Inconsistent trailing slash, query param ordering, fragment stripping. No cross-page content SimHash                               | B16 in IMPL-PLAN                            |
| P3  | Depth/breadth balance        | Breadcrumb-climb algorithm implemented, 5 extraction strategies, diminishing returns detection, hub yield projection | Tree viz not built (F34). Template-based projection needs validation (F-BACKLOG-2). Page classifier marks JS-heavy hubs as `leaf`. | §24 Depth Probing, F-BACKLOG-2              |
| P4  | Platform-aware extraction    | A2 PlatformDetector identifies Next.js/Mintlify/Docusaurus/Shopify                                                   | Extraction pipeline ignores platform identity — doesn't use framework-specific CSS selectors                                       | BACKEND-DESIGN §3, FAILURE-MODES §F         |
| P5  | Multi-format content         | Text extraction works                                                                                                | Tables, code blocks, images extracted as text blobs. No structured preservation                                                    | FAILURE-MODES §F                            |
| P6  | Draft persistence            | Crawl drafts save sections + config                                                                                  | No auto-save on config changes, 500 error on some saves, full discovery phase state not persisted                                  | F15                                         |

### NOT ADDRESSED (9)

| #   | Problem                       | Impact                                                                                                          | Design Doc Reference                         | Priority |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------- |
| N1  | Readability.js fallback       | CSS extraction fails → raw `innerText` → garbage content with nav/footer/framework artifacts                    | BACKEND-DESIGN §5 Layer 3, FAILURE-MODES §F  | **P0**   |
| N2  | A7 QualityGate wiring         | Quality measured by naive char-length (>2000="rich"), not actual boilerplate ratio/hidden content/content gates | BACKEND-DESIGN §2 row 6, FAILURE-MODES §E    | **P0**   |
| N3  | Quality-driven retry          | Pipeline accepts garbage extraction without retrying alternative strategies or escalating to LLM                | BACKEND-DESIGN §5, IMPL-PLAN Phase 2 (B1-B5) | **P0**   |
| N4  | Structured content extraction | Code blocks, FAQ accordions, tables, nested lists need special handling. Currently flattened to text            | FAILURE-MODES §F                             | P1       |
| N5  | Image/media extraction        | Alt text not extracted, no image-to-text for visual content, video descriptions dropped                         | Not in design docs — new finding             | P2       |
| N6  | PDF/document crawling         | Links to PDF/DOCX within site are discovered but content not extracted                                          | Not in design docs — new finding             | P2       |
| N7  | Scheduled re-crawl            | No change detection, no ETag/If-Modified-Since, every crawl is manual, no content hashing                       | IMPL-PLAN Phase 7, BACKEND-DESIGN §2 row 7   | P2       |
| N8  | UX unification                | Three fragmented flows: Analyse, Crawl, Bulk Import. No single entry point                                      | project_crawler_product_findings §UX         | P1       |
| N9  | Section management UI         | No manual include/exclude URLs, edit section names, merge/split sections                                        | F24-F26, W2-W3, W6                           | P1       |

### NOT ADDRESSED — Production Hardening (5)

| #   | Problem                                   | Impact                                                                      | Design Doc Reference                                       | Priority |
| --- | ----------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| H1  | BullMQ workers                            | All crawling in-process in Express. Can't scale, can't recover from crashes | IMPL-PLAN Phase 7, project_crawler_backlog §1              | P1       |
| H2  | Redis state                               | In-memory Map for crawl state. Lost on restart, can't scale horizontally    | project_crawler_backlog §2                                 | P1       |
| H3  | Auth on discover/browser endpoints        | Completely open — anyone can trigger crawls                                 | project_crawler_backlog §5, project_crawler_bugs §Security | **P0**   |
| H4  | Per-domain concurrency + robots.txt delay | No rate limiting, can hammer target sites. Could get IP-banned              | BACKEND-DESIGN §2 row 3, B15 in IMPL-PLAN                  | P1       |
| H5  | Per-tenant fair sharing                   | No max concurrent crawls per tenant                                         | Not in design docs — new finding                           | P1       |

### NOT ADDRESSED — Wireframe v5 Settings (6 of 9)

From CRAWLER-BACKEND-DESIGN-RECOMMENDATION.md §2:

| Setting           | Wireframe Control            | Backend Status                                            |
| ----------------- | ---------------------------- | --------------------------------------------------------- |
| Request speed     | Slider: Polite → Aggressive  | Partial — concurrency exists but no per-request delay     |
| AI model          | Dropdown: Model selection    | Not implemented                                           |
| AI budget         | Slider: 0–100 pages          | Not implemented — `maxLlmPages` in types but not enforced |
| Content cleanup   | Toggle: Keep/Clean           | Not implemented — ReadabilityService exists but not wired |
| Duplicate content | Toggle: Enable/Disable dedup | Not implemented — no content dedup                        |
| Cookie consent    | Toggle: Auto-dismiss/Manual  | Not implemented — no module exists                        |

### RISKS

| Level      | Risk                             | Detail                                                                                                                                    |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **HIGH**   | Extraction quality is P0 blocker | Users will see garbage content (nav, footer, RSC wire format) in search results if shipped without Readability fallback + quality gates   |
| **HIGH**   | No auth on crawler endpoints     | Anyone reaching the service can trigger crawls against any target (MCP server has execute_javascript RCE)                                 |
| **HIGH**   | In-memory state                  | All crawl progress lost on restart. Cannot scale horizontally.                                                                            |
| **MEDIUM** | No robots.txt delay              | Could get IP-banned from target sites in production                                                                                       |
| **MEDIUM** | No concurrency limits            | Could overwhelm target sites or own infrastructure                                                                                        |
| **MEDIUM** | Fan-out depth unbounded          | "Search deeper" can recurse indefinitely with no depth cap                                                                                |
| **MEDIUM** | Extraction cascade doesn't exist | 5-layer pipeline (JSON-LD → Platform → Readability → Semantic → Body) designed but none of the orchestration is built (BACKEND-DESIGN §5) |
| **LOW**    | Priority queue missing           | Crawls complete but may waste time on low-value pages before finding matches                                                              |
| **LOW**    | UX fragmentation                 | Three separate flows functional but confusing                                                                                             |

### Recommended Priority Order

1. **N1 + N2 + N3** (Extraction quality) — P0 blocker, without this search results are garbage
2. **H3** (Auth) — P0 security, must be done before any shared deployment
3. **N9 + F24-F26** (Section management) — Users can't manage 240 sections without tree grouping + editing
4. **C4** (Wire handleStartCrawl) — The actual crawl button doesn't work yet
5. **H1 + H2** (Workers + Redis) — Required for production deployment
6. **H4** (Rate limiting) — Required before crawling external sites at scale
7. **N4 + P4** (Structured + platform extraction) — Quality improvement
8. **N8** (UX unification) — Separate feature spec needed
