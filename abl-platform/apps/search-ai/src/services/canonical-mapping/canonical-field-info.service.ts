/**
 * Canonical Field Info Service
 *
 * Internal service for querying canonical field mapping information.
 * Joins CanonicalSchema (aliases) with FieldMapping (connector mappings)
 * to provide a unified view of how fields are mapped across connectors.
 *
 * Used by:
 * - Ingestion pipeline (to know what fields to map)
 * - Vocabulary generation (to auto-create terms from canonical fields)
 * - Discovery API (to expose filterable fields with alias names)
 * - Admin UI (to show mapping status per connector)
 */

import {
  CanonicalSchema,
  type ICanonicalField,
  FieldMapping,
} from '@agent-platform/database/models';
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('canonical-field-info');

// ─── Types ───────────────────────────────────────────────────────────────

export interface CanonicalFieldMappingInfo {
  connectorId: string;
  mappings: Array<{
    /** Source field path in the connector (e.g., "fields.priority.name") */
    sourcePath: string;
    /** OpenSearch field name (e.g., "priority", "custom_string_1") */
    canonicalField: string;
    /** Alias name from CanonicalSchema (e.g., "priority_level") */
    alias: string | null;
    /** Display label (e.g., "Priority Level") */
    label: string | null;
    /** Data type */
    type: string;
    /** Transform applied during ingestion */
    transform: { type: string; [key: string]: unknown };
    /** Mapping confidence score */
    confidence: number;
    /** Mapping status */
    status: string;
  }>;
}

export interface SlotAvailability {
  string: { total: number; used: number; available: number };
  number: { total: number; used: number; available: number };
  date: { total: number; used: number; available: number };
  boolean: { total: number; used: number; available: number };
}

// ─── Constants ────────────────────────────────────────────────────────────

const CUSTOM_SLOT_LIMITS = {
  string: 20,
  number: 10,
  date: 5,
  boolean: 5,
};

const CUSTOM_SLOT_PREFIXES: Record<string, string> = {
  string: 'custom_string_',
  number: 'custom_number_',
  date: 'custom_date_',
  boolean: 'custom_bool_',
};

// ─── Service ──────────────────────────────────────────────────────────────

export class CanonicalFieldInfoService {
  private schemaCache: LRUCache<string, ICanonicalField[]>;

  constructor() {
    this.schemaCache = new LRUCache<string, ICanonicalField[]>({
      max: 200,
      ttl: 1000 * 60 * 5, // 5 minutes
    });
  }

  /**
   * Get all field mappings for a KB, joined with alias info from CanonicalSchema.
   * Optionally filter to a single connector.
   */
  async getFieldMappings(
    knowledgeBaseId: string,
    tenantId: string,
    connectorId?: string,
  ): Promise<CanonicalFieldMappingInfo[]> {
    // Load canonical schema for alias lookup
    const fields = await this.loadSchema(knowledgeBaseId, tenantId);
    const aliasMap = new Map<string, ICanonicalField>();
    for (const f of fields) {
      aliasMap.set(f.storageField, f);
    }

    // Load active field mappings
    const schema = await CanonicalSchema.findOne({
      knowledgeBaseId,
      tenantId,
      status: 'active',
    })
      .sort({ version: -1 })
      .lean();

    if (!schema) return [];

    const filter: Record<string, unknown> = {
      canonicalSchemaId: schema._id,
      tenantId,
    };
    if (connectorId) {
      filter.connectorId = connectorId;
    }

    const mappings = await FieldMapping.find(filter).lean();

    // Group by connector
    const grouped = new Map<string, CanonicalFieldMappingInfo>();

    for (const m of mappings) {
      const cid = m.connectorId as string;
      if (!grouped.has(cid)) {
        grouped.set(cid, { connectorId: cid, mappings: [] });
      }

      const alias = aliasMap.get(m.canonicalField as string);

      grouped.get(cid)!.mappings.push({
        sourcePath: m.sourcePath as string,
        canonicalField: m.canonicalField as string,
        alias: alias?.name ?? null,
        label: alias?.label ?? null,
        type: alias?.type ?? 'string',
        transform: (m.transform as any) ?? { type: 'direct' },
        confidence: (m.confidence as number) ?? 0,
        status: (m.status as string) ?? 'suggested',
      });
    }

    return Array.from(grouped.values());
  }

