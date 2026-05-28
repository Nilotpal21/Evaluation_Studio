# Crawl Together — 7-Iteration Deep Design Review

Each iteration questions a core assumption of the Crawl Together design (HLD, autonomy analysis, interaction tests), identifies specific problems, and proposes fixes.

---

## Iteration 1: Can the LLM ACTUALLY Be This Autonomous?

### The Assumption

The autonomy analysis claims Tier 1 decisions (navigation, dedup, error handling, inline extraction) can be made fully autonomously by the LLM with 85-95% confidence and zero user input. The Epson FAQ example assumes the LLM will correctly: (a) infer "FAQs of printers" maps to `/Support/Printers/sh/s1`, (b) identify 9 category tiles as the discovery mechanism, (c) recognize cascading dropdowns, (d) discover that FAQ answers are inline when categories are expanded, and (e) correctly choose not to visit 35,400 individual FAQ pages. This is presented as a single reconnaissance phase taking ~30 seconds.

### The Problem

LLMs do not reliably perform multi-step web page structure analysis. Specific failure modes:

1. **Navigation hallucination**: The LLM reads `get_page_content()` HTML and infers a CSS selector like `.faq-category:nth-child(1)`. But the actual DOM has dynamically generated class names (`._3xK2f`), data attributes (`data-testid="faq-section-0"`), or shadow DOM. The LLM guesses a selector that doesn't exist. `click_element()` fails silently or clicks the wrong element.

2. **Inline content misidentification**: The HLD's key optimization is "FAQ answers are inline when expanded." But what if the expanded category shows only question titles with "Read more" links? The LLM sees short text after expanding and assumes it has the full answer. It extracts truncated content for 21,000 FAQs. Nobody notices until users complain about incomplete answers.

3. **Navigation path inference failure**: "FAQs of printers" on epson.com could map to `/Support/Printers`, `/For-Home/Printers` (marketing), or `/epson.com/support` (different URL structure). The LLM picks the wrong starting URL, crawls marketing pages, and reports "Done. 19,800 FAQs extracted" when it actually extracted product descriptions.

4. **Category expansion side effects**: Expanding FAQ categories may trigger AJAX calls that load content lazily. The LLM calls `expand_all_and_extract('.faq-category')`, but the compound tool clicks all 12 categories in rapid succession. Only the first 3 finish loading before extraction runs. 75% of FAQs are missed silently.

5. **Deduplication false positives**: The LLM sees similar FAQ titles across products and deduplicates them. But "How to connect to WiFi" for the ET-2400 and ET-2800 have different steps. The `-shared` URL suffix is treated as canonical, but some "shared" FAQs have product-specific addenda that the LLM strips.

### Edge Cases

- **LLM extracts navigation chrome as content**: Breadcrumbs, sidebar links, footer text all get submitted to the pipeline as "FAQ content." The pipeline processes it. The knowledge base now contains "Home > Support > Printers > All-In-Ones" as an FAQ answer.
- **Login page misidentification**: A CAPTCHA or age verification page is not recognized as an auth gate. The LLM extracts CAPTCHA instructions as content. Or worse: it types random text into the CAPTCHA field because `type_text()` is available.
- **Wrong tab clicked**: The LLM clicks "Downloads" instead of "FAQs" because the tab selectors are ambiguous. It extracts driver download links as FAQ content. The 300-model iteration amplifies this error across the entire crawl.

### Proposed Fix

1. **Validation layer after every Tier 1 decision**: Before the LLM acts on an autonomous decision, it must verify the result. After navigating to what it thinks is the support page, it should call `get_page_state()` and verify the URL/title match expectations. After expanding categories, it should verify content appeared (word count > threshold, content looks like Q&A).

2. **Content quality gate in `submit_to_pipeline()`**: The MCP tool should reject submissions that look like navigation chrome, error pages, or truncated content. Minimum word count, no "Sign In", no "404", no breadcrumb-only content. Return an error to the LLM so it can re-evaluate.

3. **Spot-check sampling**: After the first 5 models, pause and show the user a sample of extracted content. "Here's what I'm getting from the first 5 printers. Does this look right?" This is a one-time Tier 3 check that prevents 295 models of garbage.

4. **Confidence decay on consecutive failures**: If `click_element()` fails 3 times in a row, the agent should not keep trying autonomously. Escalate to Tier 3 (ask user) after N consecutive tool failures.

5. **Add a `verify_extraction_quality(content)` compound tool** that checks extracted content against heuristics: is it Q&A shaped? Is it > 50 words? Does it contain common error page signatures?

### Impact on HLD

- Section 3.2 (Agent Configuration): System prompt needs "verify after every navigation" instruction.
- Section 3.4 (Autonomy Tiers): Add "Tier 1.5 — autonomous with self-verification" or add verification as mandatory post-condition for all Tier 1 actions.
- Section 3.5 (Real-World Flow): Add a "quality gate" step after Phase 1 reconnaissance and after first batch of Phase 3 execution.
- New compound tool needed: `verify_extraction_quality()`.
- `submit_to_pipeline()` needs content validation before publishing to BullMQ.

---

## Iteration 2: Is the Rule Book Schema Actually Replayable?

### The Assumption

