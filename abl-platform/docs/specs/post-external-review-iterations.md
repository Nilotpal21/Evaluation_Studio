# Post-External Review — 3 Additional Iterations

After incorporating OpenAI consultation and external research (Firecrawl, Stagehand,
Crawlee, LangGraph), three more focused iterations on the remaining architectural gaps.

---

## Iteration 8: The Map Phase Is Missing — And It Changes Everything

### The Gap

Both OpenAI and Firecrawl's architecture point to the same thing: **we have no
deterministic site mapping phase.** Our design jumps straight from user intent to
LLM-driven browser navigation. Firecrawl's `map` endpoint discovers all URLs via
HTTP (no browser, no LLM) in seconds. Our agent opens a browser, loads pages,
reads HTML, reasons about links — taking minutes where Firecrawl takes seconds.

### Why This Matters for the Epson Scenario

The Epson FAQ navigation path (`Support > Printers > Category > Series > Model > FAQ tab`)
requires a browser because of cascading JavaScript dropdowns. BUT:

1. **robots.txt** often lists sitemap URLs
2. **sitemap.xml** may contain all 300 model page URLs directly
3. **The URL pattern** (`/faq/SPT_*`) is discoverable from a single page load
4. **The Epson support API** may be discoverable via network tab inspection —
   many sites have a JSON API behind the dropdowns

If we fetch `epson.com/robots.txt` and `epson.com/sitemap.xml` first (HTTP only,
no browser, no LLM, <1 second), we might discover all 300 model URLs without ever
touching the cascading dropdowns. This eliminates the most complex part of the crawl.

### The Fix: Add Phase 0 — Deterministic Discovery

Before the LLM touches anything:

```typescript
interface SiteDiscovery {
  robotsTxt: {
    sitemaps: string[];
    disallowedPaths: string[];
    crawlDelay?: number;
  };
  sitemapUrls: string[]; // All URLs from sitemaps
  urlPatterns: UrlPattern[]; // Grouped by pattern
  discoveredApis: ApiEndpoint[]; // JSON APIs found in page source
  pageTypeEstimates: Map<string, number>; // pattern → count
}

interface UrlPattern {
  pattern: string; // e.g., '/faq/SPT_*'
  exampleUrls: string[]; // First 3 matching URLs
  estimatedCount: number;
  pageType: 'product' | 'faq' | 'listing' | 'unknown';
}

interface ApiEndpoint {
  url: string;
  method: 'GET' | 'POST';
  discoveredFrom: string; // Which page's network requests
  responseType: 'json' | 'html' | 'unknown';
  description: string; // LLM-generated from response shape
}
```

**Execution**: HTTP-only. fetch robots.txt → parse sitemaps → classify URL patterns.
If sitemaps are empty/missing, do a quick HTTP crawl of the first 20 pages to
discover URL patterns. Still no browser, no LLM.

**Cost**: $0 (no LLM). Time: 5-15 seconds.

**Impact on Epson**: If sitemap has all 300 model URLs, we skip the entire
cascading dropdown navigation. The most complex part of our interaction design
(dropdown iteration, pagination, "Load More" buttons) becomes unnecessary for
sites with good sitemaps.

### What This Changes in the HLD

- Add new section before §3: "Phase 0 — Deterministic Site Discovery"
- Mode 2 starts with HTTP discovery, only uses browser for what HTTP can't reach
- The LLM's first view of the site includes the discovery results: "I found 300 URLs
  matching /faq/SPT\_\*. These appear to be printer FAQ pages."
- The interaction changes: instead of "navigating to find pages", the agent already
  has the pages and asks about extraction strategy

### Residual Risk

Some sites have no sitemap, block robots.txt, and render everything client-side.
For these, we still need browser-based discovery. But the map phase means the
browser path is the FALLBACK, not the default.

---

## Iteration 9: PageHandlers Must Be Playwright Scripts, Not Rule Descriptions

