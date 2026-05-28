/**
 * DestinationContract — typed contract for the target of a store-results node.
 *
 * Source of truth for:
 *   - store-results config UX (destination enum, dependent field rules)
 *   - Preview tab filter (only `previewable: true` destinations show up)
 *   - table-name format validation
 */

export type DestinationId = 'clickhouse' | 'mongodb' | 'callback' | 'none';

export type TableFormat = 'database.table' | 'collection' | 'url' | 'none';

export const CUSTOM_PIPELINE_RESULTS_TABLE = 'abl_platform.custom_pipeline_results';
export const CUSTOM_PIPELINE_RESULTS_COLLECTION = 'custom_pipeline_results';

export interface DestinationContract {
  id: DestinationId;
  label: string;
  table: {
    format: TableFormat;
    regex?: RegExp;
    required: boolean;
    /** Human-readable field label in the Studio config form. */
    labelText: string;
  };
  /** True iff the Observability Preview tab can read from this destination. */
  previewable: boolean;
  /** True iff the store-results config must declare an outputSchema for this destination. */
  requiresOutputSchema: boolean;
  /** Which other store-results config fields appear/disappear based on this destination. */
  dependentFields: Array<{
    field: string;
    visibility: 'required' | 'optional' | 'hidden';
  }>;
}

export const DESTINATION_REGISTRY: Readonly<Record<DestinationId, DestinationContract>> = {
  clickhouse: {
    id: 'clickhouse',
    label: 'ClickHouse',
    table: {
      format: 'database.table',
      regex: /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/,
      required: false,
      labelText: 'ClickHouse table (database.table, defaults to custom_pipeline_results)',
    },
    previewable: true,
    requiresOutputSchema: true,
    dependentFields: [
      { field: 'table', visibility: 'optional' },
      { field: 'outputSchema', visibility: 'optional' },
      { field: 'sourceStep', visibility: 'optional' },
      { field: 'source', visibility: 'optional' },
    ],
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    table: {
      format: 'collection',
      regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      required: false,
      labelText: 'MongoDB collection (defaults to custom_pipeline_results)',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [
      { field: 'table', visibility: 'optional' },
      { field: 'collection', visibility: 'optional' },
      { field: 'sourceStep', visibility: 'optional' },
      { field: 'document', visibility: 'optional' },
    ],
  },
  callback: {
    id: 'callback',
    label: 'Callback URL',
    table: {
      format: 'url',
      required: true,
      labelText: 'Callback URL',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [{ field: 'callbackUrl', visibility: 'required' }],
  },
  none: {
    id: 'none',
    label: 'None (handled by compute step)',
    table: {
      format: 'none',
      required: false,
      labelText: '(not applicable)',
    },
    previewable: false,
    requiresOutputSchema: false,
    dependentFields: [],
  },
};

const DESTINATION_IDS: readonly DestinationId[] = ['clickhouse', 'mongodb', 'callback', 'none'];

export function isDestinationId(value: unknown): value is DestinationId {
  return typeof value === 'string' && DESTINATION_IDS.includes(value as DestinationId);
}
