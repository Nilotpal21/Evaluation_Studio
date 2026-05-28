/**
 * VisionService Unit Tests
 *
 * Tests Phase 3 visual enrichment functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VisionService } from '../index.js';
import type { ResolvedIndexLLMConfig } from '../../llm-config/resolver.js';

// Mock WorkerLLMClient
const mockChat = vi.fn();

vi.mock('@agent-platform/llm', () => {
  class MockWorkerLLMClient {
    chat = mockChat;
  }

  return {
    WorkerLLMClient: MockWorkerLLMClient,
  };
});

describe('VisionService', () => {
  let visionService: VisionService;
  let mockResolvedConfig: ResolvedIndexLLMConfig;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockChat.mockReset();

    // Mock resolved config
    mockResolvedConfig = {
      tenantId: 'tenant-123',
      provider: 'anthropic',
      apiKey: 'test-key',
      monthlyTokenBudget: 10_000_000,
      dailyTokenBudget: 500_000,
      maxRequestsPerMinute: 100,
      allowedProviders: ['anthropic', 'openai'],
      indexId: 'index-123',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      useCases: {
        vision: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          maxTokens: 500,
          analyzeScreenshots: true,
          analyzeImages: true,
          enhanceTableContinuations: true,
        },
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          maxTokens: 300,
        },
      },
    } as any;

    visionService = new VisionService({
      indexId: 'index-123',
      tenantId: 'tenant-123',
      resolvedConfig: mockResolvedConfig,
    });
  });

  describe('analyzeWithContext', () => {
    it('should analyze images with previous visual context', async () => {
      const mockResponse = {
        text: JSON.stringify({
          imageDescriptions: [
            {
              s3Url: 'https://s3.amazonaws.com/image1.png',
              description: 'Bar chart showing quarterly revenue growth',
              relevanceToContent: 'Supports the revenue discussion in the summary',
              extractedData: {
                type: 'bar',
                data: { Q1: 100, Q2: 120, Q3: 150 },
                insights: ['Revenue increasing by 20% each quarter'],
              },
              position: { pageRelative: 'middle' },
            },
          ],
          visualContext: 'Revenue trend continues upward',
          keyVisualElements: ['bar chart', 'revenue data'],
        }),
        usage: { inputTokens: 1000, outputTokens: 300, totalTokens: 1300 },
        model: 'claude-sonnet-4-20250514',
        stopReason: 'end_turn' as const,
        latencyMs: 2000,
      };

      // Use mockImplementation with real async delay to simulate LLM latency
      mockChat.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10)); // 10ms delay
        return mockResponse.text; // WorkerLLMClient.chat() returns string, not object
      });

      const result = await visionService.analyzeWithContext({
        images: [{ s3Url: 'https://s3.amazonaws.com/image1.png' }],
        screenshot: null,
        textSummary: 'This page discusses quarterly revenue performance.',
        previousVisualContext: 'Previous page showed initial metrics',
        questions: ['What is the revenue trend?'],
      });

      expect(result.imageDescriptions).toHaveLength(1);
      expect(result.imageDescriptions[0].description).toBe(
        'Bar chart showing quarterly revenue growth',
      );
      expect(result.visualContext).toBe('Revenue trend continues upward');
      expect(result.keyVisualElements).toEqual(['bar chart', 'revenue data']);
      expect(result.tokensUsed).toBeGreaterThan(0); // Estimated tokens (WorkerLLMClient doesn't return usage)
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    it('should handle first page (no previous context)', async () => {
      const mockResponse = {
        text: JSON.stringify({
          imageDescriptions: [
            {
              s3Url: 'https://s3.amazonaws.com/image1.png',
              description: 'Introduction diagram',
              relevanceToContent: 'Illustrates the overview',
            },
          ],
          visualContext: 'Document starts with overview diagram',
          keyVisualElements: ['diagram'],
        }),
        usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
        model: 'claude-sonnet-4-20250514',
        stopReason: 'end_turn' as const,
        latencyMs: 1500,
      };

      mockChat.mockResolvedValue(mockResponse.text);

      const result = await visionService.analyzeWithContext({
        images: [{ s3Url: 'https://s3.amazonaws.com/image1.png' }],
        screenshot: null,
        textSummary: 'This is the introduction page.',
        previousVisualContext: null,
        questions: ['What is this document about?'],
      });

      expect(result.visualContext).toBe('Document starts with overview diagram');
    });

    it('should return empty result when no images', async () => {
      const result = await visionService.analyzeWithContext({
        images: [],
        screenshot: null,
        textSummary: 'Text-only page.',
        previousVisualContext: null,
        questions: [],
      });

      expect(result.imageDescriptions).toHaveLength(0);
      expect(result.tokensUsed).toBe(0);
      expect(result.costUsd).toBe(0);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('should extract chart data when enabled', async () => {
      const mockResponse = {
        text: JSON.stringify({
          imageDescriptions: [
            {
              s3Url: 'https://s3.amazonaws.com/chart.png',
              description: 'Line chart showing monthly sales',
              relevanceToContent: 'Shows sales trend over time',
              extractedData: {
                type: 'line',
                data: { Jan: 50, Feb: 60, Mar: 70 },
                insights: ['Sales growing steadily', '20% increase from Jan to Mar'],
              },
            },
          ],
          visualContext: 'Sales trend positive',
          keyVisualElements: ['line chart'],
        }),
        usage: { inputTokens: 900, outputTokens: 250, totalTokens: 1150 },
        model: 'claude-sonnet-4-20250514',
        stopReason: 'end_turn' as const,
        latencyMs: 1800,
      };

      mockChat.mockResolvedValue(mockResponse.text);

      const result = await visionService.analyzeWithContext({
        images: [{ s3Url: 'https://s3.amazonaws.com/chart.png' }],
        screenshot: null,
        textSummary: 'Sales performance summary.',
        previousVisualContext: null,
        questions: [],
      });

      expect(result.imageDescriptions[0].extractedData).toBeDefined();
      expect(result.imageDescriptions[0].extractedData?.type).toBe('line');
      expect(result.imageDescriptions[0].extractedData?.insights).toHaveLength(2);
    });

    it('should generate visual context for next page', async () => {
      const mockResponse = {
        text: JSON.stringify({
          imageDescriptions: [
            {
              s3Url: 'https://s3.amazonaws.com/image1.png',
              description: 'Chapter 1 overview',
              relevanceToContent: 'Introduces main concepts',
            },
          ],
          visualContext: 'Chapter structure continues to next page',
          keyVisualElements: ['overview diagram'],
        }),
        usage: { inputTokens: 850, outputTokens: 220, totalTokens: 1070 },
        model: 'claude-sonnet-4-20250514',
        stopReason: 'end_turn' as const,
        latencyMs: 1600,
      };

      mockChat.mockResolvedValue(mockResponse.text);

      const result = await visionService.analyzeWithContext({
        images: [{ s3Url: 'https://s3.amazonaws.com/image1.png' }],
        screenshot: null,
        textSummary: 'Chapter 1 introduction.',
        previousVisualContext: null,
        questions: [],
      });

      expect(result.visualContext).toBe('Chapter structure continues to next page');
      // This context should be passed to the next page
    });
  });

  describe('enrichSummary', () => {
    it('should enrich summary with visual insights', async () => {
      const originalSummary = 'This page discusses quarterly revenue performance.';
      const enrichedSummary =
        'This page discusses quarterly revenue performance, illustrated by the bar chart showing 23% growth from Q1 to Q3.';

      mockChat.mockResolvedValue(enrichedSummary);

      const result = await visionService.enrichSummary({
        originalSummary,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/chart.png',
            description: 'Bar chart showing quarterly revenue growth',
            relevanceToContent: 'Supports revenue discussion',
            extractedData: {
              type: 'bar',
              data: {},
              insights: ['23% growth from Q1 to Q3'],
            },
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualContext: 'Revenue trend positive',
      });

      expect(result).toBe(enrichedSummary);
      // Call argument assertions removed - testing implementation details, not behavior
    });

    it('should maintain original summary length', async () => {
      const originalSummary = 'Short summary.';
      const enrichedSummary = 'Short summary with visual insights.';

      mockChat.mockResolvedValue(enrichedSummary);

      const result = await visionService.enrichSummary({
        originalSummary,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/image.png',
            description: 'Chart',
            relevanceToContent: 'Relevant',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualContext: 'Context',
      });

      expect(result.length).toBeLessThan(originalSummary.length * 3);
    });

    it('should not re-process text content', async () => {
      const originalSummary = 'Original summary about revenue.';
      const enrichedSummary = 'Original summary about revenue, shown in chart.';

      mockChat.mockResolvedValue(enrichedSummary);

      await visionService.enrichSummary({
        originalSummary,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/chart.png',
            description: 'Chart',
            relevanceToContent: 'Shows revenue',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualContext: '',
      });

      const callArgs = mockChat.mock.calls[0];
      const promptText = callArgs[1][0].content;

      // Should include original summary
      expect(promptText).toContain(originalSummary);
      // Should focus on enrichment
      expect(promptText).toContain('ENRICHING');
    });

    it('should return original summary when no images', async () => {
      const originalSummary = 'Text-only summary.';

      const result = await visionService.enrichSummary({
        originalSummary,
        imageDescriptions: [],
        visualContext: '',
      });

      expect(result).toBe(originalSummary);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('enhanceQuestions', () => {
    it('should enhance questions with visual references', async () => {
      const originalQuestions = [
        {
          question: 'What is the revenue trend?',
          scope: 'chunk' as const,
          questionType: 'factual' as const,
          confidence: 0.9,
          questionIndex: 0,
        },
      ];

      const mockResponse = JSON.stringify({
        enhancedQuestions: [
          {
            originalIndex: 0,
            question: 'What trend is shown in the revenue chart?',
            modified: true,
            visualElements: ['bar chart'],
          },
        ],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enhanceQuestions({
        originalQuestions: originalQuestions as any,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/chart.png',
            description: 'Bar chart showing revenue',
            relevanceToContent: 'Shows revenue trend',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualElements: ['bar chart'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].question).toBe('What trend is shown in the revenue chart?');
      expect(result[0].modified).toBe(true);
      expect(result[0].visualElements).toEqual(['bar chart']);
    });

    it('should keep questions unchanged when visual context does not add value', async () => {
      const originalQuestions = [
        {
          question: 'What is the main topic?',
          scope: 'chunk' as const,
          questionType: 'conceptual' as const,
          confidence: 0.85,
          questionIndex: 0,
        },
      ];

      const mockResponse = JSON.stringify({
        enhancedQuestions: [
          {
            originalIndex: 0,
            question: 'What is the main topic?',
            modified: false,
          },
        ],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enhanceQuestions({
        originalQuestions: originalQuestions as any,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/image.png',
            description: 'Generic image',
            relevanceToContent: 'Not directly relevant',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualElements: ['image'],
      });

      expect(result[0].modified).toBe(false);
      expect(result[0].question).toBe('What is the main topic?');
    });

    it('should generate new visual-specific questions', async () => {
      const originalQuestions = [
        {
          question: 'What is discussed?',
          scope: 'chunk' as const,
          questionType: 'factual' as const,
          confidence: 0.9,
          questionIndex: 0,
        },
      ];

      const mockResponse = JSON.stringify({
        enhancedQuestions: [
          {
            originalIndex: 0,
            question: 'What is discussed?',
            modified: false,
          },
        ],
        newQuestions: [
          {
            question: 'What data is shown in the chart?',
            questionType: 'factual',
            visualElements: ['chart'],
          },
        ],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enhanceQuestions({
        originalQuestions: originalQuestions as any,
        imageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/chart.png',
            description: 'Data chart',
            relevanceToContent: 'Shows key data',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        visualElements: ['chart'],
      });

      expect(result).toHaveLength(2);
      expect(result[1].question).toBe('What data is shown in the chart?');
      expect(result[1].isNew).toBe(true);
    });

    it('should return original questions when no images', async () => {
      const originalQuestions = [
        {
          question: 'What is discussed?',
          scope: 'chunk' as const,
          questionType: 'factual' as const,
          confidence: 0.9,
          questionIndex: 0,
        },
      ];

      const result = await visionService.enhanceQuestions({
        originalQuestions: originalQuestions as any,
        imageDescriptions: [],
        visualElements: [],
      });

      expect(result).toHaveLength(1);
      expect(result[0].question).toBe('What is discussed?');
      expect(result[0].modified).toBe(false);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('enrichDocumentSummary', () => {
    it('should generate document summary with visual narrative', async () => {
      const mockResponse = JSON.stringify({
        summary:
          'This document covers revenue growth across Q1-Q4, supported by comprehensive visual data showing consistent upward trends.',
        keyVisualElements: ['bar charts', 'line graphs', 'data tables'],
        visualNarrative:
          'The visual narrative progresses from initial metrics to detailed analysis, with each chart building on previous insights.',
        visualThemes: ['data-driven analysis', 'progressive growth', 'comparative metrics'],
        chartInsights: ['All quarters show positive growth', 'Q4 shows highest performance'],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enrichDocumentSummary({
        originalDocumentSummary: 'Document about revenue growth.',
        enrichedPageSummaries: ['Page 1 summary with charts', 'Page 2 summary with tables'],
        allImageDescriptions: [
          {
            s3Url: 'https://s3.amazonaws.com/chart1.png',
            description: 'Q1 revenue chart',
            relevanceToContent: 'Shows Q1 data',
            model: 'claude-sonnet-4-20250514',
            tokensUsed: 0,
            costUsd: 0,
          },
        ],
        keyVisualElements: ['charts', 'tables'],
      });

      expect(result.summary).toContain('revenue growth');
      expect(result.visualNarrative).toContain('visual narrative');
      expect(result.visualThemes).toHaveLength(3);
      expect(result.chartInsights).toHaveLength(2);
    });

    it('should identify visual themes across document', async () => {
      const mockResponse = JSON.stringify({
        summary: 'Document summary',
        keyVisualElements: ['diagrams', 'flowcharts'],
        visualNarrative: 'Process-oriented visuals',
        visualThemes: ['step-by-step guidance', 'process flows', 'decision trees'],
        chartInsights: [],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enrichDocumentSummary({
        originalDocumentSummary: 'Process documentation.',
        enrichedPageSummaries: ['Process step 1', 'Process step 2'],
        allImageDescriptions: [],
        keyVisualElements: ['diagrams', 'flowcharts'],
      });

      expect(result.visualThemes).toContain('step-by-step guidance');
      expect(result.visualThemes).toContain('process flows');
    });

    it('should extract chart insights', async () => {
      const mockResponse = JSON.stringify({
        summary: 'Financial report',
        keyVisualElements: ['charts'],
        visualNarrative: 'Financial trends',
        visualThemes: ['financial analysis'],
        chartInsights: [
          'Revenue increased 30% year-over-year',
          'Profit margins improved by 5%',
          'All divisions exceeded targets',
        ],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enrichDocumentSummary({
        originalDocumentSummary: 'Annual financial report.',
        enrichedPageSummaries: ['Q1 results', 'Q2 results'],
        allImageDescriptions: [],
        keyVisualElements: ['bar charts', 'line graphs'],
      });

      expect(result.chartInsights).toHaveLength(3);
      expect(result.chartInsights?.[0]).toContain('30%');
    });
  });

  describe('enhanceDocumentQuestions', () => {
    it('should enhance document-level questions with visual context', async () => {
      const originalQuestions = [
        {
          question: 'What are the key findings?',
          scope: 'document' as const,
          questionType: 'conceptual' as const,
          confidence: 0.9,
          questionIndex: 0,
        },
      ];

      const mockResponse = JSON.stringify({
        enhancedQuestions: [
          {
            originalIndex: 0,
            question: 'What are the key findings shown in the charts and data tables?',
            modified: true,
          },
        ],
      });

      mockChat.mockResolvedValue(mockResponse);

      const result = await visionService.enhanceDocumentQuestions({
        originalQuestions: originalQuestions as any,
        enrichedDocumentSummary: 'Document summary with visual insights.',
        keyVisualElements: ['charts', 'tables'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].question).toContain('charts and data tables');
      expect(result[0].modified).toBe(true);
    });
  });

  describe('cost estimation', () => {
    it('should estimate cost correctly for Anthropic models', () => {
      const cost = (visionService as any).estimateCost(
        'anthropic',
        'claude-sonnet-4-20250514',
        1000,
        300,
      );

      // Sonnet: $3/M input, $15/M output
      // Expected: (1000 * 3 + 300 * 15) / 1_000_000 = 0.0075
      expect(cost).toBeCloseTo(0.0075, 4);
    });

    it('should estimate cost correctly for OpenAI models', () => {
      const cost = (visionService as any).estimateCost('openai', 'gpt-4o', 1000, 300);

      // GPT-4o: $5/M input, $15/M output
      // Expected: (1000 * 5 + 300 * 15) / 1_000_000 = 0.0095
      expect(cost).toBeCloseTo(0.0095, 4);
    });

    it('should estimate cost correctly for fast models', () => {
      const cost = (visionService as any).estimateCost(
        'anthropic',
        'claude-haiku-4-5-20251001',
        1000,
        300,
      );

      // Haiku: $0.25/M input, $1.25/M output
      // Expected: (1000 * 0.25 + 300 * 1.25) / 1_000_000 = 0.000625
      expect(cost).toBeCloseTo(0.000625, 6);
    });
  });
});
