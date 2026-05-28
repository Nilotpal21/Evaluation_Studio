# Crawl Together — 10-Iteration Design Review (v3)

Review of the COMPLETE HLD: 10 fundamental problems, 7-phase execution model,
batch+fork scaling, cloud/on-prem deployment, 9 research tasks, 5 POC tasks,
PageHandler model, CrawlIntelligenceService, CrawlOrchestrator.

Each iteration: (1) question the assumption, (2) find the problem, (3) counter
with prior learnings and codebase evidence, (4) net assessment + action.

---

## Iteration 1: Is the 7-Phase Model Over-Engineered?

### The Assumption

The HLD evolved from 5 phases to 7 (added Phase 3.5 PARTITION and Phase 4.5
AGGREGATE). Every crawl, even a 10-page one, goes through: MAP → UNDERSTAND →
SAMPLE+BUILD → APPROVE → PARTITION → EXECUTE → AGGREGATE → REPAIR.

### The Problem

1. **Small crawls are over-processed.** User crawls a 10-page documentation site.
   Phase 0 fetches sitemap (2 seconds). Phase 1 opens sample page (5 seconds).
   Phase 2 builds handler from 3 samples (2 minutes). Phase 3 asks approval
   (user wait). Phase 3.5 creates a FlowProducer flow with 1 batch of 10 URLs.
   Phase 4 processes 10 URLs (80 seconds). Phase 4.5 aggregates 1 batch.
   **Total overhead: ~3 minutes of setup for 80 seconds of work.**

2. **Phase count is a complexity tax.** 7 phases = 7 state transitions, 7 error
   handling paths, 7 progress reporting formats. Each phase has entry conditions,
   exit conditions, and failure modes. The CrawlIntelligenceService becomes a
   complex state machine.

3. **Not all phases are needed for all crawl sizes.** A 50-page crawl doesn't
   need PARTITION (no batching needed). A site with one page type doesn't need
   diverse sampling. A re-crawl with existing handlers doesn't need UNDERSTAND.

### Counter (Prior Learnings)

From external research: Firecrawl's pipeline is also multi-phase (map → scrape →
extract) but phases are optional. Small crawls skip the map phase entirely.

**The fix is phase elision, not phase removal.** The 7-phase model is the COMPLETE
model for enterprise scale. For small crawls, phases are skipped:

```
< 50 URLs:  Skip Phase 3.5 (PARTITION) → single batch, no FlowProducer
< 10 URLs:  Skip Phase 2 (SAMPLE) → handler from Phase 1 sample only
Mode 3:     Skip Phases 0-3 → load existing handlers, go straight to PARTITION/EXECUTE
Re-crawl:   Skip Phase 1-2 → reuse handlers, validate fingerprint in Phase 4
```

The CrawlIntelligenceService has a `planExecution()` method that examines the
input (URL count, existing handlers, handler confidence) and decides which phases
to run. This is a planning step, not a new phase.

### Net Assessment

**The 7-phase model is correct for completeness but needs phase elision.** Small
crawls run 3-4 phases (MAP → UNDERSTAND → EXECUTE → REPAIR). Enterprise crawls
run all 7. Mode 3 replays run 2-3 phases (PARTITION → EXECUTE → REPAIR).

**Action:** Add `planExecution()` to CrawlIntelligenceService that returns a
`CrawlPlan` with `phasesToRun: Phase[]`. Document phase elision rules in the HLD.

---

## Iteration 2: What Happens When the LLM Generates Conflicting PageHandlers?

### The Assumption

Phase 2 builds PageHandlers from 3 diverse sample pages. If pages have different
structures, multiple handlers are created (one per page type). The Crawl Worker
selects the right handler by URL pattern match.

### The Problem

1. **URL pattern overlap.** Two handlers with overlapping patterns:
   - Handler A: `/Support/Printers/*/s/SPT_*` (FAQ accordion, 296 pages)
   - Handler B: `/Support/Printers/*/s/SPT_*` (new-style tabs, 2 pages)
     Same URL pattern, different page structure. Which handler runs?