The HLD states Mode 3 replays rules "mechanically" without LLM involvement. The `execute_rule_sequence(rules[])` tool takes saved rules and replays them. Rules like `{ trigger: { condition: 'element-present', selector: '.faq-category' }, action: { type: 'click-all', selector: '.faq-category-header' } }` are expected to work on future crawls of the same site. The confidence model (Wilson Score, applied/success counts) is supposed to detect when rules become unreliable.

### The Problem

CSS selectors are brittle. Websites redesign. Rule replay without intelligence is a recipe for silent data quality degradation.

1. **Selector rot**: Epson redesigns their support page. `.faq-category-header` becomes `.accordion-trigger`. The rule fires (trigger condition `element-present` for `.faq-category` still matches something on the page — maybe a different element), but the action selector `.faq-category-header` finds zero elements. `click-all` clicks nothing. The rule "succeeds" (no error thrown) but extracts zero FAQs. `successCount` increments because no exception occurred. Confidence stays high. Mode 3 keeps replaying a dead rule.

2. **Semantic shift**: Epson moves warranty info into the FAQ tab. The rule "extract inline Q&A content from FAQ tab" now extracts warranty terms as FAQs. The selectors still match. The pipeline processes it. The knowledge base silently fills with wrong content. Success metrics show 100% — the rule ran without errors.

3. **Layout changes break sequence ordering**: The rule sequence assumes: navigate → click FAQs tab → expand categories → extract. But if Epson changes to a single-page layout where FAQs are already visible (no tab click needed), the "click FAQs tab" rule clicks something else or fails silently, and the subsequent extraction rule reads the wrong content area.

4. **Path pattern mismatch**: Rules use `pathPattern: '/Support/*/s/SPT_*'`. Epson changes their URL structure to `/support/printers/spt-*` (lowercase, different pattern). Rules stop matching. No rules apply. The system falls through to Mode 1 with zero intelligence. The learning from the Mode 2 session is effectively lost.

5. **`repeat: -1` is dangerous**: The interaction rule for "click Load More until all products visible" has `repeat: -1` (infinite). If the "Load More" button is replaced with pagination links, the rule finds the selector, clicks forever (it matches a different `.load-more` element or the selector matches something else), and the replay loops until timeout.

### Edge Cases

- **A/B testing**: Epson serves different page layouts to different users/regions. The rule was learned on variant A. Mode 3 replays on variant B. Selectors match partially — some content extracted, some missed. No error, just inconsistent quality.
- **CDN caching**: The page HTML varies between CDN edges. The selector works on one edge but not another. Flaky rule success rate. Wilson Score oscillates.
- **Dynamic IDs**: React-generated class names change on every build (`._3xK2f` becomes `._7yM1p`). Rules with these selectors break immediately.

### Proposed Fix

1. **Content-based validation, not just selector-based execution**: After replaying a rule, verify the OUTPUT matches expectations. Store a content fingerprint (structure hash, expected word count range, content type) alongside the rule. If the extraction result diverges significantly from the fingerprint, mark the rule as "stale" and escalate to Mode 2.

2. **Dual-selector strategy**: Store both CSS selector AND content-based fallback. Primary: `.faq-category-header`. Fallback: `element containing text matching /^(Top FAQs|Cloud|Copy|Print)/i`. If primary selector fails, try fallback. This is more resilient to CSS changes while maintaining structural intent.

3. **Rule health checks**: Before replaying a full rule sequence, do a "dry run" on one page. Compare the extraction result against the stored content fingerprint. If it diverges > 30%, abort Mode 3 and escalate to Mode 2 with context: "Rules for epson.com appear stale. The page structure may have changed."

4. **Bounded repeat**: Never allow `repeat: -1`. Max repeat should be stored from the original session (e.g., "Load More was clicked 7 times to reveal 156 items" → `repeat: 8` with a safety margin). Add a `maxRepeat` field with a hard cap (e.g., 100).

5. **Rule versioning**: Store `siteVersion` (hash of page structure at rule creation time). On replay, compute current page structure hash. If different, flag rules as potentially stale. Don't silently replay.

6. **Staleness detection via `successRate` redefinition**: Currently, `successCount` increments when no exception occurs. Redefine: success = extracted content passes quality gate (non-empty, matches expected content type, word count in expected range). This requires `submit_to_pipeline()` to return quality metrics.

### Impact on HLD

- Section 4.2 (Rule Book Schema): Add `contentFingerprint`, `fallbackSelector`, `maxRepeat`, `siteVersionHash` fields to `ICrawlRule`.
- Section 4.4 (Implicit Mode Selection): Add "dry run health check" before Mode 3 replay. Mode 3 should not be fully silent — it should validate before committing.
- Section 7 (Task Decomposition): Add a task for "rule health check service" that periodically validates stored rules against live sites.
- New MCP tool: `validate_rule_health(rules[], sampleUrl)` that does a single-page dry run.

---

## Iteration 3: Does the Compound MCP Tool Approach Actually Work?

### The Assumption

The HLD proposes compound tools (`expand_all_and_extract(selector)`, `iterate_dropdown_options(selector)`, `click_tabs_and_extract(tabSelector)`) that reduce LLM calls from 15 to 1-2 per page. These tools are presented as generic enough to work on any site while being specific enough to handle the Epson FAQ pattern. The cost math (900 LLM calls instead of 4,500) depends entirely on these compound tools working correctly.

