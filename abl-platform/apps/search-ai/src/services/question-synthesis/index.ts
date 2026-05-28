/**
 * Question Synthesis Service
 *
 * ATLAS-KG Phase 5: Pre-generate answerable questions for each chunk.
 * Enables question-based retrieval and query matching.
 *
 * Architecture:
 * - Generate 3-5 questions per chunk using LLM
 * - Classify question types (factual, conceptual, procedural, analytical)
 * - Optionally embed questions for semantic search
 * - Store in ChunkQuestion collection
 *
 * Cost: ~$0.00017/chunk (Gemini Flash)
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import type { Message } from '@abl/compiler/platform/llm/types';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
import { PromptLoaderService, type PromptDefinition } from '../prompts/prompt-loader.service.js';

export interface QuestionSynthesisConfig {
  /** LLM model for question generation */
  model: string;
  /** Number of questions to generate per chunk (3-5 recommended) */
  questionsPerChunk: number;
  /** Maximum tokens for generation */
  maxTokens: number;
  /** Enable question embedding */
  enableEmbedding: boolean;
}

export interface SynthesizedQuestion {
  question: string;
  questionType: 'factual' | 'conceptual' | 'procedural' | 'analytical' | 'other';
  confidence: number;
  vectorId?: string;
}

export interface QuestionSynthesisResult {
  questions: SynthesizedQuestion[];
  totalTokens: number;
  cost: number;
}

export class QuestionSynthesisService {
  private llmClient: ChatLLMClient;
  private config: QuestionSynthesisConfig;
  private promptLoader: PromptLoaderService;
  private promptDefinition: PromptDefinition;

  constructor(llmClient: ChatLLMClient, config: Partial<QuestionSynthesisConfig> = {}) {
    this.config = {
      model: config.model ?? 'gemini-1.5-flash',
      questionsPerChunk: config.questionsPerChunk ?? 3,
      maxTokens: config.maxTokens ?? 150,
      enableEmbedding: config.enableEmbedding ?? true,
    };
    this.llmClient = llmClient;
    this.promptLoader = new PromptLoaderService();
    this.promptDefinition = this.promptLoader.loadPrompt('question-synthesis', 1);
  }

  /**
   * Generate questions for a chunk
   */
  async generateQuestions(
    chunkContent: string,
    context?: {
      documentTitle?: string;
      documentType?: string;
      sectionHeading?: string;
    },
  ): Promise<QuestionSynthesisResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(chunkContent, context);

    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    try {
      const response = await this.llmClient.chat(systemPrompt, messages, {
        model: this.config.model,
        maxTokens: this.config.maxTokens,
      });

      // Parse JSON response
      const parsed = this.parseQuestions(response);

      // Estimate cost (rough approximation)
      const inputTokens = this.estimateTokens(systemPrompt + userPrompt);
      const outputTokens = this.estimateTokens(response);
      const cost = this.estimateCost(inputTokens, outputTokens);

      return {
        questions: parsed,
        totalTokens: inputTokens + outputTokens,
        cost,
      };
    } catch (error) {
      console.error('Failed to generate questions:', error);
      throw new Error(
        `Question generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Generate questions for multiple chunks in batch
   */
  async generateQuestionsBatch(
    chunks: Array<{
      content: string;
      context?: {
        documentTitle?: string;
        documentType?: string;
        sectionHeading?: string;
      };
    }>,
  ): Promise<QuestionSynthesisResult[]> {
    // Process in parallel (batch of 5 at a time to avoid rate limits)
    const batchSize = 5;
    const results: QuestionSynthesisResult[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((chunk) => this.generateQuestions(chunk.content, chunk.context)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Build system prompt from YAML template
   */
  private buildSystemPrompt(): string {
    return this.promptLoader.renderPrompt(this.promptDefinition.system_prompt, {
      questionsPerChunk: String(this.config.questionsPerChunk),
    });
  }

  /**
   * Build user prompt from YAML template with dynamic context
   */
  private buildUserPrompt(
    content: string,
    context?: {
      documentTitle?: string;
      documentType?: string;
      sectionHeading?: string;
    },
  ): string {
    // Build dynamic context block
    let contextBlock = '';
    if (context) {
      if (context.documentTitle) {
        contextBlock += `Document: ${context.documentTitle}\n`;
      }
      if (context.documentType) {
        contextBlock += `Type: ${context.documentType}\n`;
      }
      if (context.sectionHeading) {
        contextBlock += `Section: ${context.sectionHeading}\n`;
      }
      contextBlock += '\n';
    }

    return this.promptLoader.renderPrompt(this.promptDefinition.user_prompt_template!, {
      contextBlock,
      chunkContent: content,
      questionsPerChunk: String(this.config.questionsPerChunk),
    });
  }

  /**
   * Parse JSON response from LLM
   */
  private parseQuestions(response: string): SynthesizedQuestion[] {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7, -3).trim();
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3, -3).trim();
      }

      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }

      return parsed.map((q: any) => ({
        question: q.question || q.text || '',
        questionType: this.normalizeQuestionType(q.type || q.questionType || 'other'),
        confidence: q.confidence ?? 0.8,
        vectorId: undefined,
      }));
    } catch (error) {
      console.error('Failed to parse question response:', error);
      // Fallback: extract questions from text (simple line-based parsing)
      return this.fallbackParse(response);
    }
  }

  /**
   * Fallback parser for non-JSON responses
   */
  private fallbackParse(response: string): SynthesizedQuestion[] {
    const lines = response
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes('?'));

    return lines.slice(0, this.config.questionsPerChunk).map((line) => ({
      question: line.replace(/^\d+[\.\)]\s*/, ''), // Remove numbering
      questionType: 'other' as const,
      confidence: 0.6, // Lower confidence for fallback
      vectorId: undefined,
    }));
  }

  /**
   * Normalize question type to enum
   */
  private normalizeQuestionType(
    type: string,
  ): 'factual' | 'conceptual' | 'procedural' | 'analytical' | 'other' {
    const normalized = type.toLowerCase();
    if (
      normalized.includes('fact') ||
      normalized.includes('what') ||
      normalized.includes('who') ||
      normalized.includes('when')
    ) {
      return 'factual';
    }
    if (normalized.includes('concept') || normalized.includes('definition')) {
      return 'conceptual';
    }
    if (
      normalized.includes('procedure') ||
      normalized.includes('how') ||
      normalized.includes('step')
    ) {
      return 'procedural';
    }
    if (
      normalized.includes('analyt') ||
      normalized.includes('why') ||
      normalized.includes('compar')
    ) {
      return 'analytical';
    }
    return 'other';
  }

  /**
   * Count tokens using tiktoken for accurate cost estimation
   */
  private estimateTokens(text: string): number {
    return countTokens(text);
  }

  /**
   * Estimate cost (rough approximation for Gemini Flash)
   */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    // Gemini Flash: $0.075 per 1M input tokens, $0.30 per 1M output tokens
    const inputCost = (inputTokens / 1_000_000) * 0.075;
    const outputCost = (outputTokens / 1_000_000) * 0.3;
    return inputCost + outputCost;
  }
}
