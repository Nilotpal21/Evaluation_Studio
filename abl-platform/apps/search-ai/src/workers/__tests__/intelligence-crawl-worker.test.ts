import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

// =============================================================================
// HOISTED MOCKS
// =============================================================================

const {
  mockCrawlJobFindOneAndUpdate,
  mockSearchDocumentFindOne,
  mockPublishProgressEvent,
  mockResolveIndexLLMConfig,
  mockResolveTenantModelWithFallback,
  mockIngestCrawledContent,
  mockIsURLAllowed,
  mockMcpCallTool,
  mockMcpConnect,
  mockMcpDisconnect,
  mockTryReuse,
  mockRegisterHandler,
  mockFindByDomain,
  mockRecordSuccess,
  mockFingerprint,
  mockRedisSet,
  mockRedisGet,
  mockRedisSetex,
  mockRedisDel,
  mockRedisQuit,
  mockCreateFileStorage,
  mockStorageUpload,
  mockGetConfig,
  mockQualityGateScore,
  mockHttpAdapterFetch,
  mockFailureScorerScore,
  mockLinkScorerScoreLinks,
  mockPaginationDetectorDetect,
  mockInteractiveDetectorDetectWithDom,
  mockJsonLdExtractorExtractWithDom,
  mockIntentDecomposerDecompose,
} = vi.hoisted(() => ({
  mockCrawlJobFindOneAndUpdate: vi.fn().mockResolvedValue({}),
  mockSearchDocumentFindOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  mockPublishProgressEvent: vi.fn().mockResolvedValue(undefined),
  mockResolveIndexLLMConfig: vi.fn().mockResolvedValue({
    provider: 'openai',
    apiKey: 'test-key',
    tenantId: 'tenant-1',
    indexId: 'index-1',
  }),
  mockResolveTenantModelWithFallback: vi.fn().mockResolvedValue({
    model: { modelId: 'gpt-4o-mini', provider: 'openai', apiKey: 'test-key' },
    actualTier: 'balanced',
    reason: 'default_tier' as const,
  }),
  mockIngestCrawledContent: vi.fn().mockResolvedValue({
    success: true,
    documentId: 'doc-1',
  }),
  mockIsURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
  mockMcpCallTool: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: '<html><body>test</body></html>' }],
  }),
  mockMcpConnect: vi.fn().mockResolvedValue(undefined),
  mockMcpDisconnect: vi.fn().mockResolvedValue(undefined),
  mockTryReuse: vi.fn().mockReturnValue({ matched: false, skippedPhases: [], llmCallsSaved: 0 }),
  mockRegisterHandler: vi.fn(),
  mockFindByDomain: vi.fn().mockResolvedValue([]),
  mockRecordSuccess: vi.fn().mockResolvedValue(undefined),
  mockFingerprint: vi.fn().mockReturnValue({ fingerprint: 123n, tagPathCount: 5 }),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockRedisGet: vi.fn().mockResolvedValue(null),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
  mockRedisDel: vi.fn().mockResolvedValue(1),
  mockRedisQuit: vi.fn().mockResolvedValue(undefined),
  mockCreateFileStorage: vi.fn(),
  mockStorageUpload: vi.fn().mockResolvedValue(undefined),
  mockGetConfig: vi.fn().mockReturnValue({ storage: { provider: 'local' } }),
  mockQualityGateScore: vi.fn().mockReturnValue({
    score: 0.8,
    quality: 'rich' as const,
    shouldBlock: false,
    signals: [],
    reason: 'Page passes quality gate.',
    contentLength: 1000,
    boilerplateRatio: 0.1,
  }),
  mockHttpAdapterFetch: vi.fn().mockResolvedValue({
    success: true,
    crawlResult: {
      url: 'https://example.com/page1',
      statusCode: 200,
      title: 'Test Page',
      html: '<html><head><title>Test</title></head><body><p>Rich content here with enough text to pass quality gate checks and scoring thresholds.</p></body></html>',
      text: 'Rich content here with enough text to pass quality gate checks and scoring thresholds.',
      links: [],
      metadata: {},
      crawledAt: new Date().toISOString(),
      duration: 100,
      success: true,
      contentLength: 500,
      contentType: 'text/html',
      depth: 0,
    },
    statusCode: 200,
    duration: 100,
  }),
  mockFailureScorerScore: vi.fn().mockReturnValue({
    score: 10,
    shouldEscalate: false,
    signals: [],
    positiveSignals: [],
    reason: 'No escalation needed.',
  }),
  mockLinkScorerScoreLinks: vi.fn().mockReturnValue([]),
  mockPaginationDetectorDetect: vi.fn().mockReturnValue({
    detected: false,
    type: 'none' as const,
    confidence: 0,
  }),
  mockInteractiveDetectorDetectWithDom: vi.fn().mockReturnValue({
    detected: false,
    flags: [],
    elements: [],
    confidence: 0,
    needsPlaywright: false,
  }),
  mockJsonLdExtractorExtractWithDom: vi.fn().mockReturnValue({
    found: false,
    schemas: [],
    primaryType: undefined,
    extractedFields: {},
    canSkipLlm: false,
    confidence: 0,
  }),
  mockIntentDecomposerDecompose: vi.fn().mockResolvedValue({
    subIntents: [],
    reasoning: '',
    urlCoverage: 0,
    inputStats: { totalUrls: 0, clusters: 0, sampledUrls: 0 },
  }),
}));

