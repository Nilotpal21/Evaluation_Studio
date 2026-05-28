# Crawl Together — Prioritization Review + 7-Iteration Design Review (v4)

Objective: What should go first for an end-to-end scenario? What scaling problems
must be solved before this? What fundamental problems are prerequisites? Then 7
iterative reviews of the full design with this lens.

---

## Prioritization Review: E2E Critical Path

### The Minimum Viable End-to-End Scenario

User opens Studio → types intent + sample URL → clicks "Start Crawl Together" →
sees mapping progress → sees page understanding → sees handler preview →
approves → sees execution progress → sees extracted content in search index.

**This E2E requires these components to EXIST and WORK:**

```
Studio UI:
  ✓ CrawlJobForm with intent + sample URL fields
  ✓ CrawlTogetherPanel (chat/decisions + progress)
  ✓ WS connection for notifications
  ✓ REST call for approval

Search-AI Backend:
  ✓ POST /api/crawl/together/start endpoint
  ✓ POST /api/crawl/together/{jobId}/respond endpoint
  ✓ CrawlIntelligenceService (Phase 0-3, 5)
  ✓ Crawl Worker (Phase 4 — single batch, no orchestrator)
  ✓ WS notifications via existing progress infrastructure
  ✓ Redis state management (crawl status, decisions, checkpoint)

Data Layer:
  ✓ PageHandler model + MongoDB collection
  ✓ CrawlJob model (or extend existing)

Infrastructure:
  ✓ MCP server running (single-session OK for E2E)
  ✓ WorkerLLMClient with tool-use capability
  ✓ Existing BullMQ pipeline (content-processing → embedding)
```

### What Does NOT Need to Exist for E2E

```
SCALING (solve after E2E works on <100 pages):
  ✗ CrawlOrchestrator (batch+fork)
  ✗ Progressive batch enqueuing
  ✗ Go worker integration for HTTP pages
  ✗ KEDA/HPA auto-scaling
  ✗ Browserless integration
  ✗ Worker concurrency tuning

MODE 3 (solve after Mode 2 E2E works):
  ✗ Handler confidence tracking (Wilson Score)
  ✗ Implicit mode selector in crawl.ts
  ✗ Handler versioning + rollback
  ✗ Fingerprint-based handler selection (1 handler per domain is fine initially)
  ✗ Handler expiry/cleanup job

ADVANCED FEATURES (solve after basic E2E):
  ✗ Phase elision logic
  ✗ Browser discovery fallback (sitemap-only is fine for E2E)
  ✗ Per-phase state persistence for retry
  ✗ Concurrent crawl dedup (distributed lock)
  ✗ Per-tenant LLM rate limiting
  ✗ Auth detection + credential prompting
  ✗ loop/switchToFrame/download actions
```

### Fundamental Problems — Solve Order

