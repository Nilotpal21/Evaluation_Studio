/**
 * Example Provider Template
 *
 * This file serves as a template for creating new pipeline stage providers.
 * Copy this file and implement the required methods for your provider.
 *
 * ## Step-by-Step Guide
 *
 * 1. Define your config, input, and output types
 * 2. Implement PipelineStageProvider interface
 * 3. Implement execute() method with core logic
 * 4. Implement validateConfig() for runtime validation
 * 5. Implement getSchema() for UI form generation
 * 6. Register provider with ProviderRegistry
 * 7. Write unit tests
 *
 * ## Example: Docling Extraction Provider
 *
 * This example shows how to create an extraction provider that calls Docling API.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from './types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:example');

// ─── Step 1: Define Types ────────────────────────────────────────────────

/** Provider configuration (stored in MongoDB) */
interface ExampleProviderConfig {
  /** Which model version to use */
  model: 'v1' | 'v2';
  /** API timeout in milliseconds */
  timeout?: number;
  /** Additional options */
  options?: {
    enableOCR?: boolean;
    language?: string;
  };
}

/** Input data type (what the provider receives) */
interface ExampleProviderInput {
  /** Document buffer */
  buffer: Buffer;
  /** Document metadata */
  metadata: {
    filename: string;
    mimeType: string;
  };
}

/** Output data type (what the provider returns) */
interface ExampleProviderOutput {
  /** Extracted text */
  text: string;
  /** Page count */
  pageCount: number;
  /** Extraction metadata */
  metadata: {
    confidence: number;
    duration: number;
  };
}

// ─── Step 2: Implement Provider ──────────────────────────────────────────

/**
 * Example extraction provider using Docling API.
 *
 * This provider demonstrates best practices:
 * - Type-safe config validation
 * - Comprehensive error handling
 * - Logging and observability
 * - Cost and duration estimation
 */
export class ExampleExtractionProvider implements PipelineStageProvider<
  ExampleProviderInput,
  ExampleProviderOutput,
  ExampleProviderConfig
