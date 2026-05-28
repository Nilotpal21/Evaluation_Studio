/**
 * Graph Store Interface
 *
 * Provides abstraction for graph database operations.
 * Enables swapping between Neo4j, MongoDB, or other graph stores.
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Entity node in graph
 */
export interface EntityNode {
  /** Unique identifier */
  id: string;
  /** Entity text */
  text: string;
  /** Entity type (PERSON, ORG, LOCATION, etc.) */
  type: string;
  /** Tenant ID for isolation */
  tenantId: string;
  /** Index ID */
  indexId: string;
  /** Document ID where first seen */
  documentId: string;
  /** Chunk ID where first seen */
  chunkId: string;
  /** First occurrence timestamp */
  firstSeenAt: Date;
  /** Last occurrence timestamp */
  lastSeenAt: Date;
  /** Number of times seen across all chunks */
  occurrenceCount: number;
  /** IDF score (inverse document frequency) */
  idf?: number;
}

/**
 * Relationship edge in graph
 */
export interface RelationshipEdge {
  /** Source entity ID */
  fromEntityId: string;
  /** Target entity ID */
  toEntityId: string;
  /** Relationship type (CO_OCCURS, REFERENCES, etc.) */
  type: string;
  /** Tenant ID for isolation */
  tenantId: string;
  /** Index ID */
  indexId: string;
  /** Weight/strength of relationship */
  weight: number;
  /** Number of times this relationship was observed */
  count: number;
  /** Metadata about the relationship */
  metadata?: Record<string, unknown>;
}

/**
 * Graph statistics
 */
export interface GraphStats {
  /** Total entities in graph */
  entityCount: number;
  /** Total relationships */
  relationshipCount: number;
  /** Entity type distribution */
  entityTypes: Record<string, number>;
}

/**
 * Related entity with relationship info
 */
export interface RelatedEntity {
  /** The related entity */
  entity: EntityNode;
  /** Relationship weight */
  weight: number;
  /** Relationship type */
  relationshipType: string;
}

// =============================================================================
// GRAPH STORE INTERFACE
// =============================================================================

/**
 * Abstract graph store interface
 * All graph store implementations must implement this interface
 */
export interface GraphStore {
  /**
   * Connect to graph database
   */
  connect(): Promise<void>;

  /**
   * Close connection
   */
  close(): Promise<void>;

  /**
   * Upsert single entity
   * @returns Entity ID
   */
  upsertEntity(entity: Omit<EntityNode, 'id' | 'occurrenceCount'>): Promise<string>;

  /**
   * Upsert multiple entities (batch)
   * @returns Map of entity text -> entity ID
   */
  upsertEntities(
    entities: Array<Omit<EntityNode, 'id' | 'occurrenceCount'>>,
  ): Promise<Map<string, string>>;

  /**
   * Upsert relationship
   */
  upsertRelationship(relationship: RelationshipEdge): Promise<void>;

  /**
   * Find entity by text
   */
  findEntityByText(tenantId: string, indexId: string, text: string): Promise<EntityNode | null>;

  /**
   * Find entities by type
   */
  findEntitiesByType(
    tenantId: string,
    indexId: string,
    type: string,
    limit?: number,
  ): Promise<EntityNode[]>;

  /**
   * Find related entities via relationships
   */
  findRelatedEntities(
    tenantId: string,
    indexId: string,
    entityId: string,
    relationshipType?: string,
    limit?: number,
  ): Promise<RelatedEntity[]>;

  /**
   * Batch update IDF scores
   */
  batchUpdateIDF(tenantId: string, indexId: string, idfScores: Map<string, number>): Promise<void>;

  /**
   * Delete document graph
   */
  deleteDocumentGraph(tenantId: string, indexId: string, documentId: string): Promise<void>;

  /**
   * Delete index graph
   */
  deleteIndexGraph(tenantId: string, indexId: string): Promise<void>;

  /**
   * Get graph statistics
   */
  getGraphStats(tenantId: string, indexId: string): Promise<GraphStats>;

  /**
   * Get store name
   */
  getName(): string;
}

// =============================================================================
// ABSTRACT BASE CLASS (Optional helper)
// =============================================================================

/**
 * Abstract base class for graph stores
 * Provides common functionality and validation
 */
