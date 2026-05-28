/**
 * Source Types
 *
 * Configuration for search data sources (connectors).
 */

import type { SourceStatus } from '../constants.js';

// ─── Source Type ──────────────────────────────────────────────────────────────

export const SourceType = {
  FILE_UPLOAD: 'file_upload',
  WEB_CRAWL: 'web_crawl',
  API_CONNECTOR: 'api_connector',
  DATABASE: 'database',
  JIRA: 'jira',
  SALESFORCE: 'salesforce',
  HUBSPOT: 'hubspot',
  CONFLUENCE: 'confluence',
  NOTION: 'notion',
  GOOGLE_DRIVE: 'google_drive',
  SHAREPOINT: 'sharepoint',
  S3: 's3',
  CUSTOM: 'custom',
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

// ─── Source Config ────────────────────────────────────────────────────────────

export interface SourceConfig {
  sourceType: SourceType;
  /** Connection/authentication details (encrypted at rest) */
  connectionConfig: Record<string, unknown>;
  /** Extraction configuration */
  extractionConfig?: ExtractionConfig;
  /** Enrichment configuration */
  enrichmentConfig?: EnrichmentConfig;
  /** Sync schedule (cron expression) */
  syncSchedule?: string;
  /** Maximum documents to sync per run */
  maxDocumentsPerSync?: number;
}

export interface ExtractionConfig {
  /** Supported content types to process */
  contentTypes?: string[];
  /** Maximum file size in bytes */
  maxFileSizeBytes?: number;
  /** Custom extraction rules */
  rules?: ExtractionRule[];
}

export interface ExtractionRule {
  /** CSS selector or XPath for web content */
  selector?: string;
  /** Regex pattern for text content */
  pattern?: string;
  /** Field to extract to */
  targetField: string;
}

export interface EnrichmentConfig {
  /** Whether to extract named entities */
  extractEntities?: boolean;
  /** Whether to generate summaries */
  generateSummary?: boolean;
  /** Whether to detect language */
  detectLanguage?: boolean;
  /** Custom enrichment pipeline steps */
  customSteps?: string[];
}

// ─── Source Summary ──────────────────────────────────────────────────────────

export interface SearchSourceSummary {
  id: string;
  indexId: string;
  name: string;
  sourceType: SourceType;
  status: SourceStatus;
  documentCount: number;
  lastSyncAt: string | null;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
}