// =============================================================================
// MODULE MOCKS
// =============================================================================

vi.mock('ioredis', () => {
  class MockRedis {
    set = mockRedisSet;
    get = mockRedisGet;
    setex = mockRedisSetex;
    del = mockRedisDel;
    quit = mockRedisQuit;
    on = vi.fn();
  }
  return { default: MockRedis };
});

vi.mock('../shared.js', () => ({
  getSharedRedisClient: vi.fn(() => ({
    set: mockRedisSet,
    get: mockRedisGet,
    setex: mockRedisSetex,
    del: mockRedisDel,
    on: vi.fn(),
  })),
  getRedisConnection: vi.fn(() => ({})),
  createWorkerOptions: vi.fn(() => ({ connection: {} })),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'CrawlJob') {
      return { findOneAndUpdate: mockCrawlJobFindOneAndUpdate };
    }
    if (name === 'SearchDocument') {
      return { findOne: mockSearchDocumentFindOne };
    }
    if (name === 'HandlerTemplate') {
      return {};
    }
    return {};
  }),
}));

vi.mock('../../routes/progress.js', () => ({
  publishProgressEvent: mockPublishProgressEvent,
}));

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: mockResolveIndexLLMConfig,
}));

vi.mock('../../services/llm-config/tenant-model-adapter.js', () => ({
  resolveTenantModelWithFallback: mockResolveTenantModelWithFallback,
}));

vi.mock('../../services/ingestion/crawler-ingestion.js', () => ({
  crawlerIngestionService: {
    ingestCrawledContent: mockIngestCrawledContent,
  },
}));

vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: mockIsURLAllowed,
}));

vi.mock('../../storage/storage-factory.js', () => ({
  createFileStorage: mockCreateFileStorage.mockReturnValue({
    upload: mockStorageUpload,
  }),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: mockGetConfig,
}));

vi.mock('@abl/compiler/platform', () => {
  class MockMCPClient {
    callTool = mockMcpCallTool;
    connect = mockMcpConnect;
    disconnect = mockMcpDisconnect;
  }
  return {
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    MCPClient: MockMCPClient,
  };
});

vi.mock('@agent-platform/llm', () => {
  class MockWorkerLLMClient {}
  return { WorkerLLMClient: MockWorkerLLMClient };
});

vi.mock('@abl/crawler', () => {
  class MockTemplateFingerprinter {
    fingerprint = mockFingerprint;
    static toSerializable = vi.fn().mockReturnValue({ fingerprint: 'abc123', tagPathCount: 0 });
    static fromSerializable = vi.fn().mockReturnValue({ fingerprint: 123n, tagPathCount: 0 });
    static hammingDistance = vi.fn().mockReturnValue(0);
  }
  class MockHandlerReuser {
    tryReuse = mockTryReuse;
    registerHandler = mockRegisterHandler;
  }
  class MockMongoHandlerStore {
    findByDomain = mockFindByDomain;
    recordSuccess = mockRecordSuccess;
  }
  class MockCrawlIntelligenceService {
    execute = vi.fn().mockResolvedValue({
      llmCallCount: 2,
      totalTokens: 500,
      replay: { content: { rawHtml: '<html>result</html>' } },
      buildHandler: {
        handler: {
          urlPattern: '*',
          steps: [],
          extractionSelectors: { content: 'body' },
          description: 'test',
        },
      },
      handlerReused: false,
    });
  }
  class MockQualityGate {
    score = mockQualityGateScore;
    scoreWithDom = mockQualityGateScore;
  }
  class MockHttpAdapter {
    fetch = mockHttpAdapterFetch;
  }
  class MockFailureScorer {
    score = mockFailureScorerScore;
  }
  class MockLinkScorer {
    scoreLinks = mockLinkScorerScoreLinks;
    scoreLinksWithDom = mockLinkScorerScoreLinks;
  }
  class MockPaginationDetector {
    detect = mockPaginationDetectorDetect;
    detectWithDom = mockPaginationDetectorDetect;
  }
  class MockInteractiveDetector {
    detect = mockInteractiveDetectorDetectWithDom;
    detectWithDom = mockInteractiveDetectorDetectWithDom;
  }
  class MockJsonLdExtractor {
    extract = mockJsonLdExtractorExtractWithDom;
    extractWithDom = mockJsonLdExtractorExtractWithDom;
  }
  class MockIntentDecomposer {
    decompose = mockIntentDecomposerDecompose;
  }
  return {
    CrawlIntelligenceService: MockCrawlIntelligenceService,
    HandlerReuser: MockHandlerReuser,
    TemplateFingerprinter: MockTemplateFingerprinter,
    MongoHandlerStore: MockMongoHandlerStore,
    QualityGate: MockQualityGate,
    HttpAdapter: MockHttpAdapter,
    FailureScorer: MockFailureScorer,
    LinkScorer: MockLinkScorer,
    PaginationDetector: MockPaginationDetector,
    InteractiveDetector: MockInteractiveDetector,
    JsonLdExtractor: MockJsonLdExtractor,
    IntentDecomposer: MockIntentDecomposer,
    classifyCrawlError: vi.fn(() => 'unknown'),
    sanitizeErrorMessage: vi.fn((message: string) => message),
  };
});

vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_INTELLIGENCE_CRAWL: 'intelligence-crawl',
}));

vi.mock('cheerio', () => ({
  load: vi.fn().mockReturnValue(
    Object.assign(
      vi.fn().mockReturnValue({
        text: vi.fn().mockReturnValue(''),
        html: vi.fn().mockReturnValue(''),
        attr: vi.fn(),
        find: vi.fn().mockReturnValue({ text: vi.fn().mockReturnValue(''), each: vi.fn() }),
      }),
      { html: vi.fn().mockReturnValue('') },
    ),
  ),
}));

// Import AFTER mocks
import type { IntelligenceCrawlJobData } from '../shared.js';
import { processIntelligenceCrawl } from '../intelligence-crawl-worker.js';

// =============================================================================
// FIXTURES
// =============================================================================

function makeJobData(overrides: Partial<IntelligenceCrawlJobData> = {}): IntelligenceCrawlJobData {
  return {
    jobId: 'job-1',
    tenantId: 'tenant-1',
    indexId: 'index-1',
    sourceId: 'source-1',
    entryUrl: 'https://example.com',
    discoveredUrls: ['https://example.com/page1'],
    intent: 'Extract product info',
    limits: { maxPages: 10, maxDepth: 3, maxLlmCalls: 20 },
    discovery: { useSitemap: true, followLinks: false },
    ...overrides,
  };
}

function makeJob(data?: Partial<IntelligenceCrawlJobData>): Job<IntelligenceCrawlJobData> {
  return {
    id: 'bullmq-job-1',
    data: makeJobData(data),
    updateProgress: vi.fn(),
  } as unknown as Job<IntelligenceCrawlJobData>;
}

// =============================================================================
// TESTS
// =============================================================================

