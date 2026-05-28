/**
 * Base Schema Discovery Service
 *
 * Abstract base class for connector-specific schema discovery implementations.
 * Provides common field analysis, type detection, and schema creation patterns.
 */

import type {
  IConnectorSchema,
  IConnectorSchemaField,
  IFieldMapping,
} from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('schema-discovery');
const ConnectorSchema = getLazyModel<IConnectorSchema>('ConnectorSchema');
const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  fields: IConnectorSchemaField[];
  fieldCount: number;
  customFieldCount: number;
}

export interface FieldTypeInfo {
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'unknown';
  confidence: number;
}

export interface SchemaChangeDetails {
  hasChanges: boolean;
  addedFields: string[];
  removedFields: string[];
  typeChanges: Array<{ path: string; oldType: string; newType: string }>;
  totalChanges: number;
}

// ─── Base Discovery Service ──────────────────────────────────────────────────

export abstract class BaseSchemaDiscoveryService {
  protected connectorType: string;

  constructor(connectorType: string) {
    this.connectorType = connectorType;
  }

  /**
   * Discover schema from connector.
   * Must be implemented by subclasses.
   *
   * @param connectorId - Connector ID
   * @param tenantId - Tenant ID for isolation
   * @param credentials - Connector credentials (API keys, tokens, etc.)
   * @returns Discovered fields
   */
  abstract discover(
    connectorId: string,
    tenantId: string,
    credentials: Record<string, unknown>,
  ): Promise<DiscoveryResult>;

  /**
   * Create or update ConnectorSchema document.
   *
   * @param connectorId - Connector ID
   * @param tenantId - Tenant ID
   * @param discoveryResult - Discovered fields
   * @returns Created/updated schema document
   */
  async saveSchema(
    connectorId: string,
    tenantId: string,
    discoveryResult: DiscoveryResult,
  ): Promise<IConnectorSchema> {
    // Check for existing schema
    const existingSchema = await ConnectorSchema.findOne({
      connectorId,
      tenantId,
    })
      .sort({ version: -1 })
      .lean();

    let version = 1;
    let status = 'active';

    if (existingSchema) {
      // Compare with existing schema to detect changes
      const changeDetails = this.detectSchemaChanges(existingSchema.fields, discoveryResult.fields);

      if (!changeDetails.hasChanges) {
        logger.info('No schema changes detected', { connectorId, tenantId });
        return existingSchema as IConnectorSchema;
      }

      // Create new version if changes detected
      version = existingSchema.version + 1;
      status = 'active';

      // Mark old version as superseded
      await ConnectorSchema.findOneAndUpdate(
        { _id: existingSchema._id, tenantId },
        { $set: { status: 'superseded' } },
      );

      logger.info('Schema changes detected, creating new version', {
        connectorId,
        tenantId,
        oldVersion: existingSchema.version,
        newVersion: version,
        changes: {
          added: changeDetails.addedFields.length,
          removed: changeDetails.removedFields.length,
          typeChanges: changeDetails.typeChanges.length,
        },
      });

      // Handle field mapping updates for changed fields
      await this.handleSchemaChange(connectorId, tenantId, changeDetails);
    }

    // Create new schema document
    const schema = await ConnectorSchema.create({
      tenantId,
      connectorId,
      version,
      fields: discoveryResult.fields,
      fieldCount: discoveryResult.fieldCount,
      customFieldCount: discoveryResult.customFieldCount,
      status,
      discoveredAt: new Date(),
    });

    logger.info('Schema saved', {
      connectorId,
      tenantId,
      version,
      fieldCount: discoveryResult.fieldCount,
      customFieldCount: discoveryResult.customFieldCount,
    });

    return schema;
  }

  // ─── Helper Methods ──────────────────────────────────────────────────────

  /**
   * Detect field type from sample values.
   *
   * @param sampleValues - Array of sample values
   * @returns Type info with confidence score
   */
  protected detectFieldType(sampleValues: unknown[]): FieldTypeInfo {
    if (!sampleValues || sampleValues.length === 0) {
      return { type: 'unknown', confidence: 0 };
    }

    const types = new Map<string, number>();

    for (const value of sampleValues) {
      if (value === null || value === undefined) {
        continue;
      }

      const detectedType = this.detectValueType(value);
      types.set(detectedType, (types.get(detectedType) || 0) + 1);
    }

    if (types.size === 0) {
      return { type: 'unknown', confidence: 0 };
    }

    // Find most common type
    let maxType = 'unknown';
    let maxCount = 0;

    for (const [type, count] of types.entries()) {
      if (count > maxCount) {
        maxType = type;
        maxCount = count;
      }
    }

    const confidence = maxCount / sampleValues.length;

    return {
      type: maxType as FieldTypeInfo['type'],
      confidence,
    };
  }

  /**
   * Detect type of a single value.
   *
   * @param value - Value to analyze
   * @returns Type string
   */
  private detectValueType(value: unknown): string {
    if (typeof value === 'string') {
      // Check if it's a date string
      if (this.isDateString(value)) {
        return 'date';
      }
      return 'string';
    }

    if (typeof value === 'number') {
      return 'number';
    }

    if (typeof value === 'boolean') {
      return 'boolean';
    }

    if (Array.isArray(value)) {
      return 'array';
    }

    if (typeof value === 'object' && value !== null) {
      return 'object';
    }

    return 'unknown';
  }

