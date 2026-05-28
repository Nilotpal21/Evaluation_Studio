# Sitemap Intelligence — User Journeys

## Overview

Enhance sitemap handling with transparency, multi-source discovery, and user override.
Core design principle: **sections remain the primary unit of selection**; sitemap grouping reuses the existing grouped tree view infrastructure.

## Design Decisions

### D-1: Profiling Discovery Trail — Animated Reveal (Must-Have)

**Decision:** After the profile API responds (single request, single response), reveal the discovery steps sequentially with 150-200ms delays. Not fake progress — the system DID check these things; we present them for readability.

**Why must-have:** This is the standout moment. Every other crawl tool shows a generic spinner. We show the system thinking out loud. It builds trust, educates users about their own site, and explains why the sitemap card is enabled/disabled. Without it, sitemap meta rows on sections appear without narrative context.

**The flow:**

```
[Phase 1: User clicks Go — real spinner, 2-5s]
┌──────────────────────────────────────────────────┐
│ ◌ Profiling www.epson.com...                     │
└──────────────────────────────────────────────────┘

[Phase 2: Response arrives — animated reveal, ~1s total]
┌──────────────────────────────────────────────────┐
│ ✓ Site reachable                        (fade in)│
│ ✓ Technology: Custom                    (fade in)│
│ ✗ /sitemap.xml — not found              (fade in)│
│ ✓ robots.txt → 2 sitemaps found         (fade in)│
└──────────────────────────────────────────────────┘

[Phase 3: Strategy cards appear — trail compacts]
┌──────────────────────────────────────────────────┐
│ ▸ ✓ 2 sitemaps found via robots.txt   [compact] │
├──────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────────┐ ┌────────────┐   │
│ │ 📰 Crawl │ │ 🧭 Discovery │ │ 📋 Direct  │   │
│ │ Sitemap  │ │              │ │    URLs    │   │
│ └──────────┘ └──────────────┘ └────────────┘   │
└──────────────────────────────────────────────────┘
```

**Compact trail** stays above strategy cards. User can expand anytime to review what was found. It's the system's "here's what I know about your site" summary.

**Backend change:** Profile response returns new optional `sitemapDiscovery` field. Zero change to existing fields.

**Frontend change:** Net-new component (no existing step UI to modify — the old `analysisSteps` rendering was removed). Renders after profile response using data from the response.

### D-2: Section Grouping — Adaptive, Reuse Existing Group UI

**Decision:** Reuse the existing `SectionChecklist` grouped tree view (collapsible headers, group-level checkboxes, section count badges). Change the grouping key adaptively:

