/**
 * CrawlIntelligenceService Unit Tests
 *
 * Tests the 4-phase intelligence loop with mocked LLM and MCP clients.
 * Phase 1: MAP+INTENT — filter URLs by user intent (1 LLM call)
 * Phase 2: UNDERSTAND — browse page with MCP tools (1-8 LLM calls)
 * Phase 3: BUILD HANDLER — generate extraction recipe (1 LLM call)
 * Phase 4: REPLAY — execute handler mechanically (0 LLM calls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlIntelligenceService } from '../../intelligence/crawl-intelligence-service.js';
import type { CrawlIntent, UnderstandResult } from '../../intelligence/types.js';
import {
  MAP_INTENT_SYSTEM_PROMPT,
  UNDERSTAND_SYSTEM_PROMPT,
  BUILD_HANDLER_SYSTEM_PROMPT,
} from '../../intelligence/prompts.js';
import type { ToolUseResult } from '@agent-platform/llm';
import type { MCPTool, ToolCallResult } from '@abl/compiler/platform';

// =============================================================================
// Mock factories
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
        properties: { url: { type: 'string', description: 'URL to navigate to' } },
        required: ['url'],
      },
    },
    {
      name: 'get_page_content',
      description: 'Get page content',
      inputSchema: {
        type: 'object',
        properties: {
          includeText: { type: 'boolean', description: 'Include text' },
          includeHtml: { type: 'boolean', description: 'Include HTML' },
        },
      },
    },
    {
      name: 'extract_elements',
      description: 'Extract elements',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector' } },
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

// =============================================================================
// Test fixtures
// =============================================================================

const sampleIntent: CrawlIntent = {
  intent: 'Extract API documentation for all endpoints',
  siteUrl: 'https://example.com',
  sampleUrl: 'https://example.com/api/users',
};

const sampleSitemapUrls = [
  'https://example.com/api/users',
  'https://example.com/api/products',
  'https://example.com/api/orders',
  'https://example.com/blog/hello-world',
  'https://example.com/about',
];

// =============================================================================
// Tests
// =============================================================================

describe('CrawlIntelligenceService', () => {
  let mockLlm: ReturnType<typeof createMockLlmClient>;
  let mockMcp: ReturnType<typeof createMockMcpClient>;
  let service: CrawlIntelligenceService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLlm = createMockLlmClient();
    mockMcp = createMockMcpClient();
    service = new CrawlIntelligenceService({
      llmClient: mockLlm as never,
      mcpClient: mockMcp as never,
      sitemapUrls: sampleSitemapUrls,
    });
  });

  // ===========================================================================
  // Phase 1: MAP+INTENT
  // ===========================================================================

  describe('Phase 1: mapIntent', () => {
    it('calls llmClient.chat with the correct system prompt', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['https://example.com/api/users'],
          intentSummary: 'Extract API docs',
          urlPattern: '/api/*',
        }),
      );

      await service.mapIntent(sampleIntent, sampleSitemapUrls);

      expect(mockLlm.chat).toHaveBeenCalledTimes(1);
      expect(mockLlm.chat).toHaveBeenCalledWith(
        MAP_INTENT_SYSTEM_PROMPT,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Extract API documentation'),
          }),
        ]),
      );
    });

    it('parses JSON response correctly', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['https://example.com/api/users', 'https://example.com/api/products'],
          intentSummary: 'Extract API documentation for all endpoints',
          urlPattern: '/api/*',
        }),
      );

      const result = await service.mapIntent(sampleIntent, sampleSitemapUrls);

      expect(result.filteredUrls).toEqual([
        'https://example.com/api/users',
        'https://example.com/api/products',
      ]);
      expect(result.intentSummary).toBe('Extract API documentation for all endpoints');
      expect(result.urlPattern).toBe('/api/*');
    });

    it('handles invalid JSON gracefully and returns fallback', async () => {
      mockLlm.chat.mockResolvedValue('This is not valid JSON at all');

      const result = await service.mapIntent(sampleIntent, sampleSitemapUrls);

      expect(result.filteredUrls).toEqual([]);
      expect(result.intentSummary).toBe(sampleIntent.intent);
      expect(result.urlPattern).toBe('*');
    });

    it('strips markdown code fences from JSON response', async () => {
      mockLlm.chat.mockResolvedValue(
        '```json\n{"filteredUrls": ["https://example.com/api/users"], "intentSummary": "API docs", "urlPattern": "/api/*"}\n```',
      );

      const result = await service.mapIntent(sampleIntent, sampleSitemapUrls);

      expect(result.filteredUrls).toEqual(['https://example.com/api/users']);
      expect(result.intentSummary).toBe('API docs');
    });

    it('limits sitemap URLs to 200', async () => {
      const manyUrls = Array.from({ length: 300 }, (_, i) => `https://example.com/page/${i}`);

      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: [],
          intentSummary: 'test',
          urlPattern: '*',
        }),
      );

      await service.mapIntent(sampleIntent, manyUrls);

      // Verify the user message does not contain all 300 URLs
      const userMessage = mockLlm.chat.mock.calls[0][1][0].content as string;
      expect(userMessage).toContain('200 of 300');
      // URL at index 199 should be present, index 200 should not
      expect(userMessage).toContain('https://example.com/page/199');
      expect(userMessage).not.toContain('https://example.com/page/200');
    });

    it('handles missing fields in response with defaults', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: null,
          // missing intentSummary and urlPattern
        }),
      );

      const result = await service.mapIntent(sampleIntent, sampleSitemapUrls);

      expect(result.filteredUrls).toEqual([]);
      expect(result.intentSummary).toBe(sampleIntent.intent);
      expect(result.urlPattern).toBe('*');
    });
  });

  // ===========================================================================
  // Phase 2: UNDERSTAND
  // ===========================================================================

  describe('Phase 2: understand', () => {
    beforeEach(() => {
      mockMcp.listTools.mockResolvedValue(createMockMcpTools());
    });

    it('calls chatWithToolUse with MCP tools as ToolDefinitions', async () => {
      // B1: Mock returns submit_understanding tool call
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Single-page API docs',
                contentAreas: [
                  {
                    selector: '.api-endpoint',
                    description: 'API endpoint documentation',
                    matchesIntent: true,
                  },
                ],
                intentMatch: true,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      await service.understand(sampleIntent);

      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(1);
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledWith(
        UNDERSTAND_SYSTEM_PROMPT,
        expect.any(Array),
        expect.arrayContaining([
          expect.objectContaining({ name: 'navigate' }),
          expect.objectContaining({ name: 'get_page_content' }),
          expect.objectContaining({ name: 'extract_elements' }),
          expect.objectContaining({ name: 'get_page_state' }),
          expect.objectContaining({ name: 'submit_understanding' }),
        ]),
        // FIX 8: graduated toolChoice — iteration 1 forces tool use
        expect.objectContaining({ toolChoice: 'required' }),
      );
    });

    it('executes multi-turn tool loop: tool-calls then submit_understanding', async () => {
      // First call: LLM wants to use tools
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          text: 'Let me navigate to the page first.',
          toolCalls: [
            { id: 'tc_1', name: 'navigate', input: { url: 'https://example.com/api/users' } },
          ],
          finishReason: 'tool-calls',
        }),
      );

      // Tool call result
      mockMcp.callTool.mockResolvedValueOnce(
        createToolCallResult('Navigated to https://example.com/api/users'),
      );

      // Second call: LLM submits structured result via submit_understanding
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'REST API documentation page',
                contentAreas: [
                  {
                    selector: 'article.endpoint',
                    description: 'Endpoint docs',
                    matchesIntent: true,
                  },
                ],
                intentMatch: true,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      // LLM called twice (browse tool-calls + submit_understanding)
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(2);
      // MCP callTool called once for navigate (submit_understanding is NOT an MCP tool)
      expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
      expect(mockMcp.callTool).toHaveBeenCalledWith('navigate', {
        url: 'https://example.com/api/users',
      });

      expect(result.intentMatch).toBe(true);
      expect(result.pageStructure).toBe('REST API documentation page');
      expect(result.contentAreas).toHaveLength(1);
    });

    it('stops when submit_understanding is called and extracts result', async () => {
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Blog page with articles',
                contentAreas: [
                  { selector: '.post', description: 'Blog post content', matchesIntent: false },
                ],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      expect(result.pageStructure).toBe('Blog page with articles');
      expect(result.intentMatch).toBe(false);
      expect(result.contentAreas).toHaveLength(1);
      expect(result.contentAreas[0].selector).toBe('.post');
    });

    it('respects max iterations (8) and builds partial result from tool history', async () => {
      // Iterations 1-6: browse tools (get_page_content)
      // Iterations 7-8: submit_understanding is only tool, but mock returns browse tool calls
      // to simulate an LLM that never submits — exhausts loop and falls back to partial result
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          text: 'Still working...',
          toolCalls: [{ id: 'tc_loop', name: 'get_page_content', input: { includeText: true } }],
          finishReason: 'tool-calls',
        }),
      );
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Page content here'));

      const result = await service.understand(sampleIntent);

      // Should have called chatWithToolUse exactly 8 times (MAX_UNDERSTAND_ITERATIONS, FIX 3: 5→8)
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(8);
      // FIX 4: partial result extracted from tool history (not empty fallback)
      // buildPartialUnderstandResult salvages page structure from accumulated tool data
      expect(result.pageStructure).toBeDefined();
      expect(result.pageStructure).not.toBe('');
      expect(result.intentMatch).toBe(false);
    });

    it('handles tool call errors (isError: true)', async () => {
      // First call: LLM wants to navigate
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            { id: 'tc_err', name: 'navigate', input: { url: 'https://example.com/broken' } },
          ],
          finishReason: 'tool-calls',
        }),
      );

      // Tool call returns error
      mockMcp.callTool.mockResolvedValueOnce(
        createToolCallResult('Navigation failed: timeout', true),
      );

      // Second call: LLM handles the error and submits via submit_understanding
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Could not fully analyze',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(2);
      expect(result.intentMatch).toBe(false);
    });

    it('returns fallback when no MCP tools are available', async () => {
      // Return only tools NOT in the allowlist
      mockMcp.listTools.mockResolvedValue([
        {
          name: 'some_other_tool',
          description: 'Not in allowlist',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ]);

      const result = await service.understand(sampleIntent);

      expect(mockLlm.chatWithToolUse).not.toHaveBeenCalled();
      expect(result.pageStructure).toBe('Unable to analyze page structure');
      expect(result.contentAreas).toEqual([]);
      expect(result.intentMatch).toBe(false);
    });

    it('filters MCP tools to only allowed set', async () => {
      // Include extra tools that should be filtered out
      const toolsWithExtras: MCPTool[] = [
        ...createMockMcpTools(),
        {
          name: 'click_element',
          description: 'Click an element',
          inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
          },
        },
      ];
      mockMcp.listTools.mockResolvedValue(toolsWithExtras);

      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'test',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      await service.understand(sampleIntent);

      // Should pass 4 allowlisted MCP tools + submit_understanding = 5 tools
      const toolsArg = mockLlm.chatWithToolUse.mock.calls[0][2];
      expect(toolsArg).toHaveLength(5);
      const toolNames = (toolsArg as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).not.toContain('click_element');
      expect(toolNames).toContain('submit_understanding');
    });

    // =========================================================================
    // B1: Structured output via submit_understanding
    // =========================================================================

    it('submit_understanding tool call returns structured result directly', async () => {
      // Iteration 1: browse tool
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            { id: 'tc_1', name: 'navigate', input: { url: 'https://example.com/api/users' } },
          ],
          finishReason: 'tool-calls',
        }),
      );
      mockMcp.callTool.mockResolvedValueOnce(createToolCallResult('Navigated'));

      // Iteration 2: submit_understanding with full result
      const submitInput = {
        pageStructure: 'API docs with sidebar nav and main content',
        contentAreas: [
          { selector: '.endpoint', description: 'Endpoint docs', matchesIntent: true },
          { selector: '.sidebar', description: 'Navigation', matchesIntent: false },
        ],
        interactiveElements: [
          { type: 'tab', selector: '.tab-bar', description: 'HTTP method tabs' },
        ],
        suggestedKeywords: ['REST', 'API', 'endpoint'],
        intentMatch: true,
      };

      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [{ id: 'tc_submit', name: 'submit_understanding', input: submitInput }],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      expect(result.pageStructure).toBe('API docs with sidebar nav and main content');
      expect(result.contentAreas).toHaveLength(2);
      expect(result.contentAreas[0].selector).toBe('.endpoint');
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.suggestedKeywords).toEqual(['REST', 'API', 'endpoint']);
      expect(result.intentMatch).toBe(true);
      // submit_understanding is NOT executed via MCP — only navigate was
      expect(mockMcp.callTool).toHaveBeenCalledTimes(1);
    });

    it('wrap-up iterations only provide submit_understanding tool', async () => {
      // Exhaust iterations 1-6 with browse tools
      for (let i = 0; i < 6; i++) {
        mockLlm.chatWithToolUse.mockResolvedValueOnce(
          createToolUseResult({
            toolCalls: [{ id: `tc_${i}`, name: 'get_page_content', input: { includeText: true } }],
            finishReason: 'tool-calls',
          }),
        );
      }
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Content'));

      // Iteration 7: submit_understanding (wrap-up)
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Wrap-up result',
                contentAreas: [],
                intentMatch: true,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      await service.understand(sampleIntent);

      // 7th call (iteration 7 = WRAP_UP_ITERATION) should only have submit_understanding
      const seventhCallTools = mockLlm.chatWithToolUse.mock.calls[6][2] as Array<{ name: string }>;
      expect(seventhCallTools).toHaveLength(1);
      expect(seventhCallTools[0].name).toBe('submit_understanding');
    });

    it('toolChoice is required on wrap-up iterations', async () => {
      // Exhaust iterations 1-6 with browse tools
      for (let i = 0; i < 6; i++) {
        mockLlm.chatWithToolUse.mockResolvedValueOnce(
          createToolUseResult({
            toolCalls: [{ id: `tc_${i}`, name: 'get_page_content', input: { includeText: true } }],
            finishReason: 'tool-calls',
          }),
        );
      }
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Content'));

      // Iteration 7: submit_understanding
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'test',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      await service.understand(sampleIntent);

      // 7th call options should have toolChoice: 'required'
      const seventhCallOptions = mockLlm.chatWithToolUse.mock.calls[6][3] as {
        toolChoice: string;
      };
      expect(seventhCallOptions).toEqual({ toolChoice: 'required' });
    });

    it('submit_understanding with missing optional fields uses defaults', async () => {
      // Submit with only required fields (no interactiveElements, no suggestedKeywords)
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Simple page',
                contentAreas: [
                  { selector: 'main', description: 'Main content', matchesIntent: true },
                ],
                intentMatch: true,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      expect(result.interactiveElements).toEqual([]);
      expect(result.suggestedKeywords).toEqual([]);
      expect(result.pageStructure).toBe('Simple page');
      expect(result.intentMatch).toBe(true);
    });

    it('submit_understanding mid-loop returns result immediately', async () => {
      // Iteration 1: browse
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            { id: 'tc_1', name: 'navigate', input: { url: 'https://example.com/api/users' } },
          ],
          finishReason: 'tool-calls',
        }),
      );
      mockMcp.callTool.mockResolvedValueOnce(createToolCallResult('Navigated'));

      // Iteration 2: submit_understanding during 'auto' phase
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Early exit result',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      // Only 2 chatWithToolUse calls — exited early on submit_understanding
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(2);
      expect(result.pageStructure).toBe('Early exit result');
    });

    it('text response without tool calls continues loop', async () => {
      // Iteration 1: text only (no tools) — should continue loop
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          text: 'I need to analyze the page...',
          finishReason: 'stop',
        }),
      );

      // Iteration 2: submit_understanding
      mockLlm.chatWithToolUse.mockResolvedValueOnce(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'Result after text response',
                contentAreas: [],
                intentMatch: true,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      const result = await service.understand(sampleIntent);

      // 2 calls — text response + submit_understanding
      expect(mockLlm.chatWithToolUse).toHaveBeenCalledTimes(2);
      expect(result.pageStructure).toBe('Result after text response');
      expect(result.intentMatch).toBe(true);
    });
  });

  // ===========================================================================
  // Phase 3: BUILD HANDLER
  // ===========================================================================

  describe('Phase 3: buildHandler', () => {
    const sampleUnderstanding: UnderstandResult = {
      pageStructure: 'REST API documentation page with endpoint sections',
      contentAreas: [
        { selector: 'article.endpoint', description: 'Endpoint docs', matchesIntent: true },
        { selector: 'nav.sidebar', description: 'Navigation sidebar', matchesIntent: false },
      ],
      intentMatch: true,
    };

    it('calls llmClient.chat with intent and understanding', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          handler: {
            urlPattern: '/api/*',
            description: 'Extract API endpoint docs',
            steps: [
              {
                action: 'navigate',
                value: 'https://example.com/api/users',
                description: 'Navigate to API page',
              },
            ],
            extractionSelectors: { content: 'article.endpoint', title: 'h1' },
          },
          reasoning: 'Targeting endpoint article sections',
        }),
      );

      await service.buildHandler(sampleIntent, sampleUnderstanding);

      expect(mockLlm.chat).toHaveBeenCalledTimes(1);
      expect(mockLlm.chat).toHaveBeenCalledWith(
        BUILD_HANDLER_SYSTEM_PROMPT,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Extract API documentation'),
          }),
        ]),
      );
      // User message should contain page structure info
      const userMessage = mockLlm.chat.mock.calls[0][1][0].content as string;
      expect(userMessage).toContain('REST API documentation page');
      expect(userMessage).toContain('article.endpoint');
    });

    it('parses IPageHandler from response', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          handler: {
            urlPattern: '/api/**',
            description: 'Extract REST API endpoint documentation',
            steps: [
              {
                action: 'navigate',
                value: 'https://example.com/api/users',
                description: 'Go to API page',
              },
              { action: 'wait', selector: 'article.endpoint', description: 'Wait for content' },
            ],
            extractionSelectors: {
              content: 'article.endpoint',
              title: 'h1.page-title',
              metadata: { version: '.api-version' },
            },
          },
          reasoning: 'The API docs are in article elements',
        }),
      );

      const result = await service.buildHandler(sampleIntent, sampleUnderstanding);

      expect(result.handler.urlPattern).toBe('/api/**');
      expect(result.handler.description).toBe('Extract REST API endpoint documentation');
      expect(result.handler.steps).toHaveLength(2);
      expect(result.handler.steps[0].action).toBe('navigate');
      expect(result.handler.steps[1].action).toBe('wait');
      expect(result.handler.extractionSelectors.content).toBe('article.endpoint');
      expect(result.handler.extractionSelectors.title).toBe('h1.page-title');
      expect(result.handler.extractionSelectors.metadata).toEqual({ version: '.api-version' });
      expect(result.reasoning).toBe('The API docs are in article elements');
    });

    it('returns fallback handler for incomplete response', async () => {
      // Missing extractionSelectors.content
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          handler: {
            urlPattern: '/api/*',
            description: 'Incomplete handler',
            steps: [{ action: 'navigate', value: 'url', description: 'nav' }],
            extractionSelectors: {}, // missing required "content"
          },
          reasoning: 'test',
        }),
      );

      const result = await service.buildHandler(sampleIntent, sampleUnderstanding);

      // Should return fallback
      expect(result.handler.steps).toHaveLength(1);
      expect(result.handler.steps[0].action).toBe('navigate');
      expect(result.handler.extractionSelectors.content).toBe('body');
      expect(result.reasoning).toContain('Fallback');
    });

    it('returns fallback handler when LLM response is invalid JSON', async () => {
      mockLlm.chat.mockResolvedValue('Not valid JSON response');

      const result = await service.buildHandler(sampleIntent, sampleUnderstanding);

      expect(result.handler.extractionSelectors.content).toBe('body');
      expect(result.reasoning).toContain('Fallback');
      expect(result.reasoning).toContain('error');
    });
  });

  // ===========================================================================
  // Phase 4: REPLAY
  // ===========================================================================

  describe('Phase 4: replay', () => {
    it('does NOT call the LLM — only mcpClient.callTool', async () => {
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Success'));

      const handler = {
        urlPattern: '/api/*',
        description: 'Test handler',
        steps: [
          {
            action: 'navigate' as const,
            value: 'https://example.com/api/users',
            description: 'Navigate',
          },
        ],
        extractionSelectors: { content: 'article' },
      };

      await service.replay(handler, 'https://example.com/api/users');

      expect(mockLlm.chat).not.toHaveBeenCalled();
      expect(mockLlm.chatWithToolUse).not.toHaveBeenCalled();
      expect(mockMcp.callTool).toHaveBeenCalled();
    });

    it('maps step actions to correct MCP tool names', async () => {
      mockMcp.callTool.mockResolvedValue(createToolCallResult('OK'));

      const handler = {
        urlPattern: '/test',
        description: 'Action mapping test',
        steps: [
          { action: 'navigate' as const, value: 'https://example.com', description: 'Nav' },
          { action: 'click' as const, selector: '#btn', description: 'Click button' },
          {
            action: 'type' as const,
            selector: '#input',
            value: 'search term',
            description: 'Type text',
          },
          { action: 'wait' as const, selector: '.content', description: 'Wait' },
          { action: 'extract' as const, selector: '.data', description: 'Extract' },
        ],
        extractionSelectors: { content: 'body' },
      };

      await service.replay(handler, 'https://example.com');

      // Steps + get_page_content + extract_elements for content selector
      const callToolNames = mockMcp.callTool.mock.calls.map((call) => call[0]);
      expect(callToolNames).toContain('navigate');
      expect(callToolNames).toContain('click_element');
      expect(callToolNames).toContain('type_text');
      expect(callToolNames).toContain('wait_for_element');
      expect(callToolNames).toContain('extract_elements');
    });

    it('extracts content using extractionSelectors', async () => {
      mockMcp.callTool.mockImplementation(async (name: string) => {
        if (name === 'navigate') return createToolCallResult('Navigated');
        if (name === 'get_page_content') return createToolCallResult('Full page content');
        if (name === 'extract_elements') return createToolCallResult('Extracted article content');
        return createToolCallResult('OK');
      });

      const handler = {
        urlPattern: '/api/*',
        description: 'Test extraction',
        steps: [
          {
            action: 'navigate' as const,
            value: 'https://example.com/api/users',
            description: 'Navigate',
          },
        ],
        extractionSelectors: {
          content: 'article.main',
          title: 'h1.title',
        },
      };

      const result = await service.replay(handler, 'https://example.com/api/users');

      expect(result.success).toBe(true);
      // extract_elements should be called for content and title selectors
      expect(mockMcp.callTool).toHaveBeenCalledWith('extract_elements', {
        selector: 'article.main',
      });
      expect(mockMcp.callTool).toHaveBeenCalledWith('extract_elements', { selector: 'h1.title' });
      expect(result.content.body).toBe('Extracted article content');
      expect(result.content.title).toBe('Extracted article content');
    });

    it('handles step failures gracefully', async () => {
      let callCount = 0;
      mockMcp.callTool.mockImplementation(async (name: string) => {
        callCount++;
        if (name === 'click_element') {
          return createToolCallResult('Element not found', true);
        }
        if (name === 'get_page_content') return createToolCallResult('Some content');
        if (name === 'extract_elements') return createToolCallResult('Extracted content');
        return createToolCallResult('OK');
      });

      const handler = {
        urlPattern: '/test',
        description: 'Step failure test',
        steps: [
          {
            action: 'navigate' as const,
            value: 'https://example.com',
            description: 'Navigate',
          },
          { action: 'click' as const, selector: '#missing', description: 'Click missing element' },
        ],
        extractionSelectors: { content: 'body' },
      };

      const result = await service.replay(handler, 'https://example.com');

      // Navigate succeeds, click fails
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults[0].success).toBe(true);
      expect(result.stepResults[1].success).toBe(false);
      expect(result.stepResults[1].error).toContain('Element not found');
      // Overall success is false because not all steps succeeded
      expect(result.success).toBe(false);
    });

    it('handles unknown actions gracefully', async () => {
      mockMcp.callTool.mockResolvedValue(createToolCallResult('OK'));

      const handler = {
        urlPattern: '/test',
        description: 'Unknown action test',
        steps: [
          { action: 'unknown_action' as never, description: 'Unknown step' },
          {
            action: 'navigate' as const,
            value: 'https://example.com',
            description: 'Navigate',
          },
        ],
        extractionSelectors: { content: 'body' },
      };

      const result = await service.replay(handler, 'https://example.com');

      expect(result.stepResults[0].success).toBe(false);
      expect(result.stepResults[0].error).toContain('Unknown action');
      // Navigate should still succeed
      expect(result.stepResults[1].success).toBe(true);
    });

    it('maps scroll action args correctly (direction + optional selector)', async () => {
      mockMcp.callTool.mockResolvedValue(createToolCallResult('OK'));

      const handler = {
        urlPattern: '/test',
        description: 'Scroll test',
        steps: [
          { action: 'scroll' as const, value: 'to_bottom', description: 'Scroll to bottom' },
          {
            action: 'scroll' as const,
            selector: '#container',
            description: 'Scroll default direction',
          },
        ],
        extractionSelectors: { content: 'body' },
      };

      await service.replay(handler, 'https://example.com');

      // First scroll: direction from value, no selector
      expect(mockMcp.callTool).toHaveBeenCalledWith('scroll', { direction: 'to_bottom' });
      // Second scroll: default direction 'down', with selector
      expect(mockMcp.callTool).toHaveBeenCalledWith('scroll', {
        direction: 'down',
        selector: '#container',
      });
    });

    it('maps execute_js action args correctly (code field)', async () => {
      mockMcp.callTool.mockResolvedValue(createToolCallResult('OK'));

      const handler = {
        urlPattern: '/test',
        description: 'JS execution test',
        steps: [
          {
            action: 'execute_js' as const,
            value: 'document.title',
            description: 'Get title via JS',
          },
        ],
        extractionSelectors: { content: 'body' },
      };

      await service.replay(handler, 'https://example.com');

      // execute_javascript MCP tool expects { code: string }
      expect(mockMcp.callTool).toHaveBeenCalledWith('execute_javascript', {
        code: 'document.title',
      });
    });

    it('extracts metadata when selectors are provided', async () => {
      mockMcp.callTool.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
        if (name === 'navigate') return createToolCallResult('Navigated');
        if (name === 'get_page_content') return createToolCallResult('Full content');
        if (name === 'extract_elements') {
          if (args?.selector === 'article') return createToolCallResult('Article body');
          if (args?.selector === 'h1') return createToolCallResult('Page Title');
          if (args?.selector === '.author') return createToolCallResult('John Doe');
          if (args?.selector === '.date') return createToolCallResult('2026-03-19');
        }
        return createToolCallResult('OK');
      });

      const handler = {
        urlPattern: '/test',
        description: 'Metadata test',
        steps: [{ action: 'navigate' as const, value: 'https://example.com', description: 'Nav' }],
        extractionSelectors: {
          content: 'article',
          title: 'h1',
          metadata: { author: '.author', date: '.date' },
        },
      };

      const result = await service.replay(handler, 'https://example.com');

      expect(result.content.body).toBe('Article body');
      expect(result.content.title).toBe('Page Title');
      expect(result.content.metadata).toEqual({
        author: 'John Doe',
        date: '2026-03-19',
      });
    });
  });

  // ===========================================================================
  // Phase 1: mapIntent — short-circuit for single URL
  // ===========================================================================

  describe('Phase 1: mapIntent short-circuit', () => {
    it('mapIntent with single URL skips LLM call', async () => {
      const singleUrl = ['https://example.com/api/users'];

      const result = await service.mapIntent(sampleIntent, singleUrl);

      // LLM should NOT be called for Phase 1 when there is only 1 URL
      expect(mockLlm.chat).not.toHaveBeenCalled();
      expect(result.filteredUrls).toEqual(singleUrl);
      expect(result.intentSummary).toBe(sampleIntent.intent);
      expect(result.urlPattern).toBe(sampleIntent.sampleUrl);
    });

    it('mapIntent with empty sitemapUrls uses sampleUrl', async () => {
      const result = await service.mapIntent(sampleIntent, []);

      // LLM should NOT be called
      expect(mockLlm.chat).not.toHaveBeenCalled();
      expect(result.filteredUrls).toEqual([sampleIntent.sampleUrl]);
      expect(result.intentSummary).toBe(sampleIntent.intent);
      expect(result.urlPattern).toBe(sampleIntent.sampleUrl);
    });

    it('mapIntent with multiple URLs still uses LLM filtering', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['https://example.com/api/users'],
          intentSummary: 'Extract API docs',
          urlPattern: '/api/*',
        }),
      );

      await service.mapIntent(sampleIntent, sampleSitemapUrls);

      // LLM SHOULD be called for multiple URLs
      expect(mockLlm.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // onProgress callback
  // ===========================================================================

  describe('onProgress callback', () => {
    it('onProgress callback is called for each phase', async () => {
      const progressCalls: Array<{ phase: string; detail?: string }> = [];
      const onProgress = vi.fn(async (phase: string, detail?: string) => {
        progressCalls.push({ phase, detail });
      });

      const singleUrlService = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls: ['https://example.com/api/users'],
        onProgress,
      });

      // Phase 2: understand — return submit_understanding immediately
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

      // Phase 3: buildHandler
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
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
        }),
      );

      // Phase 4: replay
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Content extracted'));

      await singleUrlService.execute(sampleIntent);

      // Verify onProgress was called for all 4 phases
      const phases = progressCalls.map((c) => c.phase);
      expect(phases).toContain('map');
      expect(phases).toContain('understand');
      expect(phases).toContain('build_handler');
      expect(phases).toContain('replay');

      // Verify the initial phase-level calls have the right details
      expect(progressCalls[0]).toEqual({ phase: 'map', detail: 'Filtering URLs by intent' });
      // understand phase has both the initial call and iteration-level calls
      const understandCalls = progressCalls.filter((c) => c.phase === 'understand');
      expect(understandCalls.length).toBeGreaterThanOrEqual(2); // initial + at least 1 iteration
      expect(understandCalls[0]).toEqual({
        phase: 'understand',
        detail: 'Browsing and analyzing page',
      });
      expect(understandCalls[1]).toEqual({ phase: 'understand', detail: 'iteration 1/8' });
    });

    it('execute works without onProgress callback', async () => {
      // Use the default service (no onProgress)
      // Phase 1: short-circuit with single URL
      const noProgressService = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls: ['https://example.com/api/users'],
      });

      // Phase 2: understand
      mockMcp.listTools.mockResolvedValue(createMockMcpTools());
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'test',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
        }),
      );

      // Phase 3: buildHandler
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          handler: {
            urlPattern: '*',
            description: 'Fallback',
            steps: [{ action: 'navigate', value: 'https://example.com', description: 'Nav' }],
            extractionSelectors: { content: 'body' },
          },
          reasoning: 'test',
        }),
      );

      // Phase 4: replay
      mockMcp.callTool.mockResolvedValue(createToolCallResult('content'));

      // Should complete without error
      const result = await noProgressService.execute(sampleIntent);
      expect(result.replay).toBeDefined();
      expect(result.llmCallCount).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Full execute()
  // ===========================================================================

  describe('Full execute()', () => {
    it('runs all 4 phases in order and counts LLM calls correctly', async () => {
      const callOrder: string[] = [];

      // Phase 1: mapIntent (1 LLM call)
      mockLlm.chat.mockImplementation(async (systemPrompt: string) => {
        if (systemPrompt === MAP_INTENT_SYSTEM_PROMPT) {
          callOrder.push('phase1:chat');
          return JSON.stringify({
            filteredUrls: ['https://example.com/api/users'],
            intentSummary: 'Extract API docs',
            urlPattern: '/api/*',
          });
        }
        if (systemPrompt === BUILD_HANDLER_SYSTEM_PROMPT) {
          callOrder.push('phase3:chat');
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

      // Phase 2: understand (1 LLM call — direct submit_understanding)
      mockMcp.listTools.mockResolvedValue(createMockMcpTools());
      mockLlm.chatWithToolUse.mockImplementation(async () => {
        callOrder.push('phase2:chatWithToolUse');
        return createToolUseResult({
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
        });
      });

      // Phase 4: replay (0 LLM calls)
      mockMcp.callTool.mockResolvedValue(createToolCallResult('Content extracted'));

      const result = await service.execute(sampleIntent);

      // Verify phase ordering
      expect(callOrder).toEqual(['phase1:chat', 'phase2:chatWithToolUse', 'phase3:chat']);

      // Verify LLM call count: 1 (map) + 1 (understand) + 1 (build) = 3
      expect(result.llmCallCount).toBe(3);

      // Verify all phases produced results
      expect(result.mapIntent.filteredUrls).toContain('https://example.com/api/users');
      expect(result.understand.intentMatch).toBe(true);
      expect(result.buildHandler.handler.steps).toHaveLength(1);
      expect(result.replay.stepResults).toHaveLength(1);
    });

    it('tracks total tokens across phases', async () => {
      // Phase 1
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: [],
          intentSummary: 'test',
          urlPattern: '*',
        }),
      );

      // Phase 2
      mockMcp.listTools.mockResolvedValue(createMockMcpTools());
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          toolCalls: [
            {
              id: 'tc_submit',
              name: 'submit_understanding',
              input: {
                pageStructure: 'test',
                contentAreas: [],
                intentMatch: false,
              },
            },
          ],
          finishReason: 'tool-calls',
          usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        }),
      );

      // Phase 4 replay
      mockMcp.callTool.mockResolvedValue(createToolCallResult('content'));

      const result = await service.execute(sampleIntent);

      // Only Phase 2 (chatWithToolUse) tracks tokens via trackTokens()
      // Phase 1 and Phase 3 use chat() which returns a string, not ToolUseResult
      expect(result.totalTokens).toBe(300);
    });
  });
});
