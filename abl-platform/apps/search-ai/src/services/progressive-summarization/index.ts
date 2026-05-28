/**
 * Progressive Summarization Service
 *
 * ATLAS-KG Phase 2: Generate context-aware summaries for chunks.
 * Each chunk summary considers the previous chunk's summary for continuity.
 * Enables better chunking with contextual understanding.
 *
 * Architecture:
 * - Generate summary for each chunk/page with previous context
 * - Pass summary forward to next chunk for progressive context
 * - Generate document-level summary from all chunk summaries
 * - Store summaries in SearchChunk metadata
 *
 * Cost: ~$0.0002/chunk (Haiku)
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
import { PromptLoaderService, type PromptDefinition } from '../prompts/prompt-loader.service.js';

export interface ProgressiveSummarizationConfig {
  /** LLM model for summarization */
  model: string;
  /** Maximum tokens for chunk summaries */
  maxTokens: number;
  /** Enable document-level summary */
  enableDocumentSummary: boolean;
  /** Maximum tokens for document-level summary */
  documentSummaryMaxTokens: number;
}

export interface ChunkSummaryResult {
  summary: string;
  totalTokens: number;
  cost: number;
}

export interface DocumentSummaryResult {
  summary: string;
  totalTokens: number;
  cost: number;
}

export class ProgressiveSummarizationService {
  private llmClient: ChatLLMClient;
  private config: ProgressiveSummarizationConfig;
  private promptLoader: PromptLoaderService;
  private chunkPrompt: PromptDefinition;
  private documentPrompt: PromptDefinition;

  constructor(llmClient: ChatLLMClient, config: Partial<ProgressiveSummarizationConfig> = {}) {
    this.config = {
      model: config.model ?? 'claude-3-5-haiku-20241022',
      maxTokens: config.maxTokens ?? 300,
      enableDocumentSummary: config.enableDocumentSummary ?? true,
      documentSummaryMaxTokens: config.documentSummaryMaxTokens ?? 500,
    };
    this.llmClient = llmClient;
    this.promptLoader = new PromptLoaderService();
    this.chunkPrompt = this.promptLoader.loadPrompt('progressive-summarization-chunk', 1);
    this.documentPrompt = this.promptLoader.loadPrompt('progressive-summarization-document', 1);
  }