- **Multiple sitemaps** → group by `sitemapFile`. Each sitemap becomes a group header with checkbox, collapse, page count. Origin badge (`via robots.txt`, `manually added`) on the group header.
- **Single sitemap** → group by first path segment (today's behavior unchanged).

**Why:** The existing grouped tree is already polished — collapsible, interactive, with badges. Building a passive thin separator alongside it would be a step backward. The user can't act on a label. They can act on a group.

**Why adaptive:** Single-sitemap sites (most common) have no meaningful sitemap-level grouping — path segments serve the user better. Multi-sitemap sites already have the site owner's content organization — respecting it is smarter than re-inventing with path heuristics.

**What the user gains:**

- Exclude an entire sitemap's content with one checkbox ("I don't need the blog")
- Collapse sitemaps they're not interested in
- Search matches sitemap file names in addition to section patterns
- Group headers show provenance naturally

**What stays the same:**

- Section search (already exists — extend to match `sitemapFile`)
- Expand/collapse all toggle (already exists)
- Section-level checkboxes (primary unit of selection)

### D-3: "Provide URL" — Progressive Disclosure on Card

**Decision:** The disabled sitemap card transforms through three states. Not a dialog (context switch). Not below the cards (disconnected). The card itself evolves.

**Why:** The card tells a story — "we checked, didn't find one, but you can help, and it worked." The user never leaves the strategy selection context.

**Implementation note:** Today the card is a `<button disabled>`. Must restructure to a `<div>` with clickable regions — the "I have a sitemap" link is interactive even when the strategy isn't selected. The card is not truly disabled, it's in a "needs help" state.

**State 1 — No sitemap found:**

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ No sitemap found     │
│ Checked /sitemap.xml │
│ and robots.txt       │
│                      │
│ 🔗 I have a sitemap  │
└──────────────────────┘
```

Card is visually muted. "I have a sitemap" is clickable.

**State 2 — Input revealed:**

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ Sitemap URL:         │
│ ┌──────────────────┐ │
│ │ https://...      │ │
│ └──────────────────┘ │
│         [Check →]    │
│                      │
│ ← Back               │
└──────────────────────┘
```

Other two cards stay visible and selectable.

**State 3 — Valid sitemap found:**

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ ✓ 340 pages found    │
│ /content/sitemap.xml │
│                      │
│    [Select →]        │
└──────────────────────┘
```

Card transitions to enabled. User selects it. Seamless.

### D-4: Gzip Support — Deferred

Not in scope for this feature. Can be added later to the profiler's fetch pipeline independently.

---

## Data Model Changes

### CrawlSection — Provenance Metadata

```typescript
interface CrawlSection {
  // ... existing fields
  pattern: string;
  pages: string[];
  count: number;
  source: 'sitemap' | 'discovery' | 'direct';

  // NEW — sitemap provenance metadata
  sitemapFile?: string; // "/products-sitemap.xml"
  sitemapOrigin?: 'standard' | 'index-child' | 'robots-txt' | 'user-provided';
}
```

### ProfileResponse — Discovery Trail

```typescript
interface ProfileResponse {
  // ... existing fields

  // NEW — sitemap discovery trail
  sitemapDiscovery?: {
    steps: {
      check: string; // what was checked: "/sitemap.xml", "robots.txt Sitemap: directives"
      found: boolean;
      detail?: string; // "index → 5 child sitemaps", "3 declarations found"
    }[];
    sitemapFiles?: {
      url: string; // "/products-sitemap.xml"
      origin: 'standard' | 'index-child' | 'robots-txt';
      urlCount: number;
      type: 'urlset' | 'index';
    }[];
    totalUrls: number;
    duplicatesRemoved: number;
  };
}
```

---

## Journey 1: Single Sitemap at Standard Path

**User:** Enters `https://docs.stripe.com` → Go

**Phase 1 — Profiling (real spinner, 2-5s):**

```
┌──────────────────────────────────────────────────┐
│ ◌ Profiling docs.stripe.com...                   │
└──────────────────────────────────────────────────┘
```

**Phase 2 — Response arrives, animated reveal (~1s):**

```
┌──────────────────────────────────────────────────┐
│ ✓ Site reachable                                 │
│ ✓ Technology: Next.js                            │
│ ✓ Sitemap found: /sitemap.xml                    │
└──────────────────────────────────────────────────┘
```

**Phase 3 — Trail compacts, strategy cards appear:**

```
┌──────────────────────────────────────────────────┐
│ ▸ ✓ Sitemap found: /sitemap.xml                  │
├──────────────────────────────────────────────────┤
│ ┌─────────────────┐ ┌───────────────┐ ┌────────────────┐ │
│ │ 📰 Crawl Sitemap│ │ 🧭 Guided     │ │ 📋 Direct URLs │ │
│ │                 │ │   Discovery   │ │                │ │
│ │ Analyzing...    │ │ Explore page  │ │ Paste your own │ │
│ │ ◌ loading       │ │ by page       │ │ URLs           │ │
│ │                 │ │               │ │                │ │
│ │  [Recommended]  │ │               │ │                │ │
│ └─────────────────┘ └───────────────┘ └────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Clustering completes → card updates:**

```
│ 📰 Crawl Sitemap    │
│                     │
│ 2,100 pages         │
│ 15 sections         │
│                     │
│    [Recommended]    │
```

**User selects Sitemap → section list** (single sitemap = path-segment grouping, same as today):

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 Search sections or sitemaps...                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ▾ ☑ Docs                                   1,400 pages │
│   ☑ /docs/{category}/{slug}                    1,200    │
│   ☑ /docs/tutorials/{level}                      200    │
│                                                         │
│ ▾ ☑ API Reference                             600 pages │
│   ☑ /api-reference/{version}/{endpoint}          600    │
│                                                         │
│ ▸ ☑ Blog                                      100 pages │
│                                                         │
│ 1 sitemap · 2,100 pages                                │
│                            [Configure Crawl →]          │
└─────────────────────────────────────────────────────────┘
```

Single sitemap — path-segment grouping. Same UX as today, plus footer showing sitemap source.

---

## Journey 2: Sitemap Index with Children

**User:** Enters `https://www.microsoft.com` → Go

**Animated reveal:**

```
│ ✓ Site reachable                                 │
│ ✓ Technology: ASP.NET                            │
│ ✓ Sitemap found: /sitemap.xml (index → 5 files) │
```

**Compact trail:** `▸ ✓ Sitemap index: 5 sitemaps, 10,500 pages`

**User selects Sitemap → section list** (multiple sitemaps = sitemap-file grouping):

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 Search sections or sitemaps...                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ▾ ☑ /sitemaps/products.xml                 4,200 pages  │
│   ☑ /products/{category}                       1,800    │
│   ☑ /products/{category}/{slug}                2,200    │
│   ☐ /products/discontinued/{id}                  200    │
│                                                         │
│ ▾ ☑ /sitemaps/support.xml                  3,800 pages  │
│   ☑ /support/{product}/{topic}                 2,400    │
│   ☑ /support/downloads/{os}/{driver}           1,400    │
│                                                         │
│ ▾ ☑ /sitemaps/learn.xml                    1,500 pages  │
│   ☑ /learn/{path}/{module}                     1,200    │
│   ☑ /learn/certifications/{cert}                 300    │
│                                                         │
│ ▾ ☑ /sitemaps/blog.xml                       800 pages  │
│   ☑ /blog/{year}/{month}/{slug}                  650    │
│   ☑ /blog/categories/{name}                      150    │
│                                                         │
│ ▸ ☑ /sitemaps/pages.xml                      200 pages  │
│                                                         │
│ 5 sitemaps · 10,500 pages                               │
│                            [Configure Crawl →]          │
└─────────────────────────────────────────────────────────┘
```

User unchecks `/sitemaps/blog.xml` → all blog sections excluded with one click.

**Search "support"** → only matching group visible:

```
│ ▾ ☑ /sitemaps/support.xml                  3,800 pages  │
│   ☑ /support/{product}/{topic}                 2,400    │
│   ☑ /support/downloads/{os}/{driver}           1,400    │
```

---

## Journey 3: Sitemap Found via robots.txt Only

**User:** Enters `https://www.epson.com` → Go

**Animated reveal:**

```
│ ✓ Site reachable                                 │
│ ✓ Technology: Custom                             │
│ ✗ /sitemap.xml — not found                       │
│ ✓ robots.txt → 2 sitemap declarations            │
│ ✓ Resolving /sitemaps/sitemap_index.xml (index)  │
```

**Compact trail:** `▸ ✓ 2 sitemaps found via robots.txt`

**Strategy card** — enabled (robots.txt sitemaps count):

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ 6,200 pages          │
│ Found via robots.txt │
│                      │
│    [Recommended]     │
└──────────────────────┘
```

**Section list** — sitemap-file grouping with origin badge:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Search sections or sitemaps...                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ▾ ☑ /sitemaps/products.xml · via robots.txt    3,100 pages  │
│   ☑ /products/{category}/{slug}                    2,800    │
│   ☑ /products/ink/{model}                            300    │
│                                                             │
│ ▾ ☑ /sitemaps/support.xml · via robots.txt     3,100 pages  │
│   ☑ /support/{product}/{article}                   2,600    │
│   ☑ /support/drivers/{os}/{model}                    500    │
│                                                             │
│ 2 sitemaps · 6,200 pages                                    │
│                              [Configure Crawl →]            │
└─────────────────────────────────────────────────────────────┘
```

`via robots.txt` badge on group headers provides provenance without extra UI elements.

---

## Journey 4: Multiple Sitemap Sources (Index + robots.txt)

**User:** Enters `https://large-ecommerce.com` → Go

**Animated reveal:**

```
│ ✓ Site reachable                                 │
│ ✓ Sitemap found: /sitemap.xml (index → 2 files) │
│ ✓ robots.txt → 2 additional sitemaps             │
```

**Compact trail:** `▸ ✓ 4 sitemaps found (2 standard + 2 via robots.txt)`

**Section list** — mixed origins on group headers:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Search sections or sitemaps...                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ▾ ☑ /sitemap-main.xml                         5,000 pages  │
│   ☑ /shop/{department}/{category}                  3,200    │
│   ☑ /shop/{dept}/{cat}/{product}                   1,800    │
│                                                             │
│ ▾ ☑ /sitemap-pages.xml                          800 pages  │
│   ☑ /help/{topic}                                    400    │
│   ☑ /stores/{region}/{city}                          400    │
│                                                             │
│ ▾ ☑ /blog-sitemap.xml · via robots.txt         1,200 pages  │
│   ☑ /blog/{year}/{slug}                              900    │
│   ☑ /blog/guides/{category}                          300    │
│                                                             │
│ ▾ ☑ /deals-sitemap.xml · via robots.txt          500 pages  │
│   ☑ /deals/{event}/{slug}                            350    │
│   ☐ /deals/expired/{slug}                            150    │
│                                                             │
│ 4 sitemaps · 7,500 pages (12 duplicates removed)           │
│                              [Configure Crawl →]            │
└─────────────────────────────────────────────────────────────┘
```

Standard sitemaps have no badge. robots.txt sitemaps show `via robots.txt`. Footer shows dedup count.

---

## Journey 5: No Sitemap Found — User Doesn't Have One

**User:** Enters `https://spa-startup.io` → Go

**Animated reveal:**

```
│ ✓ Site reachable                                 │
│ ✓ Technology: React SPA                          │
│ ✗ /sitemap.xml — not found                       │
│ ✗ robots.txt — no sitemap declared               │
```

**Compact trail:** `▸ ✗ No sitemap found (checked /sitemap.xml, robots.txt)`

**Strategy cards** — sitemap card in "needs help" state:

```
┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐
│ 📰 Crawl Sitemap     │ │ 🧭 Guided Discovery  │ │ 📋 Direct URLs      │
│                      │ │                      │ │                     │
│ No sitemap found     │ │ Explore the site     │ │ Paste your own URLs │
│ Checked /sitemap.xml │ │ page by page         │ │                     │
│ and robots.txt       │ │                      │ │                     │
│                      │ │    [Recommended]     │ │                     │
│ 🔗 I have a sitemap  │ │                      │ │                     │
└──────────────────────┘ └──────────────────────┘ └─────────────────────┘
```

Card is visually muted but not fully disabled — "I have a sitemap" is clickable. User ignores it → picks Guided Discovery → normal flow. The checked paths give confidence the system actually looked.

---

## Journey 6: No Sitemap Found — User Provides Custom URL

**User:** Sees sitemap card → clicks **"I have a sitemap"**

**Card transforms — State 2 (input revealed):**

```
┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐
│ 📰 Crawl Sitemap     │ │ 🧭 Guided Discovery  │ │ 📋 Direct URLs      │
│                      │ │                      │ │                     │
│ Sitemap URL:         │ │ Explore the site     │ │ Paste your own URLs │
│ ┌──────────────────┐ │ │ page by page         │ │                     │
│ │ https://...      │ │ │                      │ │                     │
│ └──────────────────┘ │ │                      │ │                     │
│         [Check →]    │ │                      │ │                     │
│                      │ │                      │ │                     │
│ ← Back               │ │                      │ │                     │
└──────────────────────┘ └──────────────────────┘ └─────────────────────┘
```

Other two cards stay visible and selectable. No context switch.

**User enters URL → clicks Check → validating:**

```
│ ◌ Checking /content/sitemap_pages.xml...  │
```

**Card transforms — State 3 (valid sitemap found):**

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ ✓ 340 pages found    │
│ /content/sitemap.xml │
│                      │
│    [Select →]        │
└──────────────────────┘
```

Card transitions to enabled. User selects → sections:

```
│ ▾ ☑ /content/sitemap_pages.xml · manually added  340 pages │
│   ☑ /docs/{category}/{slug}                          180   │
│   ☑ /api/{version}/{endpoint}                        120   │
│   ☑ /tutorials/{level}/{slug}                         40   │
│                                                            │
│ 1 sitemap · 340 pages                                      │
```

Single sitemap but user-provided → sitemap-file grouping with `manually added` badge (not path-segment grouping, because the provenance is the important context here).

---

## Journey 7: User Provides Invalid Sitemap URL

**User:** Clicks "I have a sitemap" → enters URL → clicks Check

**404 response:**

```
┌──────────────────────┐
│ 📰 Crawl Sitemap     │
│                      │
│ ✗ Could not load     │
│   404 Not Found      │
│                      │
│ ┌──────────────────┐ │
│ │ https://exampl...│ │
│ └──────────────────┘ │
│         [Check →]    │
│                      │
│ ← Back               │
└──────────────────────┘
```

**Non-XML content:**

```
│ ✗ Could not load     │
│   Expected XML, got  │
│   HTML               │
```

**Empty sitemap (valid XML, zero URLs):**

```
│ ✗ Sitemap is empty   │
│   Valid XML but       │
│   0 URLs found       │
```

Input stays visible. User can correct and retry. Card stays in State 2 until valid. "← Back" returns to State 1.

---

## Journey 8: Gzipped Sitemap

**Status: DEFERRED** — not in scope for this feature. Can be added later to the profiler's fetch pipeline independently. When implemented, gzipped sitemaps will be transparently decompressed during both auto-discovery and user-provided URL validation.

---

## Journey 9: Cross-Sitemap Duplicate URLs

**User:** Site has `/sitemap.xml` and robots.txt declares `/news-sitemap.xml` — 200 URLs appear in both.

**System:** Deduplicates silently at the URL level. Keeps each URL in the **first sitemap** where it appeared (processing order: standard → index children → robots.txt declarations → user-provided).

**Footer shows dedup:**

```
│ 2 sitemaps · 4,800 pages (200 duplicates removed)    │
│                              [Configure Crawl →]      │
```

No per-section overlap badges — keeps it clean. Total count is accurate (deduplicated). User doesn't need to think about it.

---

## Journey 10: Sitemap Found But Very Few Pages

**User:** Enters `https://small-agency.com` → sitemap exists but only 8 pages.

**Animated reveal:**

```
│ ✓ Site reachable                                 │
│ ✓ Technology: WordPress                          │
│ ✓ Sitemap found: /sitemap.xml (8 pages)          │
```

**Compact trail:** `▸ ✓ Sitemap found: /sitemap.xml (8 pages)`

**Strategy cards** — sitemap enabled but not recommended:

```
┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐
│ 📰 Crawl Sitemap     │ │ 🧭 Guided Discovery  │ │ 📋 Direct URLs      │
│                      │ │                      │ │                     │
│ 8 pages              │ │ Explore the site     │ │ Paste your own URLs │
│ Sitemap is small —   │ │ page by page         │ │                     │
│ discovery may find   │ │                      │ │                     │
│ more pages           │ │    [Recommended]     │ │                     │
└──────────────────────┘ └──────────────────────┘ └─────────────────────┘
```

Card is clickable (not disabled) but Guided Discovery is recommended: "Sitemap has only 8 pages — the site likely has more content discoverable through navigation."

If user picks Sitemap → single sitemap, path-segment grouping (same as Journey 1). Their choice.

---

## Existing Code Reality (verified against codebase)

These findings inform what the HLD/LLD must address:

### Backend

| Area                      | Current State                                                                                                              | Gap                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Sitemap discovery         | Only checks `/sitemap.xml` (hardcoded in `fast-profiler.ts` line 299)                                                      | robots.txt `Sitemap:` directives parsed by `robots-analyzer.ts` but disconnected from profiler |
| Sitemap provenance        | Profiler resolves index children recursively but flattens into `string[]` (line 384). Per-URL source sitemap file is lost. | Need to preserve which sitemap file each URL came from                                         |
| Profile response          | Returns `hasSitemap: boolean` only. No sitemap URLs, no type, no children, no discovery trail.                             | Need `sitemapDiscovery` field with steps + sitemap files                                       |
| `SiteProfile` interface   | No fields for sitemap URLs/type/children (`packages/crawler/src/profiler/interfaces.ts`)                                   | Interface extension needed                                                                     |
| Clustering                | Pools all URLs globally, clusters by path pattern. No per-sitemap-file awareness.                                          | Need to tag each `UrlGroup` with its source sitemap file                                       |
| Phase B gate              | Binary: `if (!hasSitemap) skip Phase B entirely` (CrawlFlowV5 line 464)                                                    | Must trigger Phase B when robots.txt sitemaps exist too                                        |
| Custom sitemap validation | No endpoint exists                                                                                                         | New route needed: POST validate-sitemap → fetch, parse, return count                           |

### Frontend

| Area                   | Current State                                                                                                                                      | Gap                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Profiling progress UI  | No step-by-step display. Old `analysisSteps` rendering was removed. Steps exist in state but only used as boolean gate.                            | Net-new component for animated reveal + compact trail                                             |
| Section search         | Exists (State2Analysis line 375). Searches name, pattern, page URLs, titles.                                                                       | Extend to match `sitemapFile` field                                                               |
| Section grouping       | Exists (State2Analysis lines 586-610). Groups by first path segment. Collapsible headers, group checkboxes, badges. Auto-activates when >5 groups. | Change grouping key to `sitemapFile` when multiple sitemaps; keep path-segment for single sitemap |
| Disabled sitemap card  | `<button disabled>` with "No sitemap available" text (10px italic). No interactive elements.                                                       | Restructure from `<button>` to `<div>` with three states (D-3)                                    |
| `CrawlSection` type    | Has `source: 'sitemap' \| 'explored' \| 'auto' \| 'direct'`. No `sitemapFile` or `sitemapOrigin`.                                                  | Add two optional fields                                                                           |
| `ProfileResponse` type | `hasSitemap: boolean` only                                                                                                                         | Add `sitemapDiscovery` optional field                                                             |

---

## Backend Changes Summary

| Change                                                       | File                                        | Effort |
| ------------------------------------------------------------ | ------------------------------------------- | ------ |
| Wire robots.txt `Sitemap:` directives into profiler          | `fast-profiler.ts`                          | Medium |
| Preserve per-sitemap-file provenance during index resolution | `fast-profiler.ts`                          | Medium |
| Return `sitemapDiscovery` trail in profile response          | `crawl.ts` (profile route), `interfaces.ts` | Small  |
| Tag each `UrlGroup` with source sitemap file in clustering   | `crawl.ts` (cluster route)                  | Medium |
| Deduplicate URLs across sitemaps, track count                | `crawl.ts` (cluster route)                  | Small  |
| New endpoint: validate user-provided sitemap URL             | `crawl.ts` (new route)                      | Small  |

## Frontend Changes Summary

| Change                                                              | File                                                   | Effort |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------ |
| Profiling discovery trail — animated reveal + compact               | New component in `crawl-flow/`                         | Medium |
| Adaptive section grouping (sitemap-file vs path-segment)            | `State2Analysis.tsx` (SectionChecklist grouping logic) | Medium |
| Search filter matches `sitemapFile`                                 | `State2Analysis.tsx` (SectionChecklist filter)         | Small  |
| Origin badges on group headers (`via robots.txt`, `manually added`) | `State2Analysis.tsx` (SectionChecklist group render)   | Small  |
| Sitemap card three-state transform (D-3)                            | `StrategySelector.tsx`                                 | Medium |
| Wire custom sitemap → validate → re-cluster                         | `CrawlFlowV5.tsx`                                      | Medium |
| Update `CrawlSection` type with provenance fields                   | `types.ts`                                             | Small  |
| Update `ProfileResponse` type with `sitemapDiscovery`               | `crawl.ts` (API types)                                 | Small  |
| Footer: sitemap count + dedup count                                 | `State2Analysis.tsx` (SectionChecklist)                | Small  |

## Journey Summary Table

| #   | Scenario                              | Sitemap Card                | Section Grouping                         | Key UX                             |
| --- | ------------------------------------- | --------------------------- | ---------------------------------------- | ---------------------------------- |
| 1   | Single `/sitemap.xml`                 | ✅ Enabled, recommended     | Path-segment (same as today)             | Footer shows sitemap source        |
| 2   | Sitemap index with children           | ✅ Enabled, recommended     | By sitemap file (interactive groups)     | Per-sitemap checkboxes             |
| 3   | Found via robots.txt only             | ✅ Enabled, recommended     | By sitemap file + `via robots.txt` badge | Trail shows discovery path         |
| 4   | Multiple sources (index + robots.txt) | ✅ Enabled, recommended     | By sitemap file, mixed origin badges     | Dedup footer                       |
| 5   | Not found, user has none              | "Needs help" state          | N/A                                      | Checked paths + "I have a sitemap" |
| 6   | Not found, user provides valid URL    | ✅ Becomes enabled          | By sitemap file + `manually added` badge | Card transforms seamlessly         |
| 7   | User provides invalid URL             | Stays in State 2            | N/A                                      | Error message, retry input         |
| 8   | Gzipped sitemap                       | DEFERRED                    | —                                        | —                                  |
| 9   | Cross-sitemap duplicates              | ✅ Enabled                  | Silent dedup                             | Footer count                       |
| 10  | Very few pages                        | ⚠️ Enabled, not recommended | Path-segment (single sitemap)            | Suggests discovery may find more   |