  /**
   * Get available custom slot counts for a KB.
   */
  async getAvailableSlots(knowledgeBaseId: string, tenantId: string): Promise<SlotAvailability> {
    const fields = await this.loadSchema(knowledgeBaseId, tenantId);

    const used = { string: 0, number: 0, date: 0, boolean: 0 };

    for (const f of fields) {
      const field = f.storageField;
      if (field.startsWith(CUSTOM_SLOT_PREFIXES.string)) used.string++;
      else if (field.startsWith(CUSTOM_SLOT_PREFIXES.number)) used.number++;
      else if (field.startsWith(CUSTOM_SLOT_PREFIXES.date)) used.date++;
      else if (field.startsWith(CUSTOM_SLOT_PREFIXES.boolean)) used.boolean++;
    }

    return {
      string: {
        total: CUSTOM_SLOT_LIMITS.string,
        used: used.string,
        available: CUSTOM_SLOT_LIMITS.string - used.string,
      },
      number: {
        total: CUSTOM_SLOT_LIMITS.number,
        used: used.number,
        available: CUSTOM_SLOT_LIMITS.number - used.number,
      },
      date: {
        total: CUSTOM_SLOT_LIMITS.date,
        used: used.date,
        available: CUSTOM_SLOT_LIMITS.date - used.date,
      },
      boolean: {
        total: CUSTOM_SLOT_LIMITS.boolean,
        used: used.boolean,
        available: CUSTOM_SLOT_LIMITS.boolean - used.boolean,
      },
    };
  }

  /**
   * Allocate the next available custom slot for a given type.
   * Returns the storage field name (e.g., "custom_string_3") or null if exhausted.
   */
  async allocateSlot(
    knowledgeBaseId: string,
    tenantId: string,
    fieldType: 'string' | 'number' | 'date' | 'boolean',
  ): Promise<string | null> {
    const fields = await this.loadSchema(knowledgeBaseId, tenantId);
    const prefix = CUSTOM_SLOT_PREFIXES[fieldType];
    const limit = CUSTOM_SLOT_LIMITS[fieldType];

    const usedSlots = new Set<number>();
    for (const f of fields) {
      if (f.storageField.startsWith(prefix)) {
        const num = parseInt(f.storageField.slice(prefix.length), 10);
        if (!isNaN(num)) usedSlots.add(num);
      }
    }

    for (let i = 1; i <= limit; i++) {
      if (!usedSlots.has(i)) {
        return `${prefix}${i}`;
      }
    }

    logger.warn('Custom slot exhaustion', { knowledgeBaseId, fieldType, limit });
    return null;
  }

  /**
   * Invalidate cached schema for a KB.
   */
  invalidateCache(knowledgeBaseId: string, tenantId: string): void {
    this.schemaCache.delete(`${tenantId}:${knowledgeBaseId}`);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async loadSchema(knowledgeBaseId: string, tenantId: string): Promise<ICanonicalField[]> {
    const cacheKey = `${tenantId}:${knowledgeBaseId}`;
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    const doc = await CanonicalSchema.findOne({
      knowledgeBaseId,
      tenantId,
      status: 'active',
    })
      .sort({ version: -1 })
      .lean();

    const fields = (doc?.fields as ICanonicalField[]) ?? [];
    this.schemaCache.set(cacheKey, fields);
    return fields;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: CanonicalFieldInfoService | null = null;

export function getCanonicalFieldInfoService(): CanonicalFieldInfoService {
  if (!instance) {
    instance = new CanonicalFieldInfoService();
  }
  return instance;
}