### The Gap

This is the convergence point from Iteration 2 (rules aren't executable), Iteration 3
(compound tools don't work generically), and the external research (Stagehand caches
selectors, Scrapy spiders ARE code, Apify actors are executable). Our rule format:

```json
{
  "action": { "type": "click-all", "selector": ".faq-category-header" }
}
```

...is a description of what to do, not code that does it. In Mode 3, something must
interpret this. The only interpreter is the LLM (expensive) or a rule compiler (complex).

### The Solution: Store Playwright Action Sequences

Instead of declarative rules, store the ACTUAL Playwright calls that worked:

```typescript
interface PageHandler {
  id: string;
  domain: string;
  urlPattern: string; // Regex or glob
  pageType: string; // 'epson-faq', 'epson-product', etc.
  createdAt: Date;
  expiresAt: Date; // Default: 90 days
  source: 'crawl-together' | 'admin' | 'system';

  // The executable recipe
  steps: PlaywrightStep[];

  // Validation
  fingerprint: PageFingerprint;
  extractionSchema: Record<string, string>; // { question: 'string', answer: 'string' }
  expectedOutput: {
    minItems: number; // At least 5 FAQs per page
    maxItems: number; // At most 200 FAQs per page
    avgContentLength: number; // ~150 words per FAQ answer
    contentSignature: string[]; // ["How to", "Steps:", "Note:"] — common patterns
  };

  // Provenance
  learnedFrom: {
    sessionId: string;
    sampleUrls: string[]; // Which pages were used to learn this
    llmModel: string; // Which model generated this
  };
}

interface PlaywrightStep {
  id: string;
  action:
    | 'navigate'
    | 'click'
    | 'clickAll'
    | 'waitForSelector'
    | 'waitForNetworkIdle'
    | 'extractText'
    | 'extractStructured'
    | 'expandAll'
    | 'scrollToBottom'
    | 'selectOption'
    | 'typeText'
    | 'screenshot';

  // Selector with fallbacks
  selector?: string; // Primary CSS selector
  selectorFallbacks?: string[]; // Fallback selectors (text-based, aria, xpath)
  textMatch?: string; // Text content to match if selectors fail

  // Action-specific params
  params?: {
    value?: string; // For typeText, selectOption
    waitStrategy?: 'networkIdle' | 'domStable' | 'selector' | 'fixed';
    waitTimeout?: number; // ms
    waitSelector?: string; // For waitStrategy: 'selector'
    extractAs?: 'text' | 'html' | 'structured';
    schema?: Record<string, string>; // For extractStructured
    maxIterations?: number; // For expandAll, scrollToBottom
    delayBetween?: number; // ms between iterations
  };

  // Conditional execution
  condition?: {
    type: 'elementExists' | 'urlMatches' | 'contentContains';
    value: string;
  };

  // What this step produces (for chaining)
  outputKey?: string; // Store result under this key

  // Failure handling
  onFailure: 'skip' | 'retry' | 'abort' | 'fallbackSelector';
  maxRetries?: number;
}

interface PageFingerprint {
  structureHash: string; // Hash of DOM tag hierarchy (no text content)
  selectorPresence: Record<string, boolean>; // Which selectors exist
  elementCounts: Record<string, number>; // Selector → count
  contentLengthRange: [number, number]; // Min-max content length
  capturedAt: Date;
}
```

### How This Works in Practice

**During Mode 2 (Crawl Together):**

1. LLM navigates to a sample page using MCP tools
2. LLM identifies selectors, figures out extraction strategy
3. System records EVERY Playwright action the LLM triggered as a `PlaywrightStep`
4. After sample page succeeds, system compiles steps into a `PageHandler`
5. LLM reviews and confirms the handler
6. Handler is validated against 2 more sample pages
7. Handler is saved to MongoDB

**During Mode 3 (Autonomous Replay):**

1. Load handler by domain + URL pattern match
2. Validate fingerprint against current page
3. If fingerprint OK → execute steps sequentially (pure Playwright, zero LLM)
4. If fingerprint diverges → escalate to Mode 2
5. After extraction → validate output against `expectedOutput` schema
6. If validation fails → escalate to Mode 2

### Why This Is Better

- **Executable without interpretation**: Each step maps to exactly one Playwright call
- **Fallback selectors**: CSS fails → try text match → try ARIA → try XPath
- **Self-validating**: fingerprint check BEFORE execution, output check AFTER
- **Debuggable**: the handler is a readable sequence of concrete browser actions
- **Versionable**: handlers can be diffed, rolled back, A/B tested
- **Zero LLM in Mode 3**: genuinely zero — no interpretation needed

### What This Changes in the HLD

- Replace §4.2 "Rule Book Schema" entirely with PageHandler schema
- Replace §3.2 Layer 4 "Replay Tools" with PageHandler executor
- Mode 3 section rewritten: replay = execute PageHandler steps
- The "rule learning" process = recording LLM's tool calls as PageHandler steps
- Remove `ICrawlRule` interface, replace with `PageHandler` + `PlaywrightStep`

---

## Iteration 10: The Execution Worker Architecture

### The Gap

Iteration 7 identified that the chat runtime can't handle 2-hour crawls.
The hybrid model (chat for intelligence, worker for execution) was proposed
but not fully designed. This iteration makes it concrete.

### The Architecture

```
Studio UI                   Runtime                    Crawl Worker
(browser)                   (agent chat)               (BullMQ long-running)
    │                           │                           │
    │ "crawl Epson FAQs"        │                           │
    ├──────────────────────────►│                           │
    │                           │                           │
    │                    Phase 0: HTTP Discovery             │
    │                    Phase 1: LLM understands site       │
    │                    Phase 2: LLM samples pages          │
    │                    Phase 3: LLM builds PageHandlers    │
    │                           │                           │
    │ "Plan: 300 models,        │                           │
    │  ~21K FAQs, ~$2.          │                           │
    │  Approve?"                │                           │
    │◄──────────────────────────┤                           │
    │                           │                           │
    │ "Approved"                │                           │
    ├──────────────────────────►│                           │
    │                           │                           │
    │                    Emit CrawlJob to BullMQ            │
    │                           ├──────────────────────────►│
    │                           │                           │
    │                           │              Execute PageHandlers
    │                           │              against 300 URLs
    │                           │              Checkpoint every page
    │                           │              ┌────────────┤
    │  Progress: 50/300         │              │ Redis:     │
    │◄─────────────────────────────────────────┤ checkpoint │
    │                           │              │ dedup set  │
    │                           │              │ progress   │
    │                           │              └────────────┤
    │                           │                           │
    │  (user closes laptop)     │                           │
    │  ╳                        │              (continues)  │
    │                           │                           │
    │                           │              Anomaly at   │
    │                           │              page 157!    │
    │                           │◄──────────────────────────┤
    │                           │              (paused)     │
    │                           │                           │
    │  (user reopens)           │                           │
    │  "Crawl needs help at     │                           │
    │   page 157"               │                           │
    │◄──────────────────────────┤                           │
    │                           │                           │
    │                    LLM resolves anomaly               │
    │                    Updates PageHandler                │
    │                           ├──────────────────────────►│
    │                           │              Resumes      │
    │                           │                           │
    │  "Done! 19,800 FAQs"      │                           │
    │◄─────────────────────────────────────────────────────┤
```

### CrawlJob Schema

```typescript
interface CrawlJob {
  id: string;
  tenantId: string;
  projectId: string;
  sessionId: string; // Links back to chat session
  createdBy: string;

  // What to crawl
  targetDomain: string;
  urls: string[]; // All discovered URLs
  pageHandlers: PageHandler[]; // Executable handlers per page type

  // Extraction target
  extractionSchema: Record<string, string>;
  pipelineTarget: string; // BullMQ queue for extracted content

  // Execution config
  concurrency: number; // Parallel browser pages (default: 3)
  rateLimitMs: number; // Min delay between requests (default: 1000)
  maxRetries: number; // Per-page retries (default: 2)
  costCapTokens: number; // Max LLM tokens if anomalies need resolution

  // State
  status: 'pending' | 'running' | 'paused' | 'anomaly' | 'completed' | 'failed';
  progress: CrawlProgress;
  checkpoint: CrawlCheckpoint;
}

interface CrawlProgress {
  totalUrls: number;
  completedUrls: number;
  failedUrls: number;
  anomalyUrls: number;
  extractedItems: number;
  deduplicatedItems: number;
  startedAt: Date;
  estimatedCompletionAt: Date;
  tokensUsed: { input: number; output: number };
  estimatedCost: number;
}

interface CrawlCheckpoint {
  lastCompletedUrl: string;
  completedUrlSet: string[]; // For resume — skip these
  dedupHashes: string[]; // Content hashes for dedup
  handlerUpdates: Map<string, PlaywrightStep[]>; // Mid-crawl handler fixes
  anomalyLog: AnomalyEntry[];
  savedAt: Date;
}

interface AnomalyEntry {
  url: string;
  pageIndex: number;
  type:
    | 'fingerprint-mismatch'
    | 'extraction-empty'
    | 'extraction-below-threshold'
    | 'selector-not-found'
    | 'unexpected-auth'
    | 'rate-limited'
    | 'error';
  details: string;
  screenshot?: string; // S3 URL of screenshot at failure point
  resolvedBy?: 'llm' | 'user' | 'retry' | 'skip';
  resolution?: string;
}
```

### Redis Key Patterns

```
crawl:{jobId}:status              → 'running' | 'paused' | ...
crawl:{jobId}:progress            → JSON CrawlProgress
crawl:{jobId}:checkpoint          → JSON CrawlCheckpoint
crawl:{jobId}:dedup               → Redis SET of content hashes
crawl:{jobId}:completed           → Redis SET of completed URLs
crawl:{jobId}:anomalies           → Redis LIST of anomaly entries
crawl:{jobId}:handler:{handlerId} → JSON PageHandler (latest version)
```

### Worker Execution Loop

```typescript
// Simplified execution loop for the crawl worker
async function executeCrawlJob(job: CrawlJob): Promise<void> {
  const browser = await chromium.launch();
  const checkpoint = await loadCheckpoint(job.id);

  // Resume from checkpoint
  const remainingUrls = job.urls.filter((url) => !checkpoint.completedUrlSet.includes(url));

  for (const url of remainingUrls) {
    // 1. Find matching handler
    const handler = findHandler(job.pageHandlers, url);
    if (!handler) {
      await recordAnomaly(job.id, url, 'no-handler');
      continue;
    }

    // 2. Navigate and fingerprint
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    const currentFingerprint = await captureFingerprint(page);

    // 3. Validate fingerprint
    if (!isFingerprintValid(handler.fingerprint, currentFingerprint)) {
      await recordAnomaly(job.id, url, 'fingerprint-mismatch');
      await page.close();
      // Don't stop — continue with other pages, batch anomalies
      continue;
    }

    // 4. Execute handler steps
    const result = await executeSteps(page, handler.steps);

    // 5. Validate extraction
    if (!validateExtraction(result, handler.expectedOutput)) {
      await recordAnomaly(job.id, url, 'extraction-below-threshold');
      await page.close();
      continue;
    }

    // 6. Dedup and submit
    const newItems = await dedup(job.id, result.items);
    if (newItems.length > 0) {
      await submitToPipeline(job.pipelineTarget, newItems);
    }

    // 7. Checkpoint
    await saveCheckpoint(job.id, url);
    await updateProgress(job.id);

    await page.close();

    // 8. Check for pause/cancel
    const status = await redis.get(`crawl:${job.id}:status`);
    if (status === 'paused' || status === 'cancelled') break;

    // 9. Rate limit
    await delay(job.rateLimitMs);
  }

  // 10. Handle anomalies
  const anomalies = await getAnomalies(job.id);
  if (anomalies.length > 0) {
    await requestLlmResolution(job.sessionId, anomalies);
    // Worker pauses, waits for handler updates from runtime
  } else {
    await markCompleted(job.id);
  }
}
```

### What This Changes in the HLD

- Add new §5: "Crawl Worker Service" with the execution architecture
- §3.1 Architecture diagram: add Crawl Worker between Runtime and MCP Server
- §7 Task Decomposition: add T-worker for "Crawl Worker BullMQ service"
- §8 Scaling: worker concurrency, browser pool sizing, rate limit pooling
- The runtime agent's role shrinks to: understand → plan → sample → handoff
- The worker's role is: execute → checkpoint → flag anomalies

### Epson Scenario Timeline

| Phase              | Who     | LLM Calls | Time        |
| ------------------ | ------- | --------- | ----------- |
| HTTP Discovery     | Worker  | 0         | 5 sec       |
| Site Understanding | Runtime | 1-2       | 30 sec      |
| Sample Pages       | Runtime | 3-5       | 2 min       |
| Build Handlers     | Runtime | 1-2       | 1 min       |
| User Approval      | User    | 0         | 30 sec      |
| Execute 300 pg     | Worker  | 0         | 30 min      |
| Handle Anomalies   | Runtime | 2-3       | 5 min       |
| **Total**          |         | **8-12**  | **~40 min** |

Cost: ~8-12 LLM calls × ~2K tokens avg = ~20K tokens.
At Claude Haiku: $0.005. At GPT-4o: $0.15. At Claude Sonnet: $0.06.

Compare to original design: 903 LLM calls, ~$9-27, ~2 hours.

---

## Cross-Cutting Conclusion

After 10 total iterations (7 self-review + 3 post-external), the design has
converged on a fundamentally different architecture from where it started:

### What Changed

| Aspect             | Original Design          | Converged Design               |
| ------------------ | ------------------------ | ------------------------------ |
| LLM role           | Drives every decision    | Understands, plans, samples    |
| Navigation         | LLM reasons per click    | Deterministic after sampling   |
| Rules              | JSON descriptions        | Executable PageHandler scripts |
| Execution          | Chat session (2 hrs)     | Worker (30 min) + chat (5 min) |
| State              | LLM context + MCP memory | Redis checkpoints              |
| Cost (Epson)       | ~$9-27 (903 LLM calls)   | ~$0.01-0.15 (8-12 LLM calls)   |
| Crash recovery     | None                     | Per-page checkpointing         |
| User disconnects   | Crawl dies               | Worker continues               |
| Selector staleness | Undetected               | Fingerprint validation         |
| Site discovery     | LLM navigates            | HTTP map phase first           |

### The 4 Key Architectural Decisions

1. **Map Before Browse**: HTTP discovery first, browser only for what HTTP can't reach
2. **LLM Understands, Worker Executes**: Split intelligence from mechanical execution
3. **PageHandlers, Not Rules**: Store executable Playwright sequences, not descriptions
4. **Checkpoint Everything**: Redis state survives crashes, disconnects, pod restarts

### Remaining Open Questions for HLD

1. How does the PageHandler learning process work inside the MCP tool flow?
   (The LLM calls MCP tools → we record the calls → compile to PageHandler)
2. How do we handle sites where HTTP discovery finds nothing? (Pure browser mode)
3. How does the worker acquire browser sessions? (New BrowserPool vs shared MCP server)
4. What's the anomaly threshold before the worker pauses for LLM help? (1? 5? 10%)
5. How does Mode 1 (Config-driven) feed into Mode 3? (Config = static PageHandler?)
