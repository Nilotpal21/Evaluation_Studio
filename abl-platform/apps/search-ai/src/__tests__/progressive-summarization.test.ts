/**
 * Progressive Summarization Service Tests (Phase 2)
 *
 * Tests for context-aware chunk summarization and document-level summary generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressiveSummarizationService } from '../services/progressive-summarization/index.js';

// Mock LLMClient
const mockChat = vi.fn();

vi.mock('@abl/compiler/platform/llm', () => ({
  LLMClient: class MockLLMClient {
    constructor() {}
    chat = mockChat;
  },
}));

describe('ProgressiveSummarizationService', () => {
  let service: ProgressiveSummarizationService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock LLMClient is injected via constructor
    const mockLLMClient: any = {
      chat: mockChat,
    };
    service = new ProgressiveSummarizationService(mockLLMClient, {
      model: 'test-model',
      maxTokens: 300,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 500,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Chunk Summarization', () => {
    it('should summarize a chunk without previous context', async () => {
      mockChat.mockResolvedValueOnce(
        'This chunk discusses vector search fundamentals and embedding techniques.',
      );

      const result = await service.summarizeChunk(
        'Vector search is a technique for finding similar items based on their embeddings...',
        null,
      );

      expect(result).toBeDefined();
      expect(result.summary).toBe(
        'This chunk discusses vector search fundamentals and embedding techniques.',
      );
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.cost).toBeGreaterThan(0);
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Verify system prompt includes key instructions
      const systemPrompt = mockChat.mock.calls[0][0];
      expect(systemPrompt).toContain('summarization expert');
      expect(systemPrompt).toContain('KEY INFORMATION');
      expect(systemPrompt).toContain('2-3 sentences');
    });

    it('should summarize a chunk WITH previous context', async () => {
      mockChat.mockResolvedValueOnce(
        'Building on the vector search introduction, this chunk explains k-NN algorithms and ANN approximation methods.',
      );

      const previousSummary =
        'The previous chunk introduced vector search and embeddings as fundamental concepts.';

      const result = await service.summarizeChunk(
        'k-NN search finds exact nearest neighbors but is slow for large datasets. ANN methods like HNSW provide approximate results with better performance...',
        previousSummary,
      );

      expect(result).toBeDefined();
      expect(result.summary).toContain('k-NN');
      expect(result.summary).toContain('ANN');

      // Verify previous context was passed to LLM
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('Previous chunk summary:');
      expect(userPrompt).toContain(previousSummary);
      expect(userPrompt).toContain('Current chunk text:');
    });

    it('should include document context when provided', async () => {
      mockChat.mockResolvedValueOnce(
        'Page 5 of the Vector Search Guide explains indexing strategies.',
      );

      const result = await service.summarizeChunk(
        'HNSW indexes provide excellent query performance...',
        null,
        {
          documentTitle: 'Vector Search Guide',
          pageNumber: 5,
          sectionHeading: 'Indexing Strategies',
        },
      );

      expect(result).toBeDefined();

      // Verify context was included in prompt
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('Document: Vector Search Guide');
      expect(userPrompt).toContain('Page: 5');
      expect(userPrompt).toContain('Section: Indexing Strategies');
    });

    it('should handle markdown-wrapped responses', async () => {
      mockChat.mockResolvedValueOnce('```\nThis is a summary wrapped in markdown code block.\n```');

      const result = await service.summarizeChunk('Test content', null);

      expect(result.summary).toBe('This is a summary wrapped in markdown code block.');
      expect(result.summary).not.toContain('```');
    });

    it('should handle "Summary:" prefix in response', async () => {
      mockChat.mockResolvedValueOnce(
        'Summary: This chunk covers advanced topics in vector search.',
      );

      const result = await service.summarizeChunk('Advanced vector search topics...', null);

      expect(result.summary).toBe('This chunk covers advanced topics in vector search.');
      expect(result.summary).not.toContain('Summary:');
    });

    it('should handle LLM errors gracefully', async () => {
      mockChat.mockRejectedValueOnce(new Error('LLM API timeout'));

      await expect(service.summarizeChunk('Test content', null)).rejects.toThrow(
        'Chunk summarization failed',
      );
    });

    it('should estimate token count correctly', async () => {
      mockChat.mockResolvedValueOnce('Short summary.');

      const longContent = 'A'.repeat(4000); // ~1000 tokens with char/4, ~600 with tiktoken
      const result = await service.summarizeChunk(longContent, null);

      // With tiktoken: ~600 input + ~3 output + ~140 system prompt = ~750 total
      expect(result.totalTokens).toBeGreaterThan(600);
      expect(result.totalTokens).toBeLessThan(1000);
    });

    it('should estimate cost correctly for Claude Haiku', async () => {
      mockChat.mockResolvedValueOnce('Summary response with about 50 tokens.');

      const result = await service.summarizeChunk('Test content ' + 'word '.repeat(100), null);

      // Cost should be > 0 and reasonable for Haiku pricing
      expect(result.cost).toBeGreaterThan(0);
      expect(result.cost).toBeLessThan(0.001); // Should be < $0.001 per chunk
    });
  });

  describe('Document Summarization', () => {
    it('should summarize document from chunk summaries', async () => {
      mockChat.mockResolvedValueOnce(
        'This document provides a comprehensive guide to vector search, covering fundamentals, algorithms, indexing strategies, and optimization techniques. It is aimed at developers building search systems.',
      );

      const chunkSummaries = [
        'Chapter 1 introduces vector search and embeddings.',
        'Chapter 2 explains k-NN and ANN algorithms.',
        'Chapter 3 covers HNSW indexing strategies.',
        'Chapter 4 discusses performance optimization.',
      ];

      const result = await service.summarizeDocument(chunkSummaries);

      expect(result).toBeDefined();
      expect(result.summary).toContain('vector search');
      expect(result.summary.length).toBeGreaterThan(100); // Document summaries should be longer
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.cost).toBeGreaterThan(0);

      // Verify all chunk summaries were included
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('[Chunk 1]');
      expect(userPrompt).toContain('[Chunk 2]');
      expect(userPrompt).toContain('[Chunk 3]');
      expect(userPrompt).toContain('[Chunk 4]');
      expect(userPrompt).toContain('Chapter 1');
      expect(userPrompt).toContain('Chapter 4');
    });

    it('should include document context when provided', async () => {
      mockChat.mockResolvedValueOnce('The Vector Search Guide is a 100-page technical document...');

      const chunkSummaries = ['Summary 1', 'Summary 2'];

      const result = await service.summarizeDocument(chunkSummaries, {
        documentTitle: 'Vector Search Guide',
        documentType: 'Technical Guide',
        totalPages: 100,
      });

      expect(result).toBeDefined();

      // Verify context was included
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('Document: Vector Search Guide');
      expect(userPrompt).toContain('Type: Technical Guide');
      expect(userPrompt).toContain('Pages: 100');
    });

    it('should handle single chunk summary', async () => {
      mockChat.mockResolvedValueOnce('This short document discusses vector embeddings.');

      const result = await service.summarizeDocument(['Single chunk summary about embeddings.']);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('should handle many chunk summaries (100+)', async () => {
      mockChat.mockResolvedValueOnce('Comprehensive summary of 150-page document...');

      const chunkSummaries = Array(150)
        .fill(null)
        .map((_, i) => `Chunk ${i + 1} summary.`);

      const result = await service.summarizeDocument(chunkSummaries);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();

      // Verify prompt isn't too long
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt.length).toBeLessThan(100_000); // Reasonable prompt length
    });

    it('should throw error for empty chunk summaries', async () => {
      await expect(service.summarizeDocument([])).rejects.toThrow(
        'Cannot generate document summary: no chunk summaries provided',
      );
    });

    it('should handle LLM errors during document summarization', async () => {
      mockChat.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      await expect(service.summarizeDocument(['Summary 1', 'Summary 2'])).rejects.toThrow(
        'Document summarization failed',
      );
    });

    it('should use higher token limit for document summaries', async () => {
      mockChat.mockResolvedValueOnce('Long document summary ' + 'with many details. '.repeat(50));

      const result = await service.summarizeDocument(['Summary 1', 'Summary 2']);

      // Document summaries use documentSummaryMaxTokens (500 vs 300 for chunks)
      expect(result.totalTokens).toBeGreaterThan(0);
      // Verify the right model config was used in chat call
      const options = mockChat.mock.calls[0][2];
      expect(options.maxTokens).toBe(500); // documentSummaryMaxTokens
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', async () => {
      const mockLLMClient: any = { chat: mockChat };
      const defaultService = new ProgressiveSummarizationService(mockLLMClient);

      mockChat.mockResolvedValueOnce('Default config summary.');

      await defaultService.summarizeChunk('Test', null);

      const options = mockChat.mock.calls[0][2];
      expect(options.model).toBe('claude-3-5-haiku-20241022');
      expect(options.maxTokens).toBe(300);
    });

    it('should use custom configuration', async () => {
      const mockLLMClient: any = { chat: mockChat };
      const customService = new ProgressiveSummarizationService(mockLLMClient, {
        model: 'custom-model',
        maxTokens: 500,
        enableDocumentSummary: false,
        documentSummaryMaxTokens: 1000,
      });

      mockChat.mockResolvedValueOnce('Custom config summary.');

      await customService.summarizeChunk('Test', null);

      const options = mockChat.mock.calls[0][2];
      expect(options.model).toBe('custom-model');
      expect(options.maxTokens).toBe(500);
    });

    it('should respect enableDocumentSummary flag', async () => {
      const mockLLMClient: any = { chat: mockChat };
      const service = new ProgressiveSummarizationService(mockLLMClient, {
        enableDocumentSummary: true, // Explicitly enabled (default)
      });

      mockChat.mockResolvedValueOnce('Document summary.');

      const result = await service.summarizeDocument(['Summary 1']);

      expect(result).toBeDefined();
      expect(mockChat).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle very short content', async () => {
      mockChat.mockResolvedValueOnce('Brief summary.');

      const result = await service.summarizeChunk('Short.', null);

      expect(result).toBeDefined();
      expect(result.summary).toBe('Brief summary.');
    });

    it('should handle very long content (10K+ chars)', async () => {
      mockChat.mockResolvedValueOnce('Summary of long content.');

      const longContent = 'Lorem ipsum. '.repeat(1000); // ~13K chars

      const result = await service.summarizeChunk(longContent, null);

      expect(result).toBeDefined();
      expect(result.summary).toBe('Summary of long content.');
    });

    it('should handle content with special characters', async () => {
      mockChat.mockResolvedValueOnce('Summary with special chars preserved.');

      const specialContent = 'Content with $pecial ch@rs & symbols: <html> & "quotes"';

      const result = await service.summarizeChunk(specialContent, null);

      expect(result).toBeDefined();
      // Verify special chars were passed to LLM (not sanitized)
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('$pecial');
      expect(userPrompt).toContain('<html>');
    });

    it('should handle newlines and formatting in content', async () => {
      mockChat.mockResolvedValueOnce('Summary preserving structure.');

      const formattedContent = `
# Heading

Paragraph 1 with **bold**.

- List item 1
- List item 2

Code block:
\`\`\`
function test() {}
\`\`\`
`;

      const result = await service.summarizeChunk(formattedContent, null);

      expect(result).toBeDefined();
      // Verify formatting was preserved in prompt
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('# Heading');
      expect(userPrompt).toContain('- List item');
    });

    it('should handle empty previous summary (null vs empty string)', async () => {
      mockChat.mockResolvedValueOnce('Summary without context.');

      const result1 = await service.summarizeChunk('Test', null);
      mockChat.mockClear();
      mockChat.mockResolvedValueOnce('Summary without context.');
      const result2 = await service.summarizeChunk('Test', '');

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      // Both should work, prompt should not include empty "Previous chunk summary:"
      const userPrompt1 = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt1).not.toContain('Previous chunk summary:');
    });
  });
});
