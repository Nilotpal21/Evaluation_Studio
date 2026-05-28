import { createLogger, type Logger } from '@agent-platform/shared-observability';
import {
  SchemaDiscoveryService,
  type DiscoveredSchema,
  type DiscoveredField,
  type SchemaDiscoveryOptions,
} from './SchemaDiscoveryService.js';

const defaultLogger = createLogger('gsheets-schema-discovery');

/** Maximum number of data rows to sample for type inference */
const SAMPLE_ROW_COUNT = 100;

/** Maximum unique values for a column to be considered an enum candidate */
const MAX_ENUM_CARDINALITY = 20;

/** Minimum ratio of repeated values to consider as enum (prevents near-unique columns) */
const ENUM_RATIO_THRESHOLD = 0.8;

/** Maximum number of retries for rate-limited or transient API errors */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
const BASE_BACKOFF_MS = 1000;

/** HTTP status codes that trigger retry with backoff */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

// ─── Google Sheets API Types ────────────────────────────────────────────────
// Local types mirroring Google Sheets API v4 responses.
// No external connector package exists — these are defined here per Story 1.2 pattern.

/** Spreadsheet metadata from GET /v4/spreadsheets/{id}?fields=sheets.properties */
export interface GSSpreadsheet {
  spreadsheetId: string;
  properties: { title: string };
  sheets: GSSheetProperties[];
}

/** Individual sheet properties */
export interface GSSheetProperties {
  properties: {
    sheetId: number;
    title: string;
    gridProperties: { rowCount: number; columnCount: number };
  };
}

/** Cell values from GET /v4/spreadsheets/{id}/values/{range} */
export interface GSValueRange {
  range: string;
  majorDimension: 'ROWS' | 'COLUMNS';
  values?: unknown[][]; // Row-major 2D array; cells can be string, number, or boolean (absent when range is empty)
}

/** Minimal Google Sheets client interface for schema discovery */
export interface GSClient {
  getSpreadsheet(spreadsheetId: string): Promise<GSSpreadsheet>;
  getValues(spreadsheetId: string, range: string): Promise<GSValueRange>;
}

// ─── Error Codes ────────────────────────────────────────────────────────────

/** Error codes for Google Sheets schema discovery */
export const GS_ERROR_CODES = {
  AUTH_FAILED: 'ERR_GSHEETS_AUTH_FAILED',
  NOT_FOUND: 'ERR_GSHEETS_NOT_FOUND',
} as const;

// ─── Options & Config Interfaces ────────────────────────────────────────────

/** Options specific to Google Sheets schema discovery */
export interface GoogleSheetsDiscoveryOptions extends SchemaDiscoveryOptions {
  /** Spreadsheet ID to discover (overrides connector config default) */
  spreadsheetId?: string;
}

/** Minimal connector info needed for Google Sheets schema discovery */
export interface GSConnectorInfo {
  connectorId: string;
  tenantId: string;
  spreadsheetId: string;
  connectionConfig: {
    clientId?: string;
    scopes?: string[];
  };
}

/** Dependency interface for connector config lookup */
export interface GSConnectorConfigProvider {
  getConnectorConfig(connectorId: string, tenantId: string): Promise<GSConnectorInfo | null>;
}

/** Dependency interface for creating a Google Sheets client */
export interface GSClientFactory {
  createClient(config: GSConnectorInfo): Promise<GSClient>;
}

// ─── Type Inference Utilities ───────────────────────────────────────────────

const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Check if a string matches ISO 8601 date format */
export function isISO8601Date(value: string): boolean {
  return ISO_8601_PATTERN.test(value);
}

/**
 * Infer canonical type from a column of sampled values.
 * Priority: boolean > number > date > string (most specific wins).
 *
 * Handles native JS types from Google Sheets UNFORMATTED_VALUE render option.
 */

/** Canonical column types inferred from sampled data */
export type InferredColumnType = 'string' | 'number' | 'boolean' | 'date';

export function inferColumnType(values: unknown[]): InferredColumnType {
  const nonEmpty = values.filter((v) => v !== '' && v != null);
  if (nonEmpty.length === 0) return 'string';

  // Boolean: all values are native boolean or string boolean literals
  if (
    nonEmpty.every(
      (v) =>
        typeof v === 'boolean' ||
        (typeof v === 'string' && (v === 'true' || v === 'false' || v === 'TRUE' || v === 'FALSE')),
    )
  )
    return 'boolean';

  // Number: all values are native number or parseable numeric strings
  if (
    nonEmpty.every(
      (v) =>
        typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v.trim() !== ''),
    )
  )
    return 'number';

  // Date: all values are ISO 8601 date strings
  if (nonEmpty.every((v) => typeof v === 'string' && isISO8601Date(v))) return 'date';

  return 'string';
}

/**
 * Detect enum candidates by cardinality analysis.
 * Returns sorted unique values if column has ≤ maxCardinality unique values
 * and the ratio of unique to total is below the threshold (prevents near-unique columns).
 */
export function detectEnumCandidates(
  values: unknown[],
  maxCardinality: number = MAX_ENUM_CARDINALITY,
): string[] | undefined {
  const nonEmpty = values.filter((v) => v !== '' && v != null);
  if (nonEmpty.length === 0) return undefined;

  const uniqueValues = [...new Set(nonEmpty.map(String))];
  if (
    uniqueValues.length <= maxCardinality &&
    uniqueValues.length < nonEmpty.length * ENUM_RATIO_THRESHOLD
  ) {
    return uniqueValues.sort();
  }
  return undefined;
}