2. **Handler generated from wrong sample.** Phase 2 picks 3 samples. Two are
   old-style accordion, one is new-style tabs. The LLM generates handler from
   the majority (accordion). The 2 new-style pages get the wrong handler and
   fail. But Phase 2 didn't know there were only 2 new-style pages.

3. **Handler evolution.** Site updates its layout. Old handler works on 290 pages,
   fails on 8 newly redesigned pages. Two handlers exist for the same pattern.
   Which is "active"? Do we version handlers?

### Counter (Prior Learnings)

From v2 Iteration 6 (bad PageHandler risk): The fingerprint validation catches
mismatches. If Handler A is applied to a page with a different structure, the
fingerprint check fails, and the page is flagged as anomaly for Phase 5 repair.

**For problem 1 (pattern overlap):** The system should NOT use URL patterns alone.
Use URL pattern + fingerprint match. When executing:

1. Match URL to candidate handlers by pattern
2. If multiple match: capture page fingerprint, compare to each handler's fingerprint
3. Select handler with highest fingerprint similarity
4. If no good match: flag as anomaly for Phase 5

**For problem 2 (wrong sample):** Phase 5 (REPAIR) handles this. The 2 failed pages
are anomalies. The LLM investigates, discovers a different page structure, creates
Handler B. Next crawl: both handlers exist, fingerprint-based selection picks correctly.

**For problem 3 (evolution):** Handler versioning. Each handler has `version: number`.
New handlers for the same domain+pattern are a new version. Old versions stay active
until the new version reaches ≥80% confidence. Rollback if new version fails.

### Net Assessment

**Handler selection by fingerprint (not just URL pattern) is essential.** This is
a missing detail in the HLD. The URL pattern is a fast pre-filter, the fingerprint
is the accurate selector.

**Action:** Add handler selection algorithm to HLD: URL pattern pre-filter →
fingerprint comparison → best match. Add handler versioning with rollback capability.

---

## Iteration 3: Is the Research Task List Realistic?

### The Assumption

The HLD lists 9 research tasks totaling ~15-20 days. These must complete BEFORE
implementation begins. The critical path is R-1 + R-3 → POC-1 → POC-3 = 8-10 days.

### The Problem

1. **Sequential blocking.** R-1 (MCP sessions, 2-3 days) must complete before
   POC-1 (page understanding, 3-4 days). POC-1 must complete before POC-3
   (handler staleness, 2-3 days). That's 7-10 days of sequential work on the
   critical path before any implementation can start.

2. **Research paralysis.** 9 research tasks can lead to "analysis paralysis" —
   spending weeks researching before writing any production code. Some research
   findings may invalidate earlier research, creating loops.