  /**
   * Check if string is a date.
   *
   * @param value - String to check
   * @returns True if date string
   */
  private isDateString(value: string): boolean {
    // ISO 8601 format
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const date = new Date(value);
      return !isNaN(date.getTime());
    }
    return false;
  }

  /**
   * Extract nested field paths from object.
   *
   * @param obj - Object to analyze
   * @param prefix - Path prefix
   * @param maxDepth - Maximum nesting depth (default: 3)
   * @returns Array of field paths
   */
  protected extractFieldPaths(obj: Record<string, unknown>, prefix = '', maxDepth = 3): string[] {
    if (maxDepth === 0) {
      return [];
    }

    const paths: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);

      // Recurse into nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nestedPaths = this.extractFieldPaths(
          value as Record<string, unknown>,
          path,
          maxDepth - 1,
        );
        paths.push(...nestedPaths);
      }
    }

    return paths;
  }

  /**
   * Calculate field frequency across samples.
   *
   * @param samples - Array of sample objects
   * @returns Map of field path to frequency (0.0-1.0)
   */
  protected calculateFieldFrequency(samples: Record<string, unknown>[]): Map<string, number> {
    if (samples.length === 0) {
      return new Map();
    }

    const fieldCounts = new Map<string, number>();

    for (const sample of samples) {
      const paths = this.extractFieldPaths(sample);
      for (const path of paths) {
        fieldCounts.set(path, (fieldCounts.get(path) || 0) + 1);
      }
    }

    // Convert counts to frequencies
    const frequencies = new Map<string, number>();
    for (const [path, count] of fieldCounts.entries()) {
      frequencies.set(path, count / samples.length);
    }

    return frequencies;
  }

  /**
   * Collect sample values for a field path across samples.
   *
   * @param samples - Array of sample objects
   * @param fieldPath - Dot-notation field path
   * @param maxSamples - Maximum samples to collect (default: 5)
   * @returns Array of sample values
   */
  protected collectSampleValues(
    samples: Record<string, unknown>[],
    fieldPath: string,
    maxSamples = 5,
  ): unknown[] {
    const values: unknown[] = [];

    for (const sample of samples) {
      if (values.length >= maxSamples) {
        break;
      }

      const value = this.getNestedValue(sample, fieldPath);
      if (value !== undefined && value !== null) {
        values.push(value);
      }
    }

    return values;
  }

  /**
   * Get nested value using dot-notation path.
   *
   * @param obj - Object to query
   * @param path - Dot-notation path
   * @returns Value or undefined
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: any = obj;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Detect schema changes between old and new fields.
   *
   * @param oldFields - Existing schema fields
   * @param newFields - Newly discovered fields
   * @returns Detailed change information
   */
  protected detectSchemaChanges(
    oldFields: IConnectorSchemaField[],
    newFields: IConnectorSchemaField[],
  ): SchemaChangeDetails {
    const addedFields: string[] = [];
    const removedFields: string[] = [];
    const typeChanges: Array<{ path: string; oldType: string; newType: string }> = [];

    // Build maps for comparison
    const oldMap = new Map<string, IConnectorSchemaField>();
    for (const field of oldFields) {
      oldMap.set(field.path, field);
    }

    const newMap = new Map<string, IConnectorSchemaField>();
    for (const field of newFields) {
      newMap.set(field.path, field);
    }

    // Check for new fields and type changes
    for (const newField of newFields) {
      const oldField = oldMap.get(newField.path);

      if (!oldField) {
        addedFields.push(newField.path);
      } else if (oldField.type !== newField.type) {
        typeChanges.push({
          path: newField.path,
          oldType: oldField.type,
          newType: newField.type,
        });
      }
    }

    // Check for removed fields
    for (const oldField of oldFields) {
      if (!newMap.has(oldField.path)) {
        removedFields.push(oldField.path);
      }
    }

    const totalChanges = addedFields.length + removedFields.length + typeChanges.length;

    return {
      hasChanges: totalChanges > 0,
      addedFields,
      removedFields,
      typeChanges,
      totalChanges,
    };
  }

  /**
   * Handle schema changes by marking affected field mappings for review.
   *
   * @param connectorId - Connector ID
   * @param tenantId - Tenant ID
   * @param changes - Schema change details
   */
  protected async handleSchemaChange(
    connectorId: string,
    tenantId: string,
    changes: SchemaChangeDetails,
  ): Promise<void> {
    // Collect all affected source paths (removed fields + type changes)
    const affectedPaths = new Set<string>([
      ...changes.removedFields,
      ...changes.typeChanges.map((c) => c.path),
    ]);

    if (affectedPaths.size === 0) {
      return;
    }

    // Mark affected field mappings as needs_review
    const result = await FieldMapping.updateMany(
      {
        tenantId,
        connectorId,
        sourcePath: { $in: Array.from(affectedPaths) },
        status: { $in: ['suggested', 'confirmed'] },
      },
      {
        $set: { status: 'needs_review' },
      },
    );

    logger.info('Marked field mappings for review due to schema changes', {
      connectorId,
      tenantId,
      affectedPaths: Array.from(affectedPaths),
      updatedCount: result.modifiedCount,
    });
  }
}
