# Wave 1 — User Journey Specification

> **Scope**: Direct URLs mode + faster strategy selection (background clustering)
> **Date**: 2026-05-12
> **Status**: Draft — pending user approval before HLD

---

## Current State (before Wave 1)

### Crawl Setup Flow Today

```
State 1 (url-entry)
  │ User enters ONE site URL
  ▼
State 2 (analyzing)
  │ Profile runs → cluster → sample (sequential, blocking)
  │ User waits for ALL 3 steps before seeing anything useful
  │ Strategy cards shown AFTER analysis completes
  │
  │ [Crawl Full Sitemap]  [Guided Discovery]
  │
  ├── Sitemap: section checklist with toggles
  └── Discovery: sample URLs → BFS tree → treeToSections
  │
  ▼
State 3 (configure)
  │ Scope, rendering, depth, speed, compliance settings
  ▼
State 4 (crawling)
  │ Progress polling, section-level stats
  ▼
Done → View Results
```

### What's Missing

1. **No way to paste specific URLs** without going through discovery or sitemap
2. **User waits for full analysis** before seeing strategy options

---

## Wave 1 Changes

### Change 1: Faster Strategy Selection

**Before**: User waits for profile + clustering + sampling (~8-15s) before seeing strategy cards.

**After**: Profile completes (~2-3s) → strategy cards shown immediately. Clustering continues in background.

```
State 2 Timeline:
  0s ─── Profile starts ──────────────────────────────────
  2s ─── Profile done → SHOW 3 STRATEGY CARDS ─── user can pick now
  5s ─── Clustering done (background) ────────── sections ready if needed
  8s ─── Sampling done (background) ──────────── strategies ready
```

**Internal refactor**: `runAnalysis` splits into two phases:

```
Phase A (blocking — awaited):
  profileSite(url) → setProfile() → SHOW CARDS immediately

Phase B (fire-and-forget — non-awaited promise):
  clusterUrls(url) → setSections() → sitemap card updates with page count
  sampleGroups(groups) → setGroupStrategies() → per-section strategies ready

Error handling:
  Phase A error → error banner, [Retry], no cards shown
  Phase B error → sitemap card shows "Analysis failed" — Discovery/Direct URLs unaffected
```

### Change 2: Third Strategy Card — "Direct URLs"

New card alongside Sitemap and Discovery. Never auto-recommended.

### Change 3: Direct URLs Panel

Textarea for pasting URLs (max 2,000) → validates → straight to Configure (no sections).

### Deferred to Wave 2

- **G-4**: Wire "Add from Sitemap" button to tree header
- **G-8**: Sitemap preview dialog with real URL counts
- **G-9**: Unified exclusion patterns module
- **W-1**: Explore Branch post-completion toast (instead of 409)
- **CSV import**: Bulk URL import from file (removes 2,000 paste cap)
- **Direct URLs + Sitemap combo**: Combining strategies in a single crawl config

---

## User Journeys

### Journey 1: Direct URLs — Happy Path (Small List)

**Persona**: Content manager who knows exactly which 15 competitor pages to crawl.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 1    Enters "epson.com" in URL input
 2    Clicks "Go"                          Stepper appears: [Review] → Configure → Crawl
                                           Profile starts running
 3    Waits ~2-3s                          Profile completes:
                                           "epson.com · Sitemap found ·
                                            JS required · Browser rendering recommended"

                                           3 strategy cards appear:
                                           [📰 Crawl Full Sitemap]  [🧭 Guided Discovery]  [📋 Direct URLs]
                                           "Analyzing sitemap..."   "Steer the system"      "Paste specific URLs"

                                           Clustering continues in background

 3b   (after ~3-5s more)                   Clustering completes → card updates live:
                                           [📰 Crawl Full Sitemap]
                                           "4,200 pages in sitemap"
                                           ★ Recommended

 4    Clicks "Direct URLs" card            Card shows "Selected ✓"
                                           Direct URLs panel appears below cards:
                                           ┌──────────────────────────────────────────┐
                                           │  📋 Direct URLs                          │
                                           │                                          │
                                           │  Paste the URLs you want to crawl,       │
                                           │  one per line (max 2,000):               │
                                           │  ┌──────────────────────────────────────┐ │
                                           │  │ (placeholder text with example URLs) │ │
                                           │  │                                      │ │
                                           │  │                                      │ │
                                           │  └──────────────────────────────────────┘ │
                                           │                                          │
                                           │  [Configure Crawl →] (disabled)          │
                                           └──────────────────────────────────────────┘

 5    Pastes 15 URLs from clipboard        Real-time validation appears below textarea:
                                           "✓ 15 valid URLs from epson.com"

                                           [Configure Crawl (15 pages) →] (enabled)

 6    Clicks "Configure Crawl (15 pages)"  → State 3 (Configure)

                                           Summary sidebar:
                                           Pages: 15
                                           Sections: 1
                                           Est. time: < 1 min
                                           Rendering: Browser (from profile recommendation)

 7    Reviews settings, clicks             → State 4 (Crawling)
      "Start Crawl"                        Progress bars, section stats

 8    Crawl completes                      → Done
                                           "View Results" button
