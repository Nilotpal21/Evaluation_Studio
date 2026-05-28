/**
 * Types for Structured Data Ingestion
 */

export interface TableSchema {
  tableName: string;
  tenantId: string;
  indexId: string;
  columns: ColumnSchema[];
  primaryKey: string | null;
  rowCount: number;
  sampleRows: Record<string, any>[];
  statistics: Record<string, ColumnStatistics>;
  foreignKeys: ForeignKeyRelationship[];
  description?: string;
}

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  description?: string;
  nullable: boolean;
  avgLength?: number | null;
  statistics?: ColumnStatistics;
  isEmbeddable: boolean;
  isFilterable: boolean;
}

export type ColumnType = 'string' | 'number' | 'integer' | 'decimal' | 'boolean' | 'date' | 'enum';

export type ColumnStatistics = NumericStatistics | CategoricalStatistics | StringStatistics;

export interface NumericStatistics {
  type: 'numeric';
  min: number;
  max: number;
  avg: number;
  median: number;
  stddev: number;
  percentiles: {
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
}

export interface CategoricalStatistics {
  type: 'categorical';
  uniqueValues: string[];
  cardinality: number;
  distribution: Record<string, number>; // value -> percentage
  mostCommon: Array<{ value: string; count: number }>;
}

export interface StringStatistics {
  type: 'string';
  avgLength: number;
  minLength: number;
  maxLength: number;
  totalChars: number;
}

export interface ForeignKeyRelationship {
  sourceField: string;
  targetTable: string;
  targetField: string;
  confidence: number;
  detectionMethod:
    | 'naming_convention'
    | 'value_overlap'
    | 'naming_convention + validation'
    | 'naming_convention (validation failed)'
    | 'type_and_cardinality';
}

export interface ParsedTable {
  headers: string[];
  rows: any[][];
  format: 'csv' | 'json' | 'excel';
}

export interface ClickHouseTableRow {
  // Core fields
  tenant_id: string;
  index_id: string;
  table_id: string;

  // Row data (stored as JSON string)
  row_data: string; // JSON.stringify of the row object

  // Optional metadata
  row_number?: number;
  created_at?: Date;
}

export interface TableMetadata {
  table_id: string;
  table_name: string;
  display_name: string;

  // Isolation
  tenant_id: string;
  index_id: string;

  // Schema
  columns: string; // JSON array of column names
  column_types: string; // JSON array of column types
  primary_key: string | null;
  row_count: number;

  // Descriptions
  table_description: string;
  column_descriptions: string; // JSON object: { [colName]: description }

  // Statistics
  statistics: string; // JSON object with per-column stats
  sample_rows: string; // JSON array of sample rows

  // Relationships
  foreign_keys: string; // JSON array of foreign key relationships

  // Searchability
  searchable_text: string; // Concatenated text for keyword search

  // Timestamps
  created_at: Date;
  updated_at: Date;
}

export interface IngestionResult {
  success: boolean;
  tableId?: string;
  rowsIngested?: number;
  metadataGenerated?: boolean;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}
