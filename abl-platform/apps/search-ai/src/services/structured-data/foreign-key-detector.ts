/**
 * Foreign Key Detection Service
 *
 * Detects foreign key relationships between tables using multiple strategies:
 * 1. Naming convention (user_id → users.id)
 * 2. Value validation (check if FK values exist in referenced table)
 * 3. Cardinality analysis (many-to-one relationship pattern)
 * 4. Column type matching (FK type matches PK type)
 */

import type { DetectedColumn, DetectedForeignKey } from './ingestion-types.js';
import type { TableMetadata } from './types.js';

export interface ForeignKeyValidationResult extends DetectedForeignKey {
  valid: boolean;
  validationDetails: {
    totalReferences: number; // How many FK values exist
    validReferences: number; // How many FK values found in target table
    invalidReferences: number; // How many FK values NOT found
    nullReferences: number; // How many FK values are NULL
    matchRate: number; // validReferences / (totalReferences - nullReferences)
  };
}

export interface ForeignKeyDetectionConfig {
  /** Minimum match rate to consider FK valid (default: 0.9 = 90%) */
  minMatchRate: number;
  /** Maximum samples to check for validation (default: 1000) */
  maxSamples: number;
  /** Validate FK values against target table (default: true) */
  validateValues: boolean;
}

const DEFAULT_CONFIG: ForeignKeyDetectionConfig = {
  minMatchRate: 0.9,
  maxSamples: 1000,
  validateValues: true,
};

