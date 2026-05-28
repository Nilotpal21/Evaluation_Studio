/**
 * Document Classifier Service
 *
 * Classifies documents by product scope using existing summaries.
 * Uses ChatLLMClient (provider-agnostic) with Haiku primary, Sonnet escalation.
 *
 * Key Design:
 * - DOCUMENT-LEVEL classification (not chunk-level)
 * - Uses EXISTING document summary (zero extra cost!)
 * - Haiku primary (fast, cheap), Sonnet escalation if confidence < 0.8
 * - Provider-agnostic (works with any LLM via ChatLLMClient)
 *
 * Cost: ~$0.0002/document (Haiku), ~$0.002/document (Sonnet escalation)
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import type { IKnowledgeGraphTaxonomy } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import { PromptLoaderService, type PromptDefinition } from './prompts/prompt-loader.service.js';

const log = createLogger('document-classifier');

// =============================================================================
// TYPES
// =============================================================================

export interface DocumentInput {
  title: string;
  summary: string; // Already generated during ingestion!
  metadata?: Record<string, unknown>;
}

export interface ClassificationResult {
  classification: {
    productScope: {
      primaryProduct: string;
      confidence: number;
      secondaryProducts: string[];
    };
    department: string;
    subDepartment?: string;
    category: string;
    classifiedAt: Date;
    classificationMethod: 'llm';
    model: string;
    escalatedToSonnet: boolean;
  };
  reasoning?: string;
}

export interface DocumentClassifierConfig {
  primaryModel: string;
  escalationModel: string;
  confidenceThreshold: number;
  maxTokens: number;
}

// =============================================================================
// DOCUMENT CLASSIFIER SERVICE
// =============================================================================

export class DocumentClassifierService {
  private llmClient: ChatLLMClient;
  private config: DocumentClassifierConfig;
  private promptLoader: PromptLoaderService;
  private promptDefinition: PromptDefinition;

  constructor(llmClient: ChatLLMClient, config?: Partial<DocumentClassifierConfig>) {
    this.llmClient = llmClient;
    this.config = {
      primaryModel: config?.primaryModel ?? 'claude-3-5-haiku-20241022',
      escalationModel: config?.escalationModel ?? 'claude-3-5-sonnet-20241022',
      confidenceThreshold: config?.confidenceThreshold ?? 0.8,
      maxTokens: config?.maxTokens ?? 512,
    };
    this.promptLoader = new PromptLoaderService();
    this.promptDefinition = this.promptLoader.loadPrompt('document-classifier', 1);
  }

  /**
   * Classify document by product scope using existing summary
   */
  async classifyDocument(
    document: DocumentInput,
    taxonomy: IKnowledgeGraphTaxonomy,
  ): Promise<ClassificationResult> {
    // Try Haiku first (fast, cheap)
    const haikuResult = await this.classifyWithModel(
      document,
      taxonomy,
      this.config.primaryModel,
      false,
    );

    // Escalate to Sonnet if confidence < threshold
    if (haikuResult.classification.productScope.confidence < this.config.confidenceThreshold) {
      return await this.classifyWithModel(document, taxonomy, this.config.escalationModel, true);
    }

    return haikuResult;
  }

  /**
   * Internal: Classify with specific model
   */
  private async classifyWithModel(
    document: DocumentInput,
    taxonomy: IKnowledgeGraphTaxonomy,
    model: string,
    isEscalation: boolean,
  ): Promise<ClassificationResult> {
    const systemPrompt = this.buildSystemPrompt(taxonomy);
    const userPrompt = this.buildUserPrompt(document);

    try {
      const response = await this.llmClient.chat(
        systemPrompt,
        [{ role: 'user', content: userPrompt }],
        {
          model,
          maxTokens: this.config.maxTokens,
        },
      );

      // Parse JSON response
      const parsed = this.parseClassification(response);

      return {
        classification: {
          ...parsed,
          classifiedAt: new Date(),
          classificationMethod: 'llm',
          model,
          escalatedToSonnet: isEscalation,
        },
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      log.error(`Failed to classify document with ${model}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Document classification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Build system prompt from YAML template with taxonomy context
   */
  private buildSystemPrompt(taxonomy: IKnowledgeGraphTaxonomy): string {
    // Build dynamic taxonomy strings in TypeScript
    const products = taxonomy.taxonomy.products
      .map(
        (p) =>
          `- ${p.name} (${p.id}): Department=${p.department}, Category=${p.categoryId}` +
          (p.disambiguationKeywords.length > 0
            ? `, Keywords=[${p.disambiguationKeywords.join(', ')}]`
            : '') +
          (p.organizationSpecificNames.length > 0
            ? `, OrgNames=[${p.organizationSpecificNames.join(', ')}]`
            : ''),
      )
      .join('\n');

    const boundaries = taxonomy.taxonomy.departmentBoundaries
      .map((b) => `- ${b.product1} ↔ ${b.product2}: ${b.reasoning}`)
      .join('\n');

    return this.promptLoader.renderPrompt(this.promptDefinition.system_prompt, {
      products,
      boundaries,
    });
  }

  /**
   * Build user prompt from YAML template with document context
   */
  private buildUserPrompt(document: DocumentInput): string {
    return this.promptLoader.renderPrompt(this.promptDefinition.user_prompt_template!, {
      title: document.title,
      summary: document.summary,
    });
  }

  /**
   * Parse classification result from LLM response
   */
  private parseClassification(response: string): any {
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in classification response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (
      !parsed.primaryProduct ||
      typeof parsed.confidence !== 'number' ||
      !parsed.department ||
      !parsed.category
    ) {
      throw new Error('Invalid classification response format');
    }

    return {
      productScope: {
        primaryProduct: parsed.primaryProduct,
        confidence: parsed.confidence,
        secondaryProducts: parsed.secondaryProducts || [],
      },
      department: parsed.department,
      subDepartment: parsed.subDepartment,
      category: parsed.category,
      reasoning: parsed.reasoning,
    };
  }
}
