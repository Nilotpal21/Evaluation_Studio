/**
 * Multi-Modal Enrichment Service
 *
 * Enriches chunks with image descriptions and table summaries using the
 * platform's unified LLM Hub via WorkerLLMClient (Vercel AI SDK).
 *
 * Architecture:
 * - Uses WorkerLLMClient from @agent-platform/llm (same as all other workers)
 * - Supports vision via content blocks (text + images) for OpenAI, Anthropic, Gemini
 * - Table summarization via standard chat interface
 *
 * Cost per chunk: ~$0.00040 (if 20% have images)
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import type { DocumentImageContent } from '../../types/document-image.js';
import { toImageContent } from '../../types/document-image.js';
import type { SearchAIConfig } from '../../config/index.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ImageData {
  /** Base64-encoded image data or URL */
  data: string;
  /** Format: base64 or url */
  format: 'base64' | 'url';
  /** MIME type (image/png, image/jpeg, etc.) */
  mimeType: string;
  /** Image width in pixels (if known) */
  width?: number;
  /** Image height in pixels (if known) */
  height?: number;
  /** Optional context about the image */
  context?: string;
}

export interface ImageDescription {
  /** Generated description */
  description: string;
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** Tokens used */
  tokensUsed?: number;
  /** Cost in USD */
  costUsd?: number;
}

export interface TableData {
  /** Table content (HTML, CSV, or JSON string) */
  content: string;
  /** Table format */
  format: 'html' | 'csv' | 'json';
  /** Row count (if known) */
  rowCount?: number;
  /** Column count (if known) */
  columnCount?: number;
  /** Optional context */
  context?: string;
}

export interface TableSummary {
  /** Generated summary */
  summary: string;
  /** Extracted key insights */
  insights?: string[];
  /** Provider used */
  provider: string;
  /** Model used */
  model: string;
  /** Tokens used */
  tokensUsed?: number;
  /** Cost in USD */
  costUsd?: number;
}

export interface MultiModalResult {
  /** Image descriptions */
  images?: ImageDescription[];
  /** Table summaries */
  tables?: TableSummary[];
  /** Total cost */
  totalCostUsd: number;
  /** Total tokens */
  totalTokens: number;
}

// =============================================================================
// MULTI-MODAL ENRICHER
// =============================================================================

export class MultiModalEnricher {
  private config: SearchAIConfig['multiModal'];
  private visionClient: WorkerLLMClient | null = null;
  private tableSummarizerClient: WorkerLLMClient | null = null;

  constructor(config: SearchAIConfig['multiModal']) {
    this.config = config;

    // Initialize vision client if enabled and API key provided
    if (this.config.enableImageDescription && this.config.visionApiKey) {
      try {
        this.visionClient = new WorkerLLMClient(
          this.config.visionProvider,
          this.config.visionApiKey,
          this.config.visionModel,
        );
      } catch (error) {
        console.error('[MultiModal] Failed to initialize vision client:', error);
        this.visionClient = null;
      }
    }

    // Initialize table summarizer if enabled and API key provided
    if (this.config.enableTableSummarization && this.config.tableSummarizerApiKey) {
      try {
        this.tableSummarizerClient = new WorkerLLMClient(
          this.config.tableSummarizerProvider,
          this.config.tableSummarizerApiKey,
          this.config.tableSummarizerModel,
        );
      } catch (error) {
        console.error('[MultiModal] Failed to initialize table summarizer:', error);
        this.tableSummarizerClient = null;
      }
    }
  }