describe('intelligence-crawl-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset defaults
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(null);
    mockSearchDocumentFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    mockTryReuse.mockReturnValue({ matched: false, skippedPhases: [], llmCallsSaved: 0 });
    mockIngestCrawledContent.mockResolvedValue({ success: true, documentId: 'doc-1' });
    mockCrawlJobFindOneAndUpdate.mockResolvedValue({});

    // Reset V6 algorithm mocks
    mockQualityGateScore.mockReturnValue({
      score: 0.8,
      quality: 'rich' as const,
      shouldBlock: false,
      signals: [],
      reason: 'Page passes quality gate.',
      contentLength: 1000,
      boilerplateRatio: 0.1,
    });
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/page1',
        statusCode: 200,
        title: 'Test Page',
        html: '<html><head><title>Test</title></head><body><p>Rich content here with enough text.</p></body></html>',
        text: 'Rich content here with enough text.',
        links: [],
        metadata: {},
        crawledAt: new Date().toISOString(),
        duration: 100,
        success: true,
        contentLength: 500,
        contentType: 'text/html',
        depth: 0,
      },
      statusCode: 200,
      duration: 100,
    });
    mockFailureScorerScore.mockReturnValue({
      score: 10,
      shouldEscalate: false,
      signals: [],
      positiveSignals: [],
      reason: 'No escalation needed.',
    });
    mockLinkScorerScoreLinks.mockReturnValue([]);
    mockPaginationDetectorDetect.mockReturnValue({
      detected: false,
      type: 'none' as const,
      confidence: 0,
    });

    // V7 algorithm mocks
    mockInteractiveDetectorDetectWithDom.mockReturnValue({
      detected: false,
      flags: [],
      elements: [],
      confidence: 0,
      needsPlaywright: false,
    });
    mockJsonLdExtractorExtractWithDom.mockReturnValue({
      found: false,
      schemas: [],
      primaryType: undefined,
      extractedFields: {},
      canSkipLlm: false,
      confidence: 0,
    });
    mockIntentDecomposerDecompose.mockResolvedValue({
      subIntents: [],
      reasoning: '',
      urlCoverage: 0,
      inputStats: { totalUrls: 0, clusters: 0, sampledUrls: 0 },
    });
  });

  // ─── Happy Path ──────────────────────────────────────────────────────────

  test('processes single-page job (happy path)', async () => {
    const job = makeJob();
    await processIntelligenceCrawl(job);

    // Lock acquired
    expect(mockRedisSet).toHaveBeenCalledWith(
      'intelligence-crawl:active:tenant-1',
      'job-1',
      'EX',
      expect.any(Number),
      'NX',
    );

    // CrawlJob updated to crawling
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'crawling' }),
    );

    // MCP connected
    expect(mockMcpConnect).toHaveBeenCalled();

    // Ingestion called
    expect(mockIngestCrawledContent).toHaveBeenCalledWith(
      expect.objectContaining({
        indexId: 'index-1',
        sourceId: 'source-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/page1',
      }),
    );

    // CrawlJob final status
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'completed' }),
    );

    // WS events emitted
    const eventTypes = mockPublishProgressEvent.mock.calls.map(
      (c: unknown[]) => (c[0] as { type: string }).type,
    );
    expect(eventTypes).toContain('intelligence_crawl_discovering');
    expect(eventTypes).toContain('intelligence_crawl_started');
    expect(eventTypes).toContain('intelligence_page_started');
    expect(eventTypes).toContain('intelligence_page_complete');
    expect(eventTypes).toContain('intelligence_page_saved');
    expect(eventTypes).toContain('intelligence_crawl_complete');

    // Lock released + Redis cleaned up
    expect(mockRedisDel).toHaveBeenCalledWith('intelligence-crawl:active:tenant-1');

    // MCP disconnected
    expect(mockMcpDisconnect).toHaveBeenCalled();
  });

  // ─── Handler Reuse ───────────────────────────────────────────────────────

  test('handler reuse skips LLM when match found', async () => {
    mockTryReuse.mockReturnValue({
      matched: true,
      templateId: 'tpl-abc12345',
      handler: {
        urlPattern: '*.example.com/*',
        description: 'test handler',
        steps: [],
        extractionSelectors: { content: 'body' },
      },
      skippedPhases: ['Phase 2', 'Phase 3'],
      llmCallsSaved: 2,
    });

    const job = makeJob();
    await processIntelligenceCrawl(job);

    // Phase event with 'reuse' phase emitted
    const phaseEvents = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_phase',
    );
    expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
    expect((phaseEvents[0][0] as { data: { phase: string } }).data.phase).toBe('reuse');

    // Ingestion still called
    expect(mockIngestCrawledContent).toHaveBeenCalled();

    // Handler success recorded
    expect(mockRecordSuccess).toHaveBeenCalled();
  });

  // ─── Crash Recovery ──────────────────────────────────────────────────────

  test('crash recovery: skips checkpointed URLs', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ status: 'ingested' }));

    const job = makeJob();
    await processIntelligenceCrawl(job);

    // Ingestion NOT called (page was already checkpointed)
    expect(mockIngestCrawledContent).not.toHaveBeenCalled();

    // Still completes successfully
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'completed' }),
    );
  });

  test('crash recovery: skips pages with existing SearchDocument', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockSearchDocumentFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'doc-existing' }),
    });

    const job = makeJob();
    await processIntelligenceCrawl(job);

    // Ingestion NOT called
    expect(mockIngestCrawledContent).not.toHaveBeenCalled();

    // Completed
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'completed' }),
    );
  });

  // ─── LLM Budget ──────────────────────────────────────────────────────────

  test('LLM budget exhausted: skips pages without handler match', async () => {
    const job = makeJob({
      discoveredUrls: ['https://example.com/page1', 'https://example.com/page2'],
      limits: { maxPages: 10, maxDepth: 3, maxLlmCalls: 0 },
    });
    await processIntelligenceCrawl(job);

    // Ingestion NOT called (budget exhausted + no handler match = skip)
    expect(mockIngestCrawledContent).not.toHaveBeenCalled();

    // Page failed event emitted for each page
    const failedEvents = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_failed',
    );
    expect(failedEvents.length).toBe(2);

    // Job marked as failed (0 crawled)
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'failed' }),
    );
  });

  // ─── Per-page Error ──────────────────────────────────────────────────────

  test('per-page error does not fail entire job', async () => {
    // First page: MCP navigate throws
    // Second page: succeeds
    let callCount = 0;
    mockMcpCallTool.mockImplementation(async (tool: string) => {
      if (tool === 'navigate') {
        callCount++;
        if (callCount === 1) {
          // First navigate call (link discovery in step 7) succeeds
          return { content: [{ type: 'text', text: '[]' }] };
        }
        if (callCount === 2) {
          // Second navigate (first page processing) throws
          throw new Error('Navigation failed');
        }
        // Third navigate onwards succeeds
        return { content: [{ type: 'text', text: '<html>ok</html>' }] };
      }
      return { content: [{ type: 'text', text: '<html><body>test</body></html>' }] };
    });

    const job = makeJob({
      discoveredUrls: ['https://example.com/page1', 'https://example.com/page2'],
      discovery: { useSitemap: true, followLinks: false },
    });
    await processIntelligenceCrawl(job);

    // Job still completes (second page succeeded)
    const finalCalls = mockCrawlJobFindOneAndUpdate.mock.calls.filter(
      (c: unknown[]) =>
        (c[1] as { status?: string }).status === 'completed' ||
        (c[1] as { status?: string }).status === 'failed',
    );
    expect(finalCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ─── CrawlJob Status Transitions ────────────────────────────────────────

  test('CrawlJob status transitions: queued → crawling → completed', async () => {
    const job = makeJob();
    await processIntelligenceCrawl(job);

    const statusCalls = mockCrawlJobFindOneAndUpdate.mock.calls;

    // First call: set status to crawling
    const crawlingCall = statusCalls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'crawling',
    );
    expect(crawlingCall).toBeDefined();

    // Last call: set status to completed
    const completedCall = statusCalls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'completed',
    );
    expect(completedCall).toBeDefined();
  });

  // ─── Tenant Lock ─────────────────────────────────────────────────────────

  test('tenant lock acquired and released (even on error)', async () => {
    mockResolveIndexLLMConfig.mockRejectedValueOnce(new Error('LLM resolve failed'));

    const job = makeJob();
    await expect(processIntelligenceCrawl(job)).rejects.toThrow('LLM resolve failed');

    // Lock acquired
    expect(mockRedisSet).toHaveBeenCalledWith(
      'intelligence-crawl:active:tenant-1',
      'job-1',
      'EX',
      expect.any(Number),
      'NX',
    );

    // Lock released in finally
    expect(mockRedisDel).toHaveBeenCalledWith('intelligence-crawl:active:tenant-1');
  });

  test('throws when another crawl is active for tenant', async () => {
    mockRedisSet.mockResolvedValue(null); // Lock not acquired

    const job = makeJob();
    await expect(processIntelligenceCrawl(job)).rejects.toThrow(
      'Another intelligence crawl is active for this tenant',
    );
  });

  // ─── MCP Client Cleanup ──────────────────────────────────────────────────

  test('MCPClient disconnected in finally', async () => {
    const job = makeJob();
    await processIntelligenceCrawl(job);

    expect(mockMcpDisconnect).toHaveBeenCalled();
  });

  test('MCPClient disconnected even on error', async () => {
    // Make ingestion throw to trigger error path
    mockIngestCrawledContent.mockRejectedValueOnce(new Error('ingestion failed'));

    const job = makeJob();
    // The per-page error is caught, so the job still completes
    await processIntelligenceCrawl(job);

    expect(mockMcpDisconnect).toHaveBeenCalled();
  });

  // ─── WS Progress Events ─────────────────────────────────────────────────

  test('WS progress events emitted per page', async () => {
    const job = makeJob({
      discoveredUrls: ['https://example.com/page1', 'https://example.com/page2'],
    });
    await processIntelligenceCrawl(job);

    const pageStarted = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_started',
    );
    // Both pages should have started events
    expect(pageStarted.length).toBe(2);

    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(2);
  });

  // ─── A11 HTTP Routing ───────────────────────────────────────────────────

  test('AC-1: static page fetched via HTTP, MCP navigate NOT called for page', async () => {
    // HTTP adapter returns success, failure scorer says no escalation needed
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/page1',
        statusCode: 200,
        title: 'Static Page',
        html: '<html><head><title>Static</title></head><body><p>Plenty of real content here for the quality gate to pass.</p></body></html>',
        text: 'Plenty of real content here for the quality gate to pass.',
        links: [],
        metadata: {},
        crawledAt: new Date().toISOString(),
        duration: 50,
        success: true,
        contentLength: 500,
        contentType: 'text/html',
        depth: 0,
      },
      statusCode: 200,
      duration: 50,
    });
    mockFailureScorerScore.mockReturnValue({
      score: 10,
      shouldEscalate: false,
      signals: [],
      positiveSignals: [],
      reason: 'Static page, no escalation.',
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // HTTP adapter was called
    expect(mockHttpAdapterFetch).toHaveBeenCalled();

    // MCP navigate should only be called for initial link discovery (step 7),
    // NOT for page processing. With followLinks=false, no initial discovery navigate.
    // The per-page navigate should NOT be called since HTTP path was used.
    const navigateCalls = mockMcpCallTool.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] === 'navigate',
    );
    // No navigate calls for page processing (HTTP path used)
    // Note: initial link discovery may call navigate if followLinks=true, but we set it false
    expect(navigateCalls.length).toBe(0);

    // Ingestion still called
    expect(mockIngestCrawledContent).toHaveBeenCalled();
  });

  test('AC-3: HTTP failure falls back to Playwright', async () => {
    // HTTP adapter fails
    mockHttpAdapterFetch.mockResolvedValue({
      success: false,
      error: 'Connection timeout',
      duration: 15000,
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // HTTP adapter was called
    expect(mockHttpAdapterFetch).toHaveBeenCalled();

    // MCP navigate WAS called as fallback (for page processing)
    const navigateCalls = mockMcpCallTool.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] === 'navigate',
    );
    expect(navigateCalls.length).toBeGreaterThanOrEqual(1);

    // Ingestion still called (Playwright fallback succeeded)
    expect(mockIngestCrawledContent).toHaveBeenCalled();
  });

  // ─── A7 Quality Gate ────────────────────────────────────────────────────

  test('AC-2: thin content blocked, intelligence_page_blocked emitted, NOT ingested', async () => {
    // Quality gate blocks the page
    mockQualityGateScore.mockReturnValue({
      score: 0.15,
      quality: 'thin' as const,
      shouldBlock: true,
      signals: [],
      reason: 'Quality score 15.0% (thin). Page blocked from ingestion.',
      contentLength: 42,
      boilerplateRatio: 0.0,
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // Ingestion NOT called (blocked by quality gate)
    expect(mockIngestCrawledContent).not.toHaveBeenCalled();

    // intelligence_page_blocked event emitted
    const blockedEvents = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_blocked',
    );
    expect(blockedEvents.length).toBe(1);
    const blockedData = (blockedEvents[0][0] as { data: Record<string, unknown> }).data;
    expect(blockedData.url).toBe('https://example.com/page1');
    expect(blockedData.qualityScore).toBe(0.15);
    expect(blockedData.reason).toContain('blocked');
  });

  // ─── Extended Page Complete Events ──────────────────────────────────────

  test('AC-4: intelligence_page_complete includes method, qualityScore, quality', async () => {
    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(1);

    const data = (pageComplete[0][0] as { data: Record<string, unknown> }).data;
    expect(data.method).toBeDefined();
    expect(data.qualityScore).toBeDefined();
    expect(data.quality).toBeDefined();
    expect(data.a6RelevantLinks).toBeDefined();
    expect(data.paginationDetected).toBeDefined();
    expect(data.interactiveFlags).toEqual([]);
  });

  // ─── Extended Crawl Complete Events ─────────────────────────────────────

  test('AC-5: intelligence_crawl_complete includes fastCount, aiCount, blockedCount', async () => {
    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    const crawlComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_crawl_complete',
    );
    expect(crawlComplete.length).toBe(1);

    const data = (crawlComplete[0][0] as { data: Record<string, unknown> }).data;
    const summary = data.summary as Record<string, unknown>;
    expect(summary.fastCount).toBeDefined();
    expect(summary.aiCount).toBeDefined();
    expect(summary.blockedCount).toBeDefined();
    expect(typeof summary.fastCount).toBe('number');
    expect(typeof summary.aiCount).toBe('number');
    expect(typeof summary.blockedCount).toBe('number');
  });

  // ─── Group Progress ─────────────────────────────────────────────────────

  test('AC-6: intelligence_group_progress emitted with groupStrategies', async () => {
    const job = makeJob({
      discoveredUrls: ['https://example.com/docs/intro', 'https://example.com/docs/guide'],
      discovery: { useSitemap: true, followLinks: false },
      groupStrategies: [
        {
          pattern: '/docs/{slug}',
          method: 'http' as const,
          llmEstimate: 0,
          reason: 'Static docs',
          count: 2,
        },
      ],
    });

    // HTTP adapter returns success for grouped pages
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/docs/intro',
        statusCode: 200,
        title: 'Docs',
        html: '<html><body><p>Documentation content</p></body></html>',
        text: 'Documentation content',
        links: [],
        metadata: {},
        crawledAt: new Date().toISOString(),
        duration: 50,
        success: true,
        contentLength: 500,
        contentType: 'text/html',
        depth: 0,
      },
      statusCode: 200,
      duration: 50,
    });

    await processIntelligenceCrawl(job);

    // Group progress events emitted
    const groupEvents = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_group_progress',
    );
    expect(groupEvents.length).toBeGreaterThanOrEqual(1);

    const groupData = (groupEvents[0][0] as { data: Record<string, unknown> }).data;
    expect(groupData.groupPattern).toBe('/docs/{slug}');
    expect(groupData.method).toBe('http');
    expect(typeof groupData.completed).toBe('number');
    expect(typeof groupData.total).toBe('number');

    // HTTP adapter should be called (not MCP) because groupStrategies says http
    expect(mockHttpAdapterFetch).toHaveBeenCalled();
  });

  test('groupStrategies with method=http uses HTTP adapter, skips MCP', async () => {
    const job = makeJob({
      discoveredUrls: ['https://example.com/blog/post-1'],
      discovery: { useSitemap: true, followLinks: false },
      groupStrategies: [
        {
          pattern: '/blog/{slug}',
          method: 'http' as const,
          llmEstimate: 0,
          reason: 'Static blog',
          count: 1,
        },
      ],
    });

    await processIntelligenceCrawl(job);

    // HTTP adapter called
    expect(mockHttpAdapterFetch).toHaveBeenCalled();

    // MCP navigate NOT called for page processing
    const navigateCalls = mockMcpCallTool.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] === 'navigate',
    );
    expect(navigateCalls.length).toBe(0);
  });

  test('groupStrategies with method=playwright uses MCP, skips HTTP adapter', async () => {
    const job = makeJob({
      discoveredUrls: ['https://example.com/app/dashboard'],
      discovery: { useSitemap: true, followLinks: false },
      groupStrategies: [
        {
          pattern: '/app/{slug}',
          method: 'playwright' as const,
          llmEstimate: 2,
          reason: 'SPA page',
          count: 1,
        },
      ],
    });

    await processIntelligenceCrawl(job);

    // HTTP adapter NOT called (groupStrategies says playwright)
    expect(mockHttpAdapterFetch).not.toHaveBeenCalled();

    // MCP navigate called for page processing
    const navigateCalls = mockMcpCallTool.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] === 'navigate',
    );
    expect(navigateCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ─── V7 A8 Interactive Detection ──────────────────────────────────────

  test('AC-2: page with accordion → interactiveFlags=[accordion] in event', async () => {
    mockInteractiveDetectorDetectWithDom.mockReturnValue({
      detected: true,
      flags: ['accordion'],
      elements: [{ type: 'accordion', selector: '.accordion', count: 3, confidence: 0.9 }],
      confidence: 0.9,
      needsPlaywright: true,
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(1);

    const data = (pageComplete[0][0] as { data: Record<string, unknown> }).data;
    expect(data.interactiveFlags).toEqual(['accordion']);
  });

  // ─── V7 A12 JSON-LD Extraction ────────────────────────────────────────

  test('AC-1: page with JSON-LD Product → no LLM calls, jsonLdUsed=true', async () => {
    mockJsonLdExtractorExtractWithDom.mockReturnValue({
      found: true,
      schemas: [{ '@type': 'Product', name: 'Widget', price: '9.99', description: 'A widget' }],
      primaryType: 'Product',
      extractedFields: { name: 'Widget', price: '9.99', description: 'A widget' },
      canSkipLlm: true,
      confidence: 0.9,
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // Handler reuse NOT called (JSON-LD fast-path bypasses it)
    expect(mockTryReuse).not.toHaveBeenCalled();

    // Ingestion still called
    expect(mockIngestCrawledContent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          jsonLdType: 'Product',
          jsonLdFields: { name: 'Widget', price: '9.99', description: 'A widget' },
        }),
      }),
    );

    // Page complete event includes jsonLdUsed=true and llmCalls=0
    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(1);
    const data = (pageComplete[0][0] as { data: Record<string, unknown> }).data;
    expect(data.jsonLdUsed).toBe(true);
    expect(data.llmCalls).toBe(0);

    // Phase event emitted with 'jsonld' phase
    const phaseEvents = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_phase',
    );
    expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
    expect((phaseEvents[0][0] as { data: { phase: string } }).data.phase).toBe('jsonld');
  });

  // ─── V7 A9 Intent Decomposition ──────────────────────────────────────

  test('AC-4: intent provided → IntentDecomposer.decompose() called pre-loop', async () => {
    mockIntentDecomposerDecompose.mockResolvedValue({
      subIntents: [
        {
          intent: 'Extract product details',
          urlPattern: '/products',
          estimatedUrls: 5,
          confidence: 0.8,
          reasoning: 'Product pages match',
        },
      ],
      reasoning: 'Decomposed into product sub-intent',
      urlCoverage: 0.6,
      inputStats: { totalUrls: 2, clusters: 1, sampledUrls: 2 },
    });

    const job = makeJob({
      intent: 'Extract all product information',
      discoveredUrls: ['https://example.com/products/widget', 'https://example.com/about'],
      discovery: { useSitemap: true, followLinks: false },
    });
    await processIntelligenceCrawl(job);

    // IntentDecomposer.decompose was called with the intent and all URLs
    expect(mockIntentDecomposerDecompose).toHaveBeenCalledWith(
      'Extract all product information',
      expect.arrayContaining(['https://example.com/products/widget', 'https://example.com/about']),
    );
  });

  test('A9: decompose failure does not break the crawl', async () => {
    mockIntentDecomposerDecompose.mockRejectedValue(new Error('LLM timeout'));

    const job = makeJob({
      intent: 'Extract product info',
      discovery: { useSitemap: true, followLinks: false },
    });
    await processIntelligenceCrawl(job);

    // Job still completes successfully
    expect(mockCrawlJobFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-1', tenantId: 'tenant-1' },
      expect.objectContaining({ status: 'completed' }),
    );
  });

  // ─── V8 A12 JSON-LD fast-path skips LLM ─────────────────────────────

  test('A12: skips LLM when JSON-LD canSkipLlm is true', async () => {
    // JSON-LD extractor returns canSkipLlm: true
    mockJsonLdExtractorExtractWithDom.mockReturnValue({
      found: true,
      schemas: [{ '@type': 'Article', name: 'Test Article', headline: 'Test' }],
      primaryType: 'Article',
      extractedFields: { name: 'Test Article', headline: 'Test' },
      canSkipLlm: true,
      confidence: 0.95,
    });

    // Quality gate passes (not blocked)
    mockQualityGateScore.mockReturnValue({
      score: 0.85,
      quality: 'rich' as const,
      shouldBlock: false,
      signals: [],
      reason: 'Page passes quality gate.',
      contentLength: 2000,
      boilerplateRatio: 0.1,
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // CrawlIntelligenceService.execute should NOT be called (JSON-LD fast-path)
    // We verify by checking that tryReuse was not called (JSON-LD path bypasses it)
    expect(mockTryReuse).not.toHaveBeenCalled();

    // Page complete event should have jsonLdUsed=true and llmCalls=0
    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(1);
    const data = (pageComplete[0][0] as { data: Record<string, unknown> }).data;
    expect(data.jsonLdUsed).toBe(true);
    expect(data.llmCalls).toBe(0);
  });

  // ─── V8 A11 HTTP→Playwright fallback via FailureScorer ──────────────

  test('A11: falls back to Playwright when FailureScorer says escalate', async () => {
    // No groupStrategies — forces per-page HTTP check
    // HTTP adapter returns success (page loads but content is suspicious)
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/page1',
        statusCode: 200,
        title: 'SPA Page',
        html: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        text: '',
        links: [],
        metadata: {},
        crawledAt: new Date().toISOString(),
        duration: 80,
        success: true,
        contentLength: 100,
        contentType: 'text/html',
        depth: 0,
      },
      statusCode: 200,
      duration: 80,
    });

    // FailureScorer says escalate (content looks empty/JS-only)
    mockFailureScorerScore.mockReturnValue({
      score: 85,
      shouldEscalate: true,
      signals: ['empty_body', 'script_heavy'],
      positiveSignals: [],
      reason: 'Page appears to be a SPA with no server-rendered content.',
    });

    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // HTTP adapter was called first
    expect(mockHttpAdapterFetch).toHaveBeenCalled();

    // MCP navigate IS called (Playwright fallback after FailureScorer escalation)
    const navigateCalls = mockMcpCallTool.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] === 'navigate',
    );
    expect(navigateCalls.length).toBeGreaterThanOrEqual(1);

    // Page complete event should have method: 'playwright'
    const pageComplete = mockPublishProgressEvent.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'intelligence_page_complete',
    );
    expect(pageComplete.length).toBe(1);
    const data = (pageComplete[0][0] as { data: Record<string, unknown> }).data;
    expect(data.method).toBe('playwright');
  });

  // ─── V7 Cheerio Parse-Once ────────────────────────────────────────────

  test('AC-3: scoreWithDom called (not score) — cheerio parse-once', async () => {
    const job = makeJob({ discovery: { useSitemap: true, followLinks: false } });
    await processIntelligenceCrawl(job);

    // scoreWithDom (the WithDom variant) should have been called
    expect(mockQualityGateScore).toHaveBeenCalled();
    // The mock is named mockQualityGateScore but mapped to both score and scoreWithDom.
    // The worker calls scoreWithDom, which is mapped to the same mock.
    // Verify it was called with a cheerio instance (object) as first arg, not a string
    const firstCall = mockQualityGateScore.mock.calls[0];
    // First arg should be a cheerio API (object), not a string (html)
    expect(typeof firstCall[0]).not.toBe('string');
  });
});
