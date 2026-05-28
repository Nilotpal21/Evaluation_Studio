# Design Review v5: Agent-Architect Debate (Research-Informed)

5 rounds of review debate between **Agent** (implementation-focused, challenges
feasibility) and **Architect** (design-focused, defends decisions). Grounded in
research from Google, Bing, Cloudflare engineering blogs + academic papers
(Cho & Garcia-Molina, Charikar SimHash, Manku/Google, Fetterly/Microsoft, etc.).

Full research findings: `docs/specs/crawl-research-findings.md`

---

## Round 1: SHA256 vs SimHash — The Wrong Hash for Change Detection

**AGENT:** The HLD uses SHA256 for `ICrawlSignature.contentHash`. Research shows
this is the wrong tool. Google uses **SimHash** (64-bit, locality-sensitive) for
8 billion pages [Manku et al. 2007, WWW]. SHA256 is a cryptographic hash — a
single character change produces a completely different hash. That means:

1. A page adds one new FAQ entry → SHA256 says "completely changed" → full
   re-extraction + re-indexing of all 118 FAQs, even though 117 are identical.
2. A footer copyright year updates → SHA256 says "changed" → unnecessary pipeline.
3. Dynamic elements (CSRF tokens, session IDs, ad rotation) → every fetch looks
   "changed" even when content is identical.

Fetterly et al. (Microsoft Research, 2003) found that of pages that DO change,
**most changes are small** (power-law distribution). SHA256 treats a 0.1% change
the same as a 100% rewrite. We're throwing away the most valuable signal: HOW
MUCH did it change?

SimHash solves this: Hamming distance of 0 = identical, 1-3 = minor change
(boilerplate/footer), 4+ = significant content change. Google uses k=3 threshold
at 8B scale. We can set k=2 for our thousands-of-pages scale.

**ARCHITECT:** You're right that SHA256 alone is insufficient, but I'd push back
on replacing it entirely. We need BOTH:

- **SHA256 of normalized extracted text** → exact match detection (cheapest check,
  O(1) lookup). If the extracted FAQ text is byte-identical, skip pipeline. Period.
  This catches the ~65% of pages that never change [Fetterly 2003].

- **SimHash of extracted text** → near-duplicate detection. If SHA256 differs but
  SimHash Hamming distance ≤ 2, the change is minor (new FAQ added, typo fix).
  We can do a **partial update** — diff the extraction, only index changed items.

The question is: does the partial update path justify the complexity? For Part 1,
SHA256 skip-if-identical covers the biggest win (65% of pages skipped entirely).
SimHash partial updates are a Part 2 optimization.

**AGENT:** I'd accept that IF we add boilerplate removal before hashing. Common
Crawl normalizes text (lowercase, strip numbers/punctuation) before hashing
[Common Crawl practice]. Without normalization, dynamic elements make SHA256
useless — every fetch returns a different hash even for unchanged content.
R-NEW-2 (content hash stability) must validate this experimentally.

**RESOLUTION:**

- **Part 1**: SHA256 of **normalized extracted text** (not raw HTML). Normalization:
  strip whitespace, remove dynamic elements (timestamps, CSRF, ad containers).
  Skip pipeline if hash matches. This handles the 65% unchanged case.
- **Part 2**: Add SimHash (64-bit) alongside SHA256. Use Hamming distance for
  near-duplicate detection and partial update path. Threshold: k≤2 = minor
  change (update metadata only), k≥3 = significant change (full re-index).
- **ICrawlSignature** adds: `simHash?: string` (64-bit hex) for Part 2.
- **R-NEW-2** expanded: must test both SHA256 stability AND SimHash Hamming
  distance distribution for real page changes.

**HLD Change:** Update ICrawlSignature to note SHA256 is of normalized extracted
text. Add simHash as future Part 2 field. Add normalization requirements.

---

## Round 2: HTTP Eligibility Validation — Cost vs Accuracy Tradeoff

**AGENT:** Principle 5 says "validate HTTP eligibility during first crawl by
comparing Playwright extraction with a parallel HTTP GET." I've implemented
crawlers at scale. The 10% overhead claim is optimistic. Here's why:

1. **The HTTP GET itself isn't the cost — the comparison is.** You need to:
   - Fetch via HTTP (1 request)
   - Parse HTML with goquery-equivalent (cheerio in Node.js)
   - Apply the SAME extraction selectors
   - Compare extracted text with Playwright extraction
   - This is essentially running the extraction pipeline TWICE per page.