  /**
   * Process a chunk with images and/or tables
   */
  async processChunk(options: {
    images?: ImageData[];
    tables?: TableData[];
  }): Promise<MultiModalResult> {
    const result: MultiModalResult = {
      images: [],
      tables: [],
      totalCostUsd: 0,
      totalTokens: 0,
    };

    // Process images
    if (options.images && options.images.length > 0 && this.visionClient) {
      for (const image of options.images) {
        try {
          const description = await this.describeImage(image);
          result.images!.push(description);
          result.totalCostUsd += description.costUsd || 0;
          result.totalTokens += description.tokensUsed || 0;
        } catch (error) {
          console.error('[MultiModal] Failed to describe image:', error);
          result.images!.push({
            description: '[Error: Failed to describe image]',
            provider: this.config.visionProvider,
            model: this.config.visionModel,
          });
        }
      }
    }

    // Process tables
    if (options.tables && options.tables.length > 0 && this.tableSummarizerClient) {
      for (const table of options.tables) {
        try {
          const summary = await this.summarizeTable(table);
          result.tables!.push(summary);
          result.totalCostUsd += summary.costUsd || 0;
          result.totalTokens += summary.tokensUsed || 0;
        } catch (error) {
          console.error('[MultiModal] Failed to summarize table:', error);
          result.tables!.push({
            summary: '[Error: Failed to summarize table]',
            provider: this.config.tableSummarizerProvider,
            model: this.config.tableSummarizerModel,
          });
        }
      }
    }

    return result;
  }

  /**
   * Describe an image using vision model via WorkerLLMClient
   */
  async describeImage(image: ImageData): Promise<ImageDescription> {
    if (!this.visionClient) {
      throw new Error('Vision client not initialized');
    }

    const userPrompt = image.context
      ? `Describe this image in detail. Context: ${image.context}\n\nFocus on the key information, data, or insights it conveys. Be concise and specific.`
      : 'Describe this image in detail. Focus on the key information, data, or insights it conveys. Be concise and specific.';

    // Build content blocks: text prompt + image
    const imageContent: DocumentImageContent = {
      type: 'document-image',
      source: {
        type: image.format,
        media_type: image.mimeType,
        ...(image.format === 'base64' ? { data: image.data } : { url: image.data }),
      },
    };

    const contentBlocks: ContentBlock[] = [
      { type: 'text', text: userPrompt },
      toImageContent(imageContent),
    ];

    const messages: Array<{ role: string; content: ContentBlock[] }> = [
      {
        role: 'user',
        content: contentBlocks,
      },
    ];

    const response = await this.visionClient.chat(
      'You are a vision analyst. Describe images accurately and concisely.',
      messages,
      {
        maxTokens: 300,
        timeoutMs: 30000,
      },
    );

    return {
      description: response,
      provider: this.config.visionProvider,
      model: this.config.visionModel,
    };
  }

  /**
   * Summarize a table using LLM via WorkerLLMClient
   */
  async summarizeTable(table: TableData): Promise<TableSummary> {
    if (!this.tableSummarizerClient) {
      throw new Error('Table summarizer not initialized');
    }

    const contextStr = table.context ? `\n\nContext: ${table.context}` : '';

    const prompt = `Summarize the following ${table.format.toUpperCase()} table. Focus on:
1. What data the table contains
2. Key patterns, trends, or insights
3. Notable values or outliers
4. Overall purpose or conclusion

Be concise (2-3 sentences max) but capture the essential information.${contextStr}

Table:
${this.formatTableContent(table)}

Summary:`;

    const messages = [
      {
        role: 'user',
        content: prompt,
      },
    ];

    const summary = await this.tableSummarizerClient.chat(
      'You are a data analyst. Summarize tables concisely, focusing on key insights.',
      messages,
      {
        maxTokens: 300,
        timeoutMs: 20000,
      },
    );

    return {
      summary,
      provider: this.config.tableSummarizerProvider,
      model: this.config.tableSummarizerModel,
    };
  }

  /**
   * Format table content for summarization (truncate if too large)
   */
  private formatTableContent(table: TableData): string {
    const maxSize = this.config.maxTableSizeBytes;

    if (Buffer.byteLength(table.content, 'utf-8') <= maxSize) {
      return table.content;
    }

    // Truncate large tables
    if (table.format === 'csv') {
      return this.truncateCsv(table.content, maxSize);
    }

    if (table.format === 'html') {
      return this.truncateHtml(table.content, maxSize);
    }

    // For JSON, just truncate
    return table.content.slice(0, maxSize) + '\n... [truncated]';
  }