3. **Research without production code context.** Research findings in isolation
   (e.g., "FlowProducer can handle 2000 children") may not translate to production
   reality (e.g., "FlowProducer with our specific Redis config + backpressure +
   concurrent pipelines can handle 2000 children").

### Counter (Prior Learnings)

The user explicitly asked for "research and POC tasks." The research exists because
multiple fundamental problems are UNVALIDATED assumptions. Building production code
against unvalidated assumptions is how the original design (900 LLM calls) happened.

**However, not all research is equally blocking:**

```
MUST DO FIRST (blocks everything):
  R-3 (Handler quality) — if LLM can't generate usable handlers, entire design fails
  R-6 (Tool-use loop)   — if WorkerLLMClient can't do tool loops, Phase 1-2 fails

CAN DO IN PARALLEL WITH EARLY IMPLEMENTATION:
  R-1 (MCP sessions)    — T-14 can start with single-session, upgrade later
  R-2 (FlowProducer)    — T-16 can start with single-batch, add forking later
  R-4 (URL patterns)    — T-15 Phase 0 can start with exact sitemap match
  R-5 (Fingerprint)     — T-16 can use conservative thresholds initially

CAN DEFER TO CLOUD DEPLOYMENT PHASE:
  R-7 (Go worker)       — Phase 4 works with Playwright-only initially
  R-8 (Checkpoint perf) — Use JSON, optimize later if needed
  R-9 (KEDA)            — Cloud scaling is a post-MVP concern
```

**Revised critical path:** R-3 + R-6 (parallel, 3-4 days) → POC-1 (3-4 days) →
Implementation begins. Total pre-implementation: 6-8 days, not 15-20.

### Net Assessment

**Prioritize research by risk level.** R-3 and R-6 are existential risks — if
they fail, the design is fundamentally flawed. Other research is optimization.
Start implementation after R-3 + R-6 + POC-1, do remaining research in parallel.

**Action:** Add research priority tiers to the HLD. Tier 1 (blocking): R-3, R-6.
Tier 2 (parallel with implementation): R-1, R-2, R-4, R-5. Tier 3 (deferred):
R-7, R-8, R-9.

---

## Iteration 4: Does the PageHandler Schema Handle All Real-World Page Types?

### The Assumption

IPlaywrightStep covers: navigate, click, clickAll, waitForSelector,
waitForNetworkIdle, extractText, extractStructured, expandAll, scrollToBottom,
selectOption, typeText, screenshot, conditional. The extraction schema is
`Record<string, string>` mapping field names to CSS selectors.

### The Problem

1. **Pagination.** Many sites paginate content: "Page 1 of 20" with Next buttons.
   The PageHandler has no loop construct. It can click "Next" once but not
   "click Next, extract, repeat until no more pages." The `maxIterations` param
   on `expandAll` isn't the same — it's for expanding sections, not navigating
   pages.

2. **Infinite scroll.** The handler has `scrollToBottom` but no "scroll until
   content stops loading" construct. `maxIterations` limits scroll count, but
   different pages may have different amounts of content. Static iteration count
   either under-scrolls (misses content) or wastes time scrolling empty space.

3. **iframes.** Some enterprise sites embed content in iframes (e.g., knowledge
   base widgets, embedded documentation). Playwright requires `frame.locator()`
   to interact with iframe content. The handler schema has no iframe support.

4. **File downloads.** Some "content" is in PDFs, Excel files, or other downloads.
   The handler can click a download link but has no mechanism to capture the
   downloaded file and pass it to the pipeline (which has Docling for PDF extraction).

5. **Authentication flows.** Login → CAPTCHA → 2FA is multi-step. The handler has
   `typeText` and `click` but no "wait for user to solve CAPTCHA" or "enter 2FA
   code" construct. Authentication is mentioned in FP-3 as a Tier 3 user prompt,
   but the handler can't persist auth state across session batches.

### Counter (Prior Learnings)

From v1 Iteration 3: "Compound tools are suggestions, not requirements. LLM falls
back to primitives." This still applies — the handler schema covers 90% of cases.

**For pagination:** Add a `loop` action type to IPlaywrightStep:

```typescript
{ action: 'loop',
  params: { selector: '.next-page', maxIterations: 50,
            exitWhen: 'elementNotExists', extractPerIteration: true },
  steps: [ /* nested extraction steps */ ] }
```

**For infinite scroll:** The existing `scrollToBottom` with `maxIterations` is
sufficient when combined with `waitForNetworkIdle`. If new content loads after
scroll, network activity resumes. The step waits for networkIdle between scrolls.
Set `maxIterations: 100` with `earlyExitOnNoNewContent: true`.

**For iframes:** Add `switchToFrame` action:

```typescript
{ action: 'switchToFrame', selector: 'iframe.kb-widget' }
// subsequent steps operate within the frame
{ action: 'switchToMain' } // return to main page
```

**For file downloads:** The pipeline already handles files via Docling. The handler
needs a `download` action that captures the file URL and submits it directly to the
pipeline's content-processing queue as a file-type job.

**For authentication:** This is NOT a handler concern. Authentication is handled
BEFORE handler execution: Phase 1 detects login page → Tier 3 prompt → user
provides credentials or session cookie → CrawlIntelligenceService authenticates
→ passes auth cookies to Crawl Worker → all batches use the same session cookies.

### Net Assessment

**The schema needs 3 additions: loop, switchToFrame, download.** These aren't
fundamental changes — they're new action types in the existing IPlaywrightStep
enum. Authentication is correctly handled outside the handler.

**Action:** Add `loop`, `switchToFrame`, `switchToMain`, `download` to
IPlaywrightStep action types. Add `earlyExitOnNoNewContent` to scrollToBottom
params. Document iframe and pagination patterns in the LLD.

---

## Iteration 5: Is the CrawlOrchestrator / FlowProducer Pattern Correct?

### The Assumption

CrawlOrchestrator creates a BullMQ Flow: one parent job (orchestrator) with N
children (batches). Progressive enqueuing adds 20 children at a time. The parent
tracks aggregate progress across all children.

### The Problem

1. **FlowProducer doesn't support progressive enqueuing.** `FlowProducer.add()`
   creates the ENTIRE flow at once — parent + all children. You can't add children
   incrementally to an existing flow. The "20 batches at a time" pattern would
   require creating multiple independent flows or using a different BullMQ pattern.

2. **Parent job lifecycle.** In BullMQ flows, the parent job WAITS for all children
   to complete before its processor runs. If we create 20 children, the parent
   processor runs after those 20 complete. We'd need to create the parent, then
   somehow add more children to it. BullMQ flows don't support this.

3. **Alternative: queue-based orchestration.** Instead of FlowProducer, the
   CrawlOrchestrator could be a regular BullMQ worker that:
   - Receives the crawl job with all URLs
   - Enqueues 20 batch jobs to `crawl-together-batch` queue
   - Listens for completion events (Redis pub/sub or BullMQ events)
   - When 20 complete, enqueues 20 more
   - Tracks aggregate state in Redis (not BullMQ flow state)

### Counter (Prior Learnings)

From the codebase: PipelineFlowBuilder creates flat flows (one parent, N children).
But the children are ALL created at once via `FlowProducer.add()`. There's no
progressive child addition.

**The FlowProducer pattern is WRONG for progressive enqueuing.** The correct
pattern is:

```
CrawlOrchestrator = long-running BullMQ worker job (not a flow parent)
  - Uses job.updateProgress() to keep alive
  - Maintains state in Redis: { totalBatches, completedBatches, pendingBatches[] }
  - Enqueues batch jobs to 'crawl-together-batch' queue individually
  - Listens for batch completion via Redis pub/sub
  - Progressive: enqueues next batch when a previous one completes
  - Backpressure: checks queue depth before enqueuing
```

This is simpler than FlowProducer, supports progressive enqueuing, and doesn't
require all URLs to be materialized in a BullMQ flow structure.

**For small crawls (<1000 URLs):** Use FlowProducer with a single parent + 1-2
children. This is the simple path where FlowProducer is appropriate.

**For enterprise crawls (>1000 URLs):** Use the queue-based orchestrator pattern.
The orchestrator IS the long-running job, not the flow parent.

### Net Assessment

**FlowProducer is wrong for progressive enqueuing at scale.** Replace with a
queue-based orchestrator that enqueues batches individually and tracks state
in Redis. Keep FlowProducer for small crawls where it's simpler.

**Action:** Update HLD: CrawlOrchestrator uses queue-based pattern (not
FlowProducer) for enterprise scale. FlowProducer only for <1000 URLs.
Update R-2 research task to validate this pattern.

---

## Iteration 6: What's the Failure Mode When the LLM Is Unavailable?

### The Assumption

Phases 0-2 and 5 require LLM calls via WorkerLLMClient. The LLM is assumed to
be available. The 6-level credential resolution ensures SOME model is accessible.

### The Problem

1. **API rate limits.** Cloud LLM APIs (OpenAI, Anthropic) have rate limits.
   If 10 tenants start Crawl Together simultaneously, each needing 10 LLM calls,
   that's 100 calls in a few minutes. Rate limit errors return 429.

2. **LLM timeout.** `generateText()` with tool-use loop can take 10-30 seconds
   per call. If the LLM is slow (provider overload), Phase 1-2 takes 10 minutes
   instead of 2 minutes. The user stares at "Understanding your page..." for
   10 minutes.

3. **Complete LLM failure.** API key revoked, provider outage, network failure.
   Phases 0-2 can't proceed. The crawl is stuck at "understanding" with no way
   to proceed.

4. **On-premise LLM unavailability.** Local model server (vLLM, Ollama) crashes
   or runs out of GPU memory. Unlike cloud APIs, there's no automatic failover.

### Counter (Prior Learnings)

From codebase: `WorkerLLMClient` wraps Vercel AI SDK which has built-in retry
with exponential backoff. The `resolveIndexLLMConfig()` chain has 6 levels —
if one provider fails, the next level kicks in.

**For rate limits:** Implement a per-tenant LLM call rate limiter in
CrawlIntelligenceService. Max 5 concurrent LLM calls per tenant. Crawl Together
jobs queue behind each other, not stampede.

**For timeout:** Add timeout to each LLM call (30s for simple understanding,
60s for tool-use loops). If timeout: retry once with simpler prompt (fewer
tokens, no tool use). If still fails: inform user "LLM is slow, retrying."

**For complete failure:** CrawlIntelligenceService saves its state after each
phase. If Phase 1 completes but Phase 2 fails, the user can retry from Phase 2
(not from scratch). State saved in Redis: `crawl:{jobId}:intelligence:state`.

**For on-premise:** The existing credential resolution supports model fallback.
If primary model fails, fall back to a secondary. Add health check for local
model servers before starting crawl.

### Net Assessment

**LLM unavailability is a real operational risk, but existing infrastructure
handles most cases.** The missing piece is per-phase state persistence so
retries don't restart from scratch.

**Action:** Add per-phase state persistence to CrawlIntelligenceService.
Add per-tenant LLM rate limiter. Document retry strategy per phase.

---

## Iteration 7: Is the Cost Model Complete?

### The Assumption

The HLD costs LLM tokens only: ~127K tokens per crawl, $0.03-2.20 depending on
model. The key insight is "cost scales with understanding, not page count."

### The Problem

1. **Compute cost is missing.** Playwright browser sessions consume CPU and memory.
   A 298-page Crawl Together session uses ~300MB RAM and ~40 minutes of CPU time.
   On cloud (K8s), this is billable compute. On enterprise scale: 30 workers × 4
   hours = 120 worker-hours of compute.

2. **MCP server cost.** The MCP server runs Chromium. Each Crawl Worker connects
   to an MCP server instance (or shared pool). Chromium at ~200MB per context,
   3 contexts per pod, 10 pods = 6GB of RAM just for browsers during enterprise
   crawl.

3. **Redis memory cost.** 2,000 batch checkpoints × ~10KB each = 20MB for
   checkpoints. Plus dedup SETs: 1M content hashes × ~50 bytes = 50MB. Plus
   progress tracking, anomaly lists, pending decisions. Total Redis overhead
   for a 1M-page crawl: ~100-200MB.

4. **Pipeline processing cost.** 1M pages × 5 items × pipeline (docling +
   enrichment + embedding) = 5M pipeline jobs. Each embedding call costs tokens
   (if using LLM-based embeddings). This is NOT part of the "crawl cost" but
   IS part of the total cost of ownership.

5. **Storage cost.** 1M pages → ~5M content items → OpenSearch index storage.
   At ~1KB per item: ~5GB. With embeddings (~1536 dims × 4 bytes): ~30GB of
   vector storage.

### Counter (Prior Learnings)

The HLD's cost model intentionally focuses on LLM costs because that's the
variable that differs between architectures (per-page LLM vs 5-phase). Compute,
Redis, pipeline, and storage costs are the SAME regardless of whether you use
Mode 1, Mode 2, or Mode 3 — they're proportional to page count, not architecture.

**However, the HLD should acknowledge these costs exist.** The user needs to
understand total cost of ownership, not just LLM cost.

**The key addition:** A "Total Cost of Ownership" section that breaks down:

- LLM intelligence cost: $0.03-2.20 per crawl (architecture-dependent)
- Compute cost: proportional to page count × processing time (same for all modes)
- Redis memory: ~100-200MB per 1M pages during crawl (temporary, TTL-based)
- Pipeline processing: proportional to items (same for all modes)
- Storage: proportional to items (same for all modes)

The only VARIABLE cost is LLM intelligence. Everything else is a constant of
the crawl size.

### Net Assessment

**The cost model is correct for comparing architectures but incomplete for
capacity planning.** Add a "Total Cost of Ownership" breakdown that helps
operators plan infrastructure for enterprise-scale crawls.

**Action:** Add infrastructure cost breakdown to HLD section 3.6. Include
memory budget (Redis, browser), compute budget (worker-hours), and storage
projection per crawl scale.

---

## Iteration 8: How Does Mode 3 (Autonomous Replay) Actually Get Triggered?

### The Assumption

Mode 3 is invisible — when a user starts a Mode 1 crawl, the system checks for
high-confidence handlers (≥80%, success ≥90%) and auto-applies them. The user
never explicitly selects Mode 3.

### The Problem

1. **When does handler confidence reach 80%?** Wilson Score with small samples
   is conservative. After 1 successful crawl: confidence ~35%. After 5 crawls:
   ~65%. After 10 crawls: ~72%. The handler needs ~15-20 successful crawls to
   reach 80%. For a site crawled monthly, that's 15-20 MONTHS before Mode 3
   kicks in.

2. **What counts as "successful"?** If a handler extracts content from 290 of
   298 pages, is that success? The HLD says `qualityWeightedSuccess` but doesn't
   define the quality gate. If the threshold is 95% page success: 290/298 = 97.3%
   → success. If the threshold is 100%: fail.

3. **Handler applicability check.** When Mode 1 crawl starts, the system checks
   for handlers. But the URL being crawled might be different from the handler's
   `urlPattern`. "Entire site" crawl covers all pages, not just FAQ pages. Do
   handlers apply to matching URLs within a broader crawl?

4. **Handler conflict with user config.** User has a Mode 1 crawl with
   `maxPages: 100, excludePaths: ['/old/*']`. A Mode 3 handler wants to crawl
   all FAQ pages (298). Does the handler override the user's maxPages? Or does
   the user's config constrain the handler?

### Counter (Prior Learnings)

From L-6 in the HLD: Confidence is tied to how the rule was created. User-confirmed
decisions get 90-100%, which means Mode 3 eligibility after fewer successful replays.

**For confidence growth rate:** The initial confidence after Mode 2 (user-approved)
starts at 85-95%, not 35%. Wilson Score drops this to ~72% (conservative lower
bound). After 3 successful replays: ~80%. After 5: ~85%. **Mode 3 kicks in
after 3-5 successful crawls, not 15-20.** The initial confusion was applying
Wilson Score to pattern observations (starting at 0). PageHandlers from Mode 2
start with HIGH initial confidence because the user approved them.

**For success definition:** Success = extraction passes quality gate:

- ≥ 90% of pages produce content (fingerprint match + extraction succeeds)
- Average content length within ±30% of expected
- No more than 5% anomalies
  This is already in `expectedOutput` on the handler.

**For URL matching within broader crawls:** Mode 3 handlers apply to MATCHING
URLs within any crawl. If "Entire site" crawl hits a URL matching handler's
`urlPattern`, the handler executes for that URL. Non-matching URLs use Mode 1.

**For config conflict:** User config is a CONSTRAINT, handlers are an OPTIMIZATION.
User's `maxPages: 100` limits total pages. Handler's URLs are filtered by user
constraints first. Handler doesn't override user intent — it enhances execution.

### Net Assessment

**Mode 3 is viable after 3-5 successful replays, not 15-20.** The confusion was
about initial confidence. User-approved handlers start high. Handler/config
interaction follows a clear priority: user constraints > handler optimization.

**Action:** Document confidence growth curve in HLD (initial: 85-95% after Mode 2,
Wilson lower bound: ~72%, after 3 replays: ~80% → Mode 3 eligible). Document
handler/config interaction rules.

---

## Iteration 9: Are the POC Scope and Success Criteria Realistic?

### The Assumption

POC-1 (end-to-end page understanding) expects: "Handler extracts ≥90% of FAQ
content from all 5 pages. Primary selectors work on ≥80% of pages."

### The Problem

1. **Epson.com may change.** The POC targets epson.com FAQ pages. If Epson
   redesigns their FAQ section between now and POC execution, the test is
   invalid. Need backup sites.

2. **"≥90% extraction accuracy" is hard to measure.** How do you know the
   ground truth? Manual counting of all FAQs on 5 pages? That's 5 × 118 =
   590 FAQs to manually verify. Time-consuming and error-prone.

3. **MCP server isn't ready for multi-session.** POC-1 requires connecting to
   MCP server, but R-1 (MCP sessions) hasn't been completed. The POC depends
   on research that may change its prerequisites.

4. **POC-4 (batch+fork) expects "10K URLs processed in < 3 hours with 3 workers."**
   Where do 10K URLs come from? Generating synthetic URLs doesn't test real
   extraction. Using real sites means 10K real page loads — that's aggressive
   load on target sites and may trigger rate limiting.

### Counter (Prior Learnings)

**For site changes:** Use cached page HTML. Fetch 5 pages once, save HTML to
local files. POC runs against cached HTML via MCP server (which supports file://
or local HTML serving). This also makes the POC repeatable.

**For accuracy measurement:** Define accuracy as "structured extraction produces
valid JSON matching schema." Don't count individual FAQs — instead: (a) extraction
produces ANY content → structural success, (b) content matches expected schema →
schema success, (c) spot-check 10 random items → content quality.

**For MCP readiness:** POC-1 can start with single-session MCP (current state).
Multi-session is an optimization. The POC validates handler generation, not
concurrent sessions.

**For 10K URLs in POC-4:** Use synthetic pages. Create a simple Express server
that serves 10K pages with known content (variations of a template). This tests
the orchestration, batching, checkpointing, and pipeline integration without
hitting real sites. Real site validation happens in POC-1 and POC-2.

### Net Assessment

**POC success criteria need adjustment.** Use cached HTML for determinism,
simplified accuracy metrics, single-session MCP initially, and synthetic
pages for scale testing.

**Action:** Add "test infrastructure" section to each POC: what's mocked,
what's real, how accuracy is measured. Reduce POC-1 MCP dependency to
single-session.

---

## Iteration 10: What's Missing from the HLD?

### Meta-Review

After 9 iterations questioning specific aspects, this final iteration asks:
"What fundamental aspects of the design are NOT addressed?"

### Missing Items Found

1. **Tenant isolation in crawl state.** Redis keys use `crawl:{jobId}:*` but
   don't include `tenantId`. If two tenants have crawl jobs with colliding IDs
   (BullMQ uses incremental IDs within a queue), their checkpoints could collide.
   **Fix:** Redis keys must be `crawl:{tenantId}:{jobId}:*`.

2. **Concurrent crawls of the same domain.** Two users in the same tenant start
   Crawl Together on the same site simultaneously. Both run Phase 0-2, both
   generate handlers, both start execution. Duplicate work, potential conflicts.
   **Fix:** Distributed lock on `crawl-together:{tenantId}:{domain}`. Second
   crawl waits or joins the first.

3. **Handler cleanup/garbage collection.** Handlers have `expiresAt: 90 days`.
   But who runs the cleanup? There's no TTL-based cleanup job defined.
   **Fix:** Add a scheduled BullMQ job (daily) that deletes expired handlers
   and removes associated Redis state.

4. **Observability.** The HLD mentions progress via WS but not structured logging
   or metrics. For production debugging: how many LLM calls per phase? Latency
   per phase? Handler cache hit rate? Anomaly rate trends over time?
   **Fix:** Add structured logging via `createLogger('crawl-intelligence')`.
   Define key metrics: `crawl.phase.duration`, `crawl.llm.calls`,
   `crawl.handler.cache_hit_rate`, `crawl.anomaly.rate`.

5. **Rate limiting on target sites.** The HLD mentions `rateLimitMs` but doesn't
   address: how does the Crawl Worker know the target site's rate limit? Blindly
   crawling at max speed may trigger IP blocks.
   **Fix:** Phase 0 checks robots.txt `Crawl-delay`. Default: 1 request/second.
   Configurable per job. Auto-detect 429 and back off exponentially.

6. **Data retention and GDPR.** Crawled content may include PII (user reviews,
   forum posts, employee names). The HLD doesn't address: how long is raw crawl
   content retained? Is there a right-to-erasure path for crawled content?
   **Fix:** Raw crawl content follows the platform's existing TTL policy (tenant
   configurable). Pipeline applies PII detection during enrichment phase. Add
   `crawlSourceUrl` to content metadata for erasure traceability.