export abstract class AbstractGraphStore implements GraphStore {
  protected connected = false;

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  abstract upsertEntity(entity: Omit<EntityNode, 'id' | 'occurrenceCount'>): Promise<string>;
  abstract upsertEntities(
    entities: Array<Omit<EntityNode, 'id' | 'occurrenceCount'>>,
  ): Promise<Map<string, string>>;
  abstract upsertRelationship(relationship: RelationshipEdge): Promise<void>;
  abstract findEntityByText(
    tenantId: string,
    indexId: string,
    text: string,
  ): Promise<EntityNode | null>;
  abstract findEntitiesByType(
    tenantId: string,
    indexId: string,
    type: string,
    limit?: number,
  ): Promise<EntityNode[]>;
  abstract findRelatedEntities(
    tenantId: string,
    indexId: string,
    entityId: string,
    relationshipType?: string,
    limit?: number,
  ): Promise<RelatedEntity[]>;
  abstract batchUpdateIDF(
    tenantId: string,
    indexId: string,
    idfScores: Map<string, number>,
  ): Promise<void>;
  abstract deleteDocumentGraph(
    tenantId: string,
    indexId: string,
    documentId: string,
  ): Promise<void>;
  abstract deleteIndexGraph(tenantId: string, indexId: string): Promise<void>;
  abstract getGraphStats(tenantId: string, indexId: string): Promise<GraphStats>;
  abstract getName(): string;

  /**
   * Ensure connection is established
   */
  protected ensureConnected(): void {
    if (!this.connected) {
      throw new Error(`${this.getName()} not connected. Call connect() first.`);
    }
  }

  /**
   * Validate tenant ID
   */
  protected validateTenantId(tenantId: string): void {
    if (!tenantId || tenantId.trim().length === 0) {
      throw new Error('Tenant ID is required');
    }
  }

  /**
   * Validate index ID
   */
  protected validateIndexId(indexId: string): void {
    if (!indexId || indexId.trim().length === 0) {
      throw new Error('Index ID is required');
    }
  }
}

// =============================================================================
// IN-MEMORY GRAPH STORE (For testing)
// =============================================================================

/**
 * In-memory graph store implementation
 * Useful for testing and development
 */