```

**What the system does internally at Step 6:**

- Creates one `CrawlSection`: `{ sectionId: 'sec-direct-{ts}', pattern: '/*', name: 'Direct URLs', pageCount: 15, pages: [...], source: 'direct', included: true, strategy: profile.jsRequired ? 'browser' : 'http' }`
- Calls `onSectionsChange([section])` → CrawlFlowV5 saves to draft
- Calls `persistSectionUrls(draftId, [section])` → writes full URL list to bucket
- Calls `onContinue()` → transitions to State 3

---

### Journey 2: Direct URLs — At the Cap (2,000 URLs)

**Persona**: SEO analyst who exported 2,500 URLs from Screaming Frog.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 1-3  Same as Journey 1                    Profile + cards shown

 4    Clicks "Direct URLs"                 Panel appears

 5    Pastes 2,500 URLs                    System keeps first 2,000, auto-drops rest:
                                           "✓ 1,952 valid · ↔ 45 duplicates removed · ⚠ 3 invalid
                                            ⚠ 500 URLs dropped — max 2,000 per paste.
                                            Use CSV import for larger lists (coming soon)."

                                           Textarea shows 2,000 URLs (truncated)

                                           [Configure Crawl (1,952 pages) →]

 6    Clicks "Configure Crawl"             → State 3 (Configure)

                                           Summary shows:
                                           Pages: 1,952
                                           Sections: 1
                                           Est. time: 8-15 min
                                           Rendering: Browser

 7    Adjusts: scope → "Limited (1,000)"   Summary updates:
                                           Pages: 1,000 (of 1,952)

 8    Clicks "Start Crawl"                 → State 4 (Crawling)
```

**Decision**: Hard cap at 2,000 URLs in the textarea. Paste beyond 2,000 auto-drops remaining with a clear message. CSV import for larger lists is deferred.

---

### Journey 3: Direct URLs — Validation Errors

**Persona**: User pastes from a spreadsheet that has formatting issues.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 5    Pastes mixed content:                Validation:
      https://epson.com/page1              "✓ 13 valid · ⚠ 3 invalid · ↔ 2 duplicates removed"
      https://epson.com/page2
      https://support.epson.com/faq        [▼ Show 3 invalid URLs]
       (subdomain — accepted ✓)
      not-a-url                            Expanded:
      https://epson.com/page2  (dupe)      • "not-a-url" — not a valid URL
      ftp://epson.com/page3                • "ftp://epson.com/page3" — only HTTP/HTTPS supported
      epson.com/page4  (no protocol)       • "https://canon.com/page" — must be from epson.com
      https://canon.com/page  (wrong
       domain)                             Auto-fixed:
      https://epson.com/page5              • "epson.com/page4" → "https://epson.com/page4" ✓
      ...
                                           [Configure Crawl (13 pages) →] (enabled — proceeds with valid URLs)
```

**Decisions captured:**

- Invalid URLs are skipped, not blocking
- Bare domains auto-fixed with `https://` prefix
- Cross-domain URLs rejected with clear reason
- Duplicates auto-removed with count shown
- User can proceed with valid URLs only

**URL normalization before dedup:**

1. Lowercase scheme and hostname (`HTTPS://EPSON.COM/Page` → `https://epson.com/Page`)
2. Remove trailing slash (`/page/` → `/page`)
3. Keep query params — different params = different content (`?tab=specs` ≠ `?tab=faq`)
4. Sort query params for consistency (`?b=2&a=1` → `?a=1&b=2`)
5. Keep fragments (`#section`) — do NOT strip. SPA hash routing uses fragments for real pages (`/#/products` ≠ `/#/about`). User explicitly chose these URLs; stripping could silently drop real content.
6. Preserve path case — paths are case-sensitive per RFC 3986