  /**
   * Generate summary for a chunk with optional previous context
   */
  async summarizeChunk(
    chunkContent: string,
    previousSummary: string | null = null,
    context?: {
      documentTitle?: string;
      pageNumber?: number;
      sectionHeading?: string;
    },
  ): Promise<ChunkSummaryResult> {
    const systemPrompt = this.buildChunkSystemPrompt();
    const userPrompt = this.buildChunkUserPrompt(chunkContent, previousSummary, context);

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

      // Extract summary (may be wrapped in markdown)
      const summary = this.extractSummary(response);

      // Estimate cost
      const inputTokens = this.estimateTokens(systemPrompt + userPrompt);
      const outputTokens = this.estimateTokens(response);
      const cost = this.estimateCost(inputTokens, outputTokens);

      return {
        summary,
        totalTokens: inputTokens + outputTokens,
        cost,
      };
    } catch (error) {
      console.error('Failed to generate chunk summary:', error);
      throw new Error(
        `Chunk summarization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Generate document-level summary from all chunk summaries
   */
  async summarizeDocument(
    chunkSummaries: string[],
    context?: {
      documentTitle?: string;
      documentType?: string;
      totalPages?: number;
    },
  ): Promise<DocumentSummaryResult> {
    if (chunkSummaries.length === 0) {
      throw new Error('Cannot generate document summary: no chunk summaries provided');
    }

    const systemPrompt = this.buildDocumentSystemPrompt();
    const userPrompt = this.buildDocumentUserPrompt(chunkSummaries, context);

    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    try {
      const response = await this.llmClient.chat(systemPrompt, messages, {
        model: this.config.model,
        maxTokens: this.config.documentSummaryMaxTokens,
      });

      const summary = this.extractSummary(response);

      // Estimate cost
      const inputTokens = this.estimateTokens(systemPrompt + userPrompt);
      const outputTokens = this.estimateTokens(response);
      const cost = this.estimateCost(inputTokens, outputTokens);

      return {
        summary,
        totalTokens: inputTokens + outputTokens,
        cost,
      };
    } catch (error) {
      console.error('Failed to generate document summary:', error);
      throw new Error(
        `Document summarization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Build system prompt for chunk summarization from YAML template
   */
  private buildChunkSystemPrompt(): string {
    return this.chunkPrompt.system_prompt;
  }

  /**
   * Build user prompt for chunk summarization from YAML template with dynamic context
   */
  private buildChunkUserPrompt(
    content: string,
    previousSummary: string | null,
    context?: {
      documentTitle?: string;
      pageNumber?: number;
      sectionHeading?: string;
    },
  ): string {
    // Build dynamic context block
    let contextBlock = '';
    if (context) {
      if (context.documentTitle) {
        contextBlock += `Document: ${context.documentTitle}\n`;
      }
      if (context.pageNumber !== undefined) {
        contextBlock += `Page: ${context.pageNumber}\n`;
      }
      if (context.sectionHeading) {
        contextBlock += `Section: ${context.sectionHeading}\n`;
      }
      contextBlock += '\n';
    }

    // Build previous summary block
    let previousSummaryBlock = '';
    if (previousSummary) {
      previousSummaryBlock = `Previous chunk summary:\n${previousSummary}\n\n`;
    }

    return this.promptLoader.renderPrompt(this.chunkPrompt.user_prompt_template!, {
      contextBlock,
      previousSummaryBlock,
      chunkContent: content,
    });
  }

  /**
   * Build system prompt for document summarization from YAML template
   */
  private buildDocumentSystemPrompt(): string {
    return this.documentPrompt.system_prompt;
  }

  /**
   * Build user prompt for document summarization from YAML template with dynamic context
   */
  private buildDocumentUserPrompt(
    chunkSummaries: string[],
    context?: {
      documentTitle?: string;
      documentType?: string;
      totalPages?: number;
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
      if (context.totalPages !== undefined) {
        contextBlock += `Pages: ${context.totalPages}\n`;
      }
      contextBlock += '\n';
    }

    // Build chunk summaries block
    let chunkSummariesBlock = '';
    chunkSummaries.forEach((summary, idx) => {
      chunkSummariesBlock += `[Chunk ${idx + 1}]\n${summary}\n\n`;
    });

    return this.promptLoader.renderPrompt(this.documentPrompt.user_prompt_template!, {
      contextBlock,
      chunkSummariesBlock,
    });
  }

  /**
   * Extract summary from LLM response (handle markdown wrapping)
   */
  private extractSummary(response: string): string {
    let summary = response.trim();

    // Remove markdown code blocks if present
    if (summary.startsWith('```')) {
      const lines = summary.split('\n');
      lines.shift(); // Remove opening ```
      if (lines[lines.length - 1].trim() === '```') {
        lines.pop(); // Remove closing ```
      }
      summary = lines.join('\n').trim();
    }

    // Remove "Summary:" prefix if present
    summary = summary.replace(/^Summary:\s*/i, '');

    return summary;
  }

  /**
   * Count tokens using tiktoken for accurate cost estimation
   */
  private estimateTokens(text: string): number {
    return countTokens(text);
  }

  /**
   * Estimate cost (rough approximation for Claude Haiku)
   */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    // Claude 3.5 Haiku: $0.80 per 1M input tokens, $4.00 per 1M output tokens
    const inputCost = (inputTokens / 1_000_000) * 0.8;
    const outputCost = (outputTokens / 1_000_000) * 4.0;
    return inputCost + outputCost;
  }
}