### The Problem

Compound tools push LLM-level intelligence into deterministic code — but the intelligence is what makes it work.

1. **`expand_all_and_extract('.faq-category')` — what does "extract" mean?** The tool clicks all elements matching `.faq-category`. Content appears. But WHAT content does it extract? The full `innerText` of the page? Just the newly-appeared content? How does it know which DOM subtree contains the expanded content vs. the rest of the page? On Epson, the expanded FAQ answers are siblings of the category headers. On another site, expanded content might be in a modal, an iframe, or a lazy-loaded div with a completely different DOM relationship.

2. **Timing is site-specific**: `expand_all_and_extract` clicks 12 categories. Each triggers an animation or AJAX load. How long does the tool wait between clicks? After the last click? Epson's FAQ categories expand in ~200ms (CSS animation). Another site's categories load via API call taking 2 seconds. A hardcoded wait time either wastes time (too long) or misses content (too short). The LLM would adaptively wait — the compound tool cannot.

3. **Nested expandables**: The tool expands `.faq-category` elements. But what if each category contains sub-categories that also need expanding? The compound tool handles one level. The LLM would see "there are still collapsed sections" and keep expanding. A compound tool needs to be told the nesting depth upfront — which the LLM doesn't know until it sees the page.

4. **`iterate_dropdown_options(selector)` fails on dependent dropdowns**: Epson has Category → Series → Model (3 dependent dropdowns). Selecting a category populates the series dropdown. Selecting a series populates the model dropdown. `iterate_dropdown_options('.category-dropdown')` iterates categories, but after each selection, the series dropdown needs to be iterated, and for each series, the model dropdown. This is a tree traversal, not a flat iteration. The compound tool as described handles one dropdown, not cascading dependencies.

5. **Error handling in compound tools is opaque**: If `expand_all_and_extract` clicks 8 of 12 categories successfully and fails on 4, what does it return? All content from 8? An error? A partial result? The LLM wouldn't know 4 categories were missed. With primitive tools, the LLM sees each failure and can decide to retry or skip. Compound tools hide failure behind a single response.

6. **The tools aren't actually generic**: `extract_page_structure()` is supposed to return `{ tabs, expandableSections, forms, links, pagination, contentAreas }`. But how does it identify these? By hardcoded CSS selectors? (`role="tablist"`, `.accordion`, `form`, `a[href]`, `.pagination`)? Every site uses different markup. Without LLM-level understanding of page semantics, this tool returns whatever its heuristics catch — which may be nothing on a site that uses custom web components.

### Edge Cases

- **Shadow DOM**: Web components with shadow roots are invisible to `document.querySelectorAll()`. Compound tools that iterate DOM elements miss entire content sections. Epson may use Lit or Stencil web components for their FAQ accordion.
- **Infinite scroll inside expanded section**: Expanding a category reveals 10 FAQs with a "Show more" button inside the category. The compound tool extracted 10 FAQs, not the full 30. The LLM would notice the "Show more" and click it.
- **Content behind consent**: Expanding a section triggers a "This content uses cookies" sub-consent. The compound tool sees the consent dialog as "content" and extracts it.

### Proposed Fix

1. **Compound tools should be LLM-guided, not fully autonomous**: Instead of `expand_all_and_extract(selector)`, use `expand_all(selector, { waitBetween: 500, maxWait: 3000 })` that clicks and waits, then let the LLM call `get_page_content()` to decide what to extract. Split the "expand" from the "extract." This keeps the LLM call reduction (~3 calls instead of 15) while preserving LLM judgment for extraction.

2. **Add `waitStrategy` parameter**: `expand_all(selector, { waitStrategy: 'networkIdle' | 'domStable' | 'fixedDelay' })`. `networkIdle` waits until no network requests for 500ms (good for AJAX). `domStable` waits until DOM stops mutating (good for animations). `fixedDelay` uses a specified delay (fallback).

3. **Return structured results with failure details**: `expand_all()` should return `{ expanded: 8, failed: 4, failedSelectors: [...], contentLength: 12500 }` so the LLM can decide whether to retry failed sections.

4. **`iterate_cascading_dropdowns(selectors[])`**: Instead of single-dropdown iteration, support cascading: `iterate_cascading_dropdowns(['.category', '.series', '.model'], { collectAtLevel: 2 })`. Each level selection triggers population of the next. Collect results at the specified level.

5. **`extract_page_structure()` should use heuristics + screenshots**: Instead of pure DOM analysis, take a screenshot and use the LLM's vision capability to identify page structure. This is 1 LLM call but gives much better structural understanding than CSS heuristics. Alternatively, use ARIA roles and semantic HTML as primary signals with heuristic fallbacks.

6. **Compound tools are a library, not a requirement**: The agent should decide whether to use compound tools or primitives based on page complexity. Simple FAQ page → compound. Complex SPA with dynamic content → primitives. The system prompt should say "Try compound tools first. If the result is incomplete or unexpected, fall back to primitives."

### Impact on HLD