```
┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 0: VALIDATE BEFORE ANYTHING (Research + POC)                       │
│                                                                         │
│ R-3: Can LLM generate usable PageHandlers? (3-4 days)                  │
│   → If NO: entire design is invalid. Stop. Rethink.                    │
│   → If YES: proceed to implementation                                  │
│                                                                         │
│ R-6: Does WorkerLLMClient support tool-use loops? (1-2 days)           │
│   → If NO: Phase 1-2 can't work. Need alternative (manual loop).     │
│   → If YES: proceed with Vercel AI SDK tools parameter                │
│                                                                         │
│ POC-1: End-to-end on one real page (3-4 days)                          │
│   → Navigate to epson.com FAQ, understand structure, generate handler, │
│     replay on 3 pages. THIS IS THE GO/NO-GO GATE.                     │
│                                                                         │
│ TOTAL: 6-8 days before any production code is written                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 1: MINIMUM E2E (solve these for a working demo)                    │
│                                                                         │
│ FP-1 (JS content): MCP server single-session connection from search-ai │
│ FP-2 (LLM cost): 5-phase model with targeted LLM calls (not per-page) │
│ FP-3 (user intent): Intent + sample URL in CrawlJobForm               │
│ FP-4 (rule book): PageHandler model + store (basic, no versioning)     │
│ FP-6 (crash recovery): Basic Redis checkpoint per page                 │
│                                                                         │
│ Implementation tasks: T-13 → T-14 → T-15 → T-16 → T-17 → T-19 → T-20│
│ TOTAL: ~3-4 weeks of implementation after research                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 2: PRODUCTION READINESS (solve before real users)                  │
│                                                                         │
│ FP-7 (browser sessions): 50-page session batching + context cleanup    │
│ FP-10 (LLM quality): Model tier escalation on handler validation fail  │
│ Mode 3: Handler confidence tracking + implicit mode selector           │
│ Operational: Observability metrics, error notifications, rate limiting  │
│ Tenant isolation: tenantId in Redis keys, concurrent crawl lock        │
│                                                                         │
│ Implementation: T-9a-c → T-10 → T-11 → T-18 + operational tasks       │
│ TOTAL: ~2-3 weeks after E2E                                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 3: ENTERPRISE SCALE (solve before >1000 page crawls)              │
│                                                                         │
│ FP-5 (scaling): CrawlOrchestrator + batch+fork                        │
│ FP-8 (pipeline saturation): Progressive enqueuing + backpressure       │
│ FP-9 (cloud/on-prem): KEDA auto-scaling, Browserless integration      │
│ Go worker routing for HTTP-simple pages                                │
│ Handler versioning + rollback + phase elision                          │
│                                                                         │
│ Implementation: T-16b + R-2 + R-7 + R-9 + cloud config                │
│ TOTAL: ~2-3 weeks after production readiness                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Scaling Problems — What Must Be Solved BEFORE Crawl Together

These are EXISTING platform scaling problems that will bite Crawl Together
if not addressed. They're NOT Crawl Together-specific but they'll block it.

```
MUST FIX FIRST (blocks E2E):
  1. MCP server not in docker-compose → can't connect from search-ai
     Fix: Add crawler-mcp-server to docker-compose.yml
     Effort: 1 day (T-14 includes this)

  2. MCP server hardcoded single session ('default')
     Fix: SessionManager with session ID parameter
     Effort: 2 days (T-14 includes this)
     Note: E2E works with single session, but MUST fix before concurrent crawls

SHOULD FIX BEFORE PRODUCTION:
  3. Redis no maxmemory policy → crawl checkpoints could exhaust memory
     Fix: Set maxmemory + allkeys-lru eviction in docker-compose Redis config
     Effort: 1 hour

  4. Go worker custom BullMQ protocol → can't integrate with CrawlOrchestrator
     Fix: Research needed (R-7) — may need adapter
     Effort: 2 days
     Note: Only needed for Tier 3 (enterprise scale)

  5. BullMQ pipeline backpressure tested only at current scale
     Fix: Load test with crawl-volume traffic (R-2)
     Effort: 2 days
     Note: Only needed for Tier 3

CAN DEFER:
  6. No horizontal worker scaling (fixed replicas)
     Fix: KEDA + HPA configuration (R-9)
     Note: Only needed for cloud enterprise deployments
```

### Recommended Implementation Sequence

```
Week 0-1: RESEARCH + POC (Go/No-Go Gate)
  R-3 + R-6 in parallel → POC-1
  If POC-1 fails → redesign or abandon
  If POC-1 passes → proceed

Week 2-3: FOUNDATION (data layer + infrastructure)
  T-13: PageHandler model + store
  T-14: MCP server multi-session + docker-compose
  POC-2: Intent refinement (in parallel)

Week 3-5: INTELLIGENCE + EXECUTION (core E2E)
  T-15: CrawlIntelligenceService (Phase 0-3, 5)
  T-16: Crawl Worker (Phase 4, single batch)
  T-17: API routes + WS notifications + REST responses
  (T-15 and T-16 can run in parallel — different files)

