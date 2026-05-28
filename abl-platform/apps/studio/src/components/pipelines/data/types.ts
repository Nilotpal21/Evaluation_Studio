/**
 * Pipeline Data — Client-side type definitions
 *
 * Mirror shapes returned by the pipeline-data API routes.
 * Do NOT import from server-side schema-resolver (it imports Mongoose).
 */

import type { PipelineObservabilityResponseMeta } from '@agent-platform/shared';

/** Metadata for a single column in a ClickHouse output table */
export interface ColumnMeta {
  name: string;
  type: string;
  filterable: boolean;
  exportable: boolean;
  description?: string;
}

/** Schema response from GET /api/runtime/projects/:projectId/pipeline-observability/pipelines/:pipelineId/output-schema */
export interface OutputSchemaResponse {
  success: boolean;
  meta: PipelineObservabilityResponseMeta;
  data: {
    table: string;
    columns: ColumnMeta[];
  };
}

/** A single filter row applied to the query */
export interface DataFilter {
  column: string;
  op: '=' | 'in' | 'contains';
  value: string;
}

/** Allowed operators per column type category */
export type FilterOp = '=' | 'in' | 'contains';

/** Body sent to POST /api/runtime/projects/:projectId/pipeline-observability/data/query */
export interface PipelineDataQueryBody {
  pipelineId: string;
  sessionId?: string;
  runId?: string;
  timeRange: { from: string; to: string };
  filters: DataFilter[];
  limit: number;
  offset: number;
}

/** Response from POST /api/runtime/projects/:projectId/pipeline-observability/data/query */
export interface PipelineDataQueryResponse {
  success: boolean;
  meta: PipelineObservabilityResponseMeta;
  data: {
    table: string;
    columns: string[];
    rows: Record<string, unknown>[];
  };
  pagination: {
    total: number | null;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/** A previewable pipeline from GET /api/runtime/projects/:projectId/pipeline-observability/data/previewable-pipelines */
export interface PreviewablePipeline {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
}

/** Response from the previewable-pipelines endpoint */
export interface PreviewablePipelinesResponse {
  success: boolean;
  meta: PipelineObservabilityResponseMeta;
  data: PreviewablePipeline[];
}

/**
 * Known error codes from the pipeline-data routes.
 * Used for mapping to user-friendly empty states / toast messages.
 */
export type PipelineDataErrorCode =
  | 'NO_OUTPUT_TABLE'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_FILTER'
  | 'INVALID_COLUMN'
  | 'INVALID_TABLE'
  | 'RATE_LIMITED'
  | 'QUERY_TIMEOUT'
  | 'SCAN_LIMIT';