7. **Error reporting to the user.** If Phase 0 fails (site unreachable), Phase 1
   fails (LLM error), or Phase 4 fails (all batches error) — what does the user
   see? The HLD has WS notifications for progress but not for error states.
   **Fix:** Define error notification types: `crawl.error.site_unreachable`,
   `crawl.error.llm_failure`, `crawl.error.handler_generation_failed`,
   `crawl.error.execution_failed`. Each includes: what happened, why, what the
   user can do (retry, provide more info, contact support).

### Net Assessment

**7 missing items, all addressable.** The most critical are tenant isolation in
Redis keys (#1) and concurrent crawl dedup (#2) — these are production safety
issues. The rest are operational completeness.

**Action:** Add all 7 items to the HLD. #1 and #2 go into the architecture section.
#3-7 go into a new "Operational Concerns" section.

---

## Cross-Cutting Assessment (v3)

After 10 iterations on the complete HLD, the design is architecturally sound with
these categories of findings:

### Architectural Improvements (change the design)

1. **Phase elision** (Iter 1) — small crawls skip unnecessary phases
2. **Handler selection by fingerprint** (Iter 2) — not just URL pattern
3. **Queue-based orchestrator** (Iter 5) — FlowProducer wrong for progressive enqueue
4. **Tenant isolation in Redis** (Iter 10) — must prefix all keys with tenantId

### Schema Additions (extend the model)

5. **loop, switchToFrame, download actions** (Iter 4) — handle pagination, iframes, files
6. **Handler versioning** (Iter 2) — rollback capability
7. **Per-phase state persistence** (Iter 6) — retry from last successful phase

### Process Improvements (change the approach)

8. **Research prioritization** (Iter 3) — R-3, R-6 first; others parallel
9. **POC test infrastructure** (Iter 9) — cached HTML, synthetic pages, simplified metrics

### Documentation Gaps (add to HLD)

10. **Total cost of ownership** (Iter 7) — compute, Redis, storage budgets
11. **Mode 3 confidence growth** (Iter 8) — starts at 85-95%, viable in 3-5 replays
12. **Concurrent crawl dedup** (Iter 10) — distributed lock on domain
13. **Observability metrics** (Iter 10) — structured logging, key metrics
14. **Error reporting to user** (Iter 10) — notification types per failure mode
15. **Rate limiting/GDPR** (Iter 10) — robots.txt Crawl-delay, PII handling

### What Changed from This Review

| Aspect                 | Before v3 Review            | After v3 Review                             |
| ---------------------- | --------------------------- | ------------------------------------------- |
| Phase model            | Fixed 7 phases always       | Phase elision for small/repeat crawls       |
| Handler selection      | URL pattern only            | URL pattern + fingerprint similarity        |
| Orchestrator pattern   | FlowProducer                | Queue-based for scale, Flow for small       |
| PlaywrightStep actions | 13 actions                  | 16 actions (+loop, switchToFrame, download) |
| Handler versioning     | Not addressed               | Version + rollback on failure               |
| Research approach      | All 9 before implementation | R-3, R-6 first, rest parallel               |
| Redis key isolation    | jobId only                  | tenantId:jobId                              |
| Cost model             | LLM tokens only             | LLM + compute + Redis + storage budgets     |
| Mode 3 activation      | Unclear timeline            | 3-5 successful replays (~3-5 months)        |
| Concurrent crawls      | Not addressed               | Distributed lock on domain                  |
| LLM failure handling   | Not addressed               | Per-phase state persistence + retry         |
