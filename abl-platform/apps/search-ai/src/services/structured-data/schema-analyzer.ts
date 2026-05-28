/**
 * Schema Analyzer for Structured Data
 *
 * Analyzes CSV, JSON, and Excel files to detect:
 * - Column types with confidence scores
 * - Primary keys
 * - Foreign key relationships
 * - Embeddability recommendations
 * - Cost estimates
 */

import type { DetectedColumn, DetectedForeignKey, AnalyzeResponse } from './ingestion-types.js';
import { v4 as uuidv4 } from 'uuid';

interface ParsedTableData {
  tableName: string;
  rows: Record<string, any>[];
  headers: string[];
}

export class StructuredDataSchemaAnalyzer {
  /**
   * Analyze file and detect schema
   */
  async analyze(fileBuffer: Buffer, filename: string, mimeType: string): Promise<AnalyzeResponse> {
    // Parse file based on MIME type
    const parsedData = await this.parseFile(fileBuffer, filename, mimeType);

    // Detect column types
    const columns = this.detectColumns(parsedData.rows, parsedData.headers);

    // Detect primary key
    const primaryKey = this.detectPrimaryKey(parsedData.rows, columns);

    // Detect foreign keys
    const foreignKeys = this.detectForeignKeys(parsedData.rows, columns);

    // Calculate cost estimates
    const estimates = this.calculateEstimates(parsedData.rows, columns);

    // Generate quality metrics
    const quality = this.assessQuality(columns, parsedData.rows);

    const analysisId = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    return {
      analysisId,
      schema: {
        tableName: parsedData.tableName,
        rowCount: parsedData.rows.length,
        columns,
        primaryKey,
        foreignKeys,
      },
      estimates,
      quality,
      expiresAt,
    };
  }

  /**
   * Parse file based on MIME type
   */
  async parseFile(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<ParsedTableData> {
    const tableName = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');

    if (mimeType === 'text/csv' || mimeType === 'application/csv') {
      return this.parseCSV(fileBuffer, tableName);
    } else if (mimeType === 'application/json') {
      return this.parseJSON(fileBuffer, tableName);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      return this.parseExcel(fileBuffer, tableName);
    } else if (mimeType === 'application/vnd.ms-excel') {
      throw new Error('Legacy .xls format is not supported. Please convert to .xlsx');
    }

    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  /**
   * Parse CSV file
   */
  private async parseCSV(fileBuffer: Buffer, tableName: string): Promise<ParsedTableData> {
    const PapaModule = await import('papaparse');
    // Handle both ESM default export and CommonJS
    const Papa = PapaModule.default ?? PapaModule;
    const csvText = fileBuffer.toString('utf-8');

    const result = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // Keep as strings for type detection
      delimiter: ',', // Explicitly set delimiter to avoid auto-detect warnings
    });

    // Filter out non-critical warnings:
    // - auto-detect delimiter is harmless
    // - "Too few fields" / "Too many fields" happen in real-world CSVs with
    //   mixed sections (e.g., data rows + summary rows with fewer columns).
    //   PapaParse still parses them — just pads with empty values.
    const criticalErrors = result.errors.filter(
      (err) =>
        !err.message.includes('auto-detect delimiting') &&
        !err.message.includes('Too few fields') &&
        !err.message.includes('Too many fields'),
    );

    if (criticalErrors.length > 0) {
      throw new Error(`CSV parsing error: ${criticalErrors[0].message}`);
    }

    const rows = result.data as Record<string, any>[];
    const headers = result.meta.fields || [];

    if (rows.length === 0) {
      throw new Error('CSV file contains no data rows');
    }

    return {
      tableName,
      rows,
      headers,
    };
  }

