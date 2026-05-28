/**
 * Handler Reuse Wiring Tests
 *
 * Tests that HandlerReuser is properly wired into CrawlIntelligenceService.execute():
 * - When handlerReuser finds a match, Phase 2+3 are skipped
 * - When no match, normal flow proceeds and handler is registered after Phase 3
 * - When handlerReuser is not provided, normal flow works (backward compatible)
 * - handlerReused flag is true/false in result
 *
 * These are unit tests with mocked external dependencies (LLM provider, browser MCP server).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlIntelligenceService } from '../../intelligence/crawl-intelligence-service.js';
import { HandlerReuser } from '../../intelligence/algorithms/handler-reuser.js';
import { TemplateFingerprinter } from '../../intelligence/algorithms/template-fingerprinter.js';
import type { CrawlIntent } from '../../intelligence/types.js';
import {
  MAP_INTENT_SYSTEM_PROMPT,
  BUILD_HANDLER_SYSTEM_PROMPT,
} from '../../intelligence/prompts.js';
import type { ToolUseResult } from '@agent-platform/llm';
import type { MCPTool, ToolCallResult } from '@abl/compiler/platform';

// =============================================================================
// Mock factories for external dependencies (LLM provider, MCP browser server)
// =============================================================================

function createMockLlmClient() {
  return {
    chat: vi.fn<
      [string, Array<{ role: string; content: string | unknown[] }>, unknown?],
      Promise<string>
    >(),
    chatWithToolUse: vi.fn<
      [string, Array<{ role: string; content: string | unknown[] }>, unknown[], unknown?],
      Promise<ToolUseResult>
    >(),
    getModelForTier: vi.fn<[string], string>().mockReturnValue('gpt-4o'),
  };
}

function createMockMcpClient() {
  return {
    listTools: vi.fn<[], Promise<MCPTool[]>>(),
    callTool: vi.fn<[string, Record<string, unknown>?], Promise<ToolCallResult>>(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshTools: vi.fn(),
    listResources: vi.fn(),
    readResource: vi.fn(),
    listPrompts: vi.fn(),
    getPrompt: vi.fn(),
  };
}

function createMockMcpTools(): MCPTool[] {
  return [
    {
      name: 'navigate',
      description: 'Navigate to URL',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL' } },
        required: ['url'],
      },
    },
    {
      name: 'get_page_content',
      description: 'Get page content',
      inputSchema: {
        type: 'object',
        properties: {
          includeText: { type: 'boolean' },
          includeHtml: { type: 'boolean' },
        },
      },
    },
    {
      name: 'extract_elements',
      description: 'Extract elements',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'get_page_state',
      description: 'Get page state',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function createToolCallResult(text: string, isError = false): ToolCallResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

function createToolUseResult(overrides: Partial<ToolUseResult> = {}): ToolUseResult {
  return {
    text: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...overrides,
  };
}

/** Sample HTML that can be fingerprinted */
const SAMPLE_HTML = `
<html><head><title>API Docs</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <article>
      <h1>Users API</h1>
      <p>Documentation for the Users endpoint.</p>
      <pre><code>GET /api/users</code></pre>
    </article>
  </main>
  <footer><p>Footer</p></footer>
</body>
</html>
`;

const sampleIntent: CrawlIntent = {
  intent: 'Extract API documentation for all endpoints',
  siteUrl: 'https://example.com',
  sampleUrl: 'https://example.com/api/users',
};

const sampleSitemapUrls = ['https://example.com/api/users', 'https://example.com/api/products'];

// =============================================================================
// Helper: setup standard Phase 1-4 mocks for external LLM/MCP services
// =============================================================================