Week 5-6: UI (complete the loop)
  T-19: CrawlJobForm enhancement (intent, sample URL)
  T-20: CrawlTogetherPanel (chat + progress + approval)
  E2E DEMO: Complete flow on epson.com FAQ

Week 7-8: PRODUCTION READINESS
  T-9a: Fix dual completion race
  T-9b-c: MongoPatternLearner + MongoEventStore
  T-10-11: Wire stores + outcome recording
  T-18: Implicit mode selector (Mode 3)
  Operational: metrics, error notifications, tenant isolation

Week 9-10: ENTERPRISE SCALE (if needed)
  T-16b: CrawlOrchestrator
  R-2 + R-7: FlowProducer + Go worker research
  POC-4: Batch+fork validation
  Cloud config: KEDA, Browserless
```

---

## 7-Iteration Design Review (with E2E Priority Lens)

Each iteration questions whether the design supports the E2E-first approach.

---

## Iteration 1: Is the E2E Path Actually Achievable in 5-6 Weeks?

### The Assumption

Weeks 0-6 produce a working E2E: intent → map → understand → build handler →
approve → execute → content in index. This requires T-13 through T-20 plus
research + POC.

### The Problem

1. **T-15 (CrawlIntelligenceService) is massive.** It's a 5-phase orchestrator
   with LLM calls, MCP tool execution, URL pattern extraction, intent refinement,
   handler generation, anomaly resolution. Estimated "6 files" but each phase is
   a complex service method with error handling, state management, and LLM prompt
   engineering. More realistically: 10-15 files, 2000+ lines of code.

2. **Prompt engineering is unpredictable.** Phase 0 needs a prompt that reliably
   extracts URL patterns from sitemaps. Phase 1 needs a prompt that understands
   page structure. Phase 2 needs a prompt that generates valid PlaywrightSteps.
   Each prompt needs iteration — LLM responses are non-deterministic. Getting
   prompts right could take as long as writing the code.

3. **MCP server connection from search-ai is untested.** The MCP client exists
   in `@abl/compiler` but it's used by the Runtime (which runs as a separate
   process). Search-AI has never connected to an MCP server. There may be
   transport issues (stdio works between processes, but search-ai is Express —
   needs HTTP/SSE transport to MCP server).

4. **No existing test infrastructure for crawl intelligence.** No unit tests,
   no integration tests, no mock MCP server. Building the test infrastructure
   alongside the implementation adds significant time.

### Counter

**For T-15 size:** Split T-15 into sub-tasks. Each phase is a separate file:

- `phase-0-map.ts` (URL discovery + LLM intent refinement)
- `phase-1-understand.ts` (MCP page structure + LLM understanding)
- `phase-2-build.ts` (MCP navigation recording + LLM handler generation)
- `phase-3-approve.ts` (Redis decision + WS notification)
- `phase-5-repair.ts` (anomaly investigation + LLM fix)
- `crawl-intelligence.service.ts` (orchestrator that calls phases)

Each phase is independently testable. Phases can be developed sequentially
(Phase 0 first, test it, then Phase 1, etc.).

**For prompt engineering:** POC-1 already validates the core prompts. By the
time T-15 implementation starts (Week 3), the prompts from POC-1 are proven.
Production prompts are refinements, not from-scratch.

**For MCP connection:** The MCP client supports HTTP transport (SSE). The MCP
server needs an HTTP server mode (in addition to stdio). T-14 can add this.
Alternatively, search-ai spawns the MCP server as a child process and uses
stdio — same pattern as Runtime.

**For test infrastructure:** Use the cached HTML from POC-1 as test fixtures.
Mock MCP server returns pre-captured page structures. Tests validate orchestration
logic without requiring a real browser.

### Net Assessment

**5-6 weeks is tight but achievable IF:**

1. POC-1 succeeds cleanly (validates prompts + MCP connection)
2. T-15 is split into per-phase sub-tasks
3. MCP HTTP transport is available (or stdio spawn pattern)
4. Test fixtures from POC-1 are reused

**Risk:** Prompt engineering for Phase 2 (handler generation) is the biggest
unknown. If it takes 2 weeks of iteration instead of 2-3 days, the timeline
slips to 7-8 weeks.

**Action:** Add explicit "prompt iteration budget" to T-15: 1 week for handler
generation prompts specifically.

---

## Iteration 2: What's the Minimum PageHandler for E2E?

### The Assumption

The HLD's IPageHandler has: steps[], extractionSchema, fingerprint, expectedOutput,
confidence, qualityWeightedSuccess, source, appliedCount, successCount,
lastAppliedAt, lastValidatedAt, active, expiresAt, learnedFrom.

### The Problem

For the E2E demo, most of these fields are unnecessary. Confidence tracking,
quality-weighted success, expiry, versioning — all Mode 3 concerns. The E2E
only needs Mode 2: generate handler → replay on remaining pages.

Implementing the full schema delays E2E because:

1. Wilson Score calculation needs test coverage
2. Confidence decay needs a scheduled job
3. Handler versioning needs migration logic
4. Quality gates need calibration data (from production crawls)

### Counter

**Define IPageHandler v1 (E2E) and IPageHandler v2 (production):**

```typescript
// v1: E2E minimum
interface IPageHandlerV1 {
  _id: string;
  tenantId: string;
  domain: string;
  urlPattern: string;
  pageType: string;
  steps: IPlaywrightStep[];
  extractionSchema: Record<string, string>;
  fingerprint: IPageFingerprint;
  expectedOutput: { minItems: number; maxItems: number };
  active: boolean;
  createdAt: Date;
  learnedFrom: { sessionId: string; sampleUrls: string[]; llmModel: string };
}

