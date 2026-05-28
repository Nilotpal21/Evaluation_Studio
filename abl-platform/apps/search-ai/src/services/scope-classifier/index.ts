/**
 * Scope Classification Service
 *
 * ATLAS-KG Phase 5: Classify chunk scope for retrieval strategy.
 * Determines whether a chunk answers chunk-level, section-level, or document-level queries.
 *
 * Scope Levels:
 * - chunk: Answers specific, localized questions (e.g., "What is X?", "How does Y work?")
 * - section: Answers broader questions about a section/topic (e.g., "Explain authentication flow")
 * - document: Answers document-wide questions (e.g., "What is this document about?", "Summarize key points")
 *
 * Retrieval Strategies:
 * - direct: Return chunk as-is (chunk-level)
 * - with_context: Return chunk + parent summary (section-level)
 * - summary: Return parent summaries only (document-level)
 * - hierarchical: Return parent summary + top K children (document-level)
 *
 * Cost: ~$0.00001/chunk (very cheap, Gemini Flash)
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import type { Message } from '@abl/compiler/platform/llm/types';
import { PromptLoaderService } from '../prompts/prompt-loader.service.js';

export interface ScopeClassificationConfig {
  /** LLM model for classification */
  model: string;
  /** Maximum tokens for classification */
  maxTokens: number;
}

export interface ScopeClassificationResult {
  scopeLevel: 'chunk' | 'section' | 'document';
  confidence: number;
  reasoning: string | null;
  retrievalStrategy: 'direct' | 'with_context' | 'summary' | 'hierarchical';
}

export class ScopeClassifierService {
  private llmClient: ChatLLMClient;
  private config: ScopeClassificationConfig;
  private promptLoader: PromptLoaderService;

  constructor(llmClient: ChatLLMClient, config: Partial<ScopeClassificationConfig> = {}) {
    this.config = {
      model: config.model ?? 'gemini-1.5-flash',
      maxTokens: config.maxTokens ?? 150,
    };
    this.llmClient = llmClient;
    this.promptLoader = new PromptLoaderService();
  }

