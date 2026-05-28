/**
 * Docling Extraction Provider
 *
 * Wraps the docling-extraction-worker capabilities as a registered provider.
 * Provides schema, config validation, and metadata for the UI.
 *
 * Note: Actual execution still happens via BullMQ workers.
 * This provider enables UI-driven configuration and validation.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:docling-extraction');

/** Docling provider configuration (stored in pipeline definition) */
export interface DoclingExtractionConfig {
  /** Whether to fall back to legacy extraction for unsupported types */
  fallbackToLegacy?: boolean;
  /** MIME types supported by Docling extraction */
  supportedMimeTypes?: string[];
  /** MIME types that should use legacy extraction */
  legacyMimeTypes?: string[];
}

/**
 * Docling Extraction Provider
 *
 * Extracts text and metadata from documents using the Docling service.
 * Supports PDF, DOCX, PPTX, HTML, and image formats.
 */
export class DoclingExtractionProvider implements PipelineStageProvider<
  unknown,
  unknown,
  DoclingExtractionConfig
> {
  readonly id = 'docling';
  readonly name = 'Docling Extraction';
  readonly type = 'extraction' as const;
  readonly version = '2.0.0';
  readonly description =
    'Extract text and metadata from PDF, DOCX, PPTX, HTML, and images using Docling v2';

  async execute(input: unknown, config: DoclingExtractionConfig): Promise<unknown> {
    // Execution is handled by docling-extraction-worker via BullMQ
    // This method exists for the PipelineStageProvider interface
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is DoclingExtractionConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.fallbackToLegacy !== undefined && typeof c.fallbackToLegacy !== 'boolean') {
      return false;
    }

    if (c.supportedMimeTypes !== undefined && !Array.isArray(c.supportedMimeTypes)) {
      return false;
    }

    if (c.legacyMimeTypes !== undefined && !Array.isArray(c.legacyMimeTypes)) {
      return false;
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Docling Extraction Configuration',
      description: 'Configure Docling extraction for rich document formats',
      properties: {
        fallbackToLegacy: {
          type: 'boolean',
          description: 'Fall back to legacy text extraction for unsupported MIME types',
          default: true,
        },
        supportedMimeTypes: {
          type: 'array',
          description: 'MIME types handled by Docling (PDF, DOCX, PPTX, HTML, images)',
          items: { type: 'string' },
        },
        legacyMimeTypes: {
          type: 'array',
          description: 'MIME types that should use legacy extraction (text/plain, text/markdown)',
          items: { type: 'string' },
        },
      },
    };
  }

  async estimateDuration(input: unknown): Promise<number> {
    return 120_000; // ~2 minutes average for document extraction
  }
}
