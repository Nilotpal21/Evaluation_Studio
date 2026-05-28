/**
 * Security tests for CrawlIntelligenceService
 *
 * Covers:
 *   V1: SSRF prevention — filteredUrls validated against input sitemap
 *   V2: Prompt injection defense — intent/URL sanitization
 *   X2: Empty catch blocks now log (verified via no-crash behavior)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlIntelligenceService } from '../../intelligence/crawl-intelligence-service.js';
import type { CrawlIntent } from '../../intelligence/types.js';
import type { ToolUseResult } from '@agent-platform/llm';
import type { MCPTool, ToolCallResult } from '@abl/compiler/platform';

// =============================================================================
// Mock factories (same pattern as crawl-intelligence-service.test.ts)
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
// Tests
// =============================================================================

describe('CrawlIntelligenceService — Security', () => {
  let mockLlm: ReturnType<typeof createMockLlmClient>;
  let mockMcp: ReturnType<typeof createMockMcpClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLlm = createMockLlmClient();
    mockMcp = createMockMcpClient();
  });

  // ==========================================================================
  // V1: SSRF Prevention — filteredUrls validated against sitemap
  // ==========================================================================

  describe('V1: SSRF prevention in mapIntent', () => {
    const sitemapUrls = [
      'https://example.com/docs/api',
      'https://example.com/docs/guides',
      'https://example.com/blog/post-1',
    ];

    const intent: CrawlIntent = {
      intent: 'Extract API docs',
      siteUrl: 'https://example.com',
      sampleUrl: 'https://example.com/docs/api',
    };

    it('rejects URLs not in the sitemap (SSRF vector)', async () => {
      // LLM returns a mix of valid and hallucinated URLs
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: [
            'https://example.com/docs/api', // valid
            'http://169.254.169.254/latest/meta-data/', // AWS metadata — SSRF
            'https://example.com/docs/guides', // valid
            'https://evil.com/steal-data', // external — not in sitemap
          ],
          intentSummary: 'Extract API docs',
          urlPattern: '/docs/*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls,
      });

      const result = await service.mapIntent(intent, sitemapUrls);

      // Only the 2 valid sitemap URLs should survive
      expect(result.filteredUrls).toEqual([
        'https://example.com/docs/api',
        'https://example.com/docs/guides',
      ]);
      expect(result.filteredUrls).not.toContain('http://169.254.169.254/latest/meta-data/');
      expect(result.filteredUrls).not.toContain('https://evil.com/steal-data');
    });

    it('rejects ALL URLs when none are in the sitemap', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: [
            'http://169.254.169.254/latest/meta-data/',
            'https://internal.service/admin',
          ],
          intentSummary: 'Extract',
          urlPattern: '*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls,
      });

      const result = await service.mapIntent(intent, sitemapUrls);
      expect(result.filteredUrls).toEqual([]);
    });

    it('handles case-insensitive URL matching and returns sitemap original (R1-3)', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['HTTPS://EXAMPLE.COM/DOCS/API'],
          intentSummary: 'API docs',
          urlPattern: '/docs/*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls,
      });

      const result = await service.mapIntent(intent, sitemapUrls);
      expect(result.filteredUrls).toHaveLength(1);
      // R1-3: Must return the ORIGINAL sitemap URL, not the LLM's uppercased version
      expect(result.filteredUrls[0]).toBe('https://example.com/docs/api');
    });

    it('handles non-string entries in filteredUrls', async () => {
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: [
            'https://example.com/docs/api',
            42, // not a string
            null, // null
            undefined, // undefined
          ],
          intentSummary: 'API docs',
          urlPattern: '/docs/*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls,
      });

      const result = await service.mapIntent(intent, sitemapUrls);
      // Only the valid string URL should pass
      expect(result.filteredUrls).toEqual(['https://example.com/docs/api']);
    });

    it('returns only sampleUrl when sitemap is empty (short-circuit, no LLM)', async () => {
      // When sitemap is empty (≤1 URL), mapIntent short-circuits and returns
      // [intent.sampleUrl] without calling LLM — this is the V1 single-page
      // optimization. The LLM mock response is never reached.
      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['https://example.com/docs/api'],
          intentSummary: 'API docs',
          urlPattern: '/docs/*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls: [],
      });

      const result = await service.mapIntent(intent, []);
      // Short-circuit returns sampleUrl as the sole filteredUrl
      expect(result.filteredUrls).toEqual([intent.sampleUrl]);
      // LLM was never called
      expect(mockLlm.chat).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // V2: Prompt injection defense
  // ==========================================================================

  describe('V2: sanitizePromptInput', () => {
    it('truncates input beyond maxLength', () => {
      const long = 'a'.repeat(1000);
      const result = CrawlIntelligenceService.sanitizePromptInput(long, 500);
      expect(result.length).toBe(500);
    });

    it('strips control characters', () => {
      const malicious = 'Normal text\x00\x01\x02\x03hidden\x7F';
      const result = CrawlIntelligenceService.sanitizePromptInput(malicious, 500);
      expect(result).toBe('Normal texthidden');
      expect(result).not.toContain('\x00');
      expect(result).not.toContain('\x7F');
    });

    it('preserves newlines and tabs (not control-stripped)', () => {
      const text = 'Line 1\nLine 2\tTabbed';
      const result = CrawlIntelligenceService.sanitizePromptInput(text, 500);
      expect(result).toBe('Line 1\nLine 2\tTabbed');
    });

    it('returns empty string for null/undefined/non-string', () => {
      expect(CrawlIntelligenceService.sanitizePromptInput(null as never, 500)).toBe('');
      expect(CrawlIntelligenceService.sanitizePromptInput(undefined as never, 500)).toBe('');
      expect(CrawlIntelligenceService.sanitizePromptInput(42 as never, 500)).toBe('');
    });

    it('returns empty string for empty input', () => {
      expect(CrawlIntelligenceService.sanitizePromptInput('', 500)).toBe('');
    });
  });

  describe('V2: sanitizeUrl', () => {
    it('allows http and https URLs', () => {
      expect(CrawlIntelligenceService.sanitizeUrl('https://example.com')).toBe(
        'https://example.com',
      );
      expect(CrawlIntelligenceService.sanitizeUrl('http://example.com')).toBe('http://example.com');
    });

    it('rejects non-http schemes', () => {
      expect(CrawlIntelligenceService.sanitizeUrl('file:///etc/passwd')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('javascript:alert(1)')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('ftp://files.example.com')).toBe('');
    });

    it('blocks cloud metadata endpoints', () => {
      expect(CrawlIntelligenceService.sanitizeUrl('http://169.254.169.254/latest/meta-data/')).toBe(
        '',
      );
      expect(
        CrawlIntelligenceService.sanitizeUrl('http://metadata.google.internal/computeMetadata/v1/'),
      ).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://100.100.100.200/latest/meta-data/')).toBe(
        '',
      );
    });

    it('blocks .internal hostnames', () => {
      expect(CrawlIntelligenceService.sanitizeUrl('http://service.internal/api')).toBe('');
    });

    it('blocks loopback addresses (EH3-04)', () => {
      expect(CrawlIntelligenceService.sanitizeUrl('http://localhost/admin')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://127.0.0.1:3112/api')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://0.0.0.0:8080/debug')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://[::1]:3000/')).toBe('');
    });

    it('blocks RFC 1918 private IP ranges (EH3-04)', () => {
      // 10.0.0.0/8
      expect(CrawlIntelligenceService.sanitizeUrl('http://10.0.0.1/internal')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://10.255.255.255/')).toBe('');
      // 172.16.0.0/12
      expect(CrawlIntelligenceService.sanitizeUrl('http://172.16.0.1/')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://172.31.255.255/')).toBe('');
      // 172.15.x.x is NOT private
      expect(CrawlIntelligenceService.sanitizeUrl('http://172.15.0.1/')).toBe('http://172.15.0.1/');
      // 192.168.0.0/16
      expect(CrawlIntelligenceService.sanitizeUrl('http://192.168.1.1/')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('http://192.168.0.100:9200/')).toBe('');
      // 169.254.0.0/16 link-local
      expect(CrawlIntelligenceService.sanitizeUrl('http://169.254.1.1/')).toBe('');
    });

    it('strips control characters from URLs', () => {
      const result = CrawlIntelligenceService.sanitizeUrl('https://example.com/\x00path');
      expect(result).toBe('https://example.com/path');
    });

    it('truncates overly long URLs', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(3000);
      const result = CrawlIntelligenceService.sanitizeUrl(longUrl);
      expect(result.length).toBeLessThanOrEqual(2048);
    });

    it('returns empty string for null/undefined', () => {
      expect(CrawlIntelligenceService.sanitizeUrl(null as never)).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl(undefined as never)).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('')).toBe('');
    });

    it('rejects invalid/unparseable URLs (EH3-01)', () => {
      // Malformed URLs should be rejected, not passed through
      expect(CrawlIntelligenceService.sanitizeUrl('not-a-url')).toBe('');
      expect(CrawlIntelligenceService.sanitizeUrl('://missing-scheme')).toBe('');
    });
  });

  // ==========================================================================
  // V2: Verify sanitization is applied in all phases
  // ==========================================================================

  describe('V2: intent sanitization applied in prompts', () => {
    it('Phase 1 (mapIntent) truncates overly long intent', async () => {
      const longIntent = 'Extract '.repeat(200); // >500 chars
      const intent: CrawlIntent = {
        intent: longIntent,
        siteUrl: 'https://example.com',
        sampleUrl: 'https://example.com/page',
      };

      // Need 2+ sitemap URLs to bypass the single-URL short-circuit
      // so mapIntent actually calls the LLM
      const sitemapUrls = ['https://example.com/page', 'https://example.com/about'];

      mockLlm.chat.mockResolvedValue(
        JSON.stringify({
          filteredUrls: ['https://example.com/page'],
          intentSummary: 'test',
          urlPattern: '*',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
        sitemapUrls,
      });

      await service.mapIntent(intent, sitemapUrls);

      const userMessage = mockLlm.chat.mock.calls[0][1][0].content as string;
      // The intent in the prompt should be truncated
      expect(userMessage.length).toBeLessThan(longIntent.length + 200);
    });

    it('Phase 2 (understand) sanitizes intent in user message', async () => {
      const maliciousIntent = 'Extract data\x00\x01\x02 from API endpoints';
      const intent: CrawlIntent = {
        intent: maliciousIntent,
        siteUrl: 'https://example.com',
        sampleUrl: 'https://example.com/api',
      };

      mockMcp.listTools.mockResolvedValue([
        {
          name: 'navigate',
          description: 'Nav',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      mockLlm.chatWithToolUse.mockResolvedValue(
        createToolUseResult({
          text: JSON.stringify({
            pageStructure: 'test',
            contentAreas: [],
            intentMatch: false,
          }),
          finishReason: 'stop',
        }),
      );

      const service = new CrawlIntelligenceService({
        llmClient: mockLlm as never,
        mcpClient: mockMcp as never,
      });

      await service.understand(intent);

      const userMessage = mockLlm.chatWithToolUse.mock.calls[0][1][0].content as string;
      // Control chars should be stripped
      expect(userMessage).not.toContain('\x00');
      expect(userMessage).not.toContain('\x01');
      expect(userMessage).toContain('Extract data');
      expect(userMessage).toContain('from API endpoints');
    });
  });
});
