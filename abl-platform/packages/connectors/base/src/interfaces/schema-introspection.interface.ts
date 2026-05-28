/**
 * Schema Introspection Interface
 *
 * Connector-agnostic types for introspecting source system schemas
 * via API (without fetching documents). Each connector that supports
 * pre-sync field discovery implements this interface.
 *
 * Example APIs:
 *   Jira:        GET /rest/api/3/field
 *   SharePoint:  GET /sites/{id}/lists/{id}/columns
 *   Salesforce:  GET /services/data/v58.0/sobjects/{obj}/describe
 *   HubSpot:     GET /crm/v3/properties/{objectType}
 *   ServiceNow:  GET /api/now/table/{table}/columns
 */

// ─── Introspected Field ────────────────────────────────────────────────

export interface IntrospectedField {
  /** Field path in the source system (e.g., "fields.summary", "Title") */
  path: string;
  /** Human-readable label */
  label: string;
  /** Field data type */
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  /** Whether the field is required in the source system */
  required: boolean;
  /** Whether this is a custom field (not system-defined) */
  isCustom: boolean;
  /** Known enum values (for dropdowns, status fields, etc.) */
  enumValues?: string[];
  /** Sample values (if the API returns them) */
  sampleValues?: string[];
  /** Additional connector-specific metadata */
  metadata?: Record<string, unknown>;
}

// ─── Schema Introspection Interface ────────────────────────────────────

export interface ISchemaIntrospection {
  /** Connector type this introspection handles */
  readonly connectorType: string;

  /**
   * Introspect the source system's schema via API (no document fetching).
   * Returns the available fields, their types, and any metadata.
   * This is a lightweight call — should complete in < 10 seconds.
   */
  introspectSchema(): Promise<IntrospectedField[]>;
}
