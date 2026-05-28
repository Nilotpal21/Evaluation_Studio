# Crawling System — Class & Sequence Diagrams

Comprehensive UML diagrams for the crawling and ingestion pipeline architecture.

> **Rendering:** These diagrams use Mermaid syntax. View them in:
>
> - GitHub (renders natively in `.md` files)
> - VS Code with [Mermaid Preview](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) extension
> - [mermaid.live](https://mermaid.live) (paste any code block)

---

## Table of Contents

- [Class Diagrams](#class-diagrams)
  - [1. Strategy & Decision Layer](#1-strategy--decision-layer)
  - [2. Disclosure & Transparency Layer](#2-disclosure--transparency-layer)
  - [3. Go Crawler Worker](#3-go-crawler-worker)
  - [4. Ingestion Service & Data Models](#4-ingestion-service--data-models)
- [Sequence Diagrams](#sequence-diagrams)
  - [1. Full Crawl Flow (Happy Path)](#1-full-crawl-flow-happy-path)
  - [2. Decision with User Interaction (Low Confidence)](#2-decision-with-user-interaction-low-confidence)
  - [3. MCP-Based Agent Crawling](#3-mcp-based-agent-crawling)
  - [4. Post-Crawl Ingestion Pipeline](#4-post-crawl-ingestion-pipeline)

---

## Class Diagrams

### 1. Strategy & Decision Layer

Maps user intent to internal crawl parameters and makes autonomous strategy decisions.

- **StrategyResolver** — converts user-facing strategies (`smart`, `single-page`, etc.) into internal params (`bulk`, `browser`, `hybrid`)
- **DecisionEngine** — 5-level hierarchy: user override > user preference > tenant policy > learned pattern > profile heuristic
- **FastProfiler / CachedProfiler** — analyzes target sites (siteType, jsRequired, sitemap, framework detection)

```mermaid
classDiagram
    direction TB

    class UserCrawlStrategy {
        <<enumeration>>
        single-page
        sitemap
        smart
        limited
        full-site
    }

    class InternalCrawlStrategy {
        <<enumeration>>
        browser
        bulk
        hybrid
    }

    class StrategyConfig {
        +strategy?: UserCrawlStrategy
        +limits?: ~maxPages, maxDurationMinutes, maxDepth~
        +fallbackStrategy?: UserCrawlStrategy
        +filters?: CrawlFilters
        +options?: ~legacy~
    }

    class CrawlFilters {
        +includePaths?: string[]
        +excludePaths?: string[]
        +contentKeywords?: string[]
    }

    class ResolvedCrawlParams {
        +internalStrategy: InternalCrawlStrategy
        +batchSize: number
        +concurrency: number
        +jsHandling: none | static | dynamic
        +discovery: ~useSitemap, followLinks, maxPages, maxDepth~
        +limits: ~maxPages, maxDurationMs, maxDepth~
        +requestedStrategy: UserCrawlStrategy
        +fallbackApplied: boolean
        +reasoning: string
    }

    class StrategyResolver {
        +resolve(config, profile): Promise~StrategyResolutionResult~
        +getStrategyMetadata(): StrategyMetadata[]
        -mapLegacyOptionsToStrategy(options): UserCrawlStrategy
        -validateStrategy(strategy, config, profile): errors, warnings
        -resolveParams(strategy, config, profile, fallback): ResolvedCrawlParams
        -selectInternalStrategy(userStrategy, profile): InternalCrawlStrategy
        -getBatchSize(strategy): number
        -getConcurrency(strategy, profile): number
        -getJsHandling(strategy, profile): string
    }

    class ISiteProfiler {
        <<interface>>
        +profile(url, options?): Promise~SiteProfile~
        +getName(): string
        +getCapabilities(): ProfilerCapabilities
    }

    class SiteProfile {
        +domain: string
        +profiledAt: Date
        +siteType: static | spa | hybrid | unknown
        +framework?: string
        +jsRequired: boolean
        +linkDensity: number
        +estimatedSize: number
        +avgResponseTime: number
        +rateLimitDetected: boolean
        +maxConcurrency: number
        +confidence: number
        +metadata: ~hasRobotsTxt, hasSitemap, htmlSize, ...~
    }

    class FastProfiler {
        +getName(): string
        +getCapabilities(): ProfilerCapabilities
        +profile(url, options?): Promise~SiteProfile~
        +extractSitemapUrls(url, maxUrls?, timeout?): Promise~string[]~
        -detectSiteType($, html): SiteType
        -detectFramework($, html): string
        -calculateLinkDensity($, domain): number
        -estimateSizeFromLinks($, linkDensity): number
        -fetchHTML(url, timeout): Promise~string~
        -checkSitemap(url): Promise~boolean~
        -fetchRobotsTxt(url): Promise~string~
    }

    class CachedProfiler {
        -profiler: ISiteProfiler
        -cache: Map~string, CacheEntry~
        -maxSize: number
        -ttlMs: number
        +getName(): string
        +getCapabilities(): ProfilerCapabilities
        +profile(url, options?): Promise~SiteProfile~
        +getStats(): CacheStats
        +clear(): void
        +invalidate(url): boolean
        -isValid(entry): boolean
        -evictOldest(): void
    }

    class IDecisionEngine {
        <<interface>>
        +decide(context: DecisionContext): Promise~CrawlDecision~
        +recordOutcome(outcome: CrawlOutcome): void
        +explain(decision: CrawlDecision): string
    }

    class DecisionContext {
        +url: string
        +tenantId: string
        +userId?: string
        +profile: SiteProfile
        +userOverride?: object
        +estimatedUrlCount?: number
        +autoDecide?: boolean
        +previousCrawl?: object
    }

    class CrawlDecision {
        +strategy: InternalCrawlStrategy
        +batchSize: number
        +concurrency: number
        +jsHandling: none | static | dynamic
        +waitForJs?: number
        +confidence: number
        +reasoning: string
        +source: string
        +alternatives?: Alternative[]
    }

    class DecisionEngine {
        -userPreferenceStore?: IUserPreferenceStore
        -tenantPolicyStore?: ITenantPolicyStore
        -patternLearner?: IPatternLearner
        -defaultBatchSizes: Record
        -defaultConcurrency: Record
        +decide(context): Promise~CrawlDecision~
        +recordOutcome(outcome): Promise~void~
        +explain(decision): string
        -applyUserOverride(context): CrawlDecision
        -applyUserPreference(context, pref): CrawlDecision
        -applyTenantPolicy(context, policy): CrawlDecision
        -applyLearnedPattern(context, pattern): CrawlDecision
        -applyProfileHeuristic(context): CrawlDecision
        -selectStrategy(profile): CrawlStrategy
        -calculateBatchSize(strategy, profile): number
        -calculateConcurrency(strategy, profile): number
        -generateAlternatives(strategy, profile): Alternative[]
    }

    class IUserPreferenceStore {
        <<interface>>
        +getPreference(userId, tenantId, domain): Promise
        +savePreference(pref): Promise
        +deletePreference(id): Promise
        +trackUsage(id): Promise
    }

    class ITenantPolicyStore {
        <<interface>>
        +getPolicy(tenantId, domain): Promise
        +createPolicy(policy): Promise
        +updatePolicy(id, updates): Promise
        +listPolicies(tenantId): Promise
    }

    class IPatternLearner {
        <<interface>>
        +learn(outcome, profile): Promise
        +getPattern(tenantId, domain): Promise
        +listPatterns(tenantId): Promise
        +decayPatterns(): Promise
    }

    ISiteProfiler <|.. FastProfiler
    ISiteProfiler <|.. CachedProfiler
    CachedProfiler o-- ISiteProfiler : wraps
    IDecisionEngine <|.. DecisionEngine
    DecisionEngine o-- IUserPreferenceStore
    DecisionEngine o-- ITenantPolicyStore
    DecisionEngine o-- IPatternLearner
    StrategyResolver ..> SiteProfile : uses
    StrategyResolver ..> ResolvedCrawlParams : produces
    StrategyConfig *-- CrawlFilters
    DecisionEngine ..> DecisionContext : consumes
    DecisionEngine ..> CrawlDecision : produces
    DecisionContext *-- SiteProfile
```

---

### 2. Disclosure & Transparency Layer

Handles user interaction when the system has low confidence, and provides a full audit trail.

- **QuestionGenerator** — creates questions for the user when decision confidence is low
- **ResponseProcessor** — applies user answers and optionally saves preferences
- **TransparencyService** — logs every decision event for auditing and timeline reconstruction
- **MongoPatternStore** — stores learned crawl patterns per domain

```mermaid
classDiagram
    direction TB

    class QuestionGenerator {
        +generate(decision, context): PromptQuestion[]
        -generateStrategyQuestion(decision, context): PromptQuestion?
        -generateBatchSizeQuestion(decision, context): PromptQuestion?
        -generateJavaScriptQuestion(decision, context): PromptQuestion?
        -generateConcurrencyQuestion(decision, context): PromptQuestion?
        -buildStrategyOptions(decision, profile): QuestionOption[]
    }

    class PromptQuestion {
        +id: string
        +type: string
        +question: string
        +context: string
        +options?: QuestionOption[]
        +defaultValue?: any
        +range?: object
        +priority: number
    }

    class QuestionOption {
        +value: string
        +label: string
        +description: string
        +recommended?: boolean
        +expectedOutcome?: object
    }

    class ResponseProcessor {
        +applyResponses(decision, questions, responses, context): Promise~ResponseApplicationResult~
        -validateInputs(questions, responses): void
        -validateAllResponses(questions, responses): object?
        -validateResponse(question, value): string?
        -applyResponse(decision, question, response): string?
        -savePreferences(responses, context): Promise~boolean~
    }

    class QuestionResponse {
        +questionId: string
        +value: any
        +saveAsPreference?: boolean
    }

    class ResponseApplicationResult {
        +success: boolean
        +updatedDecision?: CrawlDecision
        +preferencesSaved?: boolean
        +error?: string
    }

    class TransparencyService {
        -eventStore: IEventStore
        -eventEmitter: IEventEmitter
        -handlers: Map
        +logEvent(event): Promise~void~
        +getTimeline(jobId): Promise~DecisionTimeline~
        +onEvent(eventType, handler): unsubscribe
        +onAllEvents(handler): unsubscribe
        +getEventsByTenant(tenantId, options?): Promise~DecisionEvent[]~
        +getEventsByDomain(tenantId, domain): Promise~DecisionEvent[]~
        -buildPhases(events): TimelinePhase[]
        -buildSummary(events): TimelineSummary
    }

    class DecisionEvent {
        +id: string
        +type: DecisionEventType
        +timestamp: Date
        +tenantId: string
        +jobId?: string
        +domain?: string
        +data: object
        +durationMs?: number
        +success: boolean
        +error?: string
    }

    class DecisionTimeline {
        +jobId: string
        +tenantId: string
        +events: DecisionEvent[]
        +phases: TimelinePhase[]
        +summary: TimelineSummary
        +totalDuration?: number
    }

    class IPatternStore {
        <<interface>>
        +storePattern(input): Promise~StoredPattern~
        +getPattern(tenantId, domain): Promise~StoredPattern?~
        +findPatterns(query): Promise~StoredPattern[]~
        +updateCrawlMetrics(update): Promise~void~
        +deletePattern(tenantId, domain): Promise~boolean~
        +getStats(tenantId): Promise~PatternStoreStats~
    }

    class MongoPatternStore {
        +storePattern(input): Promise~StoredPattern~
        +getPattern(tenantId, domain, options?): Promise~StoredPattern?~
        +findPatterns(query): Promise~StoredPattern[]~
        +updateCrawlMetrics(update): Promise~void~
        +deletePattern(tenantId, domain): Promise~boolean~
        +getStats(tenantId): Promise~PatternStoreStats~
        +clearTenant(tenantId): Promise~number~
    }

    QuestionGenerator ..> PromptQuestion : produces
    PromptQuestion *-- QuestionOption
    ResponseProcessor ..> QuestionResponse : consumes
    ResponseProcessor ..> ResponseApplicationResult : produces
    TransparencyService ..> DecisionEvent : logs
    TransparencyService ..> DecisionTimeline : builds
    IPatternStore <|.. MongoPatternStore
```

---

### 3. Go Crawler Worker

The high-performance crawling engine written in Go, using Colly for HTTP-based HTML fetching.

- **CollyCrawler** — wraps gocolly/colly with SSRF protection, rate limiting, and metadata extraction
- **Consumer** — polls Redis for BullMQ-compatible jobs and publishes results back
- **Processor** — orchestrates job execution (batch vs recursive crawl)

```mermaid
classDiagram
    direction TB

    class Config {
        +RedisURL: string
        +QueueName: string
        +MaxConcurrency: int
        +Parallelism: int
        +MaxDepth: int
        +UserAgent: string
        +RequestTimeout: Duration
        +DelayBetween: Duration
        +MaxJobDuration: Duration
        +RespectRobotsTxt: bool
        +ExtractHTML: bool
        +ExtractText: bool
        +ExtractLinks: bool
        +ExtractMetadata: bool
        +MaxHTMLSize: int
        +MaxTextSize: int
        +LoadFromEnv()$ Config
    }

    class CollyCrawler {
        -collector: colly.Collector
        -config: Config
        +NewCollyCrawler(cfg)$ CollyCrawler
        +CrawlURL(url string): CrawlResult
        +CrawlBatch(urls []string): []CrawlResult
        +CrawlRecursive(seedURLs, strategy, filters): []CrawlResult, []string
        +Wait()
        -extractMetadata(e HTMLElement): map
        -normalizeURL(rawURL): string
        -resolveURL(base, href): string
        -isSameDomain(url1, url2): bool
        -matchesFilters(url, filters): bool
    }

    class Consumer {
        -redis: redis.Client
        -config: Config
        -ctx: context.Context
        +NewConsumer(cfg)$ Consumer, error
        +Start(handler func): error
        +PublishProgress(update ProgressUpdate): error
        +PublishResult(result BatchResult): error
        +Close(): error
        -pollJob(): JobWithMeta, error
        -processJob(jobMeta, handler)
        -completeJob(redisJobID, job, result)
        -failJob(redisJobID, job, err)
    }

    class Processor {
        -crawler: CollyCrawler
        -consumer: Consumer
        -config: Config
        +NewProcessor(cfg, crawler, consumer)$ Processor
        +ProcessJob(job CrawlJob): BatchResult, error
    }

    class CrawlJob {
        +JobID: string
        +BatchID: string
        +URLs: []string
        +TenantID: string
        +IndexID: string
        +SourceID: string
        +Strategy: CrawlStrategy
        +Filters: CrawlFilters
    }

    class CrawlStrategy {
        +FollowLinks: bool
        +MaxPages: int
        +MaxDepth: int
        +SameDomainOnly: bool
    }

    class CrawlFilters {
        +IncludePaths: []string
        +ExcludePaths: []string
    }

    class CrawlResult {
        +URL: string
        +StatusCode: int
        +Title: string
        +HTML: string
        +Text: string
        +Links: []Link
        +Metadata: map
        +CrawledAt: Time
        +Duration: int64
        +ContentLength: int
        +ContentType: string
        +Depth: int
        +Success: bool
        +Error: string
    }

    class Link {
        +Text: string
        +Href: string
        +Title: string
        +Rel: string
        +Target: string
    }

    class BatchResult {
        +JobID: string
        +BatchID: string
        +Results: []CrawlResult
        +TenantID: string
        +IndexID: string
        +SourceID: string
        +TotalURLs: int
        +Successful: int
        +Failed: int
        +Duration: int64
        +DiscoveredLinks: []string
    }

    class SSRFValidator {
        +IsURLAllowed(rawURL string): bool, error
        -isPrivateIP(ip net.IP): bool
        -isBlockedHostname(hostname): bool
    }

    Processor o-- CollyCrawler
    Processor o-- Consumer
    Processor o-- Config
    CollyCrawler o-- Config
    Consumer o-- Config
    CollyCrawler ..> CrawlResult : produces
    Processor ..> BatchResult : produces
    CrawlJob *-- CrawlStrategy
    CrawlJob *-- CrawlFilters
    BatchResult *-- CrawlResult
    CrawlResult *-- Link
    CollyCrawler ..> SSRFValidator : uses
```

---

### 4. Ingestion Service & Data Models

Node.js services that clean, store, and track crawled content through the pipeline.

- **CrawlerIngestionService** — orchestrates HTML cleaning, dedup, S3 upload, and document creation
- **ReadabilityService** — strips noise from HTML using Mozilla Readability
- **CrawlerMCPServer / BrowserPool** — Playwright-based browser automation for agent-driven crawling
- **SearchDocument / SearchChunk** — MongoDB models tracking pipeline state

```mermaid
classDiagram
    direction TB

    class CrawlerIngestionService {
        +ingestCrawledContent(input: CrawledContentInput): Promise~CrawledContentResult~
        -sanitizeMetadata(obj): Record
    }

    class CrawledContentInput {
        +indexId: string
        +sourceId: string
        +url: string
        +htmlContent: string
        +tenantId: string
        +metadata?: object
        +force?: boolean
    }

    class CrawledContentResult {
        +success: boolean
        +documentId?: string
        +originalReference?: string
        +contentType?: string
        +contentSizeBytes?: number
        +status?: string
        +error?: string
        +duplicate?: boolean
    }

    class ReadabilityService {
        +cleanHTML(rawHTML, url, siteType?): ReadabilityResult
        -isDocumentationSite(url, siteType): boolean
        -minimalClean(rawHTML): string
        -wrapInHTMLStructure(content, title): string
        -extractTitleFromHTML(html): string
        -extractTextLength(html): number
    }

    class ReadabilityResult {
        +cleanedHTML: string
        +metadata: ReadabilityMetadata
        +success: boolean
        +error?: string
    }

    class ReadabilityMetadata {
        +title: string
        +author?: string
        +excerpt?: string
        +contentLength: number
        +textContentLength: number
        +cleaned: boolean
        +sizeReduction: number
        +originalSize: number
        +cleanedSize: number
    }

    class CrawlerMCPServer {
        -server: MCPServer
        -browserPool: BrowserPool
        +start(): Promise~void~
        +stop(): Promise~void~
        -registerTools(): void
    }

    class BrowserPool {
        -browser: Browser
        -contexts: Map~string, BrowserContext~
        -maxPages: number
        -sessionTimeout: number
        +getContext(sessionId): Promise~BrowserContext~
        +getPage(sessionId): Promise~Page~
        +closeSession(sessionId): Promise~void~
        +cleanup(): Promise~void~
    }

    class CrawlJob {
        +_id: string
        +tenantId: string
        +userId?: string
        +status: queued | crawling | ingesting | indexing | completed | failed | cancelled
        +strategy: string
        +urls: ~original, expanded, crawled, failed~
        +configuration: ~strategy, limits, discovery, filters~
        +timeline: ~submittedAt, startedAt, completedAt~
        +results: ~documentsCreated, documentsIndexed, documentsFailed, chunksCreated~
        +processingErrors: Array
    }

    class SearchDocument {
        +_id: string
        +tenantId: string
        +indexId: string
        +sourceId: string
        +contentHash: string
        +originalReference: string
        +contentType: string
        +contentSizeBytes: number
        +sourceUrl: string
        +sourceMetadata: object
        +status: DocumentStatus
        +createdAt: Date
        +updatedAt: Date
    }

    class DocumentStatus {
        <<enumeration>>
        PENDING
        EXTRACTING
        EXTRACTED
        ENRICHING
        ENRICHED
        EMBEDDING
        INDEXED
    }

    class DocumentPage {
        +_id: string
        +documentId: string
        +pageNumber: number
        +text: string
        +tokenCount: number
        +layout: ~headings, structure~
        +tables?: Array
        +images?: Array
        +status: string
    }

    class SearchChunk {
        +_id: string
        +tenantId: string
        +indexId: string
        +documentId: string
        +content: string
        +tokenCount: number
        +chunkIndex: number
        +vectorId?: string
        +metadata: object
        +canonicalMetadata?: object
        +status: ChunkStatus
    }

    class ChunkStatus {
        <<enumeration>>
        PENDING
        INDEXED
    }

    CrawlerIngestionService ..> ReadabilityService : uses
    CrawlerIngestionService ..> CrawledContentInput : consumes
    CrawlerIngestionService ..> CrawledContentResult : produces
    CrawlerIngestionService ..> SearchDocument : creates
    ReadabilityService ..> ReadabilityResult : produces
    ReadabilityResult *-- ReadabilityMetadata
    CrawlerMCPServer o-- BrowserPool
    SearchDocument ..> DocumentStatus : has
    SearchChunk ..> ChunkStatus : has
    SearchDocument "1" -- "*" DocumentPage : has pages
    SearchDocument "1" -- "*" SearchChunk : has chunks
    CrawlJob "1" -- "*" SearchDocument : tracks
```

---

## Sequence Diagrams

### 1. Full Crawl Flow (Happy Path)

User submits a URL through Studio UI, the system profiles the site, makes a strategy decision, dispatches to the Go crawler, and ingests the results.

```mermaid
sequenceDiagram
    actor User
    participant UI as Studio UI<br/>(CrawlJobForm)
    participant API as SearchAI API<br/>(crawl.ts)
    participant FP as FastProfiler
    participant DE as DecisionEngine
    participant SR as StrategyResolver
    participant TS as TransparencyService
    participant Q1 as Redis Queue<br/>(static-crawl)
    participant Go as Go Crawler Worker<br/>(Processor + CollyCrawler)
    participant Q2 as Redis Queue<br/>(content-processing)
    participant IW as Ingestion Worker
    participant IS as CrawlerIngestionService
    participant RS as ReadabilityService
    participant S3 as S3 Storage
    participant DB as MongoDB
    participant Q3 as Redis Queue<br/>(search-extraction)

    User->>UI: Enter URL, select strategy
    UI->>API: POST /profile {url}
    API->>FP: profile(url)
    FP->>FP: fetchHTML(url)
    FP->>FP: detectSiteType($, html)
    FP->>FP: detectFramework($, html)
    FP->>FP: checkSitemap(url)
    FP->>FP: fetchRobotsTxt(url)
    FP-->>API: SiteProfile {siteType, jsRequired, hasSitemap, estimatedSize, confidence}
    API-->>UI: ProfileResponse {siteType, estimatedSize, hasSitemap, estimatedDuration}

    UI->>API: POST /batch {urls, indexId, sourceId, strategy, limits, filters}
    API->>API: Validate tenantId, indexId, sourceId ownership

    API->>DE: decide({url, tenantId, profile, userOverride?})
    Note over DE: 5-Level Hierarchy
    DE->>DE: Level 1: Check userOverride
    DE->>DE: Level 2: Check userPreferenceStore
    DE->>DE: Level 3: Check tenantPolicyStore
    DE->>DE: Level 4: Check patternLearner
    DE->>DE: Level 5: applyProfileHeuristic(profile)
    DE->>DE: selectStrategy(profile) -> bulk/browser/hybrid
    DE->>DE: calculateBatchSize, calculateConcurrency
    DE->>DE: generateAlternatives()
    DE-->>API: CrawlDecision {strategy: bulk, confidence: 85, reasoning, alternatives}
    API->>TS: logEvent(DECISION_COMPLETED)

    API->>SR: resolve(strategyConfig, profile)
    SR->>SR: selectInternalStrategy() -> bulk
    SR->>SR: resolveParams(smart -> discovery, limits)
    SR-->>API: ResolvedCrawlParams {followLinks, maxPages, maxDepth, batchSize}

    API->>DB: Create CrawlJob {status: queued, strategy, urls, timeline}
    API->>Q1: Enqueue CrawlJob {jobId, urls, strategy, filters, tenantId, indexId, sourceId}
    API-->>UI: {jobId, status: queued, estimatedDuration}

    Note over Go: Go Worker picks up job
    Q1->>Go: Poll -> CrawlJob
    Go->>Go: Processor.ProcessJob(job)
    alt strategy.followLinks == true
        Go->>Go: CrawlRecursive(seedURLs, strategy, filters)
        loop For each URL (depth-first, respecting maxPages/maxDepth)
            Go->>Go: SSRFValidator.IsURLAllowed(url)
            Go->>Go: CollyCrawler.CrawlURL(url)
            Go->>Go: Extract title, text, HTML, links, metadata
            Go->>Go: Filter discovered links (domain, path, keywords)
            Go->>Go: PublishProgress({processed, total, currentURL})
        end
    else strategy.followLinks == false
        Go->>Go: CrawlBatch(urls)
        loop For each URL (parallel goroutines)
            Go->>Go: SSRFValidator.IsURLAllowed(url)
            Go->>Go: CollyCrawler.CrawlURL(url)
        end
    end
    Go->>Q2: PublishResult(BatchResult {results[], successful, failed, discoveredLinks})

    Note over IW: Ingestion Worker picks up result
    Q2->>IW: Poll -> BatchResult
    IW->>DB: Update CrawlJob {status: ingesting}

    loop For each CrawlResult in batch
        IW->>IS: ingestCrawledContent({url, htmlContent, indexId, sourceId, tenantId})
        IS->>DB: Validate index + source belong to tenant
        IS->>RS: cleanHTML(rawHTML, url, siteType)
        RS->>RS: Readability parse -> strip nav, ads, scripts
        RS-->>IS: ReadabilityResult {cleanedHTML, metadata: {sizeReduction, title}}
        IS->>IS: qualityMetrics.analyzeQuality(raw, cleaned)
        IS->>IS: SHA256(cleanedHTML) -> contentHash
        IS->>DB: Check duplicate: findOne({originalReference: url} OR {contentHash})
        IS->>S3: Upload raw HTML -> crawler/raw/{tenantId}/{indexId}/{hash}.html
        IS->>S3: Upload cleaned HTML -> crawler/cleaned/{tenantId}/{indexId}/{hash}.html
        IS->>DB: Create SearchDocument {status: PENDING, contentHash, sourceUrl}
        IS->>Q3: Enqueue extraction job {documentId, indexId, tenantId}
        IS-->>IW: {success: true, documentId}
        IW->>IW: Publish progress event (document_processed)
    end

    IW->>DB: Update CrawlJob {results: {documentsCreated, documentsFailed}}
```

---

### 2. Decision with User Interaction (Low Confidence)

When the profiler has low confidence about the site type, the system asks the user clarifying questions before proceeding.

```mermaid
sequenceDiagram
    actor User
    participant UI as Studio UI
    participant API as SearchAI API
    participant FP as FastProfiler
    participant DE as DecisionEngine
    participant PE as PromptEvaluator
    participant QG as QuestionGenerator
    participant RP as ResponseProcessor
    participant TS as TransparencyService
    participant Redis as Redis (Pending Store)
    participant Q1 as Queue (static-crawl)

    User->>UI: Enter URL for unknown SPA site
    UI->>API: POST /profile {url}
    API->>FP: profile(url)
    FP-->>API: SiteProfile {siteType: spa, jsRequired: true, confidence: 45}
    API-->>UI: ProfileResponse

    UI->>API: POST /batch {urls, strategy: smart}
    API->>DE: decide({url, profile, tenantId})
    DE->>DE: applyProfileHeuristic -> browser strategy
    DE-->>API: CrawlDecision {strategy: browser, confidence: 45}

    API->>PE: evaluate(decision)
    Note over PE: confidence < 70 -> needs user input
    PE-->>API: {needsUserInput: true}
    API->>TS: logEvent(PROMPT_REQUIRED)

    API->>QG: generate(decision, context)
    QG->>QG: generateStrategyQuestion() -> "Which crawl method?"
    QG->>QG: generateJavaScriptQuestion() -> "Does site need JS?"
    QG->>QG: generateConcurrencyQuestion() -> "How aggressive?"
    QG-->>API: PromptQuestion[] (3 questions)
    API->>TS: logEvent(QUESTIONS_GENERATED)

    API->>Redis: Store {pendingId, decision, questions} (TTL: 10min)
    API-->>UI: {pendingId, needsUserInput: true, questions: [...]}

    Note over User: User reviews questions and responds
    User->>UI: Select answers + "Save as preference"
    UI->>API: POST /batch/respond {pendingId, responses: [...]}

    API->>Redis: Retrieve pending decision
    API->>RP: applyResponses(decision, questions, responses, context)
    RP->>RP: validateAllResponses()
    RP->>RP: applyResponse(strategy -> hybrid)
    RP->>RP: applyResponse(jsHandling -> static)
    RP->>RP: applyResponse(concurrency -> 5)
    RP->>RP: savePreferences(userId, tenantId, domain)
    RP-->>API: {success: true, updatedDecision: {strategy: hybrid, confidence: 100}}
    API->>TS: logEvent(RESPONSE_APPLIED)
    API->>TS: logEvent(PREFERENCE_SAVED)

    API->>Q1: Enqueue CrawlJob with updated strategy
    API-->>UI: {jobId, status: queued}
```

---

### 3. MCP-Based Agent Crawling

An AI agent uses browser automation tools (via MCP protocol) to intelligently navigate and extract content from JavaScript-heavy sites.

```mermaid
sequenceDiagram
    participant Agent as ABL Agent (LLM)
    participant MCP as CrawlerMCPServer
    participant Pool as BrowserPool
    participant Browser as Chromium (Playwright)
    participant Page as Page Context

    Agent->>MCP: navigate({url: "https://docs.example.com", sessionId: "s1"})
    MCP->>Pool: getPage("s1")
    Pool->>Pool: getContext("s1") -> create new BrowserContext
    Pool->>Browser: newContext() -> context
    Pool->>Page: context.newPage()
    Pool-->>MCP: page
    MCP->>Page: goto(url, {waitUntil: "networkidle"})
    Page-->>MCP: response {status: 200}
    MCP-->>Agent: {success: true, url, title: "Docs Home", statusCode: 200}

    Agent->>Agent: Reason: "I should find the docs structure"
    Agent->>MCP: extract_links({sessionId: "s1"})
    MCP->>Page: evaluate(() => document.querySelectorAll('a'))
    Page-->>MCP: links[]
    MCP-->>Agent: {links: [{href: "/api", text: "API Reference"}, {href: "/guide", text: "Guide"}, ...]}

    Agent->>Agent: Reason: "API Reference is most relevant, navigate there"
    Agent->>MCP: navigate({url: "/api", sessionId: "s1"})
    MCP->>Page: goto("/api")
    MCP-->>Agent: {success: true, title: "API Reference"}

    Agent->>MCP: get_page_content({sessionId: "s1", format: "text"})
    MCP->>Page: evaluate(() => document.body.innerText)
    Page-->>MCP: text content
    MCP-->>Agent: {content: "API Reference\n\nEndpoints:\n...", title, url}

    Agent->>Agent: Reason: "This page has expandable sections, need to click"
    Agent->>MCP: click_element({sessionId: "s1", selector: ".expand-all"})
    MCP->>Page: click(".expand-all")
    MCP->>Page: waitForTimeout(1000)
    MCP-->>Agent: {success: true}

    Agent->>MCP: get_page_content({sessionId: "s1", format: "html"})
    MCP->>Page: evaluate(() => document.body.innerHTML)
    MCP-->>Agent: {content: "<h1>API Reference</h1>...", fullHTML}

    Agent->>Agent: Reason: "Need screenshot for complex layout"
    Agent->>MCP: take_screenshot({sessionId: "s1", fullPage: true})
    MCP->>Page: screenshot({fullPage: true})
    MCP-->>Agent: {screenshot: base64data, width: 1280, height: 4500}

    Note over Agent: Agent continues navigating,<br/>extracting content from each page,<br/>making intelligent decisions about<br/>which links to follow
```

---

### 4. Post-Crawl Ingestion Pipeline

The full journey of a document through 6 pipeline stages: extraction, chunking, canonical mapping, enrichment, and embedding into OpenSearch.

```mermaid
sequenceDiagram
    participant Q_Ext as Queue<br/>(search-extraction)
    participant EW as Extraction Worker
    participant Docling as Docling Service<br/>(Python, port 8080)
    participant Q_PP as Queue<br/>(search-page-processing)
    participant PPW as Page Processing Worker
    participant Q_CM as Queue<br/>(search-canonical-map)
    participant CMW as Canonical Mapper Worker
    participant Q_Enr as Queue<br/>(search-enrichment)
    participant EnrW as Enrichment Worker
    participant Q_Emb as Queue<br/>(search-embedding)
    participant EmbW as Embedding Worker
    participant BGE as BGE-M3<br/>(port 8000)
    participant OS as OpenSearch
    participant DB as MongoDB

    Note over Q_Ext: Document created by ingestion (status: PENDING)

    Q_Ext->>EW: ExtractionJobData {documentId, indexId, tenantId}
    EW->>DB: Load SearchDocument
    EW->>EW: Read cleaned HTML from sourceUrl
    alt HTML / simple text
        EW->>EW: Extract plain text from HTML
        EW->>DB: Create DocumentPage {pageNumber: 1, text, tokenCount}
    else PDF / DOCX / images
        EW->>Docling: POST /extract {file, format}
        Docling-->>EW: {pages: [{text, tables, images, layout}...]}
        loop Each page
            EW->>DB: Create DocumentPage {pageNumber, text, tables, images, layout}
        end
    end
    EW->>DB: Update SearchDocument {status: EXTRACTED}
    EW->>Q_PP: Enqueue {documentId, pageIds, tenantId}

    Q_PP->>PPW: PageProcessingJobData {documentId, pageIds (batch of 10)}
    PPW->>DB: Load DocumentPages
    loop Each page in batch
        alt Token-based chunking
            PPW->>PPW: Split by token count, respect paragraphs
        else Markdown chunking
            PPW->>PPW: Split on H1/H2 headings, preserve code blocks
        else Page-based (default)
            PPW->>PPW: One chunk per page + separate table chunks
        end
        PPW->>PPW: Progressive summarization (context from prev chunks)
        PPW->>PPW: Generate 3-5 questions per chunk
        PPW->>DB: Create SearchChunk {content, tokenCount, chunkIndex, status: PENDING}
        PPW->>DB: Create ChunkQuestion[] (if enabled)
    end
    alt More pages remain
        PPW->>Q_PP: Enqueue next batch {pageIds, previousPageSummary}
    else All pages done
        PPW->>Q_CM: Enqueue {documentId, tenantId}
    end

    Q_CM->>CMW: CanonicalMapJobData {documentId, indexId, tenantId}
    CMW->>DB: Load document + all chunks
    CMW->>CMW: Apply field mappings (direct, lowercase, split, date_format, coalesce, compute)
    CMW->>DB: Update chunks with canonicalMetadata
    CMW->>DB: Update SearchDocument {status: ENRICHED}
    CMW->>Q_Enr: Enqueue {documentId, chunkIds, tenantId}

    Q_Enr->>EnrW: EnrichmentJobData {documentId, chunkIds, tenantId}
    EnrW->>DB: Load document + chunks
    EnrW->>DB: Update SearchDocument {status: ENRICHING}
    EnrW->>EnrW: Entity extraction (NER)
    EnrW->>EnrW: Language detection
    EnrW->>EnrW: Word/char counts
    EnrW->>DB: Update chunks with enriched metadata
    Note over EnrW: Optional fan-out:<br/>knowledge-graph, multimodal,<br/>tree-building, scope-classification
    EnrW->>DB: Update SearchDocument {status: ENRICHED}
    EnrW->>Q_Emb: Enqueue {documentId, chunkIds, tenantId}

    Q_Emb->>EmbW: EmbeddingJobData {documentId, chunkIds, tenantId}
    EmbW->>DB: Load document + chunks (sorted by chunkIndex)
    EmbW->>DB: Update SearchDocument {status: EMBEDDING}
    EmbW->>EmbW: resolveIndexForWrite() -> OpenSearch index name
    EmbW->>EmbW: Fetch permissions (Neo4j -> publicEverywhere default for web)

    loop Chunks in batches of 50
        EmbW->>BGE: embedBatch(texts[])
        BGE-->>EmbW: {embeddings: number[][], totalTokens}
        EmbW->>EmbW: Build VectorRecords {id, vector, content, metadata, permissions}
        EmbW->>OS: upsert(indexName, vectorRecords[])
        EmbW->>DB: BulkWrite: SearchChunk[] -> {vectorId, status: INDEXED}
    end

    opt Question embedding enabled
        EmbW->>DB: Load ChunkQuestions {status: pending}
        EmbW->>BGE: embedBatch(questionTexts[])
        EmbW->>OS: upsert(indexName, questionVectorRecords[])
        EmbW->>DB: Update ChunkQuestions {status: indexed}
    end

    EmbW->>DB: Update SearchDocument {status: INDEXED}
    EmbW->>DB: Update SearchIndex {$inc: chunkCount, lastIndexedAt}
    EmbW->>DB: Check CrawlJob -> all docs indexed? -> status: completed
```

---

## Key Files Reference

| Component            | File                                                         |
| -------------------- | ------------------------------------------------------------ |
| Strategy types       | `packages/crawler/src/strategy/types.ts`                     |
| Strategy resolver    | `packages/crawler/src/strategy/resolver.ts`                  |
| Decision engine      | `packages/crawler/src/decision/decision-engine.ts`           |
| Decision interfaces  | `packages/crawler/src/decision/interfaces.ts`                |
| Fast profiler        | `packages/crawler/src/profiler/fast-profiler.ts`             |
| Cached profiler      | `packages/crawler/src/profiler/cached-profiler.ts`           |
| Question generator   | `packages/crawler/src/disclosure/question-generator.ts`      |
| Response processor   | `packages/crawler/src/disclosure/response-processor.ts`      |
| Transparency service | `packages/crawler/src/transparency/transparency-service.ts`  |
| Pattern store        | `packages/crawler/src/pattern-store/mongo-pattern-store.ts`  |
| Go crawler (Colly)   | `apps/crawler-go-worker/internal/crawler/colly.go`           |
| Go queue consumer    | `apps/crawler-go-worker/internal/queue/consumer.go`          |
| Go processor         | `apps/crawler-go-worker/internal/processor/processor.go`     |
| Go job types         | `apps/crawler-go-worker/pkg/types/job.go`                    |
| Go SSRF validator    | `apps/crawler-go-worker/internal/ssrf/validator.go`          |
| Ingestion service    | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts` |
| Readability service  | `apps/search-ai/src/services/readability/index.ts`           |
| Ingestion worker     | `apps/search-ai/src/workers/crawler-ingestion-worker.ts`     |
| Embedding worker     | `apps/search-ai/src/workers/embedding-worker.ts`             |
| MCP server           | `apps/crawler-mcp-server/src/server.ts`                      |
| Browser pool         | `apps/crawler-mcp-server/src/browser/pool.ts`                |
| API routes           | `apps/search-ai/src/routes/crawl.ts`                         |
| Queue constants      | `packages/search-ai-sdk/src/constants.ts`                    |