// v2: Production (add after E2E works)
// + confidence, qualityWeightedSuccess, appliedCount, successCount
// + lastAppliedAt, lastValidatedAt, expiresAt, version
// + contentSignature, avgContentLength in expectedOutput
```

V1 has 12 fields. V2 adds 9 more. V1 is sufficient for: "generate handler from
samples, replay on remaining pages, detect anomalies via fingerprint."

### Net Assessment

**Start with v1 schema.** Add v2 fields when implementing Mode 3 (Tier 2,
weeks 7-8). This reduces T-13 effort by ~40%.

**Action:** Document v1 vs v2 schema split in the HLD. Mark Mode 3 fields
as "added in Tier 2."

---

## Iteration 3: Is the WS + REST Interaction Pattern Clear Enough for Implementation?

### The Assumption

WS for notifications (server → client), REST for responses (client → server).
Pending decisions stored in Redis with 1h TTL.

### The Problem

1. **Missing message schema.** The HLD says "WS notification: Approval needed"
   but doesn't define the message format. What JSON shape does the client
   expect? How does the client know which REST endpoint to call? What payload
   does the REST response carry?

2. **No retry/reconnect protocol.** If the WS disconnects during Phase 1
   (understanding page), and reconnects during Phase 3 (approval needed),
   what messages does the client receive? Just the latest state? All missed
   messages? The HLD says "When WS reconnects, fetch current state from Redis"
   but doesn't define the "current state" API.

3. **Multi-phase notifications.** Phase 0 sends mapping progress. Phase 1 sends
   understanding progress. Phase 3 sends approval request. Phase 4 sends
   execution progress. Phase 5 sends repair progress. These are different message
   types with different payloads. The client needs to render each differently.

### Counter

**Define the message protocol explicitly:**

```typescript
// WS notification messages (server → client)
type CrawlTogetherNotification =
  | { type: 'phase_progress'; phase: string; message: string; data?: any }
  | { type: 'decision_needed'; decisionId: string; question: string;
      options: { id: string; label: string; description: string }[];
      timeout?: number }
  | { type: 'execution_progress'; pagesCompleted: number; totalPages: number;
      itemsExtracted: number; anomalies: number; eta: string }
  | { type: 'anomaly_alert'; url: string; reason: string }
  | { type: 'crawl_complete'; summary: CrawlSummary }
  | { type: 'crawl_error'; code: string; message: string; retryable: boolean }

