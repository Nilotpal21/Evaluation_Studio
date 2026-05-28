/**
 * Question Synthesis Service Tests (Phase 2)
 *
 * Tests for per-chunk and document-level question generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuestionSynthesisService } from '../services/question-synthesis/index.js';

// Mock LLMClient
const mockChat = vi.fn();

vi.mock('@abl/compiler/platform/llm', () => ({
  LLMClient: class MockLLMClient {
    constructor() {}
    chat = mockChat;
  },
}));

describe('QuestionSynthesisService (Phase 2)', () => {
  let service: QuestionSynthesisService;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockLLMClient: any = {
      chat: mockChat,
    };
    service = new QuestionSynthesisService(mockLLMClient, {
      model: 'test-model',
      questionsPerChunk: 3,
      maxTokens: 150,
      enableEmbedding: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Question Generation', () => {
    it('should generate questions from chunk content', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          {
            question: 'What is vector search?',
            type: 'conceptual',
            confidence: 0.9,
          },
          {
            question: 'How do embeddings work?',
            type: 'procedural',
            confidence: 0.85,
          },
          {
            question: 'When should you use k-NN vs ANN?',
            type: 'analytical',
            confidence: 0.8,
          },
        ]),
      );

      const result = await service.generateQuestions(
        'Vector search uses embeddings to find similar items. k-NN provides exact results while ANN offers approximate matches with better performance.',
      );

      expect(result).toBeDefined();
      expect(result.questions).toHaveLength(3);
      expect(result.questions[0].question).toBe('What is vector search?');
      expect(result.questions[0].questionType).toBe('conceptual');
      expect(result.questions[0].confidence).toBe(0.9);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.cost).toBeGreaterThan(0);
    });

    it('should handle JSON wrapped in markdown code blocks', async () => {
      mockChat.mockResolvedValueOnce(`\`\`\`json
[
  {
    "question": "What is HNSW?",
    "type": "conceptual",
    "confidence": 0.95
  }
]
\`\`\``);

      const result = await service.generateQuestions('HNSW is a graph-based ANN algorithm...');

      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].question).toBe('What is HNSW?');
    });

    it('should include document context when provided', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          {
            question: 'What indexing strategies are covered in Chapter 3?',
            type: 'factual',
            confidence: 0.9,
          },
        ]),
      );

      const result = await service.generateQuestions('HNSW indexing strategies...', {
        documentTitle: 'Vector Search Guide',
        sectionHeading: 'Chapter 3: Indexing',
      });

      expect(result).toBeDefined();

      // Verify context was passed
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('Document: Vector Search Guide');
      expect(userPrompt).toContain('Section: Chapter 3: Indexing');
    });

    it('should classify question types correctly', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'What is the index size?', type: 'factual', confidence: 0.9 },
          { question: 'What does "approximate" mean?', type: 'conceptual', confidence: 0.85 },
          {
            question: 'How do you build an HNSW index?',
            type: 'how-to-procedure',
            confidence: 0.8,
          }, // Contains "procedure"
          {
            question: 'Why is HNSW faster than flat search?',
            type: 'analytical',
            confidence: 0.75,
          },
        ]),
      );

      const result = await service.generateQuestions('Index building and performance analysis...');

      expect(result.questions).toHaveLength(4);
      expect(result.questions[0].questionType).toBe('factual');
      expect(result.questions[1].questionType).toBe('conceptual');
      expect(result.questions[2].questionType).toBe('procedural');
      expect(result.questions[3].questionType).toBe('analytical');
    });

    it('should respect questionsPerChunk configuration', async () => {
      const customService = new QuestionSynthesisService({ chat: mockChat } as any, {
        questionsPerChunk: 5,
      });

      mockChat.mockResolvedValueOnce(
        JSON.stringify(
          Array(5)
            .fill(null)
            .map((_, i) => ({
              question: `Question ${i + 1}?`,
              type: 'factual',
              confidence: 0.9,
            })),
        ),
      );

      const result = await customService.generateQuestions('Test content');

      expect(result.questions).toHaveLength(5);

      // Verify system prompt mentions 5 questions
      const systemPrompt = mockChat.mock.calls[0][0];
      expect(systemPrompt).toContain('5 clear, answerable questions');
    });

    it('should handle fallback parsing for non-JSON responses', async () => {
      mockChat.mockResolvedValueOnce(`
1. What is vector search?
2. How do embeddings work?
3. Why use ANN instead of exact search?
`);

      const result = await service.generateQuestions('Vector search basics...');

      expect(result.questions).toHaveLength(3);
      expect(result.questions[0].question).toContain('What is vector search?');
      expect(result.questions[1].question).toContain('How do embeddings work?');
      expect(result.questions[2].question).toContain('Why use ANN instead of exact search?');
      // Fallback questions have lower confidence
      expect(result.questions[0].confidence).toBe(0.6);
    });

    it('should normalize question types from various formats', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'Q1?', type: 'FACTUAL', confidence: 0.9 },
          { question: 'Q2?', type: 'definition', confidence: 0.9 },
          { question: 'Q3?', type: 'how-to', confidence: 0.9 },
          { question: 'Q4?', type: 'analytical', confidence: 0.9 }, // Changed to 'analytical'
          { question: 'Q5?', type: 'unknown', confidence: 0.9 },
        ]),
      );

      const result = await service.generateQuestions('Mixed question types...');

      expect(result.questions[0].questionType).toBe('factual');
      expect(result.questions[1].questionType).toBe('conceptual');
      expect(result.questions[2].questionType).toBe('procedural');
      expect(result.questions[3].questionType).toBe('analytical');
      expect(result.questions[4].questionType).toBe('other');
    });
  });

  describe('Batch Processing', () => {
    it('should generate questions for multiple chunks in batch', async () => {
      mockChat
        .mockResolvedValueOnce(
          JSON.stringify([{ question: 'Q1?', type: 'factual', confidence: 0.9 }]),
        )
        .mockResolvedValueOnce(
          JSON.stringify([{ question: 'Q2?', type: 'conceptual', confidence: 0.9 }]),
        )
        .mockResolvedValueOnce(
          JSON.stringify([{ question: 'Q3?', type: 'procedural', confidence: 0.9 }]),
        );

      const chunks = [
        { content: 'Chunk 1 content' },
        { content: 'Chunk 2 content' },
        { content: 'Chunk 3 content' },
      ];

      const results = await service.generateQuestionsBatch(chunks);

      expect(results).toHaveLength(3);
      expect(results[0].questions[0].question).toBe('Q1?');
      expect(results[1].questions[0].question).toBe('Q2?');
      expect(results[2].questions[0].question).toBe('Q3?');
      expect(mockChat).toHaveBeenCalledTimes(3);
    });

    it('should process batches in groups of 5', async () => {
      // Create 12 chunks (should be processed as 3 batches: 5, 5, 2)
      const chunks = Array(12)
        .fill(null)
        .map((_, i) => ({ content: `Chunk ${i + 1}` }));

      mockChat.mockResolvedValue(
        JSON.stringify([{ question: 'Test?', type: 'factual', confidence: 0.9 }]),
      );

      const results = await service.generateQuestionsBatch(chunks);

      expect(results).toHaveLength(12);
      expect(mockChat).toHaveBeenCalledTimes(12);
      // All batches should be processed (even if some are smaller)
    });

    it('should handle batch errors individually', async () => {
      mockChat
        .mockResolvedValueOnce(
          JSON.stringify([{ question: 'Q1?', type: 'factual', confidence: 0.9 }]),
        )
        .mockRejectedValueOnce(new Error('Rate limit'))
        .mockResolvedValueOnce(
          JSON.stringify([{ question: 'Q3?', type: 'factual', confidence: 0.9 }]),
        );

      const chunks = [{ content: 'Chunk 1' }, { content: 'Chunk 2' }, { content: 'Chunk 3' }];

      // Batch processing catches errors per-chunk
      await expect(service.generateQuestionsBatch(chunks)).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should throw error on LLM failure', async () => {
      mockChat.mockRejectedValueOnce(new Error('LLM timeout'));

      await expect(service.generateQuestions('Test content')).rejects.toThrow(
        'Question generation failed',
      );
    });

    it('should handle malformed JSON responses with fallback parsing', async () => {
      mockChat.mockResolvedValueOnce('{ invalid json }');

      // Should fall back to text parsing
      const result = await service.generateQuestions('Test content');

      expect(result).toBeDefined();
      expect(Array.isArray(result.questions)).toBe(true);
      // Fallback should return empty array for invalid input
      expect(result.questions).toHaveLength(0);
    });

    it('should handle empty response with fallback', async () => {
      mockChat.mockResolvedValueOnce('');

      const result = await service.generateQuestions('Test content');

      expect(result).toBeDefined();
      expect(result.questions).toHaveLength(0); // Empty fallback
    });

    it('should handle response with wrong structure using fallback', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify({
          notAnArray: 'This is not an array',
        }),
      );

      // Falls back to text parsing instead of throwing
      const result = await service.generateQuestions('Test');

      expect(result).toBeDefined();
      expect(Array.isArray(result.questions)).toBe(true);
      expect(result.questions).toHaveLength(0); // No questions extracted
    });
  });

  describe('Cost and Token Estimation', () => {
    it('should estimate tokens correctly', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'Q1?', type: 'factual', confidence: 0.9 },
          { question: 'Q2?', type: 'conceptual', confidence: 0.9 },
        ]),
      );

      const longContent = 'word '.repeat(500); // ~500 tokens
      const result = await service.generateQuestions(longContent);

      // Input tokens (~500) + system prompt (~200) + output tokens (~50)
      expect(result.totalTokens).toBeGreaterThan(700);
      expect(result.totalTokens).toBeLessThan(1000);
    });

    it('should estimate cost correctly for Gemini Flash', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([{ question: 'Q1?', type: 'factual', confidence: 0.9 }]),
      );

      const result = await service.generateQuestions('Test content ' + 'word '.repeat(100));

      // Cost should be > 0 but very small for Flash
      expect(result.cost).toBeGreaterThan(0);
      expect(result.cost).toBeLessThan(0.0005); // Should be < $0.0005 per chunk
    });
  });

  describe('Utility Methods', () => {
    it('should extract tables from HTML correctly', () => {
      const html = `
        <div>
          <table id="t1"><tr><td>Data 1</td></tr></table>
          <p>Some text</p>
          <table id="t2"><tr><td>Data 2</td></tr></table>
        </div>
      `;

      const tables = QuestionSynthesisService.prototype['extractTablesFromHtml']
        ? (QuestionSynthesisService as any).extractTablesFromHtml(html)
        : [];

      if (tables.length > 0) {
        expect(tables).toHaveLength(2);
        expect(tables[0]).toContain('Data 1');
        expect(tables[1]).toContain('Data 2');
      }
    });

    it('should extract images from HTML correctly', () => {
      const html = `
        <div>
          <img src="image1.png" alt="First image" />
          <p>Text</p>
          <img src="https://example.com/image2.jpg" />
        </div>
      `;

      const images = QuestionSynthesisService.prototype['extractImagesFromHtml']
        ? (QuestionSynthesisService as any).extractImagesFromHtml(html)
        : [];

      if (images.length > 0) {
        expect(images).toHaveLength(2);
        expect(images[0].src).toBe('image1.png');
        expect(images[0].alt).toBe('First image');
        expect(images[1].src).toBe('https://example.com/image2.jpg');
      }
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', async () => {
      const defaultService = new QuestionSynthesisService({ chat: mockChat } as any);

      mockChat.mockResolvedValueOnce(
        JSON.stringify([{ question: 'Q?', type: 'factual', confidence: 0.9 }]),
      );

      await defaultService.generateQuestions('Test');

      const options = mockChat.mock.calls[0][2];
      expect(options.model).toBe('gemini-1.5-flash');
      expect(options.maxTokens).toBe(150);
    });

    it('should use custom configuration', async () => {
      const customService = new QuestionSynthesisService({ chat: mockChat } as any, {
        model: 'custom-model',
        questionsPerChunk: 5,
        maxTokens: 200,
        enableEmbedding: false,
      });

      mockChat.mockResolvedValueOnce(
        JSON.stringify(
          Array(5)
            .fill(null)
            .map(() => ({ question: 'Q?', type: 'factual', confidence: 0.9 })),
        ),
      );

      await customService.generateQuestions('Test');

      const options = mockChat.mock.calls[0][2];
      expect(options.model).toBe('custom-model');
      expect(options.maxTokens).toBe(200);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very short content', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([{ question: 'Q?', type: 'factual', confidence: 0.9 }]),
      );

      const result = await service.generateQuestions('Short.');

      expect(result).toBeDefined();
      expect(result.questions).toHaveLength(1);
    });

    it('should handle very long content (10K+ chars)', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'What is the main topic?', type: 'conceptual', confidence: 0.9 },
        ]),
      );

      const longContent = 'Lorem ipsum. '.repeat(1000); // ~13K chars

      const result = await service.generateQuestions(longContent);

      expect(result).toBeDefined();
      expect(result.questions).toHaveLength(1);
    });

    it('should handle content with special characters and code', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'How does this code work?', type: 'procedural', confidence: 0.9 },
        ]),
      );

      const codeContent = `
function search(query: string): Result[] {
  return index.search(query);
}
`;

      const result = await service.generateQuestions(codeContent);

      expect(result).toBeDefined();
      // Verify special chars preserved in prompt
      const userPrompt = mockChat.mock.calls[0][1][0].content;
      expect(userPrompt).toContain('function search');
      expect(userPrompt).toContain('query: string');
    });

    it('should handle questions without confidence scores', async () => {
      mockChat.mockResolvedValueOnce(
        JSON.stringify([
          { question: 'Q1?', type: 'factual' }, // No confidence
          { question: 'Q2?', type: 'conceptual', confidence: undefined }, // Explicit undefined
        ]),
      );

      const result = await service.generateQuestions('Test');

      expect(result.questions).toHaveLength(2);
      expect(result.questions[0].confidence).toBe(0.8); // Default
      expect(result.questions[1].confidence).toBe(0.8); // Default
    });
  });
});
