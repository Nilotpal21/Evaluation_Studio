/**
 * Smart Chunking Strategy for Structured Data
 *
 * Implements cost-efficient chunking:
 * 1. ALWAYS: Table metadata chunk (1 per table)
 * 2. CONDITIONALLY: Row chunks for text-heavy records (>100 chars)
 * 3. NEVER: Chunks for purely numeric rows
 *
 * Cost Savings Example:
 * - 100k row table with 1k text-heavy rows
 * - Old: 100k chunks → New: 1 + 1k = 1,001 chunks (99% reduction)
 */

import type { ColumnSchema, TableSchema } from './types.js';

export interface ChunkableRow {
  rowNumber: number;
  rowData: Record<string, any>;
  textContent: string;
  textLength: number;
  embeddableFields: string[];
}

export interface TableMetadataChunk {
  type: 'table_metadata';
  tableName: string;
  displayName: string;
  description: string;
  // Schema information
  columns: Array<{
    name: string;
    type: string;
    description?: string;
    nullable: boolean;
    statistics?: any;
  }>;
  primaryKey: string | null;
  rowCount: number;
  // Sample rows (10-20 representative)
  sampleRows: Record<string, any>[];
  // Column statistics
  statistics: Record<string, any>;
  // Foreign keys
  foreignKeys: Array<{
    sourceField: string;
    targetTable: string;
    targetField: string;
    confidence: number;
  }>;
  // Metadata
  createdAt: Date;
}

export interface RowChunk {
  type: 'row';
  tableName: string;
  rowNumber: number;
  rowData: Record<string, any>;
  textContent: string;
  embeddableFields: string[];
}

export interface ChunkingResult {
  metadataChunk: TableMetadataChunk;
  rowChunks: RowChunk[];
  statistics: {
    totalRows: number;
    chunkedRows: number;
    skippedRows: number;
    savingsPercent: number;
  };
}

const TEXT_CONTENT_THRESHOLD = 100; // Only chunk rows with >100 chars of text

export class StructuredDataChunkingStrategy {
  /**
   * Apply smart chunking strategy to table data
   *
   * Design:
   * - Tables (CSV/Excel): Create ONLY 1 metadata chunk per table
   * - NO individual row chunks (all rows go to ClickHouse only)
   * - Metadata chunk is for table-level semantic search
   * - Query routing: SQL → ClickHouse, Semantic → metadata chunk → ClickHouse
   */
  chunk(
    tableName: string,
    displayName: string,
    description: string,
    columns: ColumnSchema[],
    rows: Record<string, any>[],
    primaryKey: string | null,
    foreignKeys: TableSchema['foreignKeys'],
    statistics: TableSchema['statistics'],
  ): ChunkingResult {
    // Step 1: Generate table metadata chunk (always and only this)
    const metadataChunk = this.createMetadataChunk(
      tableName,
      displayName,
      description,
      columns,
      rows,
      primaryKey,
      foreignKeys,
      statistics,
    );

    // Step 2: NO row chunks - all rows go to ClickHouse only
    const rowChunks: RowChunk[] = [];

    // Step 3: Calculate statistics (100% savings - no row chunks ever)
    const totalRows = rows.length;
    const chunkedRows = 0; // No row chunks
    const skippedRows = totalRows; // All rows skipped from chunking
    const savingsPercent = 100; // Always 100% savings

    console.log('[chunking-strategy] Table chunking complete (metadata-only):', {
      tableName,
      totalRows,
      chunkedRows,
      skippedRows,
      savingsPercent: `${savingsPercent}%`,
      note: 'All rows stored in ClickHouse, no individual row chunks',
    });

    return {
      metadataChunk,
      rowChunks,
      statistics: {
        totalRows,
        chunkedRows,
        skippedRows,
        savingsPercent,
      },
    };
  }

  /**
   * Create table metadata chunk (always created)
   */
  private createMetadataChunk(
    tableName: string,
    displayName: string,
    description: string,
    columns: ColumnSchema[],
    rows: Record<string, any>[],
    primaryKey: string | null,
    foreignKeys: TableSchema['foreignKeys'],
    statistics: TableSchema['statistics'],
  ): TableMetadataChunk {
    // Select representative sample rows (10-20)
    const sampleSize = Math.min(20, Math.max(10, Math.ceil(rows.length * 0.01)));
    const sampleRows = this.selectRepresentativeSamples(rows, sampleSize);

    // Generate table description if not provided
    const finalDescription =
      description || this.generateTableDescription(tableName, columns, rows.length);

    return {
      type: 'table_metadata',
      tableName,
      displayName,
      description: finalDescription,
      columns: columns.map((col) => ({
        name: col.name,
        type: col.type,
        description: col.description,
        nullable: col.nullable,
        statistics: col.statistics,
      })),
      primaryKey,
      rowCount: rows.length,
      sampleRows,
      statistics,
      foreignKeys,
      createdAt: new Date(),
    };
  }

  /**
   * Identify rows that should be chunked (text-heavy rows)
   */
  private identifyChunkableRows(
    rows: Record<string, any>[],
    columns: ColumnSchema[],
  ): ChunkableRow[] {
    const embeddableColumns = columns.filter((col) => col.isEmbeddable).map((col) => col.name);

    if (embeddableColumns.length === 0) {
      console.log(
        '[chunking-strategy] No embeddable columns found - no row chunks will be created',
      );
      return [];
    }

    const chunkableRows: ChunkableRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Extract text content from embeddable fields
      const textParts: string[] = [];
      const presentEmbeddableFields: string[] = [];

      for (const colName of embeddableColumns) {
        const value = row[colName];
        if (value !== null && value !== undefined && value !== '') {
          const text = String(value).trim();
          if (text.length > 0) {
            textParts.push(text);
            presentEmbeddableFields.push(colName);
          }
        }
      }

      const textContent = textParts.join(' ');
      const textLength = textContent.length;

      // Only chunk if text content exceeds threshold
      if (textLength >= TEXT_CONTENT_THRESHOLD) {
        chunkableRows.push({
          rowNumber: i,
          rowData: row,
          textContent,
          textLength,
          embeddableFields: presentEmbeddableFields,
        });
      }
    }

    return chunkableRows;
  }

  /**
   * Create row chunk for a single row
   */
  private createRowChunk(tableName: string, chunkable: ChunkableRow): RowChunk {
    return {
      type: 'row',
      tableName,
      rowNumber: chunkable.rowNumber,
      rowData: chunkable.rowData,
      textContent: chunkable.textContent,
      embeddableFields: chunkable.embeddableFields,
    };
  }

  /**
   * Select representative sample rows (stratified if possible)
   */
  private selectRepresentativeSamples(
    rows: Record<string, any>[],
    sampleSize: number,
  ): Record<string, any>[] {
    if (rows.length <= sampleSize) {
      return rows;
    }

    // Simple approach: evenly spaced samples
    const samples: Record<string, any>[] = [];
    const step = Math.floor(rows.length / sampleSize);

    for (let i = 0; i < sampleSize; i++) {
      const index = i * step;
      samples.push(rows[index]);
    }

    return samples;
  }

  /**
   * Auto-generate table description based on schema
   */
  private generateTableDescription(
    tableName: string,
    columns: ColumnSchema[],
    rowCount: number,
  ): string {
    const columnNames = columns.map((c) => c.name).join(', ');
    const columnCount = columns.length;

    return `Table '${tableName}' contains ${rowCount.toLocaleString()} rows with ${columnCount} columns: ${columnNames}. This table stores structured data for semantic search and analysis.`;
  }
}