export class InMemoryGraphStore extends AbstractGraphStore {
  private entities = new Map<string, EntityNode>();
  private relationships = new Map<string, RelationshipEdge>();
  private nextId = 1;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.entities.clear();
    this.relationships.clear();
  }

  async upsertEntity(entity: Omit<EntityNode, 'id' | 'occurrenceCount'>): Promise<string> {
    this.ensureConnected();
    this.validateTenantId(entity.tenantId);
    this.validateIndexId(entity.indexId);

    // Find existing entity
    const key = `${entity.tenantId}:${entity.indexId}:${entity.type}:${entity.text}`;
    let existing: EntityNode | undefined;

    for (const [id, node] of this.entities.entries()) {
      const nodeKey = `${node.tenantId}:${node.indexId}:${node.type}:${node.text}`;
      if (nodeKey === key) {
        existing = node;
        break;
      }
    }

    if (existing) {
      // Update existing
      existing.lastSeenAt = entity.lastSeenAt;
      existing.occurrenceCount++;
      if (entity.idf !== undefined) {
        existing.idf = entity.idf;
      }
      return existing.id;
    } else {
      // Create new
      const id = `entity_${this.nextId++}`;
      const newEntity: EntityNode = {
        ...entity,
        id,
        occurrenceCount: 1,
      };
      this.entities.set(id, newEntity);
      return id;
    }
  }

  async upsertEntities(
    entities: Array<Omit<EntityNode, 'id' | 'occurrenceCount'>>,
  ): Promise<Map<string, string>> {
    const idMap = new Map<string, string>();

    for (const entity of entities) {
      const id = await this.upsertEntity(entity);
      idMap.set(entity.text, id);
    }

    return idMap;
  }

  async upsertRelationship(relationship: RelationshipEdge): Promise<void> {
    this.ensureConnected();
    this.validateTenantId(relationship.tenantId);
    this.validateIndexId(relationship.indexId);

    const key = `${relationship.tenantId}:${relationship.indexId}:${relationship.type}:${relationship.fromEntityId}:${relationship.toEntityId}`;
    const existing = this.relationships.get(key);

    if (existing) {
      // Update existing
      existing.weight += relationship.weight;
      existing.count++;
      if (relationship.metadata) {
        existing.metadata = { ...existing.metadata, ...relationship.metadata };
      }
    } else {
      // Create new
      this.relationships.set(key, { ...relationship, count: 1 });
    }
  }

  async findEntityByText(
    tenantId: string,
    indexId: string,
    text: string,
  ): Promise<EntityNode | null> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    for (const entity of this.entities.values()) {
      if (entity.tenantId === tenantId && entity.indexId === indexId && entity.text === text) {
        return entity;
      }
    }

    return null;
  }

  async findEntitiesByType(
    tenantId: string,
    indexId: string,
    type: string,
    limit = 100,
  ): Promise<EntityNode[]> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    const results: EntityNode[] = [];

    for (const entity of this.entities.values()) {
      if (entity.tenantId === tenantId && entity.indexId === indexId && entity.type === type) {
        results.push(entity);
      }
    }

    // Sort by occurrence count descending
    results.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

    return results.slice(0, limit);
  }

  async findRelatedEntities(
    tenantId: string,
    indexId: string,
    entityId: string,
    relationshipType?: string,
    limit = 20,
  ): Promise<RelatedEntity[]> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    const results: RelatedEntity[] = [];

    for (const rel of this.relationships.values()) {
      if (
        rel.tenantId === tenantId &&
        rel.indexId === indexId &&
        rel.fromEntityId === entityId &&
        (!relationshipType || rel.type === relationshipType)
      ) {
        const targetEntity = this.entities.get(rel.toEntityId);
        if (targetEntity) {
          results.push({
            entity: targetEntity,
            weight: rel.weight,
            relationshipType: rel.type,
          });
        }
      }
    }

    // Sort by weight descending
    results.sort((a, b) => b.weight - a.weight);

    return results.slice(0, limit);
  }

  async batchUpdateIDF(
    tenantId: string,
    indexId: string,
    idfScores: Map<string, number>,
  ): Promise<void> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    for (const [entityText, idf] of idfScores.entries()) {
      const entity = await this.findEntityByText(tenantId, indexId, entityText);
      if (entity) {
        entity.idf = idf;
      }
    }
  }

  async deleteDocumentGraph(tenantId: string, indexId: string, documentId: string): Promise<void> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    // Delete entities
    for (const [id, entity] of this.entities.entries()) {
      if (
        entity.tenantId === tenantId &&
        entity.indexId === indexId &&
        entity.documentId === documentId
      ) {
        this.entities.delete(id);
      }
    }

    // Delete relationships (would need entity lookup in real implementation)
    for (const [key, rel] of this.relationships.entries()) {
      if (rel.tenantId === tenantId && rel.indexId === indexId) {
        const fromEntity = this.entities.get(rel.fromEntityId);
        const toEntity = this.entities.get(rel.toEntityId);
        if (
          (fromEntity && fromEntity.documentId === documentId) ||
          (toEntity && toEntity.documentId === documentId)
        ) {
          this.relationships.delete(key);
        }
      }
    }
  }

  async deleteIndexGraph(tenantId: string, indexId: string): Promise<void> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    // Delete all entities for this tenant/index
    for (const [id, entity] of this.entities.entries()) {
      if (entity.tenantId === tenantId && entity.indexId === indexId) {
        this.entities.delete(id);
      }
    }

    // Delete all relationships for this tenant/index
    for (const [key, rel] of this.relationships.entries()) {
      if (rel.tenantId === tenantId && rel.indexId === indexId) {
        this.relationships.delete(key);
      }
    }
  }

  async getGraphStats(tenantId: string, indexId: string): Promise<GraphStats> {
    this.ensureConnected();
    this.validateTenantId(tenantId);
    this.validateIndexId(indexId);

    const entityTypes: Record<string, number> = {};
    let entityCount = 0;

    for (const entity of this.entities.values()) {
      if (entity.tenantId === tenantId && entity.indexId === indexId) {
        entityCount++;
        entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
      }
    }

    let relationshipCount = 0;
    for (const rel of this.relationships.values()) {
      if (rel.tenantId === tenantId && rel.indexId === indexId) {
        relationshipCount++;
      }
    }

    return {
      entityCount,
      relationshipCount,
      entityTypes,
    };
  }

  getName(): string {
    return 'in-memory';
  }
}