- Section 3.2 (Tools — Layer 2): Redesign compound tools. Split `expand_all_and_extract` into `expand_all` + LLM-driven extraction. Add `waitStrategy` and structured error returns. Add `iterate_cascading_dropdowns`.
- Section 3.6 (Cost Math): Revise estimates. With split expand/extract: ~3 LLM calls per page instead of 1-2. Still much better than 15, but the "1 tool call" claim is unrealistic. Revised: ~1,200 LLM calls for Epson (not 900).
- Section 3.2 (System Prompt): Add "use compound tools for straightforward pages, fall back to primitives for complex pages."

---

## Iteration 4: What About the LLM Context Window Problem?

### The Assumption

The design assumes the LLM can process page content and maintain reasoning context across 300 product pages over ~2 hours. `get_page_content()` returns full HTML + innerText. The LLM reads this, decides what to extract, and continues to the next page. The autonomy analysis shows a simple loop: navigate → extract → submit → next.

### The Problem

Context window management is never addressed in the HLD. This is a critical gap.

1. **Single page content size**: A typical Epson support page with 12 FAQ categories expanded could be 50-100KB of HTML and 20-40KB of text. At ~4 chars/token, that's 5,000-10,000 tokens per page just for the content. Add system prompt (~2,000 tokens), tool definitions (~3,000 tokens for 20+ tools), conversation history, and the LLM is at 15,000-20,000 tokens per page.

2. **Conversation history accumulation**: The runtime reasoning loop maintains conversation history. After 50 pages, the history includes 50 tool calls and 50 responses. Even with compact representations, that's 100,000+ tokens of history. Claude's 200K context or GPT-4o's 128K context fills up. The LLM starts losing early context — including the system prompt instructions about autonomy tiers and the user's original intent.

3. **Pattern recognition requires memory**: The LLM is supposed to discover patterns like "40% of FAQs are shared." But if each page's content is processed in isolation (to save context), the LLM can't compare across pages. If all pages are kept in context, the window overflows. The autonomy analysis assumes the LLM has persistent memory of all pages it's visited — it doesn't.

4. **The deduplication set**: The design says "Track seen FAQ IDs for deduplication" as an in-session `Set<string>`. But this set lives where? If it's in the LLM's context, it grows with every page. 21,000 FAQ IDs at ~30 chars each = 630K chars = ~157K tokens. That's an entire context window just for the dedup set. If it's in the MCP server, the LLM needs a tool to check "have I seen this FAQ before?" — adding another LLM call per FAQ.

5. **Model choice conflict**: The HLD suggests "fast model for navigation reasoning (e.g., Claude Haiku, GPT-4o-mini)." Fast models have smaller context windows (Haiku: 200K, GPT-4o-mini: 128K). With 20 tools and their schemas consuming ~3K tokens, system prompt consuming ~2K tokens, and page content consuming ~10K tokens, you have ~113K tokens for conversation history with GPT-4o-mini. At ~2K tokens per round trip (tool call + result), that's ~56 pages before context overflow. The Epson crawl has 300 pages.

### Edge Cases

- **Context window exceeded mid-page**: The LLM is on page 57, processing a particularly large FAQ page. The context overflows. The runtime truncates old messages. The LLM loses track of which categories it already expanded. It re-expands, re-extracts, submits duplicates.
- **System prompt truncated**: With aggressive history, the system prompt (including autonomy tier instructions) gets pushed out of context. The LLM reverts to default behavior — starts asking the user every question. The autonomy model collapses.
- **Pattern discovery window**: The LLM discovers the "shared FAQ" pattern on page 3. By page 60, that discovery message has been truncated. The LLM "forgets" the pattern and starts extracting duplicates again.

### Proposed Fix

1. **Sliding window with summarization**: After every N pages (e.g., 10), summarize the conversation history into a compact state: "Processed 10/300 models. 1,200 FAQs extracted. 40% dedup rate. Pattern: expand all categories, extract inline. No errors." Replace the last 10 pages of history with this summary. The LLM gets: system prompt + summary + last 3 pages of history.

2. **External state via MCP tools**: Move ALL stateful tracking out of the LLM context:
   - `check_dedup(faqId)` → MCP server maintains the Set, returns boolean
   - `get_crawl_progress()` → MCP server returns current stats
   - `get_active_rules()` → MCP server returns rules discovered so far
   - `get_crawl_plan()` → MCP server returns the navigation plan (which models remain)

   The LLM only needs current-page context + a summary of what's been done. All state is in the MCP server.

3. **Page content preprocessing**: `get_page_content()` should NOT return raw HTML. It should return a **structured, token-efficient representation**: `{ title, url, sections: [{ heading, type: 'faq'|'nav'|'content', text, links }] }`. This could be 2-3K tokens instead of 10-20K. The MCP server does the HTML parsing, not the LLM.

4. **Batch execution mode**: Instead of the LLM individually processing 300 pages, have it process 1 page to learn the pattern, then emit a "batch instruction" that the MCP server executes mechanically for the remaining 299 pages. This is essentially creating a Mode 3 rule mid-session. The LLM only re-engages when the batch hits an anomaly.

5. **Session segmentation**: Break the 2-hour crawl into segments. Each segment is a fresh LLM session with a brief context summary from the previous segment. This prevents context degradation while maintaining continuity.

### Impact on HLD