**Domain enforcement:**

- Match on **root domain** (strip `www.` prefix, compare base domain)
- Subdomains accepted: `support.epson.com`, `docs.epson.com` → accepted when parent is `epson.com`
- Different root domains rejected: `canon.com` → rejected when parent is `epson.com`
- Reason: sites commonly span subdomains (support, docs, shop) — blocking them would frustrate users

---

### Journey 4: Direct URLs — Empty/Zero Valid URLs

**Persona**: User clicks Direct URLs but hasn't pasted anything yet.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 4    Clicks "Direct URLs"                 Panel with empty textarea:

                                           Placeholder text in textarea:
                                           "https://epson.com/page1
                                            https://epson.com/page2
                                            https://epson.com/page3"

                                           Helper text below:
                                           "Paste one URL per line. Max 2,000 URLs.
                                            All URLs must be from epson.com."

                                           [Configure Crawl →] (disabled — grayed out)

 5    Pastes only invalid URLs             "⚠ 0 valid URLs · 3 invalid"
                                           [Configure Crawl →] (still disabled)

 6    Fixes URLs                           "✓ 3 valid URLs from epson.com"
                                           [Configure Crawl (3 pages) →] (enabled)
```

---

### Journey 5: Direct URLs — No-Sitemap Site

**Persona**: User wants to crawl a small site that has no sitemap.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 1    Enters "myblog.dev" in URL input
 2    Clicks "Go"                          Profile starts
 3    Waits ~2-3s                          Profile completes:
                                           "myblog.dev · No sitemap ·
                                            Static site · HTTP rendering recommended"

                                           3 strategy cards appear:
                                           [📰 Crawl Full Sitemap]  [🧭 Guided Discovery]  [📋 Direct URLs]
                                            (disabled)               ★ Recommended           "Paste specific URLs"
                                            "No sitemap available"

                                           No clustering runs (nothing to cluster)

 4    Clicks "Direct URLs"                 Panel appears
 5    Pastes 10 URLs                       "✓ 10 valid URLs from myblog.dev"
 6    Clicks "Configure Crawl (10 pages)"  → State 3

                                           Rendering pre-selected: "HTTP" (static site)
```

**Decision**: No-sitemap sites skip clustering entirely. Sitemap card is visible but disabled with "No sitemap available". Only Discovery and Direct URLs are selectable. Discovery is recommended by default.

---

### Journey 6: Direct URLs — Strategy Switching

**Persona**: User tries Direct URLs, then changes mind.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 4    Clicks "Direct URLs"                 Panel shown
 5    Pastes 20 URLs                       "✓ 20 valid"
 6    Clicks "Guided Discovery" card       Strategy switches:
                                           Direct URLs panel hides
                                           Sample URL input appears
                                           Pasted URLs preserved in internal state

 7    Discovery completes, not satisfied
 8    Clicks "Direct URLs" card            Panel re-appears with 20 URLs still there
                                           "✓ 20 valid URLs from epson.com"
                                           User can continue from where they left off
```

**Decision**: Pasted URLs survive strategy switches. Stored in a `directUrls` state variable. Switching away hides the panel; switching back restores it. User clicks another card to switch — no separate "Change" button.

**Note on stale state**: When switching strategies, each strategy's state is preserved independently. Sitemap section buckets from clustering remain in the draft but are ignored — `handleStartCrawl` only reads from the _current_ strategy's `includedSections`. No cleanup needed.

---

### Journey 7: Direct URLs — Back Navigation

**Persona**: User wants to change the site URL after pasting Direct URLs.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 6    Has pasted 20 URLs, ready to proceed
 7    Clicks "URL Entry" step in stepper   → State 1
                                           URL input shows "epson.com"

 8a   Changes URL to "canon.com",          → State 2 re-runs analysis for canon.com
      clicks "Go"                          ALL previous state cleared (sections, profile,
                                           pasted URLs, discovery state)
                                           Fresh start with new domain

 8b   Keeps same URL "epson.com",          → State 2 instant restore
      clicks "Go"                          Profile and sections restored from previous state
                                           Strategy cards shown immediately
                                           If Direct URLs was selected, panel + URLs restored
```

