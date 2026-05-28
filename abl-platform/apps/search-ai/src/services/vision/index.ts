/**
 * Vision Service
 *
 * Phase 3: Visual Enrichment Service
 *
 * Provides vision-based analysis and enrichment of document content:
 * - Analyzes images and screenshots with progressive context
 * - Enriches text summaries with visual insights
 * - Enhances questions with visual references
 * - Generates document-level visual narratives
 *
 * Key Features:
 * - Progressive visual context chain (page to page)
 * - Cost optimization (sends summaries, not full chunks)
 * - Provider-agnostic (uses LLMClient abstraction)
 * - Model tier selection (balanced for vision, fast for enrichment)
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import type { Message, ContentBlock } from '@abl/compiler/platform/llm';
import type { DocumentImageContent } from '../../types/document-image.js';
import { toImageContent } from '../../types/document-image.js';
import type { ResolvedIndexLLMConfig } from '../llm-config/resolver.js';
import type { IChunkQuestion } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('vision-service');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VisionServiceConfig {
  indexId: string;
  tenantId: string;
  resolvedConfig: ResolvedIndexLLMConfig;
}

export interface ImageDescription {
  s3Url: string;
  description: string;
  relevanceToContent: string;
  extractedData?: {
    type: 'bar' | 'line' | 'pie' | 'table' | 'diagram';
    data: any;
    insights: string[];
  };
  position?: {
    bbox?: any;
    pageRelative?: 'top' | 'middle' | 'bottom';
  };
  model: string;
  tokensUsed: number;
  costUsd: number;
}

export interface ScreenshotAnalysis {
  layoutStructure: string;
  keyVisualElements: string[];
  visualHierarchy: string;
  processed: boolean;
}

export interface VisualAnalysisResult {
  imageDescriptions: ImageDescription[];
  visualContext: string;
  keyVisualElements: string[];
  screenshotAnalysis?: ScreenshotAnalysis;
  tokensUsed: number;
  costUsd: number;
  latencyMs: number;
}

export interface EnhancedQuestion {
  question: string;
  modified: boolean;
  visualElements?: string[];
  isNew?: boolean;
}

export interface DocumentSummaryResult {
  summary: string;
  keyVisualElements: string[];
  visualNarrative: string;
  visualThemes: string[];
  chartInsights?: string[];
  tokensUsed: number;
  costUsd: number;
}

// ─── VisionService ───────────────────────────────────────────────────────────

export class VisionService {
  private visionClient: WorkerLLMClient;
  private summarizationClient: WorkerLLMClient;
  private visionConfig: any;
  private summarizationConfig: any;

  constructor(private config: VisionServiceConfig) {
    this.visionConfig = config.resolvedConfig.useCases.vision;
    this.summarizationConfig = config.resolvedConfig.useCases.progressiveSummarization;

    // Create WorkerLLMClient for vision (balanced tier - supports images)
    this.visionClient = new WorkerLLMClient(
      this.visionConfig.provider,
      this.visionConfig.apiKey,
      this.visionConfig.model,
      this.visionConfig.baseUrl ? { baseUrl: this.visionConfig.baseUrl } : {},
    );

    // Create separate client for fast tier operations (summarization)
    this.summarizationClient = new WorkerLLMClient(
      this.summarizationConfig.provider,
      this.summarizationConfig.apiKey,
      this.summarizationConfig.model,
      this.summarizationConfig.baseUrl ? { baseUrl: this.summarizationConfig.baseUrl } : {},
    );
  }

  /**
   * Phase 3a: Analyze images with progressive context from previous pages
   *
   * This is the core visual analysis that:
   * - Takes previous page's visual context
   * - Analyzes current page images/screenshot
   * - Understands relevance to text summary
   * - Generates visual context for next page
   */
  async analyzeWithContext(params: {
    images: { s3Url: string }[];
    screenshot: string | null;
    textSummary: string;
    previousVisualContext: string | null;
    questions: string[];
  }): Promise<VisualAnalysisResult> {
    const startTime = Date.now();

    // Build prompt
    const prompt = this.buildAnalysisPrompt(params);

    // Build message with images (convert file:// URLs to base64)
    const imageContents = await this.buildImageContents(params.images, params.screenshot);

    if (imageContents.length === 0) {
      // No images to analyze
      return {
        imageDescriptions: [],
        visualContext: params.previousVisualContext || '',
        keyVisualElements: [],
        tokensUsed: 0,
        costUsd: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // Build message with text + images (WorkerLLMClient now handles image conversion)
    const content: ContentBlock[] = [
      { type: 'text', text: prompt },
      ...imageContents.map(toImageContent),
    ];

    // Send to vision model (balanced tier - Sonnet or GPT-4o)
    const resultText = await this.visionClient.chat(
      '', // No system prompt (included in user message)
      [{ role: 'user', content }],
      {
        maxTokens: this.visionConfig.maxTokens || 500,
        timeoutMs: 60000,
      },
    );

    const latencyMs = Date.now() - startTime;

    // Log raw LLM response for debugging
    log.debug('Raw LLM response received', {
      responseLength: resultText.length,
      firstChars: resultText.substring(0, 200),
      lastChars: resultText.substring(Math.max(0, resultText.length - 200)),
    });

    // Parse structured output
    const analysis = this.parseAnalysisResult(resultText);

    // Estimate cost and tokens (no direct usage from WorkerLLMClient.chat)
    const estimatedInputTokens = Math.ceil(
      (prompt.length + JSON.stringify(imageContents).length) / 4,
    );
    const estimatedOutputTokens = Math.ceil(resultText.length / 4);
    const costUsd = this.estimateCost(
      this.config.resolvedConfig.provider,
      this.visionConfig.model,
      estimatedInputTokens,
      estimatedOutputTokens,
    );

    const totalTokens = estimatedInputTokens + estimatedOutputTokens;

    return {
      imageDescriptions: analysis.imageDescriptions.map((desc: any) => ({
        ...desc,
        model: this.visionConfig.model,
        tokensUsed: totalTokens,
        costUsd,
      })),
      visualContext: analysis.visualContext || '',
      keyVisualElements: analysis.keyVisualElements || [],
      screenshotAnalysis: analysis.screenshotAnalysis,
      tokensUsed: totalTokens,
      costUsd,
      latencyMs,
    };
  }

  /**
   * Phase 3a: Re-summarize by enriching text summary with visual context
   *
   * CRITICAL: Does NOT re-process original text chunk
   * Only enriches existing summary with visual insights
   *
   * Input: Previous summary (300 tokens) + image descriptions
   * Output: Enriched summary (still ~300 tokens, just enhanced)
   *
   * This is the cost optimization: send summaries, not full chunks
   */
  async enrichSummary(params: {
    originalSummary: string;
    imageDescriptions: ImageDescription[];
    visualContext: string;
  }): Promise<string> {
    if (params.imageDescriptions.length === 0) {
      // No visual content to enrich with
      return params.originalSummary;
    }

    const prompt = this.buildEnrichmentPrompt(params);

    // Use FAST tier model (Haiku) for cost optimization
    const resultText = await this.summarizationClient.chat(
      'You are enriching a page summary with visual insights.',
      [{ role: 'user', content: prompt }],
      {
        maxTokens: this.summarizationConfig.maxTokens || 300,
      },
    );

    return resultText;
  }

  /**
   * Phase 3a: Enhance existing questions with visual context
   *
   * May:
   * - Modify questions to reference visual elements
   * - Add new visual-specific questions
   * - Keep unchanged if visual context doesn't add value
   */
  async enhanceQuestions(params: {
    originalQuestions: IChunkQuestion[];
    imageDescriptions: ImageDescription[];
    visualElements: string[];
  }): Promise<EnhancedQuestion[]> {
    if (params.imageDescriptions.length === 0 || params.originalQuestions.length === 0) {
      // No visual content or no questions to enhance
      return params.originalQuestions.map((q) => ({
        question: q.question,
        modified: false,
      }));
    }

    const prompt = this.buildQuestionEnhancementPrompt(params);

    // Use FAST tier model (Haiku)
    const resultText = await this.summarizationClient.chat(
      'You are enhancing questions with visual context.',
      [{ role: 'user', content: prompt }],
      {
        maxTokens: this.summarizationConfig.maxTokens || 300,
      },
    );

    // Parse structured output
    const parsed = this.parseQuestionEnhancementResult(resultText);

    return parsed.enhancedQuestions || [];
  }

  /**
   * Phase 3b: Re-generate document summary with all visual context
   *
   * Uses all enriched page summaries + all image descriptions
   * to create a document-level narrative that integrates visuals
   */
  async enrichDocumentSummary(params: {
    originalDocumentSummary: string;
    enrichedPageSummaries: string[];
    allImageDescriptions: ImageDescription[];
    keyVisualElements: string[];
  }): Promise<DocumentSummaryResult> {
    const startTime = Date.now();

    const prompt = this.buildDocumentEnrichmentPrompt(params);

    // Use vision model (balanced tier)
    const resultText = await this.visionClient.chat(
      'You are creating an enriched document-level summary with visual context.',
      [{ role: 'user', content: prompt }],
      {
        maxTokens: 1000, // More tokens for document-level
      },
    );

    // Parse structured output
    const parsed = this.parseDocumentSummaryResult(resultText);

    const tokensUsed = parsed.summary.length / 4; // Rough estimate
    const costUsd = this.estimateCost(
      this.visionConfig.provider,
      this.visionConfig.model,
      prompt.length / 4,
      tokensUsed,
    );

    return {
      summary: parsed.summary || params.originalDocumentSummary,
      keyVisualElements: parsed.keyVisualElements || params.keyVisualElements,
      visualNarrative: parsed.visualNarrative || '',
      visualThemes: parsed.visualThemes || [],
      chartInsights: parsed.chartInsights,
      tokensUsed,
      costUsd,
    };
  }

  /**
   * Phase 3b: Enhance document-level questions with visual context
   */
  async enhanceDocumentQuestions(params: {
    originalQuestions: IChunkQuestion[];
    enrichedDocumentSummary: string;
    keyVisualElements: string[];
  }): Promise<EnhancedQuestion[]> {
    if (params.keyVisualElements.length === 0 || params.originalQuestions.length === 0) {
      return params.originalQuestions.map((q) => ({
        question: q.question,
        modified: false,
      }));
    }

    const prompt = this.buildDocumentQuestionEnhancementPrompt(params);

    // Use FAST tier model
    const resultText = await this.summarizationClient.chat(
      'You are enhancing document-level questions with visual context.',
      [{ role: 'user', content: prompt }],
      {
        maxTokens: this.summarizationConfig.maxTokens || 300,
      },
    );

    const parsed = this.parseQuestionEnhancementResult(resultText);
    return parsed.enhancedQuestions || [];
  }

  // ─── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Build document image contents for message
   */
  private async buildImageContents(
    images: { s3Url: string }[],
    screenshot: string | null,
  ): Promise<DocumentImageContent[]> {
    const contents: DocumentImageContent[] = [];

    // Add screenshot first (if enabled)
    if (screenshot && this.visionConfig.analyzeScreenshots) {
      contents.push(await this.imageUrlToContent(screenshot, 'image/png'));
    }

    // Add extracted images (if enabled)
    if (this.visionConfig.analyzeImages) {
      for (const img of images) {
        contents.push(await this.imageUrlToContent(img.s3Url, 'image/png'));
      }
    }

    return contents;
  }

  /**
   * Convert image URL to DocumentImageContent, handling file://, s3://, and http(s):// URLs
   *
   * Supports:
   * - s3://bucket/key → Download from S3 and convert to base64
   * - file:///path/to/image.png → Read from local disk and convert to base64
   * - http(s)://... → Pass URL directly to LLM provider
   */
  private async imageUrlToContent(url: string, mediaType: string): Promise<DocumentImageContent> {
    // S3 URLs (s3://bucket/key format) - read from S3 and convert to base64
    if (url.startsWith('s3://')) {
      try {
        const { readFileFromStorage } = await import('../../storage/storage-factory.js');
        const buffer = await readFileFromStorage(url);
        const base64 = buffer.toString('base64');
        return {
          type: 'document-image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read S3 image ${url}: ${errorMsg}`);
      }
    }

    // Local file URLs (file:// format) - read from disk and convert to base64
    if (url.startsWith('file://')) {
      const fs = await import('fs/promises');
      const filePath = url.replace('file://', '');
      try {
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString('base64');
        return {
          type: 'document-image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read image file ${filePath}: ${errorMsg}`);
      }
    }

    // For HTTP/HTTPS URLs, pass as-is (LLM providers can fetch directly)
    return {
      type: 'document-image',
      source: {
        type: 'url',
        media_type: mediaType,
        url,
      },
    };
  }

  /**
   * Build prompt for image analysis with context
   */
  private buildAnalysisPrompt(params: {
    textSummary: string;
    previousVisualContext: string | null;
    questions: string[];
  }): string {
    return `You are analyzing images from a document page.

PREVIOUS PAGE VISUAL CONTEXT:
${params.previousVisualContext || 'This is the first page - no previous visual context.'}

CURRENT PAGE TEXT SUMMARY (from Phase 2):
${params.textSummary}

CURRENT PAGE QUESTIONS (from Phase 2):
${params.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Analyze the provided image(s) and for EACH image provide:
1. **Description**: What the image shows in detail
2. **Relevance**: How it relates to the text summary above
3. **Data Extraction**: If chart/diagram/table, extract key data points, trends, insights
4. **Connection**: How it connects to previous page's visual elements (if any)
5. **Position Context**: Where in the page (top/middle/bottom) and importance

After analyzing all images, provide:
- **Visual Context** (1-2 sentences): Key visual elements/patterns that will help analyze the NEXT page's images
- **Key Visual Elements**: List of important visual types for document-wide tracking

IMPORTANT GUIDELINES:
- Be concise but specific (avoid vague descriptions like "a chart" - say "bar chart showing quarterly revenue growth")
- Focus on content relevance to the text summary
- Extract actual data from charts/tables where possible
- Identify visual continuity patterns (e.g., "chart series continues from previous page")

Output JSON:
{
  "imageDescriptions": [{
    "s3Url": "...",
    "description": "...",
    "relevanceToContent": "...",
    "extractedData": {
      "type": "bar" | "line" | "pie" | "table" | "diagram",
      "data": {...},
      "insights": ["..."]
    },
    "position": {
      "pageRelative": "top" | "middle" | "bottom"
    }
  }],
  "visualContext": "...",
  "keyVisualElements": ["bar chart", "code block", ...]
}`;
  }

  /**
   * Build prompt for summary enrichment
   */
  private buildEnrichmentPrompt(params: {
    originalSummary: string;
    imageDescriptions: ImageDescription[];
    visualContext: string;
  }): string {
    return `You are enriching a page summary with visual context.

ORIGINAL TEXT SUMMARY (from Phase 2 - text-only):
${params.originalSummary}

IMAGE DESCRIPTIONS:
${params.imageDescriptions
  .map(
    (d, i) => `
Image ${i + 1}:
- Description: ${d.description}
- Relevance: ${d.relevanceToContent}
${d.extractedData ? `- Data: ${JSON.stringify(d.extractedData.insights)}` : ''}
`,
  )
  .join('\n')}

VISUAL CONTEXT FROM ANALYSIS:
${params.visualContext}

YOUR TASK:
Generate an ENRICHED SUMMARY that:
1. Keeps all key information from the original summary
2. Integrates visual elements naturally into the narrative
3. Highlights how images/charts support or extend the text content
4. Mentions specific data points or insights from visual elements
5. Is concise (max ${this.summarizationConfig.maxTokens || 300} tokens)

CRITICAL GUIDELINES:
- Do NOT re-describe the full text content - you already have the summary
- FOCUS on ENRICHING with visual insights
- Integrate visuals naturally (e.g., "The quarterly revenue trend, shown in the bar chart, reveals...")
- Mention specific visual evidence (e.g., "as illustrated in the diagram", "the table shows that...")
- Keep the same concise length as the original summary

ENRICHED SUMMARY:`;
  }

  /**
   * Build prompt for question enhancement
   */
  private buildQuestionEnhancementPrompt(params: {
    originalQuestions: IChunkQuestion[];
    imageDescriptions: ImageDescription[];
    visualElements: string[];
  }): string {
    return `You are enhancing questions with visual context.

ORIGINAL QUESTIONS (from Phase 2 - text-based):
${params.originalQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}

IMAGE DESCRIPTIONS:
${params.imageDescriptions.map((d, i) => `Image ${i + 1}: ${d.description}\nRelevance: ${d.relevanceToContent}`).join('\n\n')}

KEY VISUAL ELEMENTS:
${params.visualElements.join(', ')}

YOUR TASK:
For EACH original question:
1. If the question can be enhanced with visual context, rewrite it to reference visual elements
2. If the question is fine as-is (visual context doesn't add value), keep it UNCHANGED
3. Indicate whether you modified it

You may also suggest 1-2 NEW questions that are specifically about visual elements (charts, diagrams, tables).

GUIDELINES FOR ENHANCEMENT:
- Add visual references where relevant (e.g., "What trend is shown in the chart?" instead of "What is the trend?")
- Don't force visual references if they don't add value
- New questions should be answerable from the visual content

Output JSON:
{
  "enhancedQuestions": [{
    "originalIndex": 0,
    "question": "...",
    "modified": true/false,
    "visualElements": ["image 1", "image 2"]
  }],
  "newQuestions": [{
    "question": "...",
    "questionType": "factual" | "conceptual" | "procedural" | "analytical",
    "visualElements": ["..."]
  }]
}`;
  }

  /**
   * Build prompt for document-level enrichment
   */
  private buildDocumentEnrichmentPrompt(params: {
    originalDocumentSummary: string;
    enrichedPageSummaries: string[];
    allImageDescriptions: ImageDescription[];
    keyVisualElements: string[];
  }): string {
    return `You are creating an enriched document-level summary with visual context.

ORIGINAL DOCUMENT SUMMARY (from Phase 2 - text-only):
${params.originalDocumentSummary}

ENRICHED PAGE SUMMARIES (from Phase 3 - with visual context):
${params.enrichedPageSummaries.map((s, i) => `Page ${i + 1}: ${s}`).join('\n\n')}

ALL IMAGE DESCRIPTIONS (${params.allImageDescriptions.length} total):
${params.allImageDescriptions
  .slice(0, 20)
  .map((d, i) => `${i + 1}. ${d.description}`)
  .join('\n')}
${params.allImageDescriptions.length > 20 ? `... and ${params.allImageDescriptions.length - 20} more` : ''}

KEY VISUAL ELEMENTS ACROSS DOCUMENT:
${params.keyVisualElements.join(', ')}

YOUR TASK:
Generate an ENRICHED DOCUMENT SUMMARY that:
1. Maintains the high-level narrative from the original document summary
2. Integrates visual themes and patterns across the entire document
3. Highlights how visuals support the document's key messages
4. Identifies visual narrative arcs (e.g., "charts demonstrate progressive improvement")
5. Extracts key insights from data visualizations
6. Is comprehensive but concise (max 1000 tokens)

CRITICAL GUIDELINES:
- Focus on document-wide visual patterns, not individual images
- Identify visual themes (e.g., "extensive use of comparative charts", "step-by-step diagrams")
- Extract meta-insights from charts/data (e.g., "all metrics show upward trends")
- Connect visual narrative to text narrative

Output JSON:
{
  "summary": "...",
  "keyVisualElements": ["..."],
  "visualNarrative": "...",
  "visualThemes": ["..."],
  "chartInsights": ["..."]
}`;
  }

  /**
   * Build prompt for document question enhancement
   */
  private buildDocumentQuestionEnhancementPrompt(params: {
    originalQuestions: IChunkQuestion[];
    enrichedDocumentSummary: string;
    keyVisualElements: string[];
  }): string {
    return `You are enhancing document-level questions with visual context.

ORIGINAL QUESTIONS (from Phase 2):
${params.originalQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}

ENRICHED DOCUMENT SUMMARY (with visual context):
${params.enrichedDocumentSummary}

KEY VISUAL ELEMENTS:
${params.keyVisualElements.join(', ')}

For each question, determine if visual context adds value. If yes, enhance it.

Output JSON:
{
  "enhancedQuestions": [{
    "originalIndex": 0,
    "question": "...",
    "modified": true/false
  }]
}`;
  }

  /**
   * Parse analysis result from JSON (handles markdown code blocks)
   */
  private parseAnalysisResult(text: string): any {
    try {
      // Strip markdown code blocks (```json ... ``` or ``` ... ```)
      let cleanText = text.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      // Extract JSON object
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        log.debug('Successfully parsed analysis result', {
          imageDescriptionsCount: parsed.imageDescriptions?.length || 0,
          hasVisualContext: !!parsed.visualContext,
          keyVisualElementsCount: parsed.keyVisualElements?.length || 0,
        });
        return parsed;
      } else {
        log.warn('No JSON found in response after stripping markdown');
      }
    } catch (err) {
      log.warn('Failed to parse analysis result', {
        error: err instanceof Error ? err.message : String(err),
        textSample: text.substring(0, 200),
      });
    }

    return {
      imageDescriptions: [],
      visualContext: '',
      keyVisualElements: [],
    };
  }

  /**
   * Parse question enhancement result (handles markdown code blocks)
   */
  private parseQuestionEnhancementResult(text: string): any {
    try {
      // Strip markdown code blocks
      let cleanText = text.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Merge enhanced and new questions
        const all = [
          ...(parsed.enhancedQuestions || []),
          ...(parsed.newQuestions || []).map((q: any) => ({
            ...q,
            isNew: true,
            modified: true,
          })),
        ];
        return { enhancedQuestions: all };
      }
    } catch (err) {
      log.warn('Failed to parse question enhancement result', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { enhancedQuestions: [] };
  }

  /**
   * Parse document summary result (handles markdown code blocks)
   */
  private parseDocumentSummaryResult(text: string): any {
    try {
      // Strip markdown code blocks
      let cleanText = text.trim();
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      log.warn('Failed to parse document summary result', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      summary: '',
      keyVisualElements: [],
      visualNarrative: '',
      visualThemes: [],
    };
  }

  /**
   * Estimate cost based on provider and tokens
   */
  private estimateCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    // Rough estimates (per million tokens)
    const costs: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-20250514': { input: 3, output: 15 },
      'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25 },
      'gpt-4o': { input: 5, output: 15 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'gemini-2.5-pro': { input: 1.25, output: 5 },
      'gemini-2.0-flash': { input: 0.075, output: 0.3 },
    };

    const cost = costs[model] || costs['claude-sonnet-4-20250514'];
    return (inputTokens * cost.input) / 1_000_000 + (outputTokens * cost.output) / 1_000_000;
  }
}
