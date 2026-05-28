# SearchAI Crawler Infrastructure Architecture

> **Purpose**: Multi-layer infrastructure design for distributed web crawling at scale
> **Last Updated**: 2026-02-13
> **Status**: Reference architecture for traditional autonomous crawling infrastructure

---

## 📋 Executive Summary (For CTOs, Architects, PMs)

**What This Document Covers:**

- Multi-layer infrastructure architecture (6 layers: API → Orchestration → Queue → Workers → Processing → Storage)
- Distributed crawling strategies (horizontal scaling, worker pools, divide-and-conquer)
- Deployment options (Kubernetes, Azure Functions, Hybrid)
- Data flow and processing pipelines

**What This Document Does NOT Cover:**

- ⚠️ **Crawling Strategy**: See [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md) for current agent-driven approach
- ⚠️ **Framework Selection**: See [SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md](./SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md) for Go vs Python vs TypeScript comparison
- ⚠️ **Problem Taxonomy**: See [SEARCHAI_CRAWLER_PROBLEMS.md](./SEARCHAI_CRAWLER_PROBLEMS.md) for 130+ challenges

**Research Recommendations:**
| Area | Research Finding | Rationale |
|------|------------------|-----------|
| **Crawling Paradigm** | Agent-driven approach | Zero-config, handles any page structure dynamically |
| **Infrastructure Pattern** | Multi-layer distributed | Enables horizontal scaling to 1000+ workers |
| **Technology Stack** | TypeScript API + Go workers | Unified with ABL platform + high performance |
| **Deployment** | Kubernetes or Hybrid options | Multiple deployment options for different scales |
| **Scaling** | Horizontal (worker pools) | Divide-and-conquer enables massive parallelism |

**Read This If You Need To:**

- Design distributed crawler infrastructure
- Understand scaling patterns for 10k-1M URLs
- Choose deployment architecture (Kubernetes vs Azure Functions vs Hybrid)
- Plan implementation roadmap

**Skip This If You Need:**

- Agent-driven crawling approach → [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md)
- Framework comparison → [SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md](./SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md)

---

## Table of Contents