- Section 3.2 (Tools): Add external state tools (`check_dedup`, `get_crawl_progress`, `get_crawl_plan`). Modify `get_page_content()` to return structured, token-efficient content.
- Section 3.5 (Real-World Flow): Add context management between Phase 3 iterations. After every N pages, compress context.
- Section 8 (Scaling Challenges): Add "8.9 LLM Context Window Management" as a critical challenge.
- New concept: "Batch execution mode" — LLM learns pattern on first page, emits batch instruction, MCP server executes mechanically, LLM re-engages on anomalies. This bridges Mode 2 and Mode 3 within a single session.

---

## Iteration 5: Is the Implicit Mode 3 Selection Actually Safe?

### The Assumption

Section 4.4 of the HLD describes implicit mode selection: "confidence >= 80% AND success rate >= 90% → replay rules silently (no LLM, no user)." The user never picks a mode. The system decides. Mode 3 replay is presented as risk-free because Wilson Score prevents overconfidence from small samples.

### The Problem

The system has no way to detect when correct rules become wrong rules. Silent replay without validation is a data quality time bomb.

1. **Rule correctness is time-dependent**: A rule "skip `/premium/*` (paywall)" was correct when learned. Six months later, Epson reorganizes and moves printer specs to `/premium/specs/`. The rule silently skips ALL printer specs. Mode 3 replays this rule. No LLM to notice. No user to notice. The knowledge base silently loses an entire content section. Data quality degrades for months before someone notices.

2. **Success rate is a lagging indicator**: The rule replays 10 times successfully (selectors match, content extracted). On the 11th, the site changes. But by then, the success rate is 90.9% (10/11) — still above the 90% threshold. It takes many failures to pull the rate below 90%, and during that time, every replay produces garbage.

3. **Wilson Score doesn't detect semantic failure**: Wilson Score measures "did the rule execute without errors." It doesn't measure "did the rule extract the RIGHT content." A selector `.faq-content` might still exist on the redesigned page, but now it contains a product recommendation widget instead of FAQ answers. The rule "succeeds." Wilson Score stays high. Content is wrong.

4. **No human in the loop for Mode 3 by design**: The entire point of Mode 3 is "no LLM, no user." But this means there's nobody to catch drift. The HLD says "If Mode 3 replay FAILS → escalate to Mode 2." But "fails" means an exception was thrown. If the rule runs without errors but produces bad content, there's no escalation trigger.

5. **Cross-tenant rule contamination**: Rules are tenant-scoped, but what if two tenants crawl the same domain? Tenant A's rules for `docs.example.com` might conflict with Tenant B's needs. The HLD doesn't address rule isolation beyond `tenantId` — but the implicit mode selection could theoretically apply Tenant A's rules to Tenant A's re-crawl even when those rules were learned against a now-changed site.

### Edge Cases

- **Gradual site migration**: Epson migrates pages incrementally. Week 1: 10% of pages have new layout. Rules work on 90% — success rate stays high. Week 4: 50% have new layout. Success rate drops to 50%, but it took 3 weeks of bad data to get there.
- **Seasonal content changes**: Support pages add holiday-specific banners and promotional sections. Rules that skip "marketing content" now skip legitimate seasonal FAQ entries about gift-related support.
- **Rule conflict escalation**: Two rules match the same page: "extract from `.faq-content`" (learned in January) and "skip `.faq-content` because it contains marketing" (learned in March when Epson added promos). The "latest wins" tiebreaker is fragile and depends on `createdAt` comparison.

### Proposed Fix

1. **Content fingerprint validation on every Mode 3 replay**: Store a representative content fingerprint (structure hash, word count distribution, key terms) from the Mode 2 session. On Mode 3 replay, compare extracted content against the fingerprint. If divergence > 30%, pause the replay and escalate. This catches semantic drift, not just selector failure.

2. **Periodic "canary" validation**: Schedule a monthly LLM-powered validation of Mode 3 rules. The LLM visits one page per domain, extracts content using rules, and also extracts content from scratch. Compare results. If they diverge significantly, flag rules as stale. Cost: minimal (one LLM call per domain per month).

3. **Confidence decay over time**: Rules lose confidence if not re-validated. A rule at 90% confidence that hasn't been validated in 30 days drops to 80%. After 60 days: 70%. This forces periodic re-validation and prevents stale rules from staying in Mode 3 indefinitely. The `lastAppliedAt` and `expiresAt` fields already exist in the schema — use them.

4. **Redefine success**: `successCount` should only increment when extracted content passes a quality gate: non-empty, content type matches expected type, word count in expected range, no error page signatures. Add a `qualityScore` field to each replay outcome. Wilson Score operates on quality-weighted success, not just "no exception."

5. **Staged rollout for Mode 3**: Don't apply Mode 3 silently to the entire crawl. Apply it to 10% of pages first. Compare Mode 3 results against a few Mode 2 (LLM-verified) samples. Only proceed with full Mode 3 if the sample validates. This adds ~5 LLM calls per crawl but prevents full-crawl data corruption.

6. **Rule expiration as a first-class concept**: Rules should have a default TTL (e.g., 90 days for `crawl-together` source, 365 days for `admin` source). Expired rules revert to Mode 1, forcing re-discovery. The `expiresAt` field exists but has no default — it should.

### Impact on HLD

