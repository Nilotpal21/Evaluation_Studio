/**
 * HTTP Webhook Provider
 *
 * Calls an external HTTP endpoint for document processing.
 * Works as both extraction and enrichment provider.
 *
 * Security:
 * - HTTPS-only in production (HTTP allowed in development)
 * - Configurable timeout (max 300s)
 * - Auth via bearer token or API key header
 * - Retry with exponential backoff
 *
 * RFC-004 Section 5.2.3
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import type { SearchPipelineStageType } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:http-webhook');

const MAX_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_RETRIES = 3;

/** What shape the webhook returns */
export type WebhookOutputType = 'document' | 'text' | 'pages' | 'chunks' | 'enriched-chunks';

/** Where the output enters the pipeline */
export type WebhookEntryPoint =
  | 'before-extraction'
  | 'after-extraction'
  | 'after-chunking'
  | 'after-enrichment';

/** How the webhook participates in the pipeline */
export type WebhookMode = 'source' | 'replacement' | 'transformer';

export interface HttpWebhookConfig {
  /** Webhook URL */
  url: string;
  /** HTTP method (default: POST) */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Request timeout in ms */
  timeout?: number;
  /** Custom HTTP headers */
  headers?: Record<string, string>;
  /** Authentication */
  auth?: {
    type: 'bearer' | 'api-key' | 'basic';
    token: string;
    /** Header name for api-key auth (default: X-API-Key) */
    headerName?: string;
  };
  /** Max retry attempts (default: 3) */
  retries?: number;

  /**
   * How this webhook participates in the pipeline:
   * - source: provides input, downstream stages still run
   * - replacement: replaces a stage, may skip downstream based on entryPoint
   * - transformer: modifies data between stages, same shape in/out
   */
  mode?: WebhookMode;

  /**
   * What shape the webhook response returns.
   * Determines the expected response schema.
   */
  outputType?: WebhookOutputType;

  /**
   * Where the webhook output enters the pipeline.
   * Determines which downstream stages are skipped.
   */
  entryPoint?: WebhookEntryPoint;
}