1. [Vision & User Experience](#1-vision--user-experience)
2. [Multi-Layer Architecture](#2-multi-layer-architecture)
3. [Distributed Crawling & Scale](#3-distributed-crawling--scale)
4. [Component Design](#4-component-design)
5. [Deployment Architecture Options](#5-deployment-architecture-options)
6. [Data Flow & Processing Pipeline](#6-data-flow--processing-pipeline)
7. [Open Research Questions](#7-open-research-questions)

---

## 1. Vision & User Experience

### 1.1 Current State (Complex)

**Traditional crawler setup:**

```typescript
// User must understand:
const crawler = new Crawler({
  maxDepth: 5, // How deep?
  maxPages: 10000, // How many?
  concurrency: 100, // How parallel?
  useJavaScript: true, // Need browser?
  selectors: {
    // What to extract?
    content: '.article',
    exclude: 'nav, footer',
  },
  rateLimit: 1000, // How fast?
  userAgent: '...', // Which UA?
  // ... 20+ more options
});
```

**Problem**: User needs deep crawling expertise!

---

### 1.2 Target State (Agent-Driven)

**SearchAI vision:**

```typescript
// User provides:
const crawl = await searchAI.crawl({
  url: 'https://docs.python.org',
});

// Agent does everything:
// ✅ Analyzes site architecture
// ✅ Detects if JS required
// ✅ Finds sitemap
// ✅ Determines optimal concurrency
// ✅ Extracts content automatically
// ✅ Scales workers as needed
// ✅ Provides real-time progress
```

**User Experience:**

```
User: "Crawl https://docs.python.org"
  ↓
Agent: "Analyzing site... detected static documentation"
Agent: "Found sitemap with 5,234 URLs"
Agent: "Starting crawl with 200 parallel workers"
Agent: "Progress: 1,200/5,234 (23%) - ETA: 8 minutes"
Agent: "Completed! Indexed 5,234 pages."
```

**📄 See**: [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md) for complete agent-driven approach

---

### 1.3 Key Design Goals

1. **Zero-Config Crawling**: User provides URL, system does everything
2. **Agent-Guided Execution**: Agent analyzes site and adapts dynamically
3. **Automatic Scaling**: System scales workers based on load
4. **Real-Time Progress**: Live updates to user
5. **Intelligent Extraction**: Agent determines what's content vs boilerplate
6. **Parallel Execution**: Divide-and-conquer for speed
7. **Fault Tolerance**: Handles failures gracefully
8. **Cost Optimization**: Uses appropriate resources (static vs browser)

---

## 2. Multi-Layer Architecture

### 2.1 Architectural Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: User Interface & API Layer                            │
│  - REST API (apps/search-ai)                                    │
│  - Studio UI (connection management)                            │
│  - ABL Agent Integration (tool binding)                         │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│  Layer 2: Orchestration Layer                                   │
│  - Agent Coordinator (session management)                       │
│  - MCP Server (crawler tools: navigate, click, extract)         │
│  - Progress Monitor (real-time updates)                         │
│  - Job Scheduler (batch vs real-time)                           │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│  Layer 3: Job Queue & Coordination Layer                        │
│  - BullMQ (job queue, priority, retry)                          │
│  - Redis (state, locks, coordination)                           │
│  - Load Balancer (distribute work)                              │
└─────────────────────┬───────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │                           │
┌───────▼──────────┐     ┌──────────▼─────────┐
│  Layer 4A:       │     │  Layer 4B:         │
│  Static Crawler  │     │  Browser Crawler   │
│  Workers         │     │  Workers           │
│  (Go/Colly)      │     │  (Go/rod or TS)    │
│  - 1000+ workers │     │  - 50-200 workers  │
│  - Fast path     │     │  - JS path         │
└───────┬──────────┘     └──────────┬─────────┘
        │                           │
        └─────────────┬─────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│  Layer 5: Content Processing Layer                              │
│  - Extraction Service (content vs boilerplate)                  │
│  - Chunking Service (smart chunking)                            │
│  - Embedding Service (vector generation)                        │
│  - Python/ML Services (advanced extraction)                     │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│  Layer 6: Storage Layer                                         │
│  - Prisma/PostgreSQL (metadata, documents, chunks)              │
│  - Vector DB (embeddings - Qdrant/Pinecone)                     │
│  - Object Storage (raw HTML - S3/MinIO)                         │
│  - Cache (Redis - deduplication, rate limiting)                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.2 Layer Responsibilities

| Layer                   | Responsibility                   | Technology              | Scalability            |
| ----------------------- | -------------------------------- | ----------------------- | ---------------------- |
| **1. API**              | User interaction, authentication | TypeScript/Express      | Horizontal (stateless) |
| **2. Orchestration**    | Agent coordination, MCP tools    | TypeScript + ABL Agent  | Vertical (CPU)         |
| **3. Queue**            | Job management, coordination     | BullMQ + Redis          | Horizontal (workers)   |
| **4A. Static Workers**  | Fast HTML crawling               | Go/Colly                | Horizontal (1000+)     |
| **4B. Browser Workers** | JS rendering, interaction        | Go/rod or TS/Playwright | Horizontal (50-200)    |
| **5. Processing**       | Extraction, chunking, embedding  | Python/TS               | Horizontal (workers)   |
| **6. Storage**          | Data persistence, search         | PostgreSQL, Qdrant, S3  | Vertical + Horizontal  |

**📄 Framework Selection**: See [SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md](./SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md) for detailed comparison

---

## 3. Distributed Crawling & Scale

> **Note**: This section describes traditional autonomous crawler scaling patterns. For agent-driven approach, see [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md).

### 3.1 Divide-and-Conquer Strategy

#### 3.1.1 URL Space Partitioning

**Problem**: Crawl 100,000 URLs efficiently

**Solution**: Partition URL space and distribute to workers

```
┌─────────────────────────────────────────────┐
│  Master Coordinator                         │
│  - Receives: 100,000 URLs from sitemap      │
│  - Partitions into batches                  │
└─────────┬───────────────────────────────────┘
          │
          ├──> Batch 1: URLs 1-1,000     → Worker Pool 1 (10 workers)
          ├──> Batch 2: URLs 1,001-2,000 → Worker Pool 2 (10 workers)
          ├──> Batch 3: URLs 2,001-3,000 → Worker Pool 3 (10 workers)
          └──> ... (100 batches total)

Each Worker Pool:
  - Processes 1,000 URLs
  - 10 workers × 100 concurrent = 1,000 URLs in parallel
  - Time: ~1-2 minutes per batch

Total Time: ~1-2 minutes (parallel) vs ~100 minutes (sequential)
```

---

#### 3.1.2 Domain-Based Partitioning

**Use Case**: Crawling multiple domains

```
Input:
  - docs.python.org (5,000 URLs)
  - nodejs.org/docs (3,000 URLs)
  - developer.mozilla.org (10,000 URLs)

Strategy: One worker pool per domain

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Pool 1         │     │  Pool 2         │     │  Pool 3         │
│  python.org     │     │  nodejs.org     │     │  mozilla.org    │
│  100 workers    │     │  50 workers     │     │  200 workers    │
└─────────────────┘     └─────────────────┘     └─────────────────┘

Benefit: Respect per-domain rate limits independently
```

---

#### 3.1.3 Hierarchical Partitioning

**Use Case**: Deep sites with tree structure

```
Site Structure:
  /
  ├── /docs/
  │   ├── /docs/python/
  │   ├── /docs/javascript/
  │   └── /docs/go/
  ├── /blog/
  └── /api-reference/

Strategy: Partition by top-level path

Worker Pool 1: /docs/python/*     (2,000 URLs)
Worker Pool 2: /docs/javascript/* (1,500 URLs)
Worker Pool 3: /docs/go/*         (1,000 URLs)
Worker Pool 4: /blog/*            (500 URLs)
Worker Pool 5: /api-reference/*   (1,000 URLs)

Benefit: Parallel crawling of independent sections
```

---

### 3.2 Scaling Patterns

#### 3.2.1 Horizontal Scaling (Workers)

```
┌─────────────────────────────────────────────────────────┐
│  Job Queue (BullMQ + Redis)                             │
│  - Contains: 100,000 URL crawl jobs                     │
└────────┬────────────────────────────────────────────────┘
         │
         │ Pull jobs (rate-limited per domain)
         │
    ┌────┴────┬────────┬────────┬────────┬────────┐
    │         │        │        │        │        │
┌───▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐
│Worker1│ │Worker2│ │Worker3│ │...  │ │Worker │ │Worker│
│       │ │       │ │       │ │     │ │  99  │ │ 100 │
└───┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘
    │        │        │        │        │        │
    └────────┴────────┴────────┴────────┴────────┘
                       │
            Store results in database

Scale up: Add more workers (200, 500, 1000)
Scale down: Remove workers when queue empty
```

**Implementation:**

```typescript
// Kubernetes: Scale deployment
kubectl scale deployment static-crawler-workers --replicas=500

// Azure Functions: Auto-scale based on queue depth
// AWS Lambda: Concurrent executions

// Or manual scaling:
for (let i = 0; i < desiredWorkerCount; i++) {
  spawnWorker();
}
```

---

#### 3.2.2 Vertical Scaling (Resources)

```
Small site (<1k URLs):
  - 1 CPU, 512MB RAM per worker
  - 10 workers = 10 CPU, 5GB RAM

Medium site (1k-10k URLs):
  - 2 CPU, 1GB RAM per worker
  - 50 workers = 100 CPU, 50GB RAM

Large site (10k-100k URLs):
  - 4 CPU, 2GB RAM per worker
  - 200 workers = 800 CPU, 400GB RAM

Browser workers (JS-heavy):
  - 2 CPU, 2GB RAM per browser instance
  - 50 browsers = 100 CPU, 100GB RAM
```

---

### 3.3 Parallel Processing Patterns

#### 3.3.1 Pipeline Parallelism

```
Stage 1: Fetch HTML (1000 workers)
  ↓
Stage 2: Extract Content (500 workers)
  ↓
Stage 3: Chunk Text (200 workers)
  ↓
Stage 4: Generate Embeddings (100 workers)
  ↓
Stage 5: Index in Vector DB (50 workers)

Each stage processes in parallel, pipeline flows continuously
```

#### 3.3.2 Batch Processing

```
Collect 1,000 URLs
  ↓
Process as batch (parallel)
  ↓
Collect next 1,000 URLs
  ↓
Process as batch (parallel)
```

#### 3.3.3 Stream Processing

```
URL discovered → Immediately crawl (no batching)
  ↓
Content extracted → Immediately chunk
  ↓
Chunks created → Immediately embed
  ↓
Embeddings ready → Immediately index

Continuous flow, no waiting for batches
```

---

## 4. Component Design

### 4.1 Agent Coordinator Service

**Responsibility**: ABL agent session management, MCP tool orchestration

```typescript
class AgentCoordinator {
  private mcpServer: MCPServer;
  private agentRegistry: AgentRegistry;

  async initializeCrawlAgent(url: string): Promise<AgentSession> {
    // Create ABL agent session for web crawling
    const agent = await this.agentRegistry.createAgent({
      type: 'web_crawler_agent',
      mode: 'reasoning',
      tools: [
        'navigate',
        'click',
        'scroll',
        'extract_links',
        'extract_content',
        'get_page_structure',
      ],
    });

    // Initialize MCP tools
    await this.mcpServer.exposeTools(agent.sessionId, {
      navigate: this.createNavigateTool(),
      click: this.createClickTool(),
      extract_content: this.createExtractTool(),
    });

    return agent;
  }

  async monitorProgress(sessionId: string): Promise<void> {
    // Stream real-time agent decisions and progress
    const stream = await this.agentRegistry.subscribeToSession(sessionId);

    stream.on('tool_call', (event) => {
      console.log(`Agent called: ${event.toolName}`, event.params);
    });

    stream.on('decision', (event) => {
      console.log(`Agent decided: ${event.reasoning}`);
    });
  }
}
```

**📄 Complete Design**: See [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md) Section 5

---

### 4.2 Job Queue & Coordinator

```typescript
class CrawlCoordinator {
  private queue: Queue; // BullMQ
  private redis: Redis;

  async submitCrawlJob(config: CrawlConfig): Promise<string> {
    const jobId = generateId();

    // Step 1: Discover all URLs (if sitemap exists)
    const urls = await this.discoverURLs(config.seedUrl);

    // Step 2: Partition URLs
    const batches = this.partitionURLs(urls, config.batchSize);

    // Step 3: Create jobs for each batch
    for (const batch of batches) {
      await this.queue.add('crawl-batch', {
        jobId,
        batchId: generateId(),
        urls: batch,
        config: config,
      });
    }

    return jobId;
  }

  private partitionURLs(urls: string[], batchSize: number): string[][] {
    // Divide-and-conquer partitioning
    const batches: string[][] = [];
    for (let i = 0; i < urls.length; i += batchSize) {
      batches.push(urls.slice(i, i + batchSize));
    }
    return batches;
  }
}
```

---

### 4.3 Worker Pools

```typescript
class WorkerPool {
  private workers: Worker[] = [];
  private type: 'static' | 'browser';

  async initialize(count: number) {
    for (let i = 0; i < count; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
      worker.start();
    }
  }

  private createWorker(): Worker {
    return {
      id: generateId(),
      type: this.type,
      async processJob(job: CrawlJob): Promise<CrawlResult> {
        if (this.type === 'static') {
          return await this.crawlStatic(job);
        } else {
          return await this.crawlBrowser(job);
        }
      },
    };
  }

  async scale(newCount: number) {
    if (newCount > this.workers.length) {
      // Scale up
      const diff = newCount - this.workers.length;
      await this.initialize(diff);
    } else {
      // Scale down
      const diff = this.workers.length - newCount;
      for (let i = 0; i < diff; i++) {
        const worker = this.workers.pop();
        await worker.stop();
      }
    }
  }
}
```

---

## 5. Deployment Architecture Options

### 5.1 Option A: Kubernetes (Full Control)

```yaml
# Recommended for: Full control, multi-tenant, high scale

Architecture:
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                     │
│                                                          │
│  ┌────────────────────────────────────────────┐        │
│  │  Namespace: search-ai                      │        │
│  │                                             │        │
│  │  Deployments:                               │        │
│  │  - api-server (2 replicas)                 │        │
│  │  - agent-coordinator (1 replica)           │        │
│  │  - static-workers (HPA: 10-1000)           │        │
│  │  - browser-workers (HPA: 5-200)            │        │
│  │  - content-processor (HPA: 10-100)         │        │
│  │                                             │        │
│  │  StatefulSets:                              │        │
│  │  - redis (3 replicas - queue & cache)      │        │
│  │  - postgresql (3 replicas - HA)            │        │
│  │                                             │        │
│  │  Jobs/CronJobs:                             │        │
│  │  - scheduled-crawls (cron)                 │        │
│  └────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

**Pros:**

- ✅ Full control over scaling
- ✅ Cost-effective (pay for nodes, not invocations)
- ✅ Can optimize resource usage
- ✅ Best for high-volume continuous crawling

**Cons:**

- ⚠️ Need to manage infrastructure
- ⚠️ Requires Kubernetes expertise

---

### 5.2 Option B: Azure Functions (Serverless)

```yaml
# Recommended for: Pay-per-use, variable workload, low maintenance

Architecture:
┌─────────────────────────────────────────────────────────┐
│  Azure Function Apps                                    │
│                                                          │
│  1. API Function App (HTTP triggers)                    │
│     - POST /crawl                                       │
│     - GET /status/:jobId                                │
│                                                          │
│  2. Orchestrator Function App (Durable Functions)       │
│     - agent-coordinator                                 │
│     - progress-monitor                                  │
│                                                          │
│  3. Worker Function Apps (Queue triggers)               │
│     - static-crawler-worker (1000 concurrent max)       │
│     - browser-crawler-worker (100 concurrent max)       │
│     - content-processor-worker (500 concurrent max)     │
│                                                          │
│  Supporting Services:                                   │
│  - Azure Queue Storage / Service Bus (job queue)        │
│  - Azure Redis Cache (state, deduplication)             │
│  - Azure PostgreSQL (metadata)                          │
│  - Azure Blob Storage (raw HTML storage)                │
└─────────────────────────────────────────────────────────┘
```

**Scaling Model:**

```
Azure Functions Auto-Scale:
- Queue depth < 100: 10 instances
- Queue depth 100-1000: 50 instances
- Queue depth 1000-10000: 200 instances
- Queue depth > 10000: 1000 instances (max)

Cost Model:
- $0.20 per million executions
- $0.000016 per GB-second of execution time

Example: 100k URLs
- 100,000 executions × $0.0000002 = $0.02
- 100,000 × 5 seconds × 512MB × $0.000016 = $40
- Total: ~$40 per 100k URLs
```

**Pros:**

- ✅ Zero infrastructure management
- ✅ Auto-scales to zero (pay only for usage)
- ✅ Fast deployment (minutes, not hours)
- ✅ Good for variable workloads

**Cons:**

- ⚠️ Coldstart latency (1-5 seconds)
- ⚠️ Max execution time limits (10 minutes per function)
- ⚠️ More expensive at very high volume

---

### 5.3 Option C: Hybrid (API on Kube, Workers Serverless)

```
Best of both worlds:

Kubernetes:
  - API server (always running)
  - Agent coordinator (always running)
  - Redis, PostgreSQL (stateful)

Azure Functions:
  - Worker pools (auto-scale to zero)
  - Content processors (burst capacity)

Benefits:
- ✅ Consistent API (no cold starts for users)
- ✅ Cost-effective workers (scale to zero)
- ✅ Burst capacity for large crawls
```

---

### 5.4 Deployment Options by Use Case

| Workload Type            | Scale        | Budget | Research Finding                            |
| ------------------------ | ------------ | ------ | ------------------------------------------- |
| Continuous high-volume   | 1M+ URLs/day | High   | Kubernetes suitable for full control        |
| Variable burst workload  | 10k-100k/day | Medium | Azure Functions suitable for pay-per-use    |
| Mixed (steady + bursts)  | 100k-1M/day  | Medium | Hybrid approach offers flexibility          |
| Small scale              | <10k/day     | Low    | Serverless reduces infrastructure overhead  |
| Enterprise with ops team | Any          | High   | Kubernetes leverages existing expertise     |
| Early stage projects     | Any          | Low    | Serverless minimizes operational complexity |

---

## 6. Data Flow & Processing Pipeline

### 6.1 End-to-End Flow

```
Step 1: User Request
  ↓
User: POST /api/crawl { url: "https://docs.python.org" }
  ↓
┌─────────────────────────────────────────────────────┐
│  API Layer (TypeScript)                             │
│  - Authenticate user                                │
│  - Create crawl job record in DB                    │
│  - Return jobId immediately (async processing)      │
└────────────────────┬────────────────────────────────┘
                     │
Step 2: Agent Init   │
                     ▼
┌─────────────────────────────────────────────────────┐
│  Agent Coordinator                                  │
│  - Initialize ABL web crawler agent                 │
│  - Expose MCP tools (navigate, click, extract)      │
│  - Agent analyzes site and starts crawling          │
│  - Agent makes decisions dynamically                │
└────────────────────┬────────────────────────────────┘
                     │
Step 3: Job Creation │
                     ▼
┌─────────────────────────────────────────────────────┐
│  Job Queue (BullMQ)                                 │
│  - Agent discovers URLs as it explores              │
│  - Partition discovered URLs into batches           │
│  - Create queue jobs for parallel workers           │
│  - Prioritize jobs based on agent decisions         │
└────────────────────┬────────────────────────────────┘
                     │
Step 4: Distribution │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
┌───────────────────┐  ┌───────────────────┐
│  Static Workers   │  │  Browser Workers  │
│  (1000 workers)   │  │  (50 workers)     │
│  - Fetch HTML     │  │  - Render JS      │
│  - Extract links  │  │  - Interact       │
│  - Quick path     │  │  - Full coverage  │
└─────────┬─────────┘  └─────────┬─────────┘
          │                      │
Step 5: Processing               │
          └──────────┬───────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  Content Processing                                 │
│  - Extract main content (remove boilerplate)        │
│  - Chunk text (context-aware chunking)              │
│  - Generate embeddings (OpenAI/Anthropic)           │
│  - Extract metadata (title, date, author)           │
└────────────────────┬────────────────────────────────┘
                     │
Step 6: Storage      │
                     ▼
┌─────────────────────────────────────────────────────┐
│  Dual Storage                                       │
│  ┌───────────────────┐  ┌────────────────────────┐ │
│  │  PostgreSQL       │  │  Vector DB (Qdrant)    │ │
│  │  - Documents      │  │  - Chunk embeddings    │ │
│  │  - Chunks         │  │  - Similarity search   │ │
│  │  - Metadata       │  │                        │ │
│  └───────────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────┘
          │
Step 7: Notification
          ▼
User receives: "Crawl complete! 5,234 pages indexed."
```

---

## 7. Open Research Questions

### Areas Requiring Further Investigation:

1. **Deployment Target**
   - Kubernetes (full control, high scale)
   - Azure Functions (serverless, low maintenance)
   - Hybrid - API on Kube, workers serverless

2. **Browser Framework**
   - Go (rod) - unified language, good performance
   - TypeScript (Playwright) - Unified with ABL platform, MCP integration

3. **Agent Integration Depth**
   - Basic (simple tool execution)
   - Medium (agent decides + monitoring)
   - Advanced - Full agent-driven with decision knowledge

4. **Scaling Strategy**
   - Start small (10 workers), scale later
   - Adaptive - Auto-scale based on load

5. **Chunking Strategy** ⚠️
   - Research validation required (see [SEARCHAI_CHUNKING_RESEARCH_UPDATE.md](../chunking/SEARCHAI_CHUNKING_RESEARCH_UPDATE.md))

---

## Summary

**Research Finding**: Multi-layer, distributed, agent-driven architecture pattern

**Key Insights**:

1. Agent-driven approach enables zero-config crawling
2. Multi-layer architecture provides clear separation of concerns
3. Divide-and-conquer enables massive parallelism (1000+ workers)
4. Hybrid static/browser approach could optimize cost (70/30 split)
5. Deployment architecture depends on scale/budget/team

**Research Recommendations - Technology Stack**:

- **API & Orchestration**: TypeScript (unified with ABL platform)
- **Agent Runtime**: ABL Agent with MCP tools
- **Static Crawling**: Go (Colly) for high-performance path
- **Browser Crawling**: TypeScript (Playwright) for JS-heavy sites
- **Deployment**: Multiple options (Kubernetes, Azure Functions, Hybrid)

**📄 Related Research**:

1. [SEARCHAI_AGENT_DRIVEN_CRAWLER.md](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md) - Agent-driven crawling paradigm
2. [SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md](./SEARCHAI_CRAWLER_FRAMEWORKS_RESEARCH.md) - Framework comparison details
3. [SEARCHAI_CRAWLER_PROBLEMS.md](./SEARCHAI_CRAWLER_PROBLEMS.md) - Complete problem taxonomy