2. **Aktas & Can (2024, IEEE Access)** achieved 20% time savings with an ML
   classifier that predicts render-need BEFORE fetching. Their approach:
   features from URL structure + initial HTML response headers → predict.
   This is cheaper than our "extract twice and compare" approach.

3. **Google's approach** is simpler: compare raw HTML length against rendered
   DOM length. Large delta = JS-dependent. No double extraction needed.

**ARCHITECT:** Fair points. Let me counter:

1. Google's "DOM diff" approach has a flaw for our use case: the raw HTML might
   be the same SIZE as rendered DOM but with completely different content (React
   SSR hydration where HTML is a shell, JS rebuilds the tree). Size comparison
   works for Google because they control the renderer and can diff at DOM node
   level. We'd need Playwright for that — defeating the purpose.

2. The ML classifier approach [Aktas & Can] requires training data we don't have.
   17,160 labeled websites. For Part 1, we need a zero-shot approach.

3. My proposal: **Don't extract twice. Use a lightweight probe.**

```
HTTP Eligibility Probe (during first crawl, for each page type, NOT per page):
  1. Playwright extracts page → contentA (already happening)
  2. HTTP GET same URL → rawHtml
  3. Check: does rawHtml contain the FIRST and LAST expected content items?
     (e.g., first FAQ question text and last FAQ question text)
  4. If yes → httpEligible=true for this PAGE TYPE (not just this URL)
  5. Total cost: 1 extra HTTP GET per page TYPE (3-5 probes, not 300)
```

This runs on the 3-5 sample pages from Phase 2, not on all 300 pages. Cost:
3-5 extra HTTP GETs. The classification applies to the entire URL pattern.

**AGENT:** That's much better. But "first and last content items" is fragile. I'd
use **text containment**: does the HTTP response contain ≥80% of the extracted
text strings? That catches partial rendering (e.g., server renders first 10 FAQs,
JS loads the remaining 108).

Also: what about the Go worker's selector compatibility? Colly/goquery supports
standard CSS selectors but NOT Playwright-specific pseudo-selectors (`:has()`,
`:text()`, `>> nth=`). If the PageHandler uses Playwright-specific selectors, Go
worker can't execute them even if the content is HTTP-fetchable.

**ARCHITECT:** Good catch. The eligibility check must be TWO conditions:

1. **Content available via HTTP** (text containment ≥ 80%)
2. **Selectors compatible with goquery** (no Playwright-specific pseudo-selectors)

If either fails, httpEligible = false.

**RESOLUTION:**

- **Probe during Phase 2** (sample pages only, not all pages). 3-5 HTTP GETs.
- **Two-condition check**: content availability (≥80% text containment) AND
  selector compatibility (no Playwright-specific pseudo-selectors).
- **Classification is per page type** (URL pattern), not per URL. If 3/3 sample
  pages pass → entire URL pattern is httpEligible.
- **Go worker receives simplified selectors**: the system generates a goquery-
  compatible version of the extraction schema (CSS selectors only, no Playwright
  extensions). If this isn't possible → httpEligible = false.

**HLD Change:** Update Principle 5 to specify probe-based validation during Phase
2 (not parallel extraction for every page). Add selector compatibility check.
Add goquery-compatible extraction schema to PageHandler.

---

## Round 3: Sitemap Lastmod Reliability — The 30% Problem

**AGENT:** The HLD's Phase 0 RE-CRAWL OPTIMIZATION relies heavily on sitemap
lastmod for the cheapest change detection layer. But research shows this is
unreliable:

1. **Google ignores `changefreq` entirely** and only uses `lastmod` if
   "consistently and verifiably accurate" [Google Sitemap docs]. Why? Because
   many sites set lastmod to today's date for all pages, or never update it.

2. Google's 2025 paper on noisy signals [ArXiv 2502.02430] explicitly models
   sitemaps as **noisy signals with false positives AND missing events**. The
   algorithm must handle both "sitemap says changed but didn't" AND "sitemap
   says unchanged but actually did."

3. In our enterprise context: CMS-generated sitemaps are particularly unreliable.
   WordPress updates lastmod when any metadata changes (category, tag). Drupal
   often doesn't update lastmod when content changes via API.

So our Layer 1 (sitemap lastmod) can't be trusted as a SKIP signal. It can only
be trusted as a CRAWL signal (lastmod is newer → definitely re-crawl). The
opposite (lastmod is same → skip) is dangerous.