export class ForeignKeyDetector {
  /**
   * Detect foreign keys within a single table's data
   * (Without access to other tables - naming convention only)
   */
  detectForeignKeysLocal(
    rows: Record<string, any>[],
    columns: DetectedColumn[],
  ): DetectedForeignKey[] {
    const foreignKeys: DetectedForeignKey[] = [];

    for (const col of columns) {
      // Strategy 1: Naming convention (e.g., 'user_id', 'customer_id', 'order_id')
      const match = col.name.match(/^([a-z_]+)_id$/i);
      if (match && col.type === 'integer') {
        const baseName = match[1];
        const targetTable = this.pluralize(baseName);

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
   * Detect and validate foreign keys across multiple tables
   * (With access to referenced tables for value validation)
   */
  async detectAndValidateForeignKeys(
    sourceRows: Record<string, any>[],
    sourceColumns: DetectedColumn[],
    availableTables: TableMetadata[],
    config?: Partial<ForeignKeyDetectionConfig>,
  ): Promise<ForeignKeyValidationResult[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const results: ForeignKeyValidationResult[] = [];

    // Build table name → metadata map
    const tableMap = new Map<string, TableMetadata>();
    for (const table of availableTables) {
      tableMap.set(table.table_name.toLowerCase(), table);
    }

    for (const col of sourceColumns) {
      // Strategy 1: Naming convention (user_id → users)
      const namingMatch = col.name.match(/^([a-z_]+)_id$/i);
      if (namingMatch && col.type === 'integer') {
        const baseName = namingMatch[1];
        const targetTableName = this.pluralize(baseName).toLowerCase();
        const targetTable = tableMap.get(targetTableName);

        if (targetTable) {
          // Validate FK values against target table
          const validation = await this.validateForeignKey(
            sourceRows,
            col.name,
            targetTable,
            'id',
            cfg,
          );

          if (validation.matchRate >= cfg.minMatchRate) {
            results.push({
              sourceField: col.name,
              targetTable: targetTable.table_name,
              targetField: 'id',
              confidence: this.calculateConfidence(validation),
              detectionMethod: 'naming_convention + validation',
              valid: true,
              validationDetails: validation,
            });
          } else {
            // Still report but mark as invalid
            results.push({
              sourceField: col.name,
              targetTable: targetTable.table_name,
              targetField: 'id',
              confidence: 0.3,
              detectionMethod: 'naming_convention (validation failed)',
              valid: false,
              validationDetails: validation,
            });
          }
        }
      }

      // Strategy 2: Type + cardinality matching (find columns with same type in other tables)
      if (cfg.validateValues && col.type === 'integer' && !namingMatch) {
        const candidateFK = await this.detectByTypeAndCardinality(
          sourceRows,
          col,
          availableTables,
          cfg,
        );
        if (candidateFK) {
          results.push(candidateFK);
        }
      }
    }

    return results;
  }

  /**
   * Validate FK values exist in referenced table
   */
  private async validateForeignKey(
    sourceRows: Record<string, any>[],
    sourceField: string,
    targetTable: TableMetadata,
    targetField: string,
    config: ForeignKeyDetectionConfig,
  ): Promise<ForeignKeyValidationResult['validationDetails']> {
    // Get FK values from source (sample if too many)
    const allFKValues = sourceRows.map((row) => row[sourceField]);
    const fkValues =
      allFKValues.length > config.maxSamples
        ? this.sample(allFKValues, config.maxSamples)
        : allFKValues;

    // Count NULLs
    const nullCount = fkValues.filter((v) => v === null || v === undefined || v === '').length;
    const nonNullFKValues = fkValues.filter((v) => v !== null && v !== undefined && v !== '');

    // Parse target table's sample rows to get PK values
    const targetSampleRows = JSON.parse(targetTable.sample_rows) as Record<string, any>[];
    const targetPKValues = new Set(targetSampleRows.map((row) => row[targetField]));

    // Note: We're only validating against sample rows here.
    // For full validation, would need to query ClickHouse for all target PKs.
    // This is a heuristic approach suitable for schema analysis phase.

    let validCount = 0;
    for (const fkValue of nonNullFKValues) {
      if (targetPKValues.has(fkValue)) {
        validCount++;
      }
    }

    const invalidCount = nonNullFKValues.length - validCount;
    const matchRate = nonNullFKValues.length > 0 ? validCount / nonNullFKValues.length : 0;

    return {
      totalReferences: fkValues.length,
      validReferences: validCount,
      invalidReferences: invalidCount,
      nullReferences: nullCount,
      matchRate,
    };
  }

  /**
   * Detect FK by type matching and cardinality analysis
   */
  private async detectByTypeAndCardinality(
    sourceRows: Record<string, any>[],
    sourceColumn: DetectedColumn,
    availableTables: TableMetadata[],
    config: ForeignKeyDetectionConfig,
  ): Promise<ForeignKeyValidationResult | null> {
    // Only consider integer columns
    if (sourceColumn.type !== 'integer') return null;

    // Get unique values in source column
    const sourceValues = sourceRows.map((row) => row[sourceColumn.name]);
    const uniqueSourceValues = new Set(sourceValues.filter((v) => v !== null && v !== undefined));

    // Check cardinality: FK should have lower cardinality than total rows (many-to-one)
    const cardinalityRatio = uniqueSourceValues.size / sourceRows.length;
    if (cardinalityRatio > 0.5) return null; // Too high cardinality for FK

    // Look for matching PK in other tables
    for (const targetTable of availableTables) {
      const targetPK = targetTable.primary_key;
      if (!targetPK) continue;

      const targetSampleRows = JSON.parse(targetTable.sample_rows) as Record<string, any>[];
      const targetPKValues = new Set(targetSampleRows.map((row) => row[targetPK]));

      // Check type compatibility
      const targetPKType = this.inferType(targetSampleRows[0]?.[targetPK]);
      if (targetPKType !== sourceColumn.type) continue;

      // Calculate overlap
      let matchCount = 0;
      for (const sourceValue of uniqueSourceValues) {
        if (targetPKValues.has(sourceValue)) {
          matchCount++;
        }
      }

      const matchRate = uniqueSourceValues.size > 0 ? matchCount / uniqueSourceValues.size : 0;

      if (matchRate >= config.minMatchRate) {
        const validation = await this.validateForeignKey(
          sourceRows,
          sourceColumn.name,
          targetTable,
          targetPK,
          config,
        );

        return {
          sourceField: sourceColumn.name,
          targetTable: targetTable.table_name,
          targetField: targetPK,
          confidence: this.calculateConfidence(validation),
          detectionMethod: 'type_and_cardinality',
          valid: true,
          validationDetails: validation,
        };
      }
    }

    return null;
  }

  /**
   * Calculate confidence score based on validation details
   */
  private calculateConfidence(validation: ForeignKeyValidationResult['validationDetails']): number {
    // Base confidence on match rate
    const baseConfidence = validation.matchRate;

    // Penalize if too many NULLs (> 50% NULL is suspicious)
    const nullRatio = validation.nullReferences / validation.totalReferences;
    const nullPenalty = nullRatio > 0.5 ? 0.2 : 0;

    // Penalize if too few valid references (< 10 references is low confidence)
    const countBonus = validation.validReferences > 10 ? 0.1 : 0;

    const confidence = Math.min(baseConfidence - nullPenalty + countBonus, 1.0);
    return Math.max(confidence, 0.1);
  }

  /**
   * Simple pluralization (for naming convention detection)
   */
  private pluralize(word: string): string {
    const lower = word.toLowerCase();

    // Irregular plurals
    const irregulars: Record<string, string> = {
      person: 'people',
      child: 'children',
      man: 'men',
      woman: 'women',
    };

    if (irregulars[lower]) {
      return irregulars[lower];
    }

    // Regular plurals
    if (lower.endsWith('y')) {
      return lower.slice(0, -1) + 'ies'; // category → categories
    } else if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('ch')) {
      return lower + 'es'; // address → addresses
    } else {
      return lower + 's'; // user → users
    }
  }

  /**
   * Infer basic type from a sample value
   */
  private inferType(value: any): string {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    } else if (typeof value === 'boolean') {
      return 'boolean';
    } else {
      return 'string';
    }
  }

  /**
   * Random sample from array
   */
  private sample<T>(arr: T[], count: number): T[] {
    if (arr.length <= count) return arr;

    const sampled: T[] = [];
    const indices = new Set<number>();

    while (sampled.length < count) {
      const index = Math.floor(Math.random() * arr.length);
      if (!indices.has(index)) {
        indices.add(index);
        sampled.push(arr[index]);
      }
    }

    return sampled;
  }
}