  /**
   * Parse JSON file (array of objects or single object)
   */
  private parseJSON(fileBuffer: Buffer, tableName: string): ParsedTableData {
    const jsonText = fileBuffer.toString('utf-8');
    let data: any;

    try {
      data = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(
        `JSON parsing error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // Support: array directly, {data: []}, {records: []}, or single object
    let rows: Record<string, any>[];

    if (Array.isArray(data)) {
      rows = data;
    } else if (data.data && Array.isArray(data.data)) {
      rows = data.data;
    } else if (data.records && Array.isArray(data.records)) {
      rows = data.records;
    } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      // Single object - wrap in array
      rows = [data];
    } else {
      throw new Error(
        'JSON must be an array, contain "data" or "records" field with array, or be a single object',
      );
    }

    if (rows.length === 0) {
      throw new Error('JSON file contains no data');
    }

    // Extract headers from first object
    const headers = Object.keys(rows[0]);

    return { tableName, rows, headers };
  }

  /**
   * Parse Excel file (.xlsx only — exceljs does not support legacy .xls format)
   */
  private async parseExcel(fileBuffer: Buffer, tableName: string): Promise<ParsedTableData> {
    const ExcelJSModule = await import('exceljs');
    const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;
    const workbook = new ExcelJS.Workbook();
    // exceljs load() accepts Buffer at runtime but its type declarations
    // are incompatible with Node 20+ Buffer<ArrayBufferLike>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (workbook.xlsx as any).load(fileBuffer);

    // Use first sheet
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) {
      throw new Error('Excel sheet is empty');
    }

    // Extract headers from first row — iterate all columns to handle sparse headers
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    for (let col = 1; col <= sheet.columnCount; col++) {
      const cell = headerRow.getCell(col);
      headers.push(String(cell.value ?? `column_${col}`));
    }

    // Remaining rows as objects — skip completely empty rows (rowCount may include phantom rows)
    const rows: Record<string, any>[] = [];
    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const obj: Record<string, any> = {};
      let hasValue = false;
      headers.forEach((header, idx) => {
        const cell = row.getCell(idx + 1);
        const value = this.normalizeCellValue(cell.value);
        obj[header] = value;
        if (value !== null) hasValue = true;
      });
      if (hasValue) rows.push(obj);
    }

    if (rows.length === 0) {
      throw new Error('Excel sheet is empty');
    }

    return { tableName, rows, headers };
  }

  /**
   * Normalize exceljs cell values to primitives.
   * ExcelJS returns rich objects for formatted text, hyperlinks, formulas, etc.
   */
  private normalizeCellValue(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const obj = value as Record<string, any>;
      if ('richText' in obj) return obj.richText.map((r: any) => r.text).join('');
      if ('text' in obj) return String(obj.text);
      if ('result' in obj) return obj.result ?? null;
      if ('error' in obj) return null;
    }
    return String(value);
  }

  /**
   * Detect column types and properties
   */
  private detectColumns(rows: Record<string, any>[], headers: string[]): DetectedColumn[] {
    return headers.map((header) => {
      const values = rows
        .map((row) => row[header])
        .filter((v) => v !== null && v !== undefined && v !== '');
      const nullCount = rows.length - values.length;
      const uniqueCount = new Set(values).size;

      // Sample up to 10 values
      const sampleValues = values.slice(0, 10);

      // Detect type
      const { type, confidence } = this.detectColumnType(values, header);

      // Determine if embeddable (text columns with meaningful content)
      const isEmbeddable = this.isEmbeddableColumn(header, type, values);

      // Determine if filterable (low cardinality or numeric)
      const isFilterable = this.isFilterableColumn(type, uniqueCount, rows.length);

      // Calculate avg length for strings
      const avgLength =
        type === 'string'
          ? values.reduce((sum, v) => sum + String(v).length, 0) / values.length
          : undefined;

      // Extract enum values if low cardinality
      const enumValues = type === 'enum' ? Array.from(new Set(values.map(String))) : undefined;

      return {
        name: header,
        type,
        nullable: nullCount > 0,
        confidence,
        sampleValues,
        uniqueCount,
        nullCount,
        isEmbeddable,
        isFilterable,
        avgLength,
        enumValues,
      };
    });
  }

  /**
   * Detect column type with confidence
   */
  private detectColumnType(
    values: any[],
    columnName?: string,
  ): { type: DetectedColumn['type']; confidence: number } {
    if (values.length === 0) {
      return { type: 'string', confidence: 0.5 };
    }

    // Count type matches
    let integerCount = 0;
    let numberCount = 0;
    let booleanCount = 0;
    let dateCount = 0;

    for (const value of values) {
      const str = String(value).trim();

      // Check integer
      if (/^-?\d+$/.test(str)) {
        integerCount++;
        continue;
      }

      // Check number (decimal)
      if (/^-?\d+\.\d+$/.test(str) || !isNaN(Number(str))) {
        numberCount++;
        continue;
      }

      // Check boolean
      if (/^(true|false|yes|no|0|1)$/i.test(str)) {
        booleanCount++;
        continue;
      }

      // Check date (ISO format or common patterns)
      if (this.isDateString(str)) {
        dateCount++;
        continue;
      }
    }

    const total = values.length;
    const threshold = 0.9; // 90% match required
    const uniqueCount = new Set(values).size;

    // Determine type by majority
    if (integerCount / total > threshold) {
      // ID columns should always be integer, never enum (even with low cardinality)
      const isIdColumn = columnName && (/^id$/i.test(columnName) || /_id$/i.test(columnName));

      // Check if it's actually an enum (low cardinality, not an ID, and < 50% unique)
      if (!isIdColumn && uniqueCount < 50 && uniqueCount / total < 0.5) {
        return { type: 'enum', confidence: integerCount / total };
      }
      return { type: 'integer', confidence: integerCount / total };
    }

    if ((integerCount + numberCount) / total > threshold) {
      return { type: 'number', confidence: (integerCount + numberCount) / total };
    }

    if (booleanCount / total > threshold) {
      return { type: 'boolean', confidence: booleanCount / total };
    }

    if (dateCount / total > threshold) {
      return { type: 'date', confidence: dateCount / total };
    }

    // Check for categorical/enum (low cardinality strings with high repetition)
    // Only mark as enum if: unique count < 50 AND less than 70% unique (showing repetition)
    if (uniqueCount < 50 && uniqueCount / total < 0.7) {
      return { type: 'enum', confidence: 0.8 };
    }

    // Default to string
    return { type: 'string', confidence: 0.9 };
  }

  /**
   * Check if string matches common date patterns
   */
  private isDateString(str: string): boolean {
    // ISO 8601 format
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return true;

    // Common formats: MM/DD/YYYY, DD-MM-YYYY, etc.
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(str)) return true;

    // Try parsing
    const date = new Date(str);
    return !isNaN(date.getTime());
  }

  /**
   * Determine if column should be embedded
   */
  private isEmbeddableColumn(name: string, type: string, values: any[]): boolean {
    // Only string/enum columns can be embedded
    if (type !== 'string' && type !== 'enum') return false;

    // Skip ID-like columns
    if (/^id$/i.test(name) || /_id$/i.test(name)) return false;

    // Description/comment/notes fields are always embeddable
    if (/description|comment|note|text|content|summary/i.test(name)) return true;

    // Skip very short text (< 10 chars avg)
    const avgLength = values.reduce((sum, v) => sum + String(v).length, 0) / values.length;
    if (avgLength < 10) return false;

    return true;
  }

  /**
   * Determine if column should be filterable
   */
  private isFilterableColumn(type: string, uniqueCount: number, totalRows: number): boolean {
    // Numeric columns are always filterable
    if (type === 'integer' || type === 'number' || type === 'date') return true;

    // Enum/boolean are filterable
    if (type === 'boolean' || type === 'enum') return true;

    // Low cardinality strings are filterable
    if (type === 'string' && uniqueCount < 100) return true;

    return false;
  }

  /**
   * Detect primary key
   */
  private detectPrimaryKey(rows: Record<string, any>[], columns: DetectedColumn[]): string | null {
    // Look for columns named 'id' or ending with '_id'
    const idColumns = columns.filter(
      (col) => /^id$/i.test(col.name) || /^[a-z]+_id$/i.test(col.name),
    );

    for (const col of idColumns) {
      // Check if unique
      const values = rows.map((row) => row[col.name]);
      const uniqueCount = new Set(values).size;
      if (uniqueCount === rows.length) {
        return col.name;
      }
    }

    return null;
  }

  /**
   * Detect foreign key relationships
   */
  private detectForeignKeys(
    rows: Record<string, any>[],
    columns: DetectedColumn[],
  ): DetectedForeignKey[] {
    const foreignKeys: DetectedForeignKey[] = [];

    // Detect by naming convention (e.g., 'user_id' references 'users.id')
    for (const col of columns) {
      const match = col.name.match(/^([a-z]+)_id$/i);
      if (match) {
        const targetTable = `${match[1]}s`; // Pluralize
        foreignKeys.push({
          sourceField: col.name,
          targetTable,
          targetField: 'id',
          confidence: 0.7,
          detectionMethod: 'naming_convention',
        });
      }
    }

    return foreignKeys;
  }

  /**
   * Calculate cost estimates
   */
  private calculateEstimates(rows: Record<string, any>[], columns: DetectedColumn[]) {
    // Estimate embedding tokens (embeddable columns only)
    const embeddableColumns = columns.filter((col) => col.isEmbeddable);
    let totalTokens = 0;

    for (const row of rows) {
      for (const col of embeddableColumns) {
        const value = String(row[col.name] || '');
        // Rough estimate: 1 token ≈ 4 characters
        totalTokens += Math.ceil(value.length / 4);
      }
    }

    // Embedding cost (text-embedding-3-small: $0.02 per 1M tokens)
    const embeddingCost = (totalTokens / 1_000_000) * 0.02;

    // Storage estimate (JSON serialization)
    const rowJson = JSON.stringify(rows);
    const storageBytes = Buffer.byteLength(rowJson, 'utf-8');

    // Chunk count (each row becomes 1+ chunks depending on embeddable content)
    const chunkCount = rows.length * embeddableColumns.length;

    // Processing time estimate (rough: 100 rows/second)
    const processingTimeSeconds = Math.ceil(rows.length / 100);

    return {
      embeddingTokens: totalTokens,
      embeddingCost: parseFloat(embeddingCost.toFixed(8)),
      storageBytes,
      chunkCount,
      processingTimeSeconds,
    };
  }

  /**
   * Assess schema quality
   */
  private assessQuality(columns: DetectedColumn[], rows: Record<string, any>[]) {
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Calculate overall confidence (average of column confidences)
    const overallConfidence =
      columns.reduce((sum, col) => sum + col.confidence, 0) / columns.length;

    // Check for low-confidence columns
    const lowConfidenceColumns = columns.filter((col) => col.confidence < 0.8);
    if (lowConfidenceColumns.length > 0) {
      warnings.push(
        `Low confidence type detection for: ${lowConfidenceColumns.map((c) => c.name).join(', ')}`,
      );
      recommendations.push('Review and correct column types before finalizing');
    }

    // Check for high null rate
    const highNullColumns = columns.filter((col) => col.nullCount / rows.length > 0.5);
    if (highNullColumns.length > 0) {
      warnings.push(`High null rate (>50%) in: ${highNullColumns.map((c) => c.name).join(', ')}`);
    }

    // Check for no embeddable columns
    const embeddableCount = columns.filter((col) => col.isEmbeddable).length;
    if (embeddableCount === 0) {
      warnings.push('No embeddable columns detected - semantic search may be limited');
      recommendations.push('Consider adding text descriptions or notes columns');
    }

    // Check for very wide tables
    if (columns.length > 50) {
      warnings.push('Large number of columns detected');
      recommendations.push('Consider splitting into multiple related tables');
    }

    return {
      overallConfidence: parseFloat(overallConfidence.toFixed(2)),
      warnings,
      recommendations,
    };
  }
}