function setupNormalFlowMocks(
  mockLlm: ReturnType<typeof createMockLlmClient>,
  mockMcp: ReturnType<typeof createMockMcpClient>,
) {
  // Phase 1
  mockLlm.chat.mockImplementation(async (systemPrompt: string) => {
    if (systemPrompt === MAP_INTENT_SYSTEM_PROMPT) {
      return JSON.stringify({
        filteredUrls: ['https://example.com/api/users'],
        intentSummary: 'Extract API docs',
        urlPattern: '/api/*',
      });
    }
    if (systemPrompt === BUILD_HANDLER_SYSTEM_PROMPT) {
      return JSON.stringify({
        handler: {
          urlPattern: '/api/*',
          description: 'API handler',
          steps: [
            {
              action: 'navigate',
              value: 'https://example.com/api/users',
              description: 'Navigate',
            },
          ],
          extractionSelectors: { content: 'article' },
        },
        reasoning: 'Simple extraction',
      });
    }
    return '{}';
  });

  // Phase 2
  mockMcp.listTools.mockResolvedValue(createMockMcpTools());
  mockLlm.chatWithToolUse.mockResolvedValue(
    createToolUseResult({
      toolCalls: [
        {
          id: 'tc_submit',
          name: 'submit_understanding',
          input: {
            pageStructure: 'API docs page',
            contentAreas: [
              { selector: 'article', description: 'API content', matchesIntent: true },
            ],
            intentMatch: true,
          },
        },
      ],
      finishReason: 'tool-calls',
    }),
  );

  // MCP callTool — return page HTML for fingerprinting and replay
  mockMcp.callTool.mockImplementation(async (name: string) => {
    if (name === 'get_page_content') {
      return createToolCallResult(JSON.stringify({ html: SAMPLE_HTML, text: 'API Docs content' }));
    }
    return createToolCallResult('OK');
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('CrawlIntelligenceService — Handler Reuse', () => {
  let mockLlm: ReturnType<typeof createMockLlmClient>;
  let mockMcp: ReturnType<typeof createMockMcpClient>;
  let fingerprinter: TemplateFingerprinter;
  let handlerReuser: HandlerReuser;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLlm = createMockLlmClient();
    mockMcp = createMockMcpClient();
    fingerprinter = new TemplateFingerprinter();
    handlerReuser = new HandlerReuser(fingerprinter);
  });

  it('backward compatible: when handlerReuser is not provided, normal flow works and handlerReused is false', async () => {
    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    const result = await service.execute(sampleIntent);

    expect(result.handlerReused).toBe(false);
    expect(result.handlerTemplateId).toBeUndefined();
    // Phase 2+3 should have run (LLM calls: 1 map + 1 understand + 1 build = 3)
    expect(result.llmCallCount).toBe(3);
  });

  it('when handlerReuser finds a match, Phase 2+3 are skipped', async () => {
    // Pre-register a handler with matching fingerprint
    const fp = fingerprinter.fingerprint(SAMPLE_HTML);
    const storedHandler = {
      urlPattern: '/api/*',
      description: 'Pre-registered handler',
      steps: [
        {
          action: 'navigate' as const,
          value: 'https://example.com/api/users',
          description: 'Navigate',
        },
      ],
      extractionSelectors: { content: 'article' },
    };
    handlerReuser.registerHandler(fp.fingerprint, storedHandler, ['https://example.com/api/users']);

    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
      handlerReuser,
      fingerprinter,
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    const result = await service.execute(sampleIntent);

    // Handler reuse should have worked
    expect(result.handlerReused).toBe(true);
    expect(result.handlerTemplateId).toBeDefined();

    // Phase 2 (chatWithToolUse) should NOT have been called
    expect(mockLlm.chatWithToolUse).not.toHaveBeenCalled();

    // Phase 3 (buildHandler via chat with BUILD_HANDLER_SYSTEM_PROMPT) should NOT have been called
    // Only Phase 1 chat call should exist
    expect(mockLlm.chat).toHaveBeenCalledTimes(1);
    expect(mockLlm.chat).toHaveBeenCalledWith(MAP_INTENT_SYSTEM_PROMPT, expect.anything());

    // LLM calls: 1 map only (Phase 2+3 skipped)
    expect(result.llmCallCount).toBe(1);

    // Result should still have all required fields
    expect(result.understand.pageStructure).toContain('Skipped');
    expect(result.buildHandler.handler.urlPattern).toBe('/api/*');
    expect(result.replay).toBeDefined();
  });

  it('when no match found, normal flow proceeds and handler is registered', async () => {
    // handlerReuser has no registered handlers, so tryReuse will return matched: false
    const registerSpy = vi.spyOn(handlerReuser, 'registerHandler');

    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
      handlerReuser,
      fingerprinter,
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    const result = await service.execute(sampleIntent);

    // No reuse
    expect(result.handlerReused).toBe(false);

    // Normal flow: all 3 LLM calls
    expect(result.llmCallCount).toBe(3);
    expect(mockLlm.chatWithToolUse).toHaveBeenCalled();

    // Handler should have been registered after Phase 3
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith(
      expect.any(BigInt),
      expect.objectContaining({ urlPattern: '/api/*' }),
      ['https://example.com/api/users'],
    );
  });

  it('emits reuse progress event when handler is reused', async () => {
    const fp = fingerprinter.fingerprint(SAMPLE_HTML);
    handlerReuser.registerHandler(
      fp.fingerprint,
      {
        urlPattern: '/api/*',
        description: 'Handler',
        steps: [{ action: 'navigate', value: 'https://example.com', description: 'Nav' }],
        extractionSelectors: { content: 'body' },
      },
      ['https://example.com'],
    );

    const progressEvents: Array<{ phase: string; detail?: string }> = [];
    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
      handlerReuser,
      fingerprinter,
      onProgress: async (phase, detail) => {
        progressEvents.push({ phase, detail });
      },
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    await service.execute(sampleIntent);

    // Should have reuse progress event
    expect(progressEvents).toContainEqual({
      phase: 'reuse',
      detail: 'Reusing existing handler — 0 LLM calls',
    });
    // Should NOT have understand or build_handler events
    expect(progressEvents.find((e) => e.phase === 'understand')).toBeUndefined();
    expect(progressEvents.find((e) => e.phase === 'build_handler')).toBeUndefined();
  });

  it('handler reuse failure does not block normal analysis flow', async () => {
    // Create a reuser that will throw during tryReuse
    const brokenReuser = new HandlerReuser(fingerprinter);
    vi.spyOn(brokenReuser, 'tryReuse').mockImplementation(() => {
      throw new Error('Fingerprinting crashed');
    });

    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
      handlerReuser: brokenReuser,
      fingerprinter,
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    // Should NOT throw — gracefully falls back to normal flow
    const result = await service.execute(sampleIntent);

    expect(result.handlerReused).toBe(false);
    expect(result.llmCallCount).toBe(3);
  });

  it('persists handler to store after Phase 3 when handlerStore is provided', async () => {
    const mockStore = {
      saveHandler: vi.fn().mockResolvedValue(undefined),
      findByFingerprint: vi.fn(),
      findByDomain: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      deleteByDomain: vi.fn(),
    };

    const service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
      handlerReuser,
      fingerprinter,
      handlerStore: mockStore,
      tenantId: 'tenant-123',
    });
    setupNormalFlowMocks(mockLlm, mockMcp);

    await service.execute(sampleIntent);

    // Wait for async store save (fire-and-forget with .catch())
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStore.saveHandler).toHaveBeenCalledTimes(1);
    expect(mockStore.saveHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-123',
        domain: 'example.com',
        urlPattern: '/api/*',
        trainedOn: ['https://example.com/api/users'],
      }),
    );
  });
});