**Decision**: Same URL = instant restore (existing `proceedWithUrl` behavior). Different URL = full reset (existing behavior). Pasted URLs are part of the state that gets cleared on URL change.

---

### Journey 8: Direct URLs → State 3 Configure → Back

**Persona**: User proceeds to Configure, then wants to add more URLs.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 6    Clicks "Configure Crawl (20 pages)"  → State 3
 7    Reviews settings
 8    Realizes they forgot 5 URLs
 9    Clicks "Review" step in stepper      → State 2
      (or clicks "Back" button)
                                           Strategy cards shown with "Direct URLs" selected
                                           Paste panel shows existing 20 URLs

10    Adds 5 more URLs to textarea         "✓ 25 valid URLs"
                                           [Configure Crawl (25 pages) →]

11    Clicks "Configure Crawl"             → State 3 (updated: 25 pages)
```

**Decision**: Back navigation to State 2 restores full state including pasted URLs. User can edit and re-proceed. Section + bucket are re-created on the next "Configure Crawl" click.

---

### Journey 9: Sitemap Strategy — With Background Clustering

**Persona**: User wants to crawl the full sitemap.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 1    Enters "epson.com", clicks "Go"      Profile starts
 2    Waits ~2-3s                          Profile completes → 3 strategy cards appear
                                           Clustering continues in background

 3    Clicks "Crawl Full Sitemap"
      immediately (< 3s after cards)
                                           Clustering NOT done yet:
                                           ┌──────────────────────────────────────┐
                                           │  Analyzing sitemap...                │
                                           │  [████████░░░░░░░░]                  │
                                           │  Finding URL patterns and sections   │
                                           └──────────────────────────────────────┘

 4    Waits ~3-5s more                     Clustering completes:
                                           Section checklist appears with 12 sections
                                           Toggle include/exclude, rename, search

 5    Toggles sections                     Stats update in real-time
 6    Clicks "Configure Crawl"             → State 3
```

```
ALTERNATE (user takes time deciding):

 3    Reads profile, thinks for 10s        Clustering finishes in background
 4    Clicks "Crawl Full Sitemap"          Sections appear INSTANTLY — no wait
```

**Decision**: If clustering is done before user picks Sitemap → instant sections. If not done → brief loading spinner. User never waits for clustering when picking Discovery or Direct URLs.

---

### Journey 10: Switching Between All Three Strategies

**Persona**: User explores all options before committing.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 3    Cards shown, picks "Crawl Sitemap"   Sections appear (12 sections, 4,200 pages)
 4    Reviews, not satisfied
 5    Clicks "Guided Discovery" card       Switches strategy:
                                           Sections hide, sample URL input appears
                                           Sitemap sections preserved in state

 6    Enters samples, runs discovery       BFS tree grows to 200 nodes
 7    Not satisfied with coverage
 8    Clicks "Direct URLs" card            Switches strategy:
                                           Discovery tree hides (state preserved)
                                           Paste panel appears (empty — first time)

 9    Pastes 50 URLs                       "✓ 50 valid"
10    Not satisfied
11    Clicks "Crawl Full Sitemap" card     Switches strategy:
                                           Direct URLs hides (50 URLs preserved)
                                           Sections re-appear instantly (from step 3)
                                           All 12 sections still there

12    Clicks "Configure Crawl"             → State 3 with sitemap sections
```

**Key principle**: Each strategy's state is preserved independently. Switching between strategies is non-destructive — user clicks any other card to switch. Only changing the site URL in State 1 clears everything.

**State preservation per strategy:**

- Sitemap: `sections[]` array (with `source: 'sitemap'`)
- Discovery: `tree[]` + `discoveryState` (phase, completeness)
- Direct URLs: `directUrls` string (textarea content) + `directUrlSections[]`

---

### Journey 11: Direct URLs — Rendering Strategy

**Persona**: User pastes URLs for a JavaScript-heavy SPA.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 2    Profile completes                    "epson.com · JS required · Browser recommended"
 4    Picks "Direct URLs"
 5    Pastes 30 URLs                       "✓ 30 valid"
 6    Clicks "Configure Crawl"             → State 3

                                           Rendering pre-selected: "Browser"
                                           (inherited from profile recommendation)

                                           User can override to "HTTP" or "Hybrid"
```

**Decision**: Direct URLs section inherits rendering strategy from profile recommendation (`jsRequired → 'browser'`, otherwise `'http'`). User can override in State 3 Configure.