- Section 4.2 (Rule Book Schema): Add `contentFingerprint`, `qualityThreshold`, default `expiresAt` (90 days).
- Section 4.4 (Implicit Mode Selection): Add content validation step. Change from "confidence >= 80% AND success rate >= 90%" to "confidence >= 80% AND quality-weighted success rate >= 90% AND lastValidatedAt < 30 days."
- Section 7 (Task Decomposition): Add task for "canary validation service."
- Section 13 (Risk Register): Upgrade "Rule book schema too rigid" to HIGH risk. Add "Silent data quality degradation from stale Mode 3 rules" as a new HIGH risk.

---

## Iteration 6: How Does the Cost Model ACTUALLY Work for Real Users?

### The Assumption

The autonomy analysis estimates ~$9 for a full Epson FAQ crawl (903 LLM calls at $0.01/call). The over-asking model is $710-$1,000. The cost savings (117x fewer LLM calls) depend on: (a) compound tools reducing calls to ~3 per page, (b) inline FAQ extraction reducing page loads to 300, (c) zero user interaction overhead, and (d) no retries or error recovery. The user has no cost visibility before starting.

### The Problem

The $9 estimate is a best-case scenario that ignores real-world LLM usage patterns. Users have no way to predict, monitor, or cap costs.

1. **Token costs, not call costs**: The estimate uses "$0.01/call" as a flat rate. Real LLM pricing is per-token. A single `get_page_content()` response with 10K tokens of HTML at GPT-4o input pricing ($2.50/1M tokens) = $0.025 per page just for INPUT. Add output tokens for reasoning (~500 tokens at $10/1M = $0.005). Per page: ~$0.03. Across 300 pages with 3 calls each: ~$27, not $9. With Claude Haiku input at $0.25/1M: ~$3.75. The actual cost depends heavily on model choice and page size, not "calls."

2. **Retry amplification**: The happy-path estimate assumes zero retries. Real crawls hit: rate limits (429 → wait → retry), timeouts (→ retry with JS disabled), stale DOM (→ refresh → retry), wrong selector (→ try alternative → retry). Each retry is another LLM call with full context. A 20% retry rate on 900 calls = 180 additional calls. But retries often require re-sending the full page content, so they're more expensive than first attempts.

3. **Error recovery loops**: The autonomy analysis says "500 → retry once, then skip." But what if 50 out of 300 pages return 500? That's 50 retries + 50 skips. The LLM needs to reason about each: "Should I retry? Is this a pattern? Should I slow down? Should I alert the user?" Each reasoning step is an LLM call. Error recovery on flaky sites can 2-3x the LLM calls.

4. **Reconnaissance is not free**: Phase 1 (Reconnaissance) is described as "~30 seconds." But the LLM navigates to the support page, calls `get_page_content()` (10K tokens), reasons about structure, calls `extract_page_structure()`, iterates 9 tiles, opens 9 dropdowns. That's easily 20-30 LLM calls for reconnaissance alone. The "~3 LLM calls" in the scale confirmation is vastly underestimated.

5. **No cost cap mechanism**: There is no way for a user to say "don't spend more than $20." There's no real-time cost tracking. There's no "you've spent $15, continue?" checkpoint. A crawl that hits errors on every page could run up costs before anyone notices.

6. **Model cost variance**: The HLD says "fast model for navigation reasoning" but doesn't specify. Claude Haiku at $0.25/$1.25 per 1M tokens vs GPT-4o at $2.50/$10 per 1M tokens is a 10x cost difference. The user doesn't choose the model — the system does. This makes cost prediction impossible.

### Edge Cases

- **Context window overflow → fresh session → re-send system prompt and tools**: If the conversation exceeds context limits and requires a new session with summarized context, the system prompt (~2K tokens) and tool definitions (~3K tokens) are re-sent. Over a 300-page crawl with 5 session resets, that's 25K extra input tokens.
- **Large pages blow up costs**: A page with 500 FAQ entries expanded inline could be 200K tokens. One `get_page_content()` call on that page costs $0.50 with GPT-4o. The user doesn't know this page exists until the crawl is already running.
- **Compound tool fallback**: If compound tools fail and the LLM falls back to primitives, the cost jumps from 3 calls/page to 15 calls/page. For the remaining 250 pages: 3,750 calls instead of 750. Cost triples unexpectedly.

### Proposed Fix

1. **Token-based cost estimation, not call-based**: Before the crawl starts, estimate costs based on: (a) sampled page sizes (average tokens per page from reconnaissance), (b) model pricing, (c) estimated calls per page (3 for compound, 10 for primitive), (d) retry budget (20% overhead). Present this to the user as a range: "Estimated cost: $15-$45 depending on page complexity and errors."

2. **Real-time cost tracking in `report_crawl_progress()`**: Track cumulative token usage and cost. The periodic Tier 2 notifications should include: "Progress: 75/300 models. 5,200 FAQs. Tokens used: 450K input, 120K output. Cost so far: ~$8."

3. **Cost cap with automatic pause**: Allow users to set a cost cap before starting. When 80% of the cap is reached, pause and ask: "Approaching your $20 budget. 200/300 pages done. Continue or stop?" This is a Tier 3 decision that overrides autonomy.

