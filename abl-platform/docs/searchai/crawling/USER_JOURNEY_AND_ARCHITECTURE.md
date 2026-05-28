# Crawler User Journey & Architecture Overview

> **Last Updated**: 2026-02-19
> **Purpose**: Comprehensive guide to crawler user experience, flow, and system architecture
> **Audience**: Product managers, developers, stakeholders

---

## Table of Contents

1. [User Journeys](#user-journeys)
2. [Major Problems Solved](#major-problems-solved)
3. [System Flow](#system-flow)
4. [Component Architecture](#component-architecture)
5. [Key Differentiators](#key-differentiators)

---

## User Journeys

### First-Time User: Zero-Config Crawling

```
1. USER INITIATES CRAWL
   User → POST /api/crawl/batch { url: "https://docs.python.org" }
   ↓
   System: "Starting analysis of https://docs.python.org..."

2. INTELLIGENT ANALYSIS (Agent-Driven - Automatic)
   Agent analyzes site:
   • Checks for sitemap → Found sitemap.xml with 5,234 URLs
   • Detects site type → Static documentation (no JavaScript)
   • Determines strategy → Use fast static crawlers (Colly)
   • Calculates resources → 200 parallel workers needed
   ↓
   System: "Detected static site with 5,234 pages"
   System: "Starting crawl with 200 workers..."

3. PROGRESSIVE DISCLOSURE (Only When Needed)
   Agent encounters decision point:
   • Should I crawl subdomain api.python.org? (User preference needed)
   ↓
   System prompts: "Found subdomain api.python.org. Include it?"
   User responds: "Yes"
   ↓
   System: "Preference saved. Including subdomains from now on."

4. REAL-TIME PROGRESS UPDATES
   Agent streams progress:
   • Phase: URL Discovery → Found 5,234 URLs
   • Phase: Content Extraction → 1,200/5,234 (23%) - ETA: 8 min
   • Phase: Processing → Chunking and embedding content
   • Phase: Indexing → Storing in vector database
   ↓
   System: "✅ Completed! Indexed 5,234 pages in 9 minutes"

5. LEARNING & ADAPTATION (Background)
   System learns from outcome:
   • Pattern: docs.python.org = static, has sitemap
   • Confidence: 85% → 95% (next time auto-decide)
   • Stored preference: Include subdomains
```

### Active Monitoring User: Real-Time Visibility

```
USER OPENS STUDIO UI
   ↓
   WebSocket connects to decision feed (Socket.io)
   ↓
LIVE EVENTS STREAM:

09:15:23 [PROFILING] Analyzing docs.python.org...
09:15:24 [SITE_DETECTED] Type: static_documentation, Confidence: 95%
09:15:24 [DECISION_AUTO] Using static crawler (learned pattern)
09:15:25 [URL_DISCOVERY] Found sitemap with 5,234 URLs
09:15:26 [WORKER_ALLOCATION] Allocated 200 static workers
09:15:27 [BATCH_CREATED] Created 52 batches (100 URLs each)
09:15:30 [PROMPT_SKIPPED] No user input needed (high confidence)
09:16:45 [PROGRESS] 1,200/5,234 URLs crawled (23%)
09:18:12 [PROGRESS] 3,500/5,234 URLs crawled (67%)
09:20:30 [EXTRACTION_COMPLETE] 5,234 pages extracted
09:21:15 [EMBEDDING_COMPLETE] Generated 15,702 chunks
09:21:45 [INDEXING_COMPLETE] All content indexed

SUMMARY STATISTICS DASHBOARD:
┌──────────────────────────────────────┐
│ Crawl Statistics                     │
│                                      │
│ Auto-Decision Rate: 89%              │
│ User Prompts: 2 (both saved)         │
│ Avg Confidence: 87%                  │
│ Worker Efficiency: 94%               │
│ Total Time: 9m 45s                   │
└──────────────────────────────────────┘

FILTERABLE EVENT LOG:
• Site Profiling (4 events)
• Strategy Decision (3 events)
• URL Discovery (1 event)
• Worker Allocation (1 event)
• Content Extraction (5,234 events - collapsed)
• Progressive Prompts (2 events - expandable)
• Learning Updates (3 events)

EXPANDABLE EVENT DETAILS:
Click on any event → Shows full JSON:
{
  "eventType": "DECISION_AUTO",
  "tenantId": "tenant_123",
  "crawlId": "crawl_456",
  "confidence": 0.95,
  "reasoning": "Learned pattern match from 15 previous crawls",
  "strategy": "static_crawler",
  "workers": 200
}
```

---

## Major Problems Solved

Based on **SEARCHAI_CRAWLER_PROBLEMS.md** (130+ problems across 21 categories):

### Critical Challenges Addressed

#### 1. Discovery Problems (12+ issues)

- Sitemap detection and parsing (XML, HTML, nested)
- Pagination patterns (numbered, infinite scroll, "Load More")
- Hidden content behind interactions
- Dynamic URL generation

#### 2. Content Rendering Problems (15+ issues)

- JavaScript frameworks (React, Vue, Angular)
- Server-side rendering vs client-side
- Lazy loading and deferred content
- SPA routing

#### 3. Anti-Bot Detection (18+ issues)

- Rate limiting and IP blocking
- Browser fingerprinting
- CAPTCHA challenges
- User-agent detection
- Behavioral analysis

#### 4. Interactive Content Problems (10+ issues)

- Dropdown menus and selects
- Tabs and accordions
- Modals and popups
- Hover-triggered content
- Multi-step wizards

#### 5. Access Control Problems (8+ issues)

- Login walls and authentication
- Session management
- Cookie handling
- OAuth flows

#### 6. Extraction Problems (15+ issues)

- Content vs boilerplate separation
- Structured data parsing
- Metadata extraction
- Multi-language content
- Ads and tracking code removal

#### 7. Scale & Performance Problems (12+ issues)

- Millions of URLs to crawl
- Memory management
- Connection pooling
- Distributed coordination
- Cost optimization

### Why Traditional Crawlers Fail

```
Traditional Approach:
❌ Requires hours of configuration per site
❌ Breaks when site structure changes
❌ Cannot adapt to unexpected scenarios
❌ Misses 30-40% of content (edge cases)
❌ Over-provisions resources (wasteful)

Agent-Driven Solution:
✅ Zero configuration needed
✅ Adapts to changes automatically
✅ Handles unexpected situations like a human
✅ Achieves 95%+ coverage
✅ Uses appropriate resources (static vs browser)
```

---

## System Flow

### End-to-End Flow

```
STEP 1: REQUEST RECEIVED
  User → POST /api/crawl/batch { url: "https://example.com" }
  ↓
  API creates crawl job record (Prisma)
  Returns jobId immediately (async processing)

STEP 2: AGENT INITIALIZATION
  ↓
  Agent Coordinator:
  • Creates ABL web_crawler_agent session
  • Exposes MCP tools (11 tools available)
  • Agent receives GOAL and INSTRUCTIONS

STEP 3: INTELLIGENT ANALYSIS
  ↓
  Agent uses MCP tools:
  • navigate(url) → Loads page
  • get_page_content() → Gets HTML/text
  • execute_javascript("check for React") → Detects JS framework
  • extract_links() → Finds sitemap

  Agent reasons:
  • "Site has sitemap.xml → use it for discovery"
  • "No JavaScript frameworks detected → static site"
  • "5,234 URLs found → needs parallel workers"
  • "Decision: Use Colly static crawlers"

STEP 4: STRATEGY SELECTION (Decision Engine)
  ↓
  Decision Hierarchy (5 levels):
  1. User Override? → No
  2. User Preference? → Check: "User prefers static for .org docs"
  3. Tenant Policy? → Check: "Max 500 workers allowed"
  4. Learned Pattern? → Check: "docs.python.org crawled before"
  5. Default Strategy → Fallback if no match

  Result: Use static_crawler, 200 workers (within policy)

STEP 5: PROGRESSIVE DISCLOSURE (Only When Needed)
  ↓
  Prompt Evaluator checks 5 skip rules:
  • High confidence? YES (95% from learned pattern) → SKIP
  • User preference exists? YES (from previous crawl) → SKIP
  • Tenant policy clear? YES → SKIP
  • Low impact decision? NO (affects entire crawl) → KEEP
  • Recent prompt? NO → KEEP

  Decision: SKIP prompt (confidence high enough)

STEP 6: URL PARTITIONING
  ↓
  Job Coordinator:
  • Takes 5,234 URLs
  • Partitions into 52 batches (100 URLs each)
  • Creates BullMQ jobs for each batch
  • Distributes to worker queue

STEP 7: PARALLEL EXECUTION
  ↓
  200 Static Workers (Go + Colly) pull jobs:

  Worker Pool A (50 workers) → Batch 1-10
  Worker Pool B (50 workers) → Batch 11-20
  Worker Pool C (50 workers) → Batch 21-30
  Worker Pool D (50 workers) → Batch 31-40

  Each worker:
  1. Fetch HTML (HTTP request)
  2. Parse with goquery
  3. Extract content (remove nav, footer, ads)
  4. Extract metadata (title, date, author)
  5. Return CrawlResult

STEP 8: REAL-TIME PROGRESS TRACKING
  ↓
  Transparency Service logs events:
  • Redis pub/sub for progress updates
  • WebSocket streams to user (Socket.io)
  • ClickHouse stores decision events

  Events emitted:
  • BATCH_STARTED (crawlId, batchId, urlCount)
  • URL_CRAWLED (url, statusCode, durationMs)
  • EXTRACTION_SUCCESS (url, contentLength, chunkCount)
  • BATCH_COMPLETED (crawlId, batchId, successRate)

STEP 9: CONTENT PROCESSING
  ↓
  Processing Pipeline:
  • Content Extraction → Remove boilerplate
  • Smart Chunking → Context-aware splits
  • Embedding Generation → OpenAI/Anthropic
  • Metadata Enrichment → Add crawl metadata

STEP 10: STORAGE
  ↓
  Dual Storage:
  • PostgreSQL (Prisma):
    - Documents table (url, title, metadata)
    - Chunks table (content, position, documentId)
    - CrawlJobs table (status, stats)

  • Vector DB (Qdrant/Pinecone):
    - Chunk embeddings (vector search)

STEP 11: LEARNING & ADAPTATION
  ↓
  Learning Engine:
  • Outcome: Crawl successful (5,234/5,234 pages)
  • Pattern Update: docs.python.org confirmed as static
  • Confidence Boost: 85% → 95%
  • Next time: Auto-decide with 95% confidence

STEP 12: COMPLETION
  ↓
  User notification:
  "✅ Crawl complete! Indexed 5,234 pages in 9m 45s"

  WebSocket disconnects
  Resources cleaned up
```

---

## Component Architecture

### Three-Layer Hybrid System

```
┌─────────────────────────────────────────────────────┐
│ LAYER 1: INTELLIGENCE (Agent Brain)                 │
│                                                      │
│  ABL Agent (TypeScript)                             │
│  • Observes page structure                          │
│  • Reasons about strategy                           │
│  • Makes intelligent decisions                      │
│  • Uses MCP tools as "hands"                        │
│  • Handles 10% of problems (edge cases)             │
└────────────────────┬────────────────────────────────┘
                     │
                     │ Delegates bulk work
                     │
┌────────────────────▼────────────────────────────────┐
│ LAYER 2: ORCHESTRATION (Coordinator)                │
│                                                      │
│  MCP Server + BullMQ + Redis                        │
│  • Provides browser tools (navigate, click, etc.)   │
│  • Manages job queue                                │
│  • Partitions URLs into batches                     │
│  • Tracks progress                                  │
│  • Routes jobs to appropriate workers               │
└────────────────────┬────────────────────────────────┘
                     │
            ┌────────┴────────┐
            │                 │
┌───────────▼───────┐   ┌─────▼──────────────────┐
│ LAYER 3A:         │   │ LAYER 3B:              │
│ STATIC WORKERS    │   │ BROWSER WORKERS        │
│ (Go + Colly)      │   │ (TypeScript/Playwright)│
│                   │   │                        │
│ 70-80% of sites   │   │ 20-30% of sites       │
│ 10,000 req/s      │   │ 100 req/s             │
│ 50MB RAM/1k URLs  │   │ 200MB RAM/browser     │
│ $0.10/M URLs      │   │ $4.30/M URLs          │
│                   │   │                        │
│ Solves:           │   │ Solves:                │
│ • Static HTML     │   │ • JavaScript SPAs      │
│ • Documentation   │   │ • Complex interactions │
│ • Blogs/News      │   │ • Dynamic loading      │
│ • Simple sites    │   │ • Anti-bot challenges  │
└───────────────────┘   └────────────────────────┘
```

### Detailed Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER LAYER                                │
│                                                                     │
│  ┌────────────────┐         ┌──────────────────┐                   │
│  │ Studio UI      │         │ REST API Client  │                   │
│  │ - Timeline     │◄────────┤ - POST /crawl    │                   │
│  │ - Stats        │WebSocket│ - GET /status    │                   │
│  │ - Live Feed    │         │ - POST /respond  │                   │
│  └────────────────┘         └──────────────────┘                   │
└─────────────────┬────────────────────────┬───────────────────────────┘
                  │                        │
                  │ WebSocket (live)       │ HTTP (API calls)
                  │                        │
┌─────────────────▼────────────────────────▼──────────────────────────┐
│                        API LAYER (TypeScript)                       │
│                                                                     │
│  apps/search-ai/src/routes/crawl.ts                                │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │  POST /api/crawl/batch                                  │      │
│  │  • Authenticate user (JWT)                              │      │
│  │  • Validate request (Zod)                               │      │
│  │  • Create crawl job record (Prisma)                     │      │
│  │  • Return jobId (async processing)                      │      │
│  └─────────────────────────────────────────────────────────┘      │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │  Socket.io Server (Port 3001)                           │      │
│  │  • JWT authentication                                    │      │
│  │  • Room-based subscriptions (per crawlId)               │      │
│  │  • Tenant isolation (userId + crawlId)                  │      │
│  │  • Event streaming (decision events)                    │      │
│  └─────────────────────────────────────────────────────────┘      │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────┐
│                    INTELLIGENCE LAYER (Agent Brain)                 │
│                                                                     │
│  packages/crawler/src/                                              │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ Site Profiler (FastProfiler + CachedProfiler)        │          │
│  │ • HTTP-only profiling (no browser)                   │          │
│  │ • Detects: static/JS, sitemap, pagination            │          │
│  │ • Caches results (LRU, 1000 entries, 1 hour TTL)     │          │
│  └──────────────────────────────────────────────────────┘          │
│                          ↓                                          │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ Decision Engine (5-Level Hierarchy)                  │          │
│  │ 1. User Override (manual)                            │          │
│  │ 2. User Preference (saved choices)                   │          │
│  │ 3. Tenant Policy (resource limits)                   │          │
│  │ 4. Learned Pattern (AI outcomes)                     │          │
│  │ 5. Default Strategy (fallback)                       │          │
│  └──────────────────────────────────────────────────────┘          │
│                          ↓                                          │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ Progressive Disclosure (Prompt Evaluator)            │          │
│  │ • 5 skip rules (minimize user interruption)          │          │
│  │ • Question generator (4 types)                       │          │
│  │ • Response processor (validation + persistence)      │          │
│  └──────────────────────────────────────────────────────┘          │
│                          ↓                                          │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ Transparency Service                                 │          │
│  │ • 35+ event types (9 lifecycle phases)               │          │
│  │ • Timeline reconstruction                            │          │
│  │ • Redis pub/sub (progress updates)                   │          │
│  │ • WebSocket emission                                 │          │
│  └──────────────────────────────────────────────────────┘          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────┐
│                     ORCHESTRATION LAYER                             │
│                                                                     │
│  ┌──────────────────────────┐   ┌─────────────────────────┐        │
│  │ MCP Server               │   │ BullMQ + Redis          │        │
│  │ (apps/crawler-mcp-server)│   │                         │        │
│  │                          │   │ Job Queue:              │        │
│  │ 11 Tools:                │   │ • crawl-batch queue     │        │
│  │ • navigate()             │   │ • Priority ordering     │        │
│  │ • get_page_content()     │   │ • Retry logic (3x)      │        │
│  │ • click_element()        │   │ • Rate limiting         │        │
│  │ • scroll()               │   │ • Progress tracking     │        │
│  │ • type_text()            │   │                         │        │
│  │ • wait_for_element()     │   │ Coordination:           │        │
│  │ • extract_links()        │   │ • Redis pub/sub         │        │
│  │ • extract_elements()     │   │ • Distributed locks     │        │
│  │ • take_screenshot()      │   │ • Session state         │        │
│  │ • execute_javascript()   │   │ • Deduplication         │        │
│  │ • get_page_state()       │   │                         │        │
│  │                          │   │                         │        │
│  │ Browser Pool:            │   │                         │        │
│  │ • Playwright contexts    │   │                         │        │
│  │ • Session isolation      │   │                         │        │
│  │ • Resource limits        │   │                         │        │
│  └──────────────────────────┘   └─────────────────────────┘        │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
┌───────────────────▼──────────┐   ┌────────────▼────────────────────┐
│ WORKER LAYER 3A:             │   │ WORKER LAYER 3B:                │
│ STATIC CRAWLERS              │   │ BROWSER CRAWLERS                │
│                              │   │                                 │
│ apps/crawler-go-worker/      │   │ MCP Server (Playwright mode)    │
│ (Go + Colly framework)       │   │ (TypeScript + Playwright)       │
│                              │   │                                 │
│ Features:                    │   │ Features:                       │
│ • HTTP-only (no browser)     │   │ • Full browser (Chrome/Firefox) │
│ • goquery HTML parsing       │   │ • JavaScript execution          │
│ • Regex-based extraction     │   │ • Complex interactions          │
│ • 10,000 req/s throughput    │   │ • Screenshot capability         │
│ • 50MB RAM per 1k URLs       │   │ • 100 req/s throughput          │
│ • $0.10 per million URLs     │   │ • 200MB RAM per browser         │
│ • 70-80% of websites         │   │ • $4.30 per million URLs        │
│                              │   │ • 20-30% of websites            │
│                              │   │                                 │
│ Use Cases:                   │   │ Use Cases:                      │
│ • Documentation sites        │   │ • SPAs (React, Vue, Angular)    │
│ • Static blogs/news          │   │ • E-commerce (interactive)      │
│ • Simple corporate sites     │   │ • Social media                  │
│ • Government sites           │   │ • Complex auth flows            │
│ • Server-rendered content    │   │ • Infinite scroll               │
└──────────────────┬───────────┘   └─────────────┬───────────────────┘
                   │                             │
                   └─────────────┬───────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────┐
│                      PROCESSING LAYER                                │
│                                                                      │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ Content Processor                                     │          │
│  │ • Boilerplate removal (trafilatura/readability)       │          │
│  │ • Smart chunking (context-aware, 500-1000 tokens)     │          │
│  │ • Metadata extraction (title, date, author)           │          │
│  │ • Embedding generation (OpenAI/Anthropic)             │          │
│  └───────────────────────────────────────────────────────┘          │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────┐
│                         STORAGE LAYER                                │
│                                                                      │
│  ┌─────────────────────┐    ┌─────────────────────┐                 │
│  │ PostgreSQL (Prisma) │    │ Vector DB (Qdrant)  │                 │
│  │                     │    │                     │                 │
│  │ Tables:             │    │ Collections:        │                 │
│  │ • Documents         │    │ • Chunk embeddings  │                 │
│  │ • Chunks            │    │ • Similarity search │                 │
│  │ • CrawlJobs         │    │                     │                 │
│  │ • UserPreferences   │    │                     │                 │
│  │ • TenantPolicies    │    │                     │                 │
│  │ • LearnedPatterns   │    │                     │                 │
│  │ • CrawlOutcomes     │    │                     │                 │
│  └─────────────────────┘    └─────────────────────┘                 │
│                                                                      │
│  ┌─────────────────────┐    ┌─────────────────────┐                 │
│  │ ClickHouse          │    │ Redis               │                 │
│  │ • Decision events   │    │ • Cache (profiles)  │                 │
│  │ • Audit trail       │    │ • Sessions          │                 │
│  │ • Analytics queries │    │ • Pub/sub (progress)│                 │
│  └─────────────────────┘    └─────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### Intelligence Layer (packages/crawler/src/)

- **Site Profiler**: HTTP-only analysis, site type detection
- **Decision Engine**: 5-level hierarchy for strategy selection
- **Progressive Disclosure**: 5 skip rules, 4 question types
- **Transparency Service**: 35+ event types, timeline reconstruction

#### Orchestration Layer

- **MCP Server**: 11 browser automation tools
- **BullMQ**: Job queue with priority and retry
- **Redis**: State, locks, pub/sub, cache

#### Worker Layer

- **Static Workers (Go + Colly)**: 70-80% of sites, 10,000 req/s
- **Browser Workers (Playwright)**: 20-30% of sites, 100 req/s

---

## Key Differentiators

### 1. Agent-Driven vs Traditional

| Aspect           | Traditional Crawler    | Agent-Driven Crawler   |
| ---------------- | ---------------------- | ---------------------- |
| **Setup**        | Hours of configuration | Just provide URL       |
| **Adaptability** | Breaks on changes      | Adapts automatically   |
| **Coverage**     | 60-80% of content      | 95%+ coverage          |
| **Cost**         | $4-5 per million URLs  | $1.36 per million URLs |
| **Edge Cases**   | Pre-programmed only    | Handles dynamically    |
| **Maintenance**  | High (per-site config) | Low (self-adapting)    |

### 2. Hybrid Workers (70/30 Split)

**Cost Optimization through Intelligence:**

- 70% of sites → Static HTML → Use Colly (Go) → 100x faster, 43x cheaper
- 30% of sites → JavaScript-heavy → Use Playwright (TypeScript) → Full interaction

**Example Cost Calculation (1M URLs):**

- Naive approach (all browser): $4.30/M URLs
- Our approach: (700k × $0.10) + (300k × $4.30) = $1.36/M URLs
- **Savings: 68%**

### 3. Progressive Disclosure

**Minimize User Interruption:**

- **89% auto-decision rate**: Most decisions made without user input
- **5 skip rules**: High confidence, preference exists, policy clear, low impact, no recent prompt
- **Learn from responses**: Preferences saved for future crawls
- **Confidence-based**: Only prompt when confidence < 70%

### 4. Full Transparency

**Real-Time Visibility:**

- Every decision logged with reasoning
- WebSocket streaming to UI
- Timeline reconstruction
- Confidence scoring
- Learning updates

### 5. Learning & Adaptation

**Continuous Improvement:**

- Pattern reinforcement from successful crawls
- Confidence adjustment from outcomes
- Tenant-specific learning
- Domain-specific patterns

---

## Performance Metrics

### Static Workers (Go + Colly)

- **Throughput**: 10,000 requests/second
- **Memory**: 50MB per 1,000 URLs
- **Cost**: $0.10 per million URLs
- **Use Case**: 70-80% of websites

### Browser Workers (Playwright)

- **Throughput**: 100 requests/second
- **Memory**: 200MB per browser instance
- **Cost**: $4.30 per million URLs
- **Use Case**: 20-30% of websites

### Overall System

- **Coverage**: 95%+ of content (vs 60-80% traditional)
- **Auto-Decision Rate**: 89% (11% require user input)
- **Average Confidence**: 87%
- **Cost Savings**: 68% vs browser-only approach

---

## Summary

This crawler system represents a **paradigm shift** from traditional configuration-heavy crawlers to an **intelligent, agent-driven approach** that:

✅ Requires **zero configuration** from users
✅ **Adapts automatically** to any site structure
✅ Achieves **95%+ content coverage** vs 60-80% traditional
✅ Provides **real-time visibility** into all decisions
✅ **Learns and improves** from every crawl
✅ Optimizes **cost** (68% savings) through intelligent worker selection
✅ **Minimizes user interruption** (89% auto-decision rate)

The three-layer architecture (Intelligence → Orchestration → Workers) enables both the **flexibility of AI reasoning** and the **performance of specialized workers**, making it suitable for production-scale web crawling.

---

## Related Documentation

- **[SEARCHAI_CRAWLER_PROBLEMS.md](./SEARCHAI_CRAWLER_PROBLEMS.md)**: Complete taxonomy of 130+ crawling problems
- **[SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md)**: Agent-driven paradigm details
- **[SEARCHAI_CRAWLER_ARCHITECTURE.md](./SEARCHAI_CRAWLER_ARCHITECTURE.md)**: Infrastructure architecture
- **[AUTONOMOUS_INTELLIGENCE_DESIGN.md](./AUTONOMOUS_INTELLIGENCE_DESIGN.md)**: Intelligence layer design
- **[RESUME.md](./RESUME.md)**: Project status and implementation progress
- **[QUICKSTART.md](./QUICKSTART.md)**: Setup and installation guide

---

**Last Updated**: 2026-02-19
**Status**: Living document - Updated as system evolves