export interface WebhookInput {
  documentId: string;
  content: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface WebhookOutput {
  content?: string;
  pages?: Array<{ pageNumber: number; content: string; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

/**
 * HTTP Webhook Provider
 *
 * Sends document content to an external HTTP endpoint for processing.
 * Used for custom extraction, content editing, enrichment, or transformation.
 */
export class HttpWebhookProvider implements PipelineStageProvider<
  WebhookInput,
  WebhookOutput,
  HttpWebhookConfig
> {
  readonly id = 'http-webhook';
  readonly name = 'HTTP Webhook';
  readonly version = '1.0.0';
  readonly description =
    'Call an external HTTP API for custom document processing, content editing, or transformation';

  constructor(public readonly type: SearchPipelineStageType = 'enrichment') {}

  async execute(input: WebhookInput, config: HttpWebhookConfig): Promise<WebhookOutput> {
    const {
      url,
      method = 'POST',
      timeout = DEFAULT_TIMEOUT,
      headers = {},
      auth,
      retries = MAX_RETRIES,
    } = config;

    logger.info('Executing HTTP webhook', {
      url,
      method,
      documentId: input.documentId,
      contentLength: input.content?.length ?? 0,
      payload: input.content,
    });

    // Validate URL security
    const parsed = new URL(url);

    if (process.env.NODE_ENV === 'production') {
      if (parsed.protocol !== 'https:') {
        throw new ProviderExecutionError(
          `HTTP webhook URL must use HTTPS in production, got: ${parsed.protocol}`,
          this.id,
        );
      }

      // SSRF protection: block internal/private network addresses in production
      const hostname = parsed.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')
      ) {
        throw new ProviderExecutionError(
          'HTTP webhook URL must not target internal/private network addresses',
          this.id,
        );
      }
    }

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (auth) {
      if (auth.type === 'bearer') {
        requestHeaders['Authorization'] = `Bearer ${auth.token}`;
      } else if (auth.type === 'api-key') {
        const headerName = auth.headerName ?? 'X-API-Key';
        requestHeaders[headerName] = auth.token;
      } else if (auth.type === 'basic') {
        requestHeaders['Authorization'] = `Basic ${auth.token}`;
      }
    }

    // Build request body
    const body = JSON.stringify({
      documentId: input.documentId,
      content: input.content,
      contentType: input.contentType,
      metadata: input.metadata ?? {},
    });

    // Execute with retries (minimum 1 attempt)
    let lastError: Error | null = null;
    const maxAttempts = Math.max(1, Math.min(retries, MAX_RETRIES));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), Math.min(timeout, MAX_TIMEOUT));

        const response = await fetch(url, {
          method,
          headers: requestHeaders,
          body: method !== 'GET' ? body : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          throw new Error(`Webhook returned ${response.status}: ${errorBody.slice(0, 500)}`);
        }

        const result = (await response.json()) as WebhookOutput;

        logger.info('HTTP webhook succeeded', {
          url,
          documentId: input.documentId,
          attempt,
          hasContent: !!result.content,
          hasPages: !!result.pages,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const isAbort = lastError.name === 'AbortError';
        logger.warn('HTTP webhook attempt failed', {
          url,
          documentId: input.documentId,
          attempt,
          maxAttempts,
          error: lastError.message,
          isTimeout: isAbort,
        });

        if (attempt < maxAttempts && !isAbort) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new ProviderExecutionError(
      `HTTP webhook failed after ${maxAttempts} attempts: ${lastError?.message ?? 'Unknown error'}`,
      this.id,
      lastError ?? undefined,
      { url, documentId: input.documentId },
    );
  }

  validateConfig(config: unknown): config is HttpWebhookConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;

    if (typeof c.url !== 'string' || c.url.trim().length === 0) return false;

    // Validate URL format
    try {
      new URL(c.url);
    } catch {
      return false;
    }

    if (c.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH'].includes(c.method as string))
      return false;
    if (c.timeout !== undefined) {
      if (typeof c.timeout !== 'number' || c.timeout < 1000 || c.timeout > MAX_TIMEOUT)
        return false;
    }
    if (c.headers !== undefined && (typeof c.headers !== 'object' || c.headers === null))
      return false;
    if (c.retries !== undefined) {
      if (typeof c.retries !== 'number' || c.retries < 0 || c.retries > MAX_RETRIES) return false;
    }

    if (c.auth !== undefined) {
      if (typeof c.auth !== 'object' || c.auth === null) return false;
      const auth = c.auth as Record<string, unknown>;
      if (!['bearer', 'api-key', 'basic'].includes(auth.type as string)) return false;
      if (typeof auth.token !== 'string') return false;
    }

    const validModes: WebhookMode[] = ['source', 'replacement', 'transformer'];
    if (c.mode !== undefined && !validModes.includes(c.mode as WebhookMode)) return false;

    const validOutputTypes: WebhookOutputType[] = [
      'document',
      'text',
      'pages',
      'chunks',
      'enriched-chunks',
    ];
    if (c.outputType !== undefined && !validOutputTypes.includes(c.outputType as WebhookOutputType))
      return false;

    const validEntryPoints: WebhookEntryPoint[] = [
      'before-extraction',
      'after-extraction',
      'after-chunking',
      'after-enrichment',
    ];
    if (c.entryPoint !== undefined && !validEntryPoints.includes(c.entryPoint as WebhookEntryPoint))
      return false;

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'HTTP Webhook Configuration',
      description: 'Call an external HTTP endpoint for document processing',
      properties: {
        url: {
          type: 'string',
          description: 'Webhook URL (HTTPS required in production)',
        },
        method: {
          type: 'string',
          description: 'HTTP method',
          enum: ['GET', 'POST', 'PUT', 'PATCH'],
          default: 'POST',
        },
        timeout: {
          type: 'number',
          description: 'Request timeout in milliseconds (max 300000)',
          minimum: 1000,
          maximum: 300000,
          default: 30000,
        },
        headers: {
          type: 'object',
          description: 'Custom HTTP headers (e.g., Authorization)',
        },
        retries: {
          type: 'number',
          description: 'Max retry attempts',
          minimum: 1,
          maximum: 3,
          default: 3,
        },
        mode: {
          type: 'string',
          description:
            'source: provides input (downstream runs), replacement: replaces stage (may skip downstream), transformer: modifies between stages (same shape)',
          enum: ['source', 'replacement', 'transformer'],
          default: 'replacement',
        },
        outputType: {
          type: 'string',
          description:
            'What your API returns: document (file), text, pages, chunks, or enriched-chunks',
          enum: ['document', 'text', 'pages', 'chunks', 'enriched-chunks'],
          default: 'text',
        },
        entryPoint: {
          type: 'string',
          description: 'Where the output enters the pipeline (determines which stages are skipped)',
          enum: ['before-extraction', 'after-extraction', 'after-chunking', 'after-enrichment'],
          default: 'after-extraction',
        },
      },
      required: ['url'],
    };
  }

  async estimateDuration(input: WebhookInput, config: HttpWebhookConfig): Promise<number> {
    return config.timeout ?? DEFAULT_TIMEOUT;
  }
}
