# OpenAI Consultation — Crawl Together Design

_Date: 2026-03-17_
_Model: GPT-4o (3 separate consultations with escalating specificity)_

---

## Summary

Three calls made to OpenAI API with increasing prompt specificity. Responses were
high-level but reinforced critical themes already identified in self-review. Key
external insights are synthesized below alongside the web-research-based external
analysis (see `external-perspective-analysis.md` for production system comparisons).

---

## Key Reinforcements from OpenAI

### 1. The Fundamental Flaw: Over-Reliance on LLM for Real-Time Decisions

OpenAI independently confirmed what our Iteration 7 identified: **the LLM should
not drive navigation**. Their framing: "The architecture assumes the LLM can handle
tasks that are better suited for deterministic algorithms or pre-defined rules."

This aligns with:

- Firecrawl pattern: LLM only at extraction layer, never for navigation
- Stagehand pattern: deterministic-first, AI-on-failure
- Our Iteration 1 finding: LLM selector hallucination is the #1 production risk

### 2. Batch Execution Mode Will Break on Page Variability

OpenAI's critique of our "learn on page 1, replay on pages 2-300" proposal:

> "It will break when subsequent pages deviate significantly from the learned
> pattern" and "dynamic content that changes based on user interaction or time
> will not be handled by static replay."

**This is a real gap.** Our Epson scenario has mostly-uniform pages, but real-world
crawls will have mixed page types (product pages vs. FAQ pages vs. download pages).
The batch execution model needs **per-page-type handlers**, not a single pattern.

### 3. First 5 Production Failures (in order)

OpenAI's assessment aligns with our self-review but provides a useful priority order:

1. **LLM selector errors** (Iteration 1) — immediate, every crawl
2. **Session timeouts/disconnects** (Iteration 7) — first long crawl
3. **Context window overflow** (Iteration 4) — first crawl > 50 pages
4. **Selector rot** (Iteration 2) — first re-crawl after site update
5. **Cost overruns** (Iteration 6) — first enterprise-scale crawl

### 4. Optimal LLM Calls for Epson Scenario

OpenAI proposed ~5-7 LLM calls total:

1. **Site understanding** — Parse site structure, generate navigation plan
2. **Selector identification** — Identify FAQ selectors on sample page
3. **Pattern learning** — Learn extraction pattern from first model page
4. **Periodic verification** — Every 5-10 pages, verify data quality
5. **Final validation** — End-of-crawl quality check

This matches the 5-phase architecture from our external research:
Map → Plan → Sample → Execute → Repair

### 5. Missing: Page Structure Variability Within a Single Crawl

OpenAI hinted at but didn't fully articulate: within a single crawl, different
sections of a site may have completely different page structures. The Epson FAQ
crawl assumes all 300 model pages have the same layout. But:

- Some models may have a different FAQ layout (newer products vs older)
- Some categories may use a completely different page template
- Regional variants may serve different HTML

**Fix needed:** The batch execution model needs anomaly detection per page.
If a page's structure doesn't match the learned pattern, flag it for LLM
re-evaluation rather than blindly extracting.

---

## Concrete Suggestions Extracted

### From OpenAI (actionable items only)

1. **HTML preprocessing before LLM sees it** — Strip non-text elements, extract
   text with associated selectors, send hierarchical structure summary instead
   of raw HTML. (Matches our Iteration 4 "page content preprocessing" fix.)

2. **Rule format must be directly executable** — Not JSON descriptions. OpenAI
   suggested selector sequences with action types. (Matches our Iteration 2
   finding and Stagehand's cached selector pattern.)

3. **Content hashing for staleness** — Hash extracted content, compare with stored
   hash on replay. Simple but effective first layer. (Matches our Iteration 5
   "content fingerprint validation" fix.)

### From External Research (higher quality, see external-perspective-analysis.md)

1. **Firecrawl Map Phase** — HTTP-only site discovery before any browser/LLM
2. **Stagehand DOM Fingerprinting** — Per-selector cache with fingerprint validation
3. **Crawlee Request Queue** — Persistent, deduplicated URL queue with checkpoint
4. **LangGraph Checkpointing** — State snapshots at each step, resume from last
5. **Schema-First Extraction** — Define output schema, LLM maps content to it
6. **80/20 Hybrid Split** — Deterministic for 80% of steps, LLM for 20%

---

## Synthesis: Convergent Architecture

Both OpenAI and external research converge on the same architecture. The 7 self-review
iterations independently arrived at the same conclusions. Here's the convergent model:

```
┌─────────────────────────────────────────────────────────┐
│ Phase 1: MAP (deterministic, no LLM)                    │
│ HTTP crawl → sitemap → URL patterns → page type classify│
│ Output: SiteMap + page count estimate                   │
├─────────────────────────────────────────────────────────┤
│ Phase 2: PLAN (1 LLM call)                              │
│ User intent + SiteMap → CrawlPlan                       │
│ Show Intent Preview → user approves                     │
│ Output: CrawlPlan with extraction schemas               │
├─────────────────────────────────────────────────────────┤
│ Phase 3: SAMPLE (3-5 LLM calls)                         │
│ Pick representative pages per type                      │
│ LLM understands structure, generates PageHandlers       │
│ Validate handlers on sample pages                       │
│ Output: Executable PageHandlers per page type            │
├─────────────────────────────────────────────────────────┤
│ Phase 4: EXECUTE (0 LLM calls, worker-driven)           │
│ BullMQ worker with Crawlee-style execution:             │
│ RequestQueue + SessionPool + Checkpointing              │
│ Per page: match handler → execute → extract → validate  │
│ Anomaly → flag for Phase 5                              │
│ Output: ExtractedContent[] + AnomalyPages[]             │
├─────────────────────────────────────────────────────────┤
│ Phase 5: REPAIR (1-3 LLM calls, as needed)              │
│ Re-engage LLM for anomaly pages                         │
│ Update PageHandlers                                     │
│ Retry anomalies                                         │
│ If repair fails → escalate to user                      │
└─────────────────────────────────────────────────────────┘
```

**Total LLM calls for Epson: ~8-12** (vs. our current 903, vs. OpenAI's ~5-7)

**Key principle:** The LLM UNDERSTANDS. The worker EXECUTES. The user APPROVES.