// REST response endpoint
POST /api/crawl/together/{jobId}/respond
Body: { decisionId: string; selectedOption: string; notes?: string }

// Reconnect: client calls
GET /api/crawl/together/{jobId}/state
Returns: { phase: string; status: string; pendingDecisions: Decision[];
           progress: ExecutionProgress; notifications: Notification[] }
```

**For reconnect:** The `/state` endpoint returns the CURRENT state from Redis.
No message replay needed — the client renders current state, not history.
Pending decisions are in the response, so the client can show the approval
dialog immediately on reconnect.

### Net Assessment

**The interaction protocol needs explicit message types.** This is a LLD concern
but the HLD should define the message type enum and the reconnect pattern.

**Action:** Add CrawlTogetherNotification type enum and reconnect API to HLD
section 3.3 (interaction patterns).

---

## Iteration 4: Can Phase 0 Work Without a Sitemap?

### The Assumption

Phase 0 has a 4-level fallback chain: sitemap+sample → sitemap+intent →
browser+intent → ask user. But for E2E (Tier 1), the HLD says "sitemap-only
is fine for E2E."

### The Problem

1. **Many interesting E2E demo targets don't have sitemaps.** Internal knowledge
   bases, small business sites, newly built documentation sites — exactly the
   sites that benefit most from Crawl Together — often lack sitemaps.

2. **If Phase 0 fails, the whole flow fails.** No URLs → no samples → no
   handlers → no execution. The user sees "Mapping site... 0 URLs found."
   and the crawl stops.

3. **The browser fallback is NOT trivial.** "Open base URL, extract all links,
   classify via LLM" requires: MCP server connection in Phase 0 (currently
   Phase 0 is HTTP-only), link dedup, depth-limited traversal, and LLM
   classification of link groups.

### Counter

**For E2E, there's a simpler fallback than full browser discovery:**

If sitemap returns 0 URLs AND user provided a sample URL:

1. Use the sample URL as the starting point
2. Open sample URL via MCP, extract all internal links from that page
3. Group links by URL structure (no LLM needed — just string analysis)
4. Present groups to user: "I found these link patterns on your sample page.
   Which ones contain the content you want?"
5. User selects → filter links → proceed to Phase 1

This is a 1-page browser visit (not a full site crawl). It finds the local
neighborhood of the sample URL, which is usually sufficient for the user's intent.

**For sites with neither sitemap nor sample URL:**
Phase 0 returns `{ discoveryMethod: 'manual', message: 'Could not discover
pages automatically. Provide specific URLs to crawl.' }`. The user adds URLs
manually (like Mode 1's batch URL input).

### Net Assessment

**The browser fallback should be simpler for E2E: one-page link extraction from
the sample URL.** Full site discovery via browser crawling is a Tier 3 enhancement.

**Action:** Simplify Phase 0 fallback for E2E: sample URL link extraction
(one MCP call) instead of full browser discovery. Document as "E2E fallback"
vs "full fallback" in the phase specification.

---

## Iteration 5: Is the Crawl Worker Implementation Straightforward?

### The Assumption

Crawl Worker receives a batch of URLs + PageHandlers. For each URL: navigate,
fingerprint, execute handler steps, extract, checkpoint, submit to pipeline.

### The Problem

1. **PlaywrightStep execution engine.** The handler has steps like `click`,
   `expandAll`, `waitForSelector`, `extractStructured`. Each step maps to MCP
   tool calls. But the mapping isn't 1:1:
   - `expandAll` needs multiple MCP calls (click each item, wait between)
   - `extractStructured` needs custom logic to map schema to extraction
   - `conditional` needs evaluation logic
   - `loop` (pagination) needs recursion with exit conditions
     This is a mini execution engine, not simple sequential MCP calls.

2. **Error handling per step.** Each step has `onFailure: 'skip' | 'retry' |
'abort' | 'fallbackSelector'`. The worker must implement all four strategies.
   `fallbackSelector` must try `selectorFallbacks[]` in order and `textMatch`
   as last resort. This is ~50 lines of error handling per step execution.

3. **Output parsing.** `extractStructured` returns raw HTML/text. The worker
   must parse this into structured data matching `extractionSchema`. For the
   Epson FAQ scenario: extract `.faq-question` text + `.faq-answer` HTML,
   pair them, deduplicate, format for pipeline submission.

### Counter

**The PlaywrightStep executor is the most implementation-heavy component in the
entire system.** But it's also the most TESTABLE — each step type is a pure
function: (step + MCP client) → result.

**Implementation strategy:**

```
step-executor.ts — main loop, delegates to step handlers
handlers/
  click.handler.ts
  expand-all.handler.ts
  extract-structured.handler.ts
  wait.handler.ts
  conditional.handler.ts
  loop.handler.ts    (Tier 3 — pagination)
  iframe.handler.ts  (Tier 3 — switchToFrame)
  download.handler.ts (Tier 3 — file capture)
error-strategy.ts — implements skip/retry/abort/fallbackSelector
fingerprint.ts — capture + compare fingerprints
```

**For E2E, implement only the 6 core handlers:** click, expandAll,
waitForSelector, extractStructured, extractText, navigate. The remaining
(conditional, loop, iframe, download) are Tier 3 enhancements.

### Net Assessment

**The step executor is a significant implementation effort but well-structured.**
Split into per-handler files. Start with 6 core handlers for E2E, add advanced
handlers later.

**Action:** Document step handler implementation strategy in the HLD. Identify
which handlers are E2E-required vs Tier 3. Estimate: step executor = ~800-1200
lines total for E2E handlers.

---

## Iteration 6: Does the HLD Address the "Happy Path" AND "Sad Paths"?

### The Assumption

The Epson FAQ scenario (§3.5) shows the happy path beautifully: sitemap has URLs,
sample URL is valid, handlers work on all pages, 2 anomalies are easily repaired.

### The Problem

Real-world crawls will frequently hit sad paths. The HLD mentions them in
fundamental problems and reviews, but doesn't have a unified "what happens when
things go wrong" section. An implementer needs to know:

1. **Phase 0 fails:** Site unreachable (DNS, timeout, firewall). What does the
   user see? Can they retry? Is state cleaned up?

2. **Phase 1 fails:** Sample URL doesn't load (404, redirect, auth page).
   Does the user get a helpful error? Can they provide a different URL?

3. **Phase 2 fails:** LLM generates a handler that fails validation on all
   samples. Should it try a different approach? Ask the user? Give up?

4. **Phase 3 timeout:** User starts a crawl, gets the approval prompt, then
   leaves for 2 hours. What happens? Does the crawl expire? Can they resume?

5. **Phase 4 fails at scale:** 200 of 298 pages succeed, 98 fail. Not just
   2 anomalies — a third of pages fail. Handler is partially wrong. The HLD's
   early-stop at 5 anomalies would pause at page ~15. But what if failures
   are spread (not clustered in the first 20)?

6. **Phase 5 can't repair:** LLM can't figure out why pages fail. Anomaly
   resolution fails. What's the final fallback?

### Counter

**Define explicit sad path handling for each phase:**

```
Phase 0 FAILS:
  → Site unreachable: WS error notification with retry button
  → No sitemap + no sample URL: prompt user for URLs or sample page
  → Sitemap empty: fallback to sample URL link extraction
  → State: cleaned up on failure, no orphan Redis keys

Phase 1 FAILS:
  → Sample URL 404/redirect: WS notification "URL not found. Provide another?"
  → Auth page detected: Tier 3 prompt for credentials
  → LLM timeout/error: retry once, then WS notification "AI unavailable, retry later"
  → State: Phase 0 results preserved, retry from Phase 1

Phase 2 FAILS:
  → Handler fails validation on ALL samples: try with 'balanced' model tier
  → Still fails: WS notification "Couldn't understand this site automatically.
    Try providing a more representative sample page."
  → State: Phase 0-1 results preserved, user can adjust and retry from Phase 2

Phase 3 TIMEOUT:
  → Decision TTL: 1 hour. After expiry: crawl state moved to 'paused'
  → User returns: can approve (state still in Redis) or abandon
  → WS reconnect shows pending decision

Phase 4 HIGH FAILURE:
  → Early-stop: 5+ anomalies in first 20 pages → pause, rebuild handler
  → Spread failures: track rolling anomaly rate. If >15% in any 50-page window
    → pause, collect anomaly samples, engage Phase 5 repair
  → Handler rebuilt → re-run failed pages only (not entire batch)

Phase 5 CAN'T REPAIR:
  → After 3 repair attempts on an anomaly: mark page as 'unresolvable'
  → If >20% pages unresolvable: WS notification "Handler works for X% of pages.
    Y pages couldn't be crawled. Would you like to: (a) keep partial results,
    (b) try a different approach, (c) provide manual guidance?"
  → User guidance → save as specialized handler for edge cases
```

### Net Assessment

**The HLD needs a "Failure Modes & Recovery" section.** This is critical for
implementers — they need to know what to build for EACH failure case, not just
the happy path.

**Action:** Add §3.X "Failure Modes & Recovery" with per-phase failure handling.
Include state preservation rules (which phases' state survives failure).

---

## Iteration 7: Is the HLD Implementable as Written?

### Meta-Review: Implementability Checklist

Going through the HLD section by section, asking: "Can an implementer build
this from what's written?"

| Section                       | Implementable? | Gap                                                                                       |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| §1 Vision (3 modes)           | ✅ Clear       | None                                                                                      |
| §2 Existing infrastructure    | ✅ Clear       | File paths verified                                                                       |
| §3.0 Principles               | ✅ Clear       | Well-motivated                                                                            |
| §3.1 Architecture diagram     | ✅ Clear       | Components + connections shown                                                            |
| §3.2 CrawlIntelligenceService | ⚠️ Partially   | Method signatures clear, but prompt templates not defined                                 |
| §3.2.1 Intent + sample URL    | ✅ Clear       | Algorithm shown step-by-step                                                              |
| §3.3 Interaction patterns     | ⚠️ Partially   | Patterns clear, message format undefined (fixed in Iter 3)                                |
| §3.4 Autonomy tiers           | ✅ Clear       | Decision rules clear                                                                      |
| §3.5 Real-world flow          | ✅ Clear       | End-to-end example                                                                        |
| §3.6 Cost math                | ✅ Clear       | Token-based with per-model breakdown                                                      |
| §3.7 Deployment models        | ✅ Clear       | Cloud vs on-prem env vars                                                                 |
| §3.8 Phase elision            | ✅ Clear       | Rules table                                                                               |
| §3.9 Tenant isolation         | ✅ Clear       | Redis key format + lock pattern                                                           |
| §3.10 Operational concerns    | ✅ Clear       | Metrics, cleanup, rate limiting                                                           |
| §4 Rule book + PageHandler    | ⚠️ Partially   | Schema clear, handler selection clear. Missing: how step execution maps to MCP tool calls |
| §7 Task decomposition         | ⚠️ Partially   | Tasks listed but no effort estimates per-task for E2E path                                |
| §11 Fundamental problems      | ✅ Clear       | Root cause + response + research links                                                    |
| §12 Research tasks            | ✅ Clear       | Questions, methods, outputs, duration                                                     |
| §13 POC tasks                 | ✅ Clear       | Scope, expected outcomes, code artifacts                                                  |

### Gaps to Fill

1. **Prompt templates.** The HLD lists 4 prompt template files but doesn't
   show the actual prompt structure. The LLD should define at least the system
   prompt and expected output format for each Phase 0-2 and Phase 5 call.

2. **MCP tool call mapping.** How does `extractStructured` in a PageHandler
   translate to actual MCP tool calls? Is it `get_page_content()` with post-
   processing? Or a new compound tool? The HLD defines compound tools but
   doesn't show the execution mapping.

3. **Pipeline submission format.** The Crawl Worker submits extracted content
   to `content-processing` queue. What's the job format? The Go worker submits
   `BatchResult`. Does the Crawl Worker submit in the same format? Different?

4. **E2E effort estimates.** The task decomposition has "Est. Files" but not
   "Est. Effort." For the E2E path, implementers need: T-13 (2 days), T-14
   (3 days), T-15 (8-10 days), T-16 (5 days), T-17 (3 days), T-19 (2 days),
   T-20 (3 days).

### Net Assessment

**The HLD is 90% implementable.** The remaining 10% (prompt templates, MCP mapping,
pipeline format, effort estimates) are LLD concerns. The HLD correctly defers
these to the LLD.

**The HLD is COMPLETE.** It addresses:

- ✅ 10 fundamental problems with root causes and solutions
- ✅ 7-phase execution model with phase elision
- ✅ Batch+fork scaling with cloud/on-prem deployment
- ✅ 9 prioritized research tasks
- ✅ 5 POC tasks with success criteria
- ✅ Implementation task decomposition with dependencies
- ✅ 26+ review iterations with traceability
- ✅ E2E critical path and solve order

**What the LLD must define:**

- Exact function signatures for CrawlIntelligenceService methods
- Prompt templates (YAML) for each phase
- MCP tool call sequence for each PlaywrightStep action
- Pipeline job submission format
- Database migration scripts
- Test plan with fixtures

**Action:** Add effort estimates to task decomposition for E2E path. Mark the
HLD as ready for LLD decomposition.

---

## Cross-Cutting Assessment (v4)

### Implementation Priority (E2E First)

The design should be implemented in this order:

```
WEEK 0-1: Validate (R-3, R-6, POC-1) → Go/No-Go
WEEK 2-3: Foundation (T-13, T-14)
WEEK 3-5: Core (T-15, T-16, T-17) — the "hard middle"
WEEK 5-6: UI (T-19, T-20) → E2E Demo
WEEK 7-8: Harden (T-9a-c, T-10-11, T-18) → Production
WEEK 9-10: Scale (T-16b, KEDA, Go routing) → Enterprise
```

### Key Findings from This Review

1. **T-15 is the risk.** CrawlIntelligenceService is the largest, most complex
   component. Split into per-phase files. Budget 1 extra week for prompt iteration.
2. **PageHandler v1 vs v2.** Start with minimal schema (12 fields). Add Mode 3
   fields after E2E works.
3. **Step executor is substantial.** 6 core handlers for E2E, advanced handlers
   deferred. ~800-1200 lines of well-structured code.
4. **Sad path handling missing.** Need per-phase failure recovery documentation.
5. **Message protocol undefined.** Need explicit WS notification types + reconnect API.
6. **Simple browser fallback for E2E.** Sample URL link extraction, not full site crawl.
7. **HLD is 90% implementable.** Remaining 10% is LLD scope (prompts, MCP mapping).

### What Changed

| Aspect                 | Before v4 Review             | After v4 Review                                                   |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Implementation order   | All tasks in parallel phases | E2E critical path: R-3→POC-1→T-13→T-15→T-19                       |
| PageHandler schema     | Full schema from day 1       | v1 (E2E: 12 fields) → v2 (production: 21 fields)                  |
| Phase 0 fallback (E2E) | Full browser discovery       | Simple: sample URL link extraction                                |
| Step executor          | All 16 action types          | 6 core for E2E, 10 advanced for Tier 3                            |
| Failure handling       | Scattered in reviews         | Need unified §3.X "Failure Modes & Recovery"                      |
| WS messages            | Undefined format             | Need CrawlTogetherNotification type enum                          |
| T-15 effort            | "6 files"                    | Split into per-phase files, budget 8-10 days + 1 week for prompts |
