import { createLogger, type Logger } from '@agent-platform/shared-observability';
import {
  SchemaDiscoveryService,
  type DiscoveredSchema,
  type DiscoveredField,
  type SchemaDiscoveryOptions,
} from './SchemaDiscoveryService.js';
import { isISO8601Date, detectEnumCandidates } from './GoogleSheetsSchemaDiscoveryService.js';

const defaultLogger = createLogger('csv-schema-discovery');

/** Maximum number of data rows to sample for type inference */
const MAX_SAMPLE_ROWS = 1000;

/** Maximum unique values for a column to be considered an enum candidate (CSV-specific: <30) */
const CSV_MAX_ENUM_CARDINALITY = 30;

/** Maximum number of retries for rate-limited or transient errors */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
const BASE_BACKOFF_MS = 1000;

/** HTTP status codes that trigger retry with backoff */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

// --- DI Interfaces -----------------------------------------------------------

/** Raw CSV data returned by provider — header row + data rows */
export interface CSVData {
  /** Header names from first row */
  headers: string[];
  /** Data rows (each row is an array of string cell values, aligned with headers) */
  rows: string[][];
  /** Detected delimiter for metadata */
  delimiter: string;
  /** Total row count in source (may exceed sampled rows) */
  totalRowCount?: number;
}

/** Minimal client interface for fetching CSV data */
export interface CSVDataProvider {
  /**
   * Fetch CSV data with headers and up to `maxRows` data rows.
   * Provider is responsible for: file reading, BOM stripping, delimiter detection,
   * quote handling, and encoding. Returns clean tabular data.
   */
  getCSVData(connectorId: string, maxRows: number): Promise<CSVData>;
}

/** Minimal connector info needed for CSV schema discovery */
export interface CSVConnectorInfo {
  connectorId: string;
  tenantId: string;
  connectionConfig: {
    fileSource?: string;
    delimiter?: string;
    encoding?: string;
  };
}

/** Dependency interface for connector config lookup */
export interface CSVConnectorConfigProvider {
  getConnectorConfig(connectorId: string, tenantId: string): Promise<CSVConnectorInfo | null>;
}

/** Dependency interface for creating a CSV data provider from connector config */
export interface CSVDataProviderFactory {
  createProvider(config: CSVConnectorInfo): Promise<CSVDataProvider>;
}

// --- Error Codes -------------------------------------------------------------

/** Error codes for CSV schema discovery */
export const CSV_ERROR_CODES = {
  AUTH_FAILED: 'ERR_CSV_AUTH_FAILED',
  PARSE_FAILED: 'ERR_CSV_PARSE_FAILED',
} as const;

// --- Type Inference Utilities ------------------------------------------------

/** Canonical field types inferred from CSV string values */
export type CSVInferredType = 'string' | 'number' | 'boolean' | 'date';

/** Common date patterns beyond ISO 8601 */
const COMMON_DATE_PATTERNS = [
  /^\d{1,2}\/\d{1,2}\/\d{4}$/, // MM/DD/YYYY or DD/MM/YYYY
  /^\d{1,2}-\d{1,2}-\d{4}$/, // MM-DD-YYYY or DD-MM-YYYY
  /^\d{4}\/\d{1,2}\/\d{1,2}$/, // YYYY/MM/DD
];

/** Check if a string matches a common date format (non-ISO) */
export function isCommonDateFormat(value: string): boolean {
  return COMMON_DATE_PATTERNS.some((p) => p.test(value.trim()));
}

/** Check if a string matches CSV boolean patterns (broader than JSON/GSheets) */
export function isCSVBoolean(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return ['true', 'false', 'yes', 'no', '1', '0'].includes(lower);
}

/**
 * Infer canonical type from CSV string column values.
 * Priority: boolean > number > date > string.
 * All CSV values are strings — type is inferred from parsing.
 */
export function inferCSVColumnType(values: string[]): CSVInferredType {
  const nonEmpty = values.filter((v) => v.trim() !== '');
  if (nonEmpty.length === 0) return 'string';

  if (nonEmpty.every((v) => isCSVBoolean(v))) return 'boolean';

  if (nonEmpty.every((v) => !isNaN(Number(v)))) return 'number';

  if (nonEmpty.every((v) => isISO8601Date(v.trim()) || isCommonDateFormat(v))) return 'date';

  return 'string';
}