---

### Journey 12: Direct URLs — Draft Resume

**Persona**: User started a Direct URLs crawl setup yesterday, returns today.

```
STEP  USER ACTION                          SYSTEM RESPONSE
────  ───────────────────────────────────  ──────────────────────────────────────
 1    Opens crawl setup page               State 1 shows:
                                           Saved Drafts:
                                           • epson.com · Direct URLs · 50 pages · 1 day ago
                                             [Resume] [Delete]

 2    Clicks "Resume"                      → State 2 restored:
                                           Profile loaded from draft (cached — no re-profile)
                                           Strategy "Direct URLs" pre-selected
                                           Paste panel shows 50 URLs from draft bucket

                                           "✓ 50 valid URLs from epson.com"
                                           [Configure Crawl (50 pages) →]
```

**What the system does internally:**

- Loads `profile` from `CrawlDraft.profile` (domain, siteType, hasSitemap, jsRequired)
- Loads `strategy` from `CrawlDraft.strategy` → selects "Direct URLs" card
- Loads section URLs from `CrawlDraftUrlBucket` for the direct-urls section
- Populates textarea from bucket URLs, runs validation
- No re-profile needed — uses cached profile from draft (matches existing `proceedWithUrl` behavior)

**Decision**: Direct URLs state is persisted to `CrawlDraft` like other strategies. Draft stores the strategy type and the section with all URLs (in URL buckets). Resume restores the full state without re-profiling.

---

## Edge Cases & Error States

### E-1: Network Error During Profile

```
Profile fails → Error banner:
"Could not analyze epson.com. Check the URL and try again."
[Retry]

Strategy cards NOT shown — profile is required for rendering recommendation.
Direct URLs requires profile to determine browser vs HTTP rendering.
```

### E-2: Paste Exceeds 2,000 URL Cap

```
User pastes 3,500 URLs:
→ System keeps first 2,000 lines, drops rest
→ Validation runs on kept URLs
→ "✓ 1,890 valid · ↔ 87 duplicates removed · ⚠ 23 invalid
   ⚠ 1,500 URLs dropped — max 2,000 per paste.
   Use CSV import for larger lists (coming soon)."

Textarea shows the kept 2,000 lines only.
User can manually edit to swap in different URLs.
```

### E-3: User Pastes Non-URL Content

```
User pastes paragraph of text, CSV data, HTML, etc.
→ "⚠ 0 valid URLs found. Paste one URL per line."
   [Configure Crawl →] (disabled)
```

### E-4: All Pasted URLs Are Duplicates

```
User pastes 10 URLs, all duplicates of each other.
→ "✓ 1 valid · ↔ 9 duplicates removed"
   [Configure Crawl (1 page) →] (enabled)
```

### E-5: Draft Save Fails

```
Draft persistence is best-effort (existing behavior).
If save fails: crawl setup continues, but draft won't appear in "Saved Drafts" on return.
No user-facing error — matches current behavior.

URL persistence timing: URLs are saved to draft bucket on "Configure Crawl" click,
not on every keystroke. If user closes browser before clicking Configure, URLs are
lost — acceptable because pasting is fast and user can re-paste from clipboard.
Draft metadata (strategy: 'direct-urls') saves on card selection.
```

### E-6: Clustering Takes Too Long (Sitemap Strategy)

```
User picks Sitemap, clustering still running after 10s:
→ Show spinner with "Analyzing sitemap..." message
   Cancel link: "Switch to Direct URLs instead?"

Clustering timeout (30s):
→ "Sitemap analysis timed out. Try Guided Discovery or Direct URLs."
```

### E-7: Browser Closed Mid-Paste

```
User pastes URLs, closes browser, returns.
→ If draft was saved (user clicked Configure before closing): resume from saved state
→ If no draft URLs yet (closed before Configure): draft exists with strategy but no URLs
   Panel shows empty textarea — user re-pastes
```

### E-8: User Pastes URLs That Return 404/500

```
Validation only checks URL format and domain, NOT reachability.
Dead URLs will fail during crawl (State 4) — shown as failed pages.
No pre-crawl reachability check (too slow for large lists).
```

---

## UX Specifications

### Strategy Card Layout (3 cards)