> {
  // Provider metadata
  readonly id = 'example-docling';
  readonly name = 'Example Docling Provider';
  readonly type = 'extraction' as const;
  readonly version = '1.0.0';
  readonly description = 'Example provider for documentation purposes';

  // ─── Step 3: Implement execute() ───────────────────────────────────────

  /**
   * Execute the extraction logic.
   *
   * Best practices:
   * - Validate inputs
   * - Handle errors gracefully
   * - Log execution metrics
   * - Return structured output
   */
  async execute(
    input: ExampleProviderInput,
    config: ExampleProviderConfig,
  ): Promise<ExampleProviderOutput> {
    const startTime = Date.now();

    logger.info('Starting extraction', {
      providerId: this.id,
      filename: input.metadata.filename,
      model: config.model,
    });

    try {
      // Validate input
      if (!input.buffer || input.buffer.length === 0) {
        throw new ProviderExecutionError('Empty document buffer', this.id);
      }

      // Call external service (example: Docling API)
      const result = await this.callDoclingAPI(input.buffer, config);

      // Validate output
      if (!result.text) {
        throw new ProviderExecutionError('Extraction returned empty text', this.id);
      }

      const duration = Date.now() - startTime;

      logger.info('Extraction completed', {
        providerId: this.id,
        filename: input.metadata.filename,
        textLength: result.text.length,
        pageCount: result.pageCount,
        duration,
      });

      return {
        text: result.text,
        pageCount: result.pageCount,
        metadata: {
          confidence: result.confidence,
          duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('Extraction failed', {
        providerId: this.id,
        filename: input.metadata.filename,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      throw new ProviderExecutionError(
        `Extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
        error instanceof Error ? error : undefined,
        {
          filename: input.metadata.filename,
          model: config.model,
        },
      );
    }
  }

  // ─── Step 4: Implement validateConfig() ────────────────────────────────

  /**
   * Validate provider configuration at runtime.
   *
   * This ensures config from MongoDB matches expected schema.
   * Use type narrowing for TypeScript safety.
   */
  validateConfig(config: unknown): config is ExampleProviderConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    // Required: model field
    if (typeof c.model !== 'string' || !['v1', 'v2'].includes(c.model)) {
      return false;
    }

    // Optional: timeout field
    if (c.timeout !== undefined && typeof c.timeout !== 'number') {
      return false;
    }

    // Optional: options field
    if (c.options !== undefined) {
      if (typeof c.options !== 'object' || c.options === null) {
        return false;
      }

      const opts = c.options as Record<string, unknown>;
      if (opts.enableOCR !== undefined && typeof opts.enableOCR !== 'boolean') {
        return false;
      }
      if (opts.language !== undefined && typeof opts.language !== 'string') {
        return false;
      }
    }

    return true;
  }

  // ─── Step 5: Implement getSchema() ─────────────────────────────────────

  /**
   * Get JSON Schema for configuration.
   *
   * This schema is used by Studio UI to generate dynamic configuration forms.
   * Should match the ExampleProviderConfig type structure.
   */
  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Example Docling Configuration',
      description: 'Configure Docling extraction provider',
      properties: {
        model: {
          type: 'string',
          description: 'Docling model version to use',
          enum: ['v1', 'v2'],
          default: 'v2',
        },
        timeout: {
          type: 'number',
          description: 'API timeout in milliseconds',
          minimum: 1000,
          maximum: 600000,
          default: 30000,
        },
        options: {
          type: 'object',
          description: 'Additional extraction options',
          properties: {
            enableOCR: {
              type: 'boolean',
              description: 'Enable OCR for scanned documents',
              default: false,
            },
            language: {
              type: 'string',
              description: 'Document language (ISO 639-1 code)',
              default: 'en',
            },
          },
        },
      },
      required: ['model'],
    };
  }

  // ─── Optional: Cost/Duration Estimation ─────────────────────────────────

  /**
   * Estimate execution duration.
   *
   * Optional but recommended for UI progress indicators and BullMQ lockDuration.
   */
  async estimateDuration(
    input: ExampleProviderInput,
    config: ExampleProviderConfig,
  ): Promise<number> {
    // Estimate based on document size and model
    const sizeInMB = input.buffer.length / (1024 * 1024);
    const baseTimePerMB = config.model === 'v2' ? 2000 : 5000; // ms per MB
    return Math.ceil(sizeInMB * baseTimePerMB);
  }

  /**
   * Estimate execution cost.
   *
   * Optional but recommended for tenant billing.
   */
  async estimateCost(input: ExampleProviderInput, config: ExampleProviderConfig): Promise<number> {
    // Example: $0.01 per page for v2, $0.005 for v1
    const pricePerPage = config.model === 'v2' ? 0.01 : 0.005;
    const estimatedPages = Math.ceil(input.buffer.length / 50000); // Rough estimate
    return estimatedPages * pricePerPage;
  }

  // ─── Private Helper Methods ─────────────────────────────────────────────

  /**
   * Call Docling API (example implementation).
   *
   * Replace this with actual API call logic.
   */
  private async callDoclingAPI(
    buffer: Buffer,
    config: ExampleProviderConfig,
  ): Promise<{ text: string; pageCount: number; confidence: number }> {
    // Example: POST to Docling API
    // const response = await fetch('http://docling:8080/extract', {
    //   method: 'POST',
    //   body: buffer,
    //   headers: { 'X-Model-Version': config.model },
    // });
    //
    // if (!response.ok) {
    //   throw new Error(`Docling API error: ${response.statusText}`);
    // }
    //
    // return response.json();

    // Mock implementation for example
    return {
      text: 'Extracted text goes here...',
      pageCount: 10,
      confidence: 0.95,
    };
  }
}

// ─── Step 6: Register Provider ───────────────────────────────────────────

/**
 * Register the provider on module load.
 *
 * Best practice: Register providers in a central initialization file
 * (e.g., apps/search-ai/src/providers/register-all.ts)
 */
// import { ProviderRegistry } from './index';
// const registry = ProviderRegistry.getInstance();
// registry.register(new ExampleExtractionProvider());

// ─── Step 7: Write Tests ─────────────────────────────────────────────────

/**
 * Example test file: example-provider.test.ts
 *
 * ```typescript
 * import { ExampleExtractionProvider } from './example-provider';
 *
 * describe('ExampleExtractionProvider', () => {
 *   const provider = new ExampleExtractionProvider();
 *
 *   it('should have correct metadata', () => {
 *     expect(provider.id).toBe('example-docling');
 *     expect(provider.type).toBe('extraction');
 *   });
 *
 *   it('should validate correct config', () => {
 *     const config = { model: 'v2', timeout: 30000 };
 *     expect(provider.validateConfig(config)).toBe(true);
 *   });
 *
 *   it('should reject invalid config', () => {
 *     const config = { model: 'invalid' };
 *     expect(provider.validateConfig(config)).toBe(false);
 *   });
 *
 *   it('should execute extraction', async () => {
 *     const input = {
 *       buffer: Buffer.from('test'),
 *       metadata: { filename: 'test.pdf', mimeType: 'application/pdf' }
 *     };
 *     const config = { model: 'v2' };
 *     const result = await provider.execute(input, config);
 *
 *     expect(result.text).toBeDefined();
 *     expect(result.pageCount).toBeGreaterThan(0);
 *   });
 * });
 * ```
 */