4. **Model selection transparency**: Show the user which model will be used and its pricing. Allow overriding: "Using Claude Haiku (~$4 for this crawl) or GPT-4o (~$30 for better accuracy)?"

5. **Progressive cost refinement**: After Phase 1 (reconnaissance) and the first 5 pages of Phase 3 (execution), recalculate the cost estimate with real data. "Updated estimate: $22 (up from initial $15 — pages are larger than expected)."

6. **Batch execution as cost control**: The "batch execution mode" from Iteration 4 (LLM learns pattern on first page, MCP server executes mechanically) eliminates LLM calls for the mechanical portion. Only anomalies trigger LLM calls. This could reduce costs by 80% compared to the per-page LLM loop.

### Impact on HLD

- Section 3.5 (Real-World Flow): Add cost estimation after Phase 1 and cost tracking during Phase 3. Add cost cap as a Tier 3 decision.
- Section 3.6 (Cost Math): Rewrite entirely. Use token-based estimates with ranges. Acknowledge retry overhead. Provide per-model pricing comparison.
- Section 8.7 (LLM Cost): Expand with real pricing analysis, not flat "$0.01/call."
- New field in `report_crawl_progress()`: `{ tokensUsed: { input, output }, estimatedCost, costCap }`.
- Studio UI: Add cost display in CrawlTogetherPanel alongside progress.

---

## Iteration 7: Is the Runtime Agent Model Correct for Long-Running Crawls?

### The Assumption

The HLD states "Crawl Together = a specialized agent that uses MCP crawler tools and talks to the user." It runs on the ABL Runtime via the existing `load_agent` → `send_message` WebSocket flow. The runtime's reasoning loop (LLM → tool calls → results → LLM → repeat) drives the crawl. Sessions persist in Redis/MongoDB. The HLD acknowledges the session timeout issue (Section 8.8: "Runtime session timeout is 30 min. Need session extension or background execution pattern") but doesn't solve it.

### The Problem

The ABL Runtime was designed for conversational agents that respond in seconds. Crawl Together sessions run for hours. The execution model is fundamentally mismatched.

1. **Session timeout**: `apps/runtime/src/services/session-cleanup-job.ts` marks sessions as ended after an idle timeout. The MCP server's `sessionTimeout` is 30 minutes (`apps/crawler-mcp-server/src/server.ts:48`). During autonomous Phase 3, the user is idle (they confirmed scope and walked away). After 30 minutes of no user messages, the session expires. The runtime's cleanup job marks it as ended. The crawl dies at page 50 of 300.

2. **WebSocket disconnection**: The user closes their laptop, loses WiFi, or closes the browser tab. The WS connection drops. The runtime detects the disconnect and stops the reasoning loop (it's waiting for a WebSocket to stream responses to). The crawl stops. All progress since the last `submit_to_pipeline()` is lost. When the user reconnects, they see "Session expired."

3. **Pod restart during crawl**: The runtime runs on Kubernetes. A pod restart (deploy, OOM kill, spot instance reclaim) kills the in-flight reasoning loop. The runtime's session data is in Redis/MongoDB, but the EXECUTION STATE is not. Which page was being processed? Which categories were expanded? Which FAQ IDs were already seen (the dedup Set)? The session can be "resumed" but the agent starts from scratch — it doesn't know where it left off.

4. **Reasoning loop is synchronous**: The runtime's reasoning executor (`reasoning-executor.ts:284`) runs as: receive message → LLM call → tool call → result → LLM call → repeat. This is a synchronous loop tied to a single user session. It blocks one LLM "slot" for the entire 2-hour crawl. If 10 users start Crawl Together sessions, that's 10 concurrent reasoning loops, each holding an LLM connection for hours. The runtime wasn't designed for this load pattern.

5. **No checkpoint/resume**: There's no mechanism to save execution state mid-crawl and resume later. If the crawl fails at page 150, restarting means re-crawling pages 1-149 (the pipeline deduplicates, but the LLM calls are wasted). The `submit_to_pipeline()` calls are durable (BullMQ), but the crawl orchestration state (which pages remain, which rules are learned) is ephemeral.

6. **User can't "come back later"**: The design shows the user confirming scope and then the agent working for 2 hours with periodic notifications. But the runtime expects the user to be connected. There's no "I'll check back in an hour" flow. No email/push notification on completion. No background job that the user can monitor from a dashboard.

7. **Heartbeat conflict**: The runtime uses WebSocket heartbeats to detect dead sessions. During autonomous execution, the agent generates tool calls (which create WS traffic), but between complex pages, there might be 30+ seconds of pure MCP server work (browser loading, expanding, extracting) with no WS messages. The heartbeat timer might expire.

### Edge Cases

- **2-hour crawl, user gone, pod restart at 1h45m**: 262 pages crawled. Pod restarts. Session data in Redis. Agent reloads. But: which page was it on? The dedup Set of 18,000 FAQ IDs is gone (it was in LLM context or MCP server memory). The agent starts from page 1. Extracts 18,000 duplicates. Pipeline deduplicates some, but the LLM cost doubles.
- **Concurrent crawl sessions exhaust LLM rate limits**: 5 users each run 2-hour crawls. Each makes ~3 LLM calls/minute. That's 15 calls/minute sustained for 2 hours. LLM provider rate limits (e.g., 60 RPM for GPT-4o) are hit. All 5 crawls slow to a crawl. Queue of LLM requests backs up.
- **MCP server session timeout vs runtime session**: The MCP server browser session times out at 30 minutes. The runtime session might be extended, but the browser is gone. The agent tries to call `get_page_content()` and gets "session not found" from the MCP server. The crawl fails with an opaque tool error.

### Proposed Fix

1. **Hybrid execution model — "Crawl Job" with agent supervision**:
   - User starts Crawl Together → runtime agent does reconnaissance + user interaction (Phase 1-2) via the normal WS flow.
   - After user confirms scope, the agent emits a **Crawl Job** to BullMQ with: the learned rules, the page list, the execution plan.
   - A **dedicated crawl worker** (new, long-running, not the runtime) executes the plan mechanically using rules + MCP tools. No LLM needed for the mechanical part.
   - The worker reports progress to the same crawl progress WS channel.
   - If the worker encounters an anomaly (selector fails, unexpected page structure, new auth gate), it **pauses the job** and escalates back to the runtime agent: "I'm stuck on page 157. The FAQ tab isn't where expected."
   - The user gets a notification (WS if connected, or queued message for reconnect): "Crawl needs your attention."
   - The runtime agent resumes the conversation, resolves the issue, updates the rules, and the worker continues.

   This is the background worker pattern. The runtime handles the intelligence. The worker handles the execution. The user can disconnect.

2. **Checkpoint state in Redis**: After every page, save execution state: `{ currentIndex: 157, totalPages: 300, deduplicatedIds: [...], learnedRules: [...], errors: [...] }`. On restart, resume from checkpoint. This is critical regardless of whether we use the hybrid model.

3. **MCP server session extension**: The MCP server's `sessionTimeout` should be configurable per session. Crawl Together sessions set `sessionTimeout: 4 * 60 * 60 * 1000` (4 hours). Add a `keepAlive()` tool that the agent/worker calls periodically.

4. **Disconnect-resilient execution**: When the WS disconnects during autonomous Phase 3, DON'T stop the crawl. Keep the reasoning loop running (it's making tool calls, not waiting for user input). Queue any Tier 2 notifications for when the user reconnects. Only stop if a Tier 3 decision is needed and the user is gone for > 5 minutes.