```
INITIAL (clustering in progress, site HAS sitemap):

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  📰              │  │  🧭              │  │  📋              │
│  Crawl Full     │  │  Guided         │  │  Direct         │
│  Sitemap        │  │  Discovery      │  │  URLs           │
│                 │  │                 │  │                 │
│  Analyzing      │  │  Steer the      │  │  Paste specific │
│  sitemap...     │  │  system to find │  │  URLs you want  │
│                 │  │  what you need  │  │  to crawl       │
│                 │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘

AFTER CLUSTERING COMPLETES (card updates live):

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  📰              │  │  🧭              │  │  📋              │
│  Crawl Full     │  │  Guided         │  │  Direct         │
│  Sitemap        │  │  Discovery      │  │  URLs           │
│                 │  │                 │  │                 │
│  4,200 pages    │  │  Steer the      │  │  Paste specific │
│  in sitemap     │  │  system to find │  │  URLs you want  │
│                 │  │  what you need  │  │  to crawl       │
│  ★ Recommended  │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘

NO SITEMAP:

┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  📰              │  │  🧭              │  │  📋              │
│  Crawl Full     │  │  Guided         │  │  Direct         │
│  Sitemap        │  │  Discovery      │  │  URLs           │
│  (disabled)     │  │                 │  │                 │
│  No sitemap     │  │  Steer the      │  │  Paste specific │
│  available      │  │  system to find │  │  URLs you want  │
│                 │  │  what you need  │  │  to crawl       │
│                 │  │  ★ Recommended  │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘

Grid: responsive — 3 cols on desktop, stack on mobile
Recommendation: only Sitemap or Discovery. Never Direct URLs.
  Appears only after clustering completes (needs page count for logic).
  No sitemap → Discovery always recommended.
No sitemap: Sitemap card visible but disabled with "No sitemap available"
Sitemap card is selectable even while "Analyzing..." — user sees spinner after selecting.
Switching: user clicks another card to switch. No separate "Change" button.
```

### Direct URLs Panel

```
┌──────────────────────────────────────────────────────────────┐
│  📋 Direct URLs                                    [Clear ✕] │
│                                                              │
│  Paste the URLs you want to crawl, one per line:            │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ https://epson.com/Support/Printers/All-In-Ones/ET-Se... ││
│  │ https://epson.com/Support/Printers/All-In-Ones/Work... ││
│  │ https://epson.com/faq/et-2400                           ││
│  │                                                          ││
│  │                                                          ││
│  │                                                          ││
│  └──────────────────────────────────────────────────────────┘│
│  Max 2,000 URLs · All URLs must be from epson.com           │
│                                                              │
│  ┌─ Validation ────────────────────────────────────────────┐ │
│  │ ✓ 15 valid URLs from epson.com                          │ │
│  │ ↔ 2 duplicates removed                                  │ │
│  │ ⚠ 1 invalid  [▼ Show details]                           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│                              [Configure Crawl (15 pages) →]  │
└──────────────────────────────────────────────────────────────┘

States:
- Empty: placeholder text, helper text, button disabled
- Has URLs: validation shown, button shows count
- All invalid: button disabled, validation shows errors
- Over cap: first 2,000 kept, drop message shown
```

---

## Data Flow Summary

### Direct URLs — Internal Pipeline

```
User pastes URLs in textarea
  │
  ▼
Frontend validates (immediate, in-browser):
  - Truncate to first 2,000 lines (auto-drop rest with message)
  - URL format check (new URL() parse)
  - Auto-fix bare domains (add https://)
  - Domain match: root domain of pasted URL must match State 1 URL
    (subdomains accepted: support.epson.com ✓ when parent is epson.com)
  - Normalize: lowercase scheme+host, remove trailing slash, sort query params
  - Dedup on normalized full URL (including query params and fragments)
  - Fragments kept — not stripped (SPA hash routing = real pages)
  │
  ▼
User clicks "Configure Crawl"
  │
  ▼
Frontend creates CrawlSection:
  {
    sectionId: 'sec-direct-{timestamp}',
    pattern: '/*',
    name: 'Direct URLs',
    pageCount: validUrls.length,
    examples: validUrls.slice(0, 5),
    pages: validUrls.map(url => ({ url, title: '' })),
    included: true,
    source: 'direct',
    strategy: profile.jsRequired ? 'browser' : 'http',
    estimatedTime: estimateTime(validUrls.length),
    warnings: [],
    depth: 0
  }
  │
  ├── onSectionsChange([section]) → saves to draft
  ├── persistSectionUrls(draftId, [section]) → saves URLs to bucket
  └── onContinue() → transitions to State 3
  │
  ▼
State 3 Configure (unchanged)
  │ Shows 1 section: "Direct URLs — N pages"
  │ with extraction preview button (existing behavior)
  ▼
handleStartCrawl (unchanged)
  │ Reads URLs from bucket → dedup → addSource → submitBatchCrawl
  ▼
POST /api/search-ai/crawl/batch (unchanged)
  │ Backend validates: max 50,000 URLs per batch (MAX_BATCH_URLS)
  ▼
bulk-crawl queue → worker → HTTP/Browser fetch → ingest → done
```