**ARCHITECT:** You're raising the classic "false negative" problem with sitemaps.
Let me propose a trust calibration approach, inspired by Google's noisy signals
paper:

```
Sitemap Trust Score (per domain, learned over time):
  First crawl: trust = 0.5 (neutral)

  After each re-crawl, validate:
    - Sitemap said "unchanged" + content hash confirms unchanged → trust += 0.1
    - Sitemap said "changed" + content hash confirms changed → trust += 0.1
    - Sitemap said "unchanged" + content actually changed → trust -= 0.2
    - Sitemap said "changed" + content actually unchanged → trust -= 0.05

  Trust > 0.8: use sitemap lastmod as skip signal (high confidence)
  Trust 0.5-0.8: use sitemap as PRIORITY signal (crawl "changed" first, but
    still verify "unchanged" via HTTP conditional)
  Trust < 0.5: ignore sitemap lastmod entirely (unreliable)
```

This way, we LEARN whether a site's sitemap is trustworthy. First re-crawl:
we verify everything. After 3-5 re-crawls with accurate sitemaps: we trust
the skip signal. Bad sitemaps get ignored automatically.

**AGENT:** That's elegant but adds state complexity (per-domain trust score).
For Part 1, can we simplify? My proposal:

**Part 1 rule:** Sitemap lastmod is a PRIORITY signal, never a SKIP signal.

- URLs where lastmod is newer → crawl FIRST (likely changed)
- URLs where lastmod is same → crawl LAST (likely unchanged, but verify)
- Still check HTTP 304 for all URLs (the authoritative skip signal)

**Part 2:** Add trust calibration as described above.

**ARCHITECT:** Agreed. This is the conservative approach that loses almost nothing.
The ordering optimization alone is valuable: process 20 changed URLs first
(progressive results), then verify the 260 "unchanged" ones. If we're right
about 85% unchanged, those 260 will mostly return 304.

**RESOLUTION:**

- **Part 1**: Sitemap lastmod is a PRIORITY signal (crawl-order optimization),
  NOT a skip signal. HTTP 304 or content hash is the authoritative skip decision.
- **Part 2**: Add per-domain sitemap trust calibration. After trust > 0.8,
  sitemap lastmod becomes a skip signal (avoiding the HTTP 304 round-trip).
- **Phase 0 re-crawl report** changes: "20 URLs have newer lastmod (crawl first),
  260 URLs unchanged in sitemap (verify via HTTP). 5 URLs removed."

**HLD Change:** Downgrade sitemap from "skip entirely" to "priority ordering"
in Phase 0 RE-CRAWL OPTIMIZATION and Phase 4 CHANGE DETECTION Layer 1.

---

## Round 4: The "Browserless Web Data Extraction" Insight — API Interception

**AGENT:** The WWW 2018 paper "Browserless Web Data Extraction" found something
our HLD completely misses: many SPAs load content via **XHR/fetch API calls**.
The Playwright browser renders JS which makes API calls which return JSON which
gets rendered into DOM. But the DATA is in the API response, not the DOM.

Example: A React SPA FAQ page does:

```
GET /api/faqs?product=SPT_C11CJ67201 → JSON: [{ question: "...", answer: "..." }]
```

If we intercept the API call, we get structured data directly — no Playwright
needed, no DOM parsing, no CSS selectors. And it's **magnitudes more efficient**
than browser rendering [WWW 2018].

Our Mode 2 (Crawl Together) uses Playwright to navigate, observe, and extract.
But during Phase 1-2, when the LLM observes the page, it could ALSO observe
the network requests and identify the data API. Then Phase 4 execution could
call the API directly instead of rendering the page.

**ARCHITECT:** This is a powerful optimization but let me scope it carefully:

1. **Not all SPAs use clean REST APIs.** Many use GraphQL with complex queries,
   or have APIs behind auth tokens that change per session, or use websockets.

2. **The MCP server already has network introspection capability.** Playwright
   can intercept network requests via `page.route()` or `page.on('response')`.
   During Phase 1-2, the system could record which API endpoints returned the
   content the LLM extracted.

3. **This is a third execution path**, alongside Playwright and Go worker:
   - **HTTP (Go worker)**: static HTML pages, CSS selectors
   - **API direct**: SPA pages with clean REST/JSON APIs
   - **Playwright**: everything else (complex JS, no API, auth-dependent)

**AGENT:** I agree it's a Phase 2/Part 2 optimization, not Part 1. But the
PageHandler schema should SUPPORT it now so we don't need a migration later.
Proposal:

```typescript
// Add to IPageHandler for future API interception
apiEndpoint?: {
  url: string;            // The API URL pattern (with path params)
  method: 'GET' | 'POST';
  headers?: Record<string, string>;  // Required headers
  bodyTemplate?: string;   // For POST requests, with {{variable}} placeholders
  responseMapping: Record<string, string>;  // JSON path → field name
};
```

If `apiEndpoint` exists, Mode 3 replay calls the API directly. Falls back to
Playwright if API returns error/auth failure.

**ARCHITECT:** I like the schema extension but have a concern: API endpoints
are MORE fragile than DOM selectors. APIs change versions, add auth, rename
fields. The fingerprint/staleness detection that works for DOM doesn't work for
APIs (there's no "DOM structure hash" for a JSON response).

For Part 1: don't implement API interception. For Part 2: implement with a
**separate API fingerprint** (response schema hash + field presence check).

**RESOLUTION:**

- **Part 1**: No API interception. Focus on HTTP vs Playwright path.
- **Part 2**: Add `apiEndpoint` to PageHandler schema. Phase 2 records network
  requests during page observation. If clean REST API found → store endpoint.
  Mode 3 tries API first, falls back to Playwright.
- **Add to PageHandler schema NOW** (as optional field) to avoid migration.
- **New execution priority**: API direct (cheapest) → HTTP/Go worker → Playwright
- **New research task**: R-NEW-3: API endpoint discovery and stability analysis.

**HLD Change:** Add `apiEndpoint?` as optional future field in IPageHandler.
Add brief note in §3.0 Principles about API interception as Part 2 path.
DO NOT add to Phase 4 execution — Part 2 scope.

---

## Round 5: Adaptive Re-Crawl Scheduling — The Missing Mode 3.5

**AGENT:** Cho & Garcia-Molina (2003) proved that optimal re-crawl frequency is
per-page, proportional to change rate. Azar et al. (2018, PNAS) provided an
efficient algorithm. Google's 2025 paper incorporates noisy signals. Our HLD
has ZERO concept of adaptive scheduling. Mode 3 replays happen when the user
triggers a re-crawl. There's no system-initiated re-crawl.

For enterprise customers crawling 50+ sites, manually triggering re-crawls is
untenable. The system should learn: "epson.com/faq pages change ~monthly,
epson.com/support pages change ~weekly, epson.com/drivers changes ~daily."
And schedule re-crawls accordingly.

Fetterly's data: 65% of pages never change in 11 weeks. Why crawl them weekly?
Conversely, 23% of .com pages change daily — weekly crawls miss most changes.

**ARCHITECT:** Absolutely agree this matters, but I want to avoid scope creep.
Let me propose a **minimal viable scheduler** for Part 1, with a research path
to the full Poisson model for Part 2.

**Part 1 — Simple heuristic scheduler:**

```
Per-domain crawl schedule (tenant-configurable):
  Default: weekly
  Override per domain: daily | weekly | biweekly | monthly | manual-only

Per-URL change rate tracking (automatic):
  After each re-crawl, store: { url, changed: boolean, checkedAt: Date }
  Compute: changeRate = changedCount / checkCount (simple frequency)

  No automatic schedule adjustment in Part 1 — just TRACK the data.
  Show in UI: "This domain: 15% pages change weekly, 5% change daily."
```

**Part 2 — Adaptive scheduling (Poisson model):**

```
Per-URL re-crawl interval:
  Use Cho & Garcia-Molina's estimator (corrected for observation bias)
  Allocate crawl budget proportionally to change rate
  Incorporate noisy signals (sitemap, RSS) per Google 2025 paper

Scheduled re-crawl worker:
  Cron: check all domains with auto-schedule enabled
  For each domain: compute optimal crawl set (which URLs, how many)
  Enqueue as Mode 3 replay (zero LLM, change detection enabled)
  Report: "Crawled 45 URLs, 12 changed, 33 unchanged (skipped pipeline)"
```

**AGENT:** I agree on the Part 1/Part 2 split. But even for Part 1, the
ICrawlSignature should store change HISTORY, not just the latest signature.
Without history, you can't compute change rates when Part 2 arrives.

Proposal: add a lightweight `crawl_change_log` collection:

```typescript
interface ICrawlChangeLog {
  tenantId: string;
  domain: string;
  url: string;
  checkedAt: Date;
  changed: boolean;
  changeType: 'new' | 'content' | 'structure' | 'removed' | 'unchanged';
  contentHashBefore?: string;
  contentHashAfter?: string;
}
// Capped collection or TTL: 180 days
// Index: { tenantId: 1, domain: 1, url: 1, checkedAt: -1 }
```

This is ~100 bytes per entry. 300 URLs × 52 weeks = 15,600 entries per domain
per year. Trivial storage. But it enables:

- Change rate computation: `db.crawl_change_log.find({ url, changed: true }).count() / total`
- Change pattern analysis: "this URL changes every Monday" (CMS publish cycle)
- Per-domain freshness dashboard in Studio

**ARCHITECT:** Agreed. The change log is cheap and enables everything we need for
Part 2 without premature optimization. Let me also flag: the re-crawl scheduling
intersects with the existing crawl job scheduling in search-ai. We have
`scheduledCrawls` already — the adaptive scheduler would be an enhancement to
that existing infrastructure, not a new system.

**RESOLUTION:**

- **Part 1**:
  - Tenant-configurable per-domain schedule (daily/weekly/biweekly/monthly/manual)
  - Track change history in `crawl_change_log` collection (lightweight, capped)
  - Display change stats in Studio: "15% of pages changed since last crawl"
  - No automatic schedule adjustment — just data collection
- **Part 2**:
  - Adaptive per-URL scheduling using Poisson change rate estimator
  - Incorporate noisy signals (sitemap, RSS) per Google 2025 paper
  - Scheduled re-crawl worker (cron-triggered Mode 3 replay)
  - Crawl budget allocation proportional to change rate
- **New model**: ICrawlChangeLog — add to HLD schema section
- **New research task**: R-NEW-4: Change rate estimation accuracy (validate
  Poisson model against real enterprise site change patterns)

**HLD Change:** Add ICrawlChangeLog schema. Add brief note about scheduled
re-crawl as Part 2 feature. Add R-NEW-4 research task.

---

## Summary: All Changes from 5-Round Debate

| Round | Topic                  | Resolution                                                                                 | Part |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------ | ---- |
| 1     | SHA256 vs SimHash      | SHA256 of normalized text for Part 1. Add SimHash for Part 2 near-dedup.                   | 1+2  |
| 1     | Content normalization  | Strip whitespace, dynamic elements before hashing. R-NEW-2 validates.                      | 1    |
| 2     | HTTP eligibility probe | Probe during Phase 2 samples (3-5 GETs), not per-page. Two-condition: content + selectors. | 1    |
| 2     | Go worker selectors    | Generate goquery-compatible extraction schema. If not possible → httpEligible=false.       | 1    |
| 3     | Sitemap lastmod trust  | Part 1: priority signal, not skip signal. Part 2: per-domain trust calibration.            | 1+2  |
| 4     | API interception       | Part 2 optimization. Add optional apiEndpoint field to PageHandler now.                    | 2    |
| 5     | Adaptive re-crawl      | Part 1: configurable schedule + change log. Part 2: Poisson-model adaptive scheduling.     | 1+2  |
| 5     | Change log collection  | ICrawlChangeLog for change rate tracking. Cheap, enables Part 2.                           | 1    |

### Research Tasks Added

- **R-NEW-2 expanded**: Must test normalization strategies (boilerplate removal, timestamp stripping)
- **R-NEW-3** (NEW): API endpoint discovery during Phase 2, stability analysis
- **R-NEW-4** (NEW): Change rate estimation — validate Poisson model vs real enterprise change patterns

### Key Numbers from Research (Informing Design)

| Number                                    | Source                   | Design Impact                   |
| ----------------------------------------- | ------------------------ | ------------------------------- |
| 65% of pages unchanged in 11 weeks        | Fetterly 2003            | SHA256 skip covers majority     |
| 40% change within 1 week                  | Cho & Garcia-Molina 2000 | Weekly re-crawl catches most    |
| Only 0.017% of fetches use HTTP 304       | Google 2024              | Can't rely solely on 304        |
| 64-bit SimHash sufficient for 8B pages    | Manku 2007               | SimHash is trivially small      |
| 20% time savings from selective rendering | Aktas & Can 2024         | HTTP eligibility probe pays off |
| Rendering is 50-100× slower than HTTP     | Multiple                 | Minimize Playwright usage       |
| Most changes are small (power-law)        | Fetterly 2003            | SimHash near-dedup valuable     |
| Noisy signals still improve freshness     | Google 2025              | Use sitemaps despite inaccuracy |
