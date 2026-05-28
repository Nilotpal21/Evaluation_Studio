/**
 * Canonical Mapper Service
 *
 * Applies field mappings to transform source metadata into canonical fields.
 * Reads confirmed FieldMappings from the database and applies transforms
 * at ingestion time to materialize canonical metadata on document chunks.
 *
 * Transform types supported:
 * - direct:       Copy value as-is
 * - lowercase:    Convert string to lowercase
 * - split:        Split string by delimiter into array
 * - date_format:  Parse and reformat date (pass-through for now)
 * - rename_value: Lookup value in a rename map
 * - extract:      Regex extraction from string value
 * - coalesce:     Try multiple source paths, return first non-null
 * - compute:      Evaluate a simple expression (stub)
 */

import { getLazyModel } from '../../db/index.js';
import type { IFieldMapping, IFieldTransform } from '@agent-platform/database';

const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping'); // → abl_platform

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of applying canonical mappings to a source document's metadata.
 * Keys are canonical field names, values are the transformed values.
 */
export type CanonicalMetadata = Record<string, unknown>;

// =============================================================================
// SERVICE
// =============================================================================

export class CanonicalMapperService {
  /** In-memory cache of confirmed mappings keyed by connectorId */
  private cache: Map<string, IFieldMapping[]> = new Map();