5. **Rate limit pooling**: All Crawl Together sessions share an LLM rate limit pool. If 5 sessions are active, each gets 1/5 of the rate limit. Sessions are prioritized by: user-is-connected > user-disconnected > near-completion.

6. **Completion notification**: When a crawl finishes (or needs attention), persist the final report in MongoDB. When the user next opens Studio, show "Your Epson crawl completed: 19,800 FAQs extracted." Don't rely on WS for delivery.

### Impact on HLD

- Section 3.1 (Architecture): Major change. Add a "Crawl Worker" service between the runtime and MCP server. The runtime is for intelligence/interaction. The worker is for execution.
- Section 3.2 (Agent Configuration): Split into "interactive agent" (reconnaissance, user interaction) and "execution plan" (emitted to worker).
- Section 6.3 (Runtime Capabilities): Change "Cannot Do: Long-running agent sessions" to "Mitigated: Hybrid model — runtime for interaction, worker for execution."
- Section 7 (Task Decomposition): Add tasks for: Crawl Worker service, checkpoint/resume, disconnect-resilient execution.
- Section 8.8 (Long-Running Sessions): Rewrite from "Need session extension" to the full hybrid execution model.
- Section 13 (Risk Register): Add "Runtime reasoning loop not designed for hours-long execution" as HIGH risk. The hybrid model mitigates it.

---

## Cross-Cutting Findings

Several problems appear across multiple iterations and deserve architectural attention:

### Finding 1: Content Quality Validation is Missing Everywhere

Iterations 1, 2, and 5 all identify the same gap: there is no mechanism to verify that extracted content is actually correct. The pipeline processes whatever `submit_to_pipeline()` sends. The confidence model measures execution success, not content quality. A content quality gate is needed at the MCP tool level, the pipeline level, and the Mode 3 replay level.

### Finding 2: The "Zero LLM" Mode 3 Promise is Premature

Iterations 2, 5, and 7 all question whether Mode 3 can safely operate without ANY intelligence. The proposed fix across all three iterations converges on: Mode 3 needs periodic LLM-assisted validation, not zero LLM. The cost savings are still massive (1 LLM call per 50 pages for canary validation vs 3 per page for full Mode 2), but "zero LLM" is unsafe.

### Finding 3: External State Management is a Prerequisite

Iterations 4 and 7 both identify that crawl state (dedup set, progress, learned rules, execution plan) cannot live in the LLM context or in-process memory. It must be in Redis/MongoDB with checkpoint/resume capability. This is a foundational infrastructure requirement that should be addressed before any compound tool or autonomy work.

### Finding 4: Cost Estimation Needs a Complete Redesign

Iteration 6 shows the current cost model is unrealistic. But the fix (token-based estimation, real-time tracking, cost caps) depends on knowing which model is used, how large pages are, and how many retries occur — all of which are unknowable until after reconnaissance. The cost model should be explicitly iterative: rough estimate before start → refined estimate after reconnaissance → real-time tracking during execution → final report.