  /**
   * Truncate CSV to fit within size limit
   */
  private truncateCsv(csv: string, maxSize: number): string {
    const lines = csv.split('\n').filter((line) => line.trim());

    if (lines.length === 0) {
      return csv;
    }

    // Always include header
    const header = lines[0];
    let result = header + '\n';
    let currentSize = Buffer.byteLength(result, 'utf-8');

    // Add rows until we hit size limit
    for (let i = 1; i < lines.length; i++) {
      const lineSize = Buffer.byteLength(lines[i] + '\n', 'utf-8');

      if (currentSize + lineSize > maxSize) {
        result += '... [truncated]\n';
        break;
      }

      result += lines[i] + '\n';
      currentSize += lineSize;
    }

    return result;
  }

  /**
   * Truncate HTML table to fit within size limit
   */
  private truncateHtml(html: string, maxSize: number): string {
    if (Buffer.byteLength(html, 'utf-8') <= maxSize) {
      return html;
    }

    // Try to truncate at a row boundary
    const rows = html.split(/<\/tr>/i);

    let result = '';
    for (let i = 0; i < rows.length; i++) {
      const chunk = rows[i] + '</tr>';
      if (Buffer.byteLength(result + chunk, 'utf-8') > maxSize) {
        result += '... [truncated]</tbody></table>';
        break;
      }
      result += chunk;
    }

    return result;
  }

  /**
   * Extract tables from HTML content
   */
  static extractTablesFromHtml(html: string): string[] {
    const tables: string[] = [];
    const tableRegex = /<table[\s\S]*?<\/table>/gi;
    let match: RegExpExecArray | null;

    while ((match = tableRegex.exec(html)) !== null) {
      tables.push(match[0]);
    }

    return tables;
  }

  /**
   * Extract images from HTML content
   */
  static extractImagesFromHtml(html: string): Array<{ src: string; alt?: string }> {
    const images: Array<{ src: string; alt?: string }> = [];
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = imgRegex.exec(html)) !== null) {
      const src = match[1];
      const altMatch = match[0].match(/alt=["']([^"']+)["']/i);
      images.push({
        src,
        alt: altMatch ? altMatch[1] : undefined,
      });
    }

    return images;
  }

  /**
   * Detect table metadata
   */
  static detectTableMetadata(
    content: string,
    format: 'html' | 'csv' | 'json',
  ): { rowCount?: number; columnCount?: number } {
    if (format === 'html') {
      const trMatches = content.match(/<tr/gi);
      const thMatches = content.match(/<th\b/gi);
      return {
        rowCount: trMatches ? trMatches.length : undefined,
        columnCount: thMatches ? thMatches.length : undefined,
      };
    }

    if (format === 'csv') {
      const lines = content.split('\n').filter((line) => line.trim());
      const firstLine = lines[0] || '';
      const columnCount = firstLine.split(',').length;
      return {
        rowCount: lines.length - 1, // Exclude header
        columnCount,
      };
    }

    return {};
  }

  /**
   * Check if service is available
   */
  isAvailable(): boolean {
    return this.visionClient !== null || this.tableSummarizerClient !== null;
  }

  /**
   * Get service status
   */
  getStatus(): {
    visionEnabled: boolean;
    tableSummarizerEnabled: boolean;
    visionProvider?: string;
    tableSummarizerProvider?: string;
  } {
    return {
      visionEnabled: this.visionClient !== null,
      tableSummarizerEnabled: this.tableSummarizerClient !== null,
      visionProvider: this.visionClient ? this.config.visionProvider : undefined,
      tableSummarizerProvider: this.tableSummarizerClient
        ? this.config.tableSummarizerProvider
        : undefined,
    };
  }
}

// Re-export types
export type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
export type { DocumentImageContent } from '../../types/document-image.js';
