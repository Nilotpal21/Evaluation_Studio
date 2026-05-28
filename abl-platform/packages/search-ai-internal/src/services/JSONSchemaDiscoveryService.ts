import { createLogger, type Logger } from '@agent-platform/shared-observability';
import {
  SchemaDiscoveryService,
  type DiscoveredSchema,
  type DiscoveredField,
  type SchemaDiscoveryOptions,
} from './SchemaDiscoveryService.js';
import { isISO8601Date, detectEnumCandidates } from './GoogleSheetsSchemaDiscoveryService.js';

const defaultLogger = createLogger('json-schema-discovery');

/** Maximum recursion depth for nested object traversal */
const MAX_DEPTH = 5;

/** Maximum number of documents to sample for schema inference */
const MAX_SAMPLE_DOCUMENTS = 100;

/** Maximum number of retries for rate-limited or transient errors */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
const BASE_BACKOFF_MS = 1000;

/** HTTP status codes that trigger retry with backoff */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

// --- DI Interfaces -----------------------------------------------------------

/** A single JSON document for schema inference */
export interface JSONDocument {
  /** Unique document identifier */
  id: string;
  /** Parsed JSON content (already deserialized) */
  content: Record<string, unknown>;
}

/** Minimal client interface for fetching JSON document samples */
export interface JSONDocumentProvider {
  /** Fetch up to `maxDocuments` sample documents for schema inference */
  getDocumentSamples(connectorId: string, maxDocuments: number): Promise<JSONDocument[]>;
}

/** Minimal connector info needed for JSON schema discovery */
export interface JSONConnectorInfo {
  connectorId: string;
  tenantId: string;
  connectionConfig: {
    documentSource?: string;
  };
}

/** Dependency interface for connector config lookup */
export interface JSONConnectorConfigProvider {
  getConnectorConfig(connectorId: string, tenantId: string): Promise<JSONConnectorInfo | null>;
}

/** Dependency interface for creating a document provider from connector config */
export interface JSONDocumentProviderFactory {
  createProvider(config: JSONConnectorInfo): Promise<JSONDocumentProvider>;
}

// --- Error Codes -------------------------------------------------------------

/** Error codes for JSON schema discovery */
export const JSON_ERROR_CODES = {
  AUTH_FAILED: 'ERR_JSON_AUTH_FAILED',
  PARSE_FAILED: 'ERR_JSON_PARSE_FAILED',
} as const;

// --- Type Inference Utilities ------------------------------------------------

/** Canonical field types inferred from JSON document sampling */
export type JSONInferredType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';

/**
 * Recursively extract field paths from a JSON object.
 * Returns Map<dotPath, values[]> for type inference across documents.
 * Nested objects are flattened to dot-notation paths.
 * Recursion stops at MAX_DEPTH to prevent explosion.
 */
export function extractFieldPaths(
  obj: Record<string, unknown>,
  prefix: string = '',
  depth: number = 0,
): Map<string, unknown[]> {
  const fields = new Map<string, unknown[]>();
  if (depth >= MAX_DEPTH) return fields;

  for (const [key, value] of Object.entries(obj)) {
    // Escape dots in keys to avoid ambiguity with nested path separator
    const safeKey = key.includes('.') ? `[${key}]` : key;
    const path = prefix ? `${prefix}.${safeKey}` : safeKey;

    if (value === null || value === undefined) {
      appendToMap(fields, path, value);
    } else if (Array.isArray(value)) {
      appendToMap(fields, path, value);
    } else if (typeof value === 'object') {
      const nested = extractFieldPaths(value as Record<string, unknown>, path, depth + 1);
      mergeFieldMaps(fields, nested);
    } else {
      appendToMap(fields, path, value);
    }
  }
  return fields;
}

/** Append a value to the list for a given key in the field map */
function appendToMap(map: Map<string, unknown[]>, key: string, value: unknown): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** Merge source field map into target (mutates target) */
function mergeFieldMaps(target: Map<string, unknown[]>, source: Map<string, unknown[]>): void {
  for (const [key, values] of source) {
    const existing = target.get(key);
    if (existing) {
      existing.push(...values);
    } else {
      target.set(key, [...values]);
    }
  }
}

/**
 * Infer canonical type from collected values across documents.
 * Priority: array > boolean > number > date > string.
 * Mixed types across documents fall back to 'string'.
 */
export function inferJSONFieldType(values: unknown[]): JSONInferredType {
  const nonEmpty = values.filter((v) => v != null);
  if (nonEmpty.length === 0) return 'string';

  if (nonEmpty.every((v) => Array.isArray(v))) return 'array';

  if (nonEmpty.every((v) => typeof v === 'object' && !Array.isArray(v))) return 'object';

  if (nonEmpty.every((v) => typeof v === 'boolean')) return 'boolean';

  if (nonEmpty.every((v) => typeof v === 'number')) return 'number';

  if (nonEmpty.every((v) => typeof v === 'string' && isISO8601Date(v))) return 'date';

  if (nonEmpty.every((v) => typeof v === 'string')) return 'string';

  // Mixed types across documents
  return 'string';
}

/**
 * Detect homogeneous item type for array fields.
 * Returns the common type if all items match, 'mixed' if heterogeneous, or undefined if empty.
 */
/** Possible item types for homogeneous array detection */
export type ArrayItemType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'mixed';