// ─── Retry Utility ─────────────────────────────────────────────────────────

/** Check if an error has an HTTP status code that warrants retry */
function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Quote a sheet title for use in A1 range notation.
 * Titles with spaces or special characters must be wrapped in single quotes,
 * with internal single quotes doubled.
 */
function quoteSheetTitle(title: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(title)) return title;
  return `'${title.replace(/'/g, "''")}'`;
}

// ─── Service Implementation ─────────────────────────────────────────────────

/**
 * Google Sheets Schema Discovery Service
 *
 * Discovers field schemas from Google Sheets via the Sheets API v4.
 * Uses a hybrid approach: API headers + data sampling for type inference.
 */
export class GoogleSheetsSchemaDiscoveryService extends SchemaDiscoveryService {
  private configProvider: GSConnectorConfigProvider;
  private clientFactory: GSClientFactory;

  constructor(
    configProvider: GSConnectorConfigProvider,
    clientFactory: GSClientFactory,
    logger?: Logger,
  ) {
    super(logger ?? defaultLogger);
    this.configProvider = configProvider;
    this.clientFactory = clientFactory;
  }

  /** Delay for retry backoff — protected for test override */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async discoverSchema(options: GoogleSheetsDiscoveryOptions): Promise<DiscoveredSchema> {
    const { connectorId, tenantId, spreadsheetId } = options;

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.start' when TraceStore is injected
    this.logger.info('Google Sheets schema discovery started', { tenantId, connectorId });

    const connectorConfig = await this.configProvider.getConnectorConfig(connectorId, tenantId);
    if (!connectorConfig) {
      throw new Error(`Connector not found: ${connectorId} for tenant ${tenantId}`);
    }

    let client: GSClient;
    try {
      client = await this.clientFactory.createClient(connectorConfig);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('Google Sheets auth failed', { tenantId, connectorId, error: errorMsg });
      throw Object.assign(new Error(`${GS_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
        code: GS_ERROR_CODES.AUTH_FAILED,
      });
    }

    const targetSpreadsheetId = spreadsheetId ?? connectorConfig.spreadsheetId;
    const allFields: DiscoveredField[] = [];
    let sheetCount = 0;

    try {
      const spreadsheet = await this.withRetry(
        () => client.getSpreadsheet(targetSpreadsheetId),
        tenantId,
        connectorId,
      );

      // Fetch all sheets in parallel (M2 fix)
      const sheetResults = await Promise.all(
        spreadsheet.sheets.map(async (sheet) => {
          const sheetTitle = sheet.properties.title;
          const quotedTitle = quoteSheetTitle(sheetTitle);
          const range = `${quotedTitle}!1:${SAMPLE_ROW_COUNT + 1}`;
          const valueRange = await this.withRetry(
            () => client.getValues(targetSpreadsheetId, range),
            tenantId,
            connectorId,
          );
          return { sheetTitle, valueRange };
        }),
      );

      for (const { sheetTitle, valueRange } of sheetResults) {
        if (!valueRange.values || valueRange.values.length === 0) continue;

        sheetCount++;
        const headers = valueRange.values[0];
        const dataRows = valueRange.values.slice(1);

        for (let colIdx = 0; colIdx < headers.length; colIdx++) {
          const headerValue = headers[colIdx];
          if (headerValue == null || headerValue === '') continue;

          const columnName = String(headerValue);
          const columnValues = dataRows.map((row) => row[colIdx]).filter((v) => v !== undefined);

          allFields.push({
            name: columnName,
            type: inferColumnType(columnValues),
            path: `sheets/${sheetTitle}/columns/${columnName}`,
            metadata: {
              description: `${sheetTitle}: ${columnName}`,
              enumValues: detectEnumCandidates(columnValues),
            },
          });
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;

      if (status === 401 || status === 403) {
        this.logger.error('Google Sheets auth failed during discovery', {
          tenantId,
          connectorId,
          error: errorMsg,
        });
        throw Object.assign(new Error(`${GS_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
          code: GS_ERROR_CODES.AUTH_FAILED,
        });
      }

      if (status === 404) {
        this.logger.error('Google Sheets spreadsheet not found', {
          tenantId,
          connectorId,
          error: errorMsg,
        });
        throw Object.assign(new Error(`${GS_ERROR_CODES.NOT_FOUND}: ${errorMsg}`), {
          code: GS_ERROR_CODES.NOT_FOUND,
        });
      }

      throw err;
    }

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.complete' when TraceStore is injected
    this.logger.info('Google Sheets schema discovery complete', {
      tenantId,
      connectorId,
      sheetCount,
      fieldCount: allFields.length,
    });

    return {
      connectorId,
      tenantId,
      fields: allFields,
      discoveryMethod: 'hybrid',
      discoveredAt: new Date(),
      metadata: {
        connectorType: 'google-sheets',
        version: 'v4',
      },
    };
  }

  /**
   * Execute an API call with exponential backoff retry for rate limits and transient errors.
   * Retries on 429/500/503 up to MAX_RETRIES times with exponential delay.
   * Non-retryable errors are thrown immediately.
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
        this.logger.warn('Google Sheets API rate limited, retrying', {
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
      const client = await this.clientFactory.createClient(connectorConfig);
      await client.getSpreadsheet(connectorConfig.spreadsheetId);
      return true;
    } catch {
      return false;
    }
  }
}