### Background Clustering — Internal Pipeline

```
runAnalysis(siteUrl) refactored into:

  PHASE A — blocking (user waits for this):
    profileSite(siteUrl)
      → setProfile(result)
      → setCrawlConfig({ rendering: ... })
      → SHOW 3 STRATEGY CARDS
      → Save profile to draft

  PHASE B — fire-and-forget (non-awaited promise):
    clusterUrls(siteUrl, { platform, apiEndpoints, draftId })
      → setSections(mappedSections)       // sitemap card count updates live
      → sitemapPageCount reactive update  // recommendation badge appears
    sampleGroups(groups)
      → setGroupStrategies(strategies)    // per-section strategy available

  Error paths:
    Phase A fails → error banner, [Retry], no cards
    Phase B fails → sitemap card shows "Analysis failed"
                    Discovery and Direct URLs fully functional
                    User can retry by clicking Sitemap card
    No sitemap (hasSitemap: false) → Phase B skipped entirely
```

---

## Type Changes Required

```typescript
// types.ts — add 'direct-urls' to strategy union
export type DiscoveryStrategy = 'crawl-sitemap' | 'guided-discovery' | 'direct-urls';

// types.ts — add 'direct' to section source union
export interface CrawlSection {
  // ...existing fields...
  source?: 'sitemap' | 'explored' | 'auto' | 'direct'; // ← add 'direct'
}

// api/crawl.ts — same change in CrawlDraftSection
export interface CrawlDraftSection {
  // ...existing fields...
  source: 'sitemap' | 'explored' | 'auto' | 'direct'; // ← add 'direct'
}

// Backend: CrawlDraft strategy validation must accept 'direct-urls'

// Frontend constant
export const DIRECT_URLS_MAX = 2_000;
```

---

## Acceptance Criteria

### AC-1: Direct URLs Happy Path

**Given** user has entered a site URL and profile is complete
**When** user selects "Direct URLs", pastes 15 valid URLs, clicks "Configure Crawl"
**Then** State 3 shows with 15 pages, correct rendering from profile, and crawl can start

### AC-2: Direct URLs Validation

**Given** user has selected "Direct URLs"
**When** user pastes mix of valid, invalid, duplicate, and cross-domain URLs
**Then** validation summary shows correct counts, invalid URLs listed, only valid URLs proceed

### AC-3: Direct URLs 2,000 Cap

**Given** user has selected "Direct URLs"
**When** user pastes 3,000 URLs
**Then** first 2,000 lines are kept, rest auto-dropped, message shows how many were dropped

### AC-4: Strategy Switching Preserves State

**Given** user has pasted 20 URLs in Direct URLs mode
**When** user clicks another strategy card and then clicks "Direct URLs" card again
**Then** the 20 URLs are still in the textarea

### AC-5: Faster Strategy Selection

**Given** user enters a URL and analysis starts
**When** profile completes (before clustering finishes)
**Then** 3 strategy cards are shown immediately, clustering continues in background

### AC-6: Sitemap Card Updates Live

**Given** strategy cards are showing with "Analyzing sitemap..."
**When** background clustering completes
**Then** sitemap card updates to show page count and recommendation badge

### AC-7: No-Sitemap Site

**Given** user enters a URL for a site with no sitemap
**When** profile completes
**Then** sitemap card is disabled ("No sitemap available"), Discovery is recommended, Direct URLs is enabled

### AC-8: Direct URLs Draft Resume

**Given** user created a Direct URLs setup with 50 URLs and closed the browser
**When** user returns and clicks "Resume" on the saved draft
**Then** Direct URLs panel shows with all 50 URLs restored from draft (no re-profile)
