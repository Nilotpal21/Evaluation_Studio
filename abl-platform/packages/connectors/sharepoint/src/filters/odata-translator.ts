/**
 * OData Translator
 *
 * Translates structured filter conditions to OData $filter query strings
 * for Microsoft Graph API server-side filtering.
 *
 * Not all fields support OData filtering. The translator classifies each
 * condition as 'api' (translatable to OData) or 'post-fetch' (must be
 * evaluated client-side after fetching).
 */

import type { FilterCondition, AdvancedFilterConfig } from '@agent-platform/connectors-base';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TranslationResult {
  /** OData $filter string for Graph API (may be empty if no conditions translate) */
  odataFilter: string;
  /** Conditions that could not be translated and must be evaluated post-fetch */
  postFetchConditions: FilterCondition[];
  /** Whether any conditions were successfully translated to OData */
  hasOdataFilter: boolean;
}

// ─── OData-Compatible Fields ────────────────────────────────────────────

/**
 * Fields that support OData $filter in Microsoft Graph API.
 * Maps our field names to Graph API field names.
 */
const ODATA_FIELD_MAP: Record<string, string> = {
  // DriveItem fields (documents/files)
  name: 'name',
  modifiedAt: 'lastModifiedDateTime',
  createdAt: 'createdDateTime',
  sizeBytes: 'size',
  contentType: 'file/mimeType',

  // Common metadata aliases
  lastModifiedDateTime: 'lastModifiedDateTime',
  createdDateTime: 'createdDateTime',
  size: 'size',

  // Pages (SharePoint pages API)
  title: 'title',
  'metadata.sharepoint.createdBy': 'createdBy/user/displayName',
  'metadata.sharepoint.lastModifiedBy': 'lastModifiedBy/user/displayName',
};

/**
 * Operators that translate to OData.
 */
const ODATA_OPERATOR_MAP: Record<string, string> = {
  eq: 'eq',
  ne: 'ne',
  gt: 'gt',
  lt: 'lt',
  ge: 'ge',
  le: 'le',
  contains: 'contains',
  startsWith: 'startswith',
};

// ─── Translator ─────────────────────────────────────────────────────────

export class ODataTranslator {
  /**
   * Translate advanced filter conditions to OData $filter string.
   *
   * Returns both the OData string for API-level filtering and any conditions
   * that must be applied post-fetch.
   */
  translate(config: AdvancedFilterConfig): TranslationResult {
    if (!config.enabled) {
      return { odataFilter: '', postFetchConditions: [], hasOdataFilter: false };
    }

    const odataParts: string[] = [];
    const postFetchConditions: FilterCondition[] = [];

    // Translate top-level conditions
    for (const condition of config.conditions) {
      const translated = this.translateCondition(condition);
      if (translated) {
        odataParts.push(translated);
      } else {
        postFetchConditions.push(condition);
      }
    }

    // Translate groups
    for (const group of config.groups) {
      const groupParts: string[] = [];
      const groupPostFetch: FilterCondition[] = [];

      for (const condition of group.conditions) {
        const translated = this.translateCondition(condition);
        if (translated) {
          groupParts.push(translated);
        } else {
          groupPostFetch.push(condition);
        }
      }

      // If all conditions in a group translate, wrap in parentheses
      if (groupParts.length > 0 && groupPostFetch.length === 0) {
        const groupOp = group.operator.toLowerCase();
        odataParts.push(`(${groupParts.join(` ${groupOp} `)})`);
      } else {
        // Mixed group — can't partially translate, move all to post-fetch
        postFetchConditions.push(...group.conditions);
      }
    }

    const rootOp = config.rootOperator.toLowerCase();
    const odataFilter = odataParts.join(` ${rootOp} `);

    return {
      odataFilter,
      postFetchConditions,
      hasOdataFilter: odataParts.length > 0,
    };
  }

  /**
   * Generate OData $filter for standard date conditions.
   * Used by sync coordinators to add date filtering to Graph API calls.
   */
  translateDateFilters(modifiedAfter?: Date | null, modifiedBefore?: Date | null): string {
    const parts: string[] = [];

    if (modifiedAfter) {
      parts.push(`lastModifiedDateTime ge ${modifiedAfter.toISOString()}`);
    }
    if (modifiedBefore) {
      parts.push(`lastModifiedDateTime le ${modifiedBefore.toISOString()}`);
    }

    return parts.join(' and ');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /**
   * Translate a single condition to OData syntax.
   * Returns null if the condition can't be translated.
   */
  private translateCondition(condition: FilterCondition): string | null {
    // Check if field is OData-compatible
    const odataField = ODATA_FIELD_MAP[condition.field];
    if (!odataField) {
      return null; // Field not supported in OData
    }

    // Check if operator is OData-compatible
    const odataOp = ODATA_OPERATOR_MAP[condition.operator];
    if (!odataOp) {
      return null; // Operator not supported in OData
    }

    // Format value based on type
    const formattedValue = this.formatODataValue(condition.value);
    if (formattedValue === null) {
      return null; // Can't format value for OData
    }

    // 'contains' and 'startsWith' use function syntax in OData
    if (condition.operator === 'contains') {
      return `contains(${odataField},${formattedValue})`;
    }
    if (condition.operator === 'startsWith') {
      return `startswith(${odataField},${formattedValue})`;
    }

    return `${odataField} ${odataOp} ${formattedValue}`;
  }

  /**
   * Format a value for OData query syntax.
   */
  private formatODataValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return 'null';
    }

    if (typeof value === 'string') {
      // Check if it looks like a date
      const dateMs = Date.parse(value);
      if (!isNaN(dateMs) && /^\d{4}-\d{2}/.test(value)) {
        return new Date(dateMs).toISOString();
      }
      // String value — wrap in single quotes and escape
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === 'number') {
      return String(value);
    }

    if (typeof value === 'boolean') {
      return String(value);
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return null; // Can't format complex types
  }
}