// --- Retry Utility -----------------------------------------------------------

/** Check if an error has an HTTP status code that warrants retry */
function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

// --- Service Implementation --------------------------------------------------

/**
 * CSV File Schema Discovery Service
 *
 * Discovers field schemas from CSV file samples via header parsing and row sampling.
 * Uses a hybrid approach: headers for field names + string parsing for type inference.
 */
export class CSVSchemaDiscoveryService extends SchemaDiscoveryService {
  private configProvider: CSVConnectorConfigProvider;
  private providerFactory: CSVDataProviderFactory;

  constructor(
    configProvider: CSVConnectorConfigProvider,
    providerFactory: CSVDataProviderFactory,
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
    this.logger.info('CSV schema discovery started', { tenantId, connectorId });

    const connectorConfig = await this.configProvider.getConnectorConfig(connectorId, tenantId);
    if (!connectorConfig) {
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      throw new Error(`Connector not found: ${connectorId} for tenant ${tenantId}`);
    }

    let provider: CSVDataProvider;
    try {
      provider = await this.providerFactory.createProvider(connectorConfig);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('CSV data provider creation failed', {
        tenantId,
        connectorId,
        error: errorMsg,
      });
      throw Object.assign(new Error(`${CSV_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
        code: CSV_ERROR_CODES.AUTH_FAILED,
      });
    }

    let csvData: CSVData;
    try {
      csvData = await this.withRetry(
        () => provider.getCSVData(connectorId, MAX_SAMPLE_ROWS),
        tenantId,
        connectorId,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('CSV data fetch failed', {
        tenantId,
        connectorId,
        error: errorMsg,
      });
      throw err;
    }

    // Validate headers exist
    const validHeaders = csvData.headers.filter((h) => h != null && h.trim() !== '');
    if (validHeaders.length === 0) {
      const errorMsg = 'CSV has no valid headers';
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('CSV schema discovery failed: no valid headers', {
        tenantId,
        connectorId,
      });
      throw Object.assign(new Error(`${CSV_ERROR_CODES.PARSE_FAILED}: ${errorMsg}`), {
        code: CSV_ERROR_CODES.PARSE_FAILED,
      });
    }

    // Build discovered fields from headers + row sampling
    // Iterate over original headers with indices to handle duplicates correctly
    const seenHeaders = new Map<string, number>();
    const fields: DiscoveredField[] = [];
    for (let colIdx = 0; colIdx < csvData.headers.length; colIdx++) {
      const rawHeader = csvData.headers[colIdx];
      if (rawHeader == null || rawHeader.trim() === '') continue;

      // Deduplicate: append suffix for repeated header names
      const count = seenHeaders.get(rawHeader) ?? 0;
      seenHeaders.set(rawHeader, count + 1);
      const header = count === 0 ? rawHeader : `${rawHeader}_${count}`;

      const columnValues = csvData.rows.map((row) => row[colIdx] ?? '');
      const fieldType = inferCSVColumnType(columnValues);

      const metadata: DiscoveredField['metadata'] = {
        description: `CSV column: ${rawHeader}`,
      };

      // Detect enum candidates with CSV-specific threshold (30)
      const enumValues = detectEnumCandidates(columnValues, CSV_MAX_ENUM_CARDINALITY);
      if (enumValues) {
        metadata.enumValues = enumValues;
      }

      fields.push({
        name: header,
        type: fieldType,
        path: `columns/${header}`,
        metadata,
      });
    }

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.complete' when TraceStore is injected
    this.logger.info('CSV schema discovery complete', {
      tenantId,
      connectorId,
      rowCount: csvData.rows.length,
      fieldCount: fields.length,
    });

    return {
      connectorId,
      tenantId,
      fields,
      discoveryMethod: 'hybrid',
      discoveredAt: new Date(),
      metadata: {
        connectorType: 'csv',
        version: `1.0;delimiter=${csvData.delimiter}`,
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
        this.logger.warn('CSV data fetch rate limited, retrying', {
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
      await provider.getCSVData(connectorId, 1);
      return true;
    } catch {
      return false;
    }
  }
}