export function inferArrayItemType(arrays: unknown[][]): ArrayItemType | undefined {
  const allItems = arrays.flat().filter((v) => v != null);
  if (allItems.length === 0) return undefined;

  const types = new Set(allItems.map((v) => typeof v));
  if (types.size === 1) {
    const singleType = [...types][0];
    if (singleType === 'string') {
      if (allItems.every((v) => isISO8601Date(v as string))) return 'date';
      return 'string';
    }
    return singleType as ArrayItemType;
  }
  return 'mixed';
}

// --- Retry Utility -----------------------------------------------------------

/** Check if an error has an HTTP status code that warrants retry */
function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

// --- Service Implementation --------------------------------------------------

/**
 * JSON Document Schema Discovery Service
 *
 * Discovers field schemas from JSON document samples via recursive traversal.
 * Uses a hybrid approach: native JSON types + data sampling for type inference.
 */
export class JSONSchemaDiscoveryService extends SchemaDiscoveryService {
  private configProvider: JSONConnectorConfigProvider;
  private providerFactory: JSONDocumentProviderFactory;

  constructor(
    configProvider: JSONConnectorConfigProvider,
    providerFactory: JSONDocumentProviderFactory,
    logger?: Logger,
  ) {
    super(logger ?? defaultLogger);
    this.configProvider = configProvider;
    this.providerFactory = providerFactory;
  }

  /** Delay for retry backoff — protected for test override */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async discoverSchema(options: SchemaDiscoveryOptions): Promise<DiscoveredSchema> {
    const { connectorId, tenantId } = options;

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.start' when TraceStore is injected
    this.logger.info('JSON schema discovery started', { tenantId, connectorId });

    const connectorConfig = await this.configProvider.getConnectorConfig(connectorId, tenantId);
    if (!connectorConfig) {
      throw new Error(`Connector not found: ${connectorId} for tenant ${tenantId}`);
    }

    let provider: JSONDocumentProvider;
    try {
      provider = await this.providerFactory.createProvider(connectorConfig);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('JSON document provider creation failed', {
        tenantId,
        connectorId,
        error: errorMsg,
      });
      throw Object.assign(new Error(`${JSON_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
        code: JSON_ERROR_CODES.AUTH_FAILED,
      });
    }

    let documents: JSONDocument[];
    try {
      documents = await this.withRetry(
        () => provider.getDocumentSamples(connectorId, MAX_SAMPLE_DOCUMENTS),
        tenantId,
        connectorId,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('JSON document fetch failed', {
        tenantId,
        connectorId,
        error: errorMsg,
      });
      throw err;
    }

    // Merge field paths across all documents
    const mergedFields = new Map<string, unknown[]>();
    let documentCount = 0;

    for (const doc of documents) {
      try {
        const docFields = extractFieldPaths(doc.content);
        mergeFieldMaps(mergedFields, docFields);
        documentCount++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn('Failed to parse JSON document, skipping', {
          tenantId,
          connectorId,
          documentId: doc.id,
          error: errorMsg,
        });
      }
    }

    // If all documents failed to parse, throw PARSE_FAILED
    if (documentCount === 0 && documents.length > 0) {
      const errorMsg = `All ${documents.length} documents failed to parse`;
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('JSON schema discovery failed: no parseable documents', {
        tenantId,
        connectorId,
        totalDocuments: documents.length,
      });
      throw Object.assign(new Error(`${JSON_ERROR_CODES.PARSE_FAILED}: ${errorMsg}`), {
        code: JSON_ERROR_CODES.PARSE_FAILED,
      });
    }

    // Build discovered fields from merged field map
    const fields: DiscoveredField[] = [];
    for (const [path, values] of mergedFields) {
      const fieldType = inferJSONFieldType(values);
      const fieldName = path.includes('.') ? path.split('.').pop()! : path;

      const metadata: DiscoveredField['metadata'] = {
        description: path,
      };

      // Detect enum candidates for non-array primitive fields
      if (fieldType !== 'array' && fieldType !== 'object') {
        const enumValues = detectEnumCandidates(values);
        if (enumValues) {
          metadata.enumValues = enumValues;
        }
      }

      // Detect array item type for array fields
      if (fieldType === 'array') {
        const arrayValues = values.filter((v) => Array.isArray(v)) as unknown[][];
        const itemType = inferArrayItemType(arrayValues);
        if (itemType) {
          metadata.format = `array<${itemType}>`;
        }
      }

      fields.push({
        name: fieldName,
        type: fieldType,
        path,
        metadata,
      });
    }

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.complete' when TraceStore is injected
    this.logger.info('JSON schema discovery complete', {
      tenantId,
      connectorId,
      documentCount,
      fieldCount: fields.length,
    });

    return {
      connectorId,
      tenantId,
      fields,
      discoveryMethod: 'hybrid',
      discoveredAt: new Date(),
      metadata: {
        connectorType: 'json',
        version: '1.0',
      },
    };
  }

  /**
   * Execute an API call with exponential backoff retry for rate limits and transient errors.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    tenantId: string,
    connectorId: string,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === MAX_RETRIES) throw err;
        const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
        this.logger.warn('JSON document fetch rate limited, retrying', {
          tenantId,
          connectorId,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delayMs,
          status: (err as { status?: number }).status,
        });
        await this.sleep(delayMs);
      }
    }
    throw lastError; // unreachable, satisfies TypeScript
  }

  async validateCredentials(connectorId: string, tenantId: string): Promise<boolean> {
    const connectorConfig = await this.configProvider.getConnectorConfig(connectorId, tenantId);
    if (!connectorConfig) return false;

    try {
      const provider = await this.providerFactory.createProvider(connectorConfig);
      await provider.getDocumentSamples(connectorId, 1);
      return true;
    } catch {
      return false;
    }
  }
}