  /**
   * Apply canonical field mappings to source metadata.
   *
   * Loads confirmed mappings for the given connectorId (cached after first load),
   * reads source values from the metadata, applies transforms, and returns
   * the resulting canonical metadata record.
   *
   * @param connectorId - The connector whose mappings to apply
   * @param sourceMetadata - The source document's raw metadata
   * @returns Canonical metadata record with transformed field values
   */
  async mapDocument(
    connectorId: string,
    sourceMetadata: Record<string, unknown>,
  ): Promise<CanonicalMetadata> {
    const mappings = await this.loadMappings(connectorId);
    const result: CanonicalMetadata = {};

    for (const mapping of mappings) {
      try {
        const value = this.applyTransform(mapping, sourceMetadata);
        if (value !== undefined && value !== null) {
          result[mapping.canonicalField] = value;
        }
      } catch (error) {
        // Log but do not fail the entire mapping for one field
        console.warn(
          `[canonical-mapper] Transform failed for field "${mapping.canonicalField}" ` +
            `(connector: ${connectorId}, source: ${mapping.sourcePath}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return result;
  }

  /**
   * Clear the in-memory mapping cache.
   * Call this when mappings are updated or confirmed to force a reload.
   *
   * @param connectorId - If provided, clear only that connector's cache.
   *                       If omitted, clear all cached mappings.
   */
  clearCache(connectorId?: string): void {
    if (connectorId) {
      this.cache.delete(connectorId);
    } else {
      this.cache.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Mapping loader
  // ---------------------------------------------------------------------------

  /**
   * Load confirmed field mappings for a connector, using the in-memory cache.
   */
  private async loadMappings(connectorId: string): Promise<IFieldMapping[]> {
    const cached = this.cache.get(connectorId);
    if (cached) {
      return cached;
    }

    const mappings = await FieldMapping.find({
      connectorId,
      status: 'confirmed',
    }).lean<IFieldMapping[]>();

    this.cache.set(connectorId, mappings);
    return mappings;
  }

  // ---------------------------------------------------------------------------
  // Transform dispatcher
  // ---------------------------------------------------------------------------

  /**
   * Read the source value and apply the configured transform.
   */
  private applyTransform(mapping: IFieldMapping, sourceMetadata: Record<string, unknown>): unknown {
    const transform = mapping.transform;
    const transformType = transform?.type ?? 'direct';

    switch (transformType) {
      case 'direct':
        return this.transformDirect(mapping.sourcePath, sourceMetadata);

      case 'lowercase':
        return this.transformLowercase(mapping.sourcePath, sourceMetadata);

      case 'split':
        return this.transformSplit(mapping.sourcePath, sourceMetadata, transform);

      case 'date_format':
        return this.transformDateFormat(mapping.sourcePath, sourceMetadata);

      case 'rename_value':
        return this.transformRenameValue(mapping.sourcePath, sourceMetadata, transform);

      case 'extract':
        return this.transformExtract(mapping.sourcePath, sourceMetadata, transform);

      case 'coalesce':
        return this.transformCoalesce(sourceMetadata, transform);

      case 'compute':
        return this.transformCompute(sourceMetadata, transform);

      default:
        console.warn(`[canonical-mapper] Unknown transform type: ${transformType}`);
        return this.transformDirect(mapping.sourcePath, sourceMetadata);
    }
  }

  // ---------------------------------------------------------------------------
  // Individual transforms
  // ---------------------------------------------------------------------------

  /**
   * Direct: copy value as-is from the source path.
   */
  private transformDirect(sourcePath: string, sourceMetadata: Record<string, unknown>): unknown {
    return this.getNestedValue(sourceMetadata, sourcePath);
  }

  /**
   * Lowercase: convert string value to lowercase.
   */
  private transformLowercase(sourcePath: string, sourceMetadata: Record<string, unknown>): unknown {
    const value = this.getNestedValue(sourceMetadata, sourcePath);
    if (typeof value === 'string') {
      return value.toLowerCase();
    }
    return value;
  }

  /**
   * Split: split a string value by the configured delimiter.
   */
  private transformSplit(
    sourcePath: string,
    sourceMetadata: Record<string, unknown>,
    transform: IFieldTransform,
  ): unknown {
    const value = this.getNestedValue(sourceMetadata, sourcePath);
    if (typeof value === 'string') {
      const delimiter = transform.delimiter ?? ',';
      return value.split(delimiter).map((s) => s.trim());
    }
    return value;
  }

  /**
   * Date format: parse and reformat a date value.
   * Currently a pass-through — full date reformatting can be added later
   * when source/target format configuration is finalized.
   */
  private transformDateFormat(
    sourcePath: string,
    sourceMetadata: Record<string, unknown>,
  ): unknown {
    const value = this.getNestedValue(sourceMetadata, sourcePath);
    if (typeof value === 'string') {
      // Attempt to parse and return as ISO string for normalization
      const parsed = Date.parse(value);
      if (!isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    return value;
  }

  /**
   * Rename value: lookup the source value in the configured valueMap.
   * Returns the original value if no mapping is found.
   */
  private transformRenameValue(
    sourcePath: string,
    sourceMetadata: Record<string, unknown>,
    transform: IFieldTransform,
  ): unknown {
    const value = this.getNestedValue(sourceMetadata, sourcePath);
    if (typeof value === 'string' && transform.valueMap) {
      return transform.valueMap[value] ?? value;
    }
    return value;
  }

  /**
   * Extract: apply a regex to the source value and return the first
   * capture group (or the full match if no groups).
   */
  private transformExtract(
    sourcePath: string,
    sourceMetadata: Record<string, unknown>,
    transform: IFieldTransform,
  ): unknown {
    const value = this.getNestedValue(sourceMetadata, sourcePath);
    if (typeof value === 'string' && transform.expression) {
      try {
        const regex = new RegExp(transform.expression);
        const match = value.match(regex);
        if (match) {
          // Return first capture group if available, otherwise full match
          return match[1] ?? match[0];
        }
      } catch {
        console.warn(`[canonical-mapper] Invalid regex expression: ${transform.expression}`);
      }
    }
    return value;
  }

  /**
   * Coalesce: try multiple source paths in order, return the first non-null value.
   */
  private transformCoalesce(
    sourceMetadata: Record<string, unknown>,
    transform: IFieldTransform,
  ): unknown {
    const sources = transform.sources ?? [];
    for (const path of sources) {
      const value = this.getNestedValue(sourceMetadata, path);
      if (value !== null && value !== undefined) {
        return value;
      }
    }
    return null;
  }

  /**
   * Compute: evaluate a computed expression.
   * This is a stub — full expression evaluation will be implemented
   * when the expression language is defined.
   */
  private transformCompute(
    _sourceMetadata: Record<string, unknown>,
    transform: IFieldTransform,
  ): unknown {
    console.warn(
      `[canonical-mapper] Compute transform is not yet implemented. ` +
        `Expression: ${transform.computeExpression ?? '(none)'}`,
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a nested value from an object using a dot-separated path.
   *
   * @example
   * getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c') // => 42
   * getNestedValue({ items: [1, 2] }, 'items.0')       // => 1
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }
}