  /**
   * Classify scope for a chunk
   */
  async classify(
    chunkContent: string,
    context?: {
      documentTitle?: string;
      sectionHeading?: string;
      position?: number;
      totalChunks?: number;
    },
  ): Promise<ScopeClassificationResult> {
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

      return this.parseClassification(response);
    } catch (error) {
      console.error('Failed to classify scope:', error);
      // Fallback: use heuristics
      return this.fallbackClassify(chunkContent, context);
    }
  }

  /**
   * Classify scope for multiple chunks in batch
   */
  async classifyBatch(
    chunks: Array<{
      content: string;
      context?: {
        documentTitle?: string;
        sectionHeading?: string;
        position?: number;
        totalChunks?: number;
      };
    }>,
  ): Promise<ScopeClassificationResult[]> {
    // Process in parallel (batch of 10 at a time - classification is cheap)
    const batchSize = 10;
    const results: ScopeClassificationResult[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((chunk) => this.classify(chunk.content, chunk.context)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Build system prompt from YAML template
   */
  private buildSystemPrompt(): string {
    const prompt = this.promptLoader.loadPrompt('scope-classifier', 1);
    return prompt.system_prompt;
  }

  /**
   * Build user prompt from YAML template with runtime context
   */
  private buildUserPrompt(
    content: string,
    context?: {
      documentTitle?: string;
      sectionHeading?: string;
      position?: number;
      totalChunks?: number;
    },
  ): string {
    const prompt = this.promptLoader.loadPrompt('scope-classifier', 1);

    // Build dynamic context block
    let contextBlock = '';
    if (context) {
      if (context.documentTitle) {
        contextBlock += `Document: ${context.documentTitle}\n`;
      }
      if (context.sectionHeading) {
        contextBlock += `Section: ${context.sectionHeading}\n`;
      }
      if (context.position !== undefined && context.totalChunks !== undefined) {
        contextBlock += `Position: ${context.position + 1}/${context.totalChunks}\n`;
      }
      contextBlock += '\n';
    }

    // Truncate content if too long (keep first 500 chars for classification)
    const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;

    return this.promptLoader.renderPrompt(prompt.user_prompt_template!, {
      contextBlock,
      content: truncated,
    });
  }

  /**
   * Parse JSON response from LLM
   */
  private parseClassification(response: string): ScopeClassificationResult {
    try {
      // Extract JSON from response
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7, -3).trim();
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3, -3).trim();
      }

      const parsed = JSON.parse(jsonStr);

      const scopeLevel = this.normalizeScopeLevel(parsed.scope || parsed.scopeLevel || 'chunk');
      const confidence = parsed.confidence ?? 0.8;
      const reasoning = parsed.reasoning || null;

      return {
        scopeLevel,
        confidence,
        reasoning,
        retrievalStrategy: this.determineRetrievalStrategy(scopeLevel),
      };
    } catch (error) {
      console.error('Failed to parse classification response:', error);
      // Fallback to chunk-level
      return {
        scopeLevel: 'chunk',
        confidence: 0.5,
        reasoning: 'Fallback classification (parse error)',
        retrievalStrategy: 'direct',
      };
    }
  }

  /**
   * Fallback heuristic-based classification
   */
  private fallbackClassify(
    content: string,
    context?: {
      documentTitle?: string;
      sectionHeading?: string;
      position?: number;
      totalChunks?: number;
    },
  ): ScopeClassificationResult {
    const lowerContent = content.toLowerCase();

    // Document-level indicators
    const docIndicators = [
      'abstract',
      'summary',
      'overview',
      'introduction',
      'conclusion',
      'table of contents',
      'this document',
      'this paper',
      'this report',
    ];

    const hasDocIndicator = docIndicators.some((indicator) => lowerContent.includes(indicator));

    // First or last chunk is more likely document-level
    const isEdgeChunk =
      context?.position === 0 ||
      (context?.position !== undefined &&
        context?.totalChunks !== undefined &&
        context.position >= context.totalChunks - 2);

    if (hasDocIndicator || isEdgeChunk) {
      return {
        scopeLevel: 'document',
        confidence: 0.6,
        reasoning: 'Heuristic: document-level indicators or edge position',
        retrievalStrategy: 'summary',
      };
    }

    // Section-level indicators
    const sectionIndicators = [
      'in this section',
      'the following',
      'as shown above',
      'as discussed',
      'steps:',
      'process:',
      'workflow:',
    ];

    const hasSectionIndicator = sectionIndicators.some((indicator) =>
      lowerContent.includes(indicator),
    );

    if (hasSectionIndicator || context?.sectionHeading) {
      return {
        scopeLevel: 'section',
        confidence: 0.6,
        reasoning: 'Heuristic: section-level indicators',
        retrievalStrategy: 'with_context',
      };
    }

    // Default to chunk-level
    return {
      scopeLevel: 'chunk',
      confidence: 0.7,
      reasoning: 'Heuristic: default chunk-level',
      retrievalStrategy: 'direct',
    };
  }

  /**
   * Normalize scope level string to enum
   */
  private normalizeScopeLevel(scope: string): 'chunk' | 'section' | 'document' {
    const normalized = scope.toLowerCase().trim();
    if (normalized.includes('doc')) return 'document';
    if (normalized.includes('sect')) return 'section';
    return 'chunk';
  }

  /**
   * Determine retrieval strategy based on scope level
   */
  private determineRetrievalStrategy(
    scope: 'chunk' | 'section' | 'document',
  ): 'direct' | 'with_context' | 'summary' | 'hierarchical' {
    switch (scope) {
      case 'chunk':
        return 'direct';
      case 'section':
        return 'with_context';
      case 'document':
        return 'hierarchical'; // Default to hierarchical for document-level
      default:
        return 'direct';
    }
  }
}
