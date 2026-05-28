/**
 * Taxonomy Graph Service
 *
 * Manages taxonomy graph in Neo4j for domain-aware knowledge graph.
 * Creates taxonomy nodes (Domain → Category → Product → Attribute) and
 * links deduplicated entity instances to products for disambiguation.
 *
 * Tenant isolation: All nodes include tenantId and indexId properties.
 *
 * NOTE: Document and Chunk nodes are NOT stored in the taxonomy graph.
 * Document classification data lives in MongoDB (searchdocuments.metadata.kgState,
 * classification fields). All document stats/listings are served from MongoDB.
 * The permission graph (packages/search-ai-internal/src/permissions/) manages its
 * own :Document nodes in Neo4j for access-control queries — DO NOT modify those.
 */

import neo4j, { type Driver, type Session, type ManagedTransaction } from 'neo4j-driver';
import { getConfig, type SearchAIConfig } from '../../config/index.js';
import { ConfigurationError } from '@agent-platform/search-ai-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface TaxonomyNode {
  tenantId: string;
  indexId: string;
}

export interface DomainNode extends TaxonomyNode {
  id: string;
  name: string;
  version: string;
}

export interface CategoryNode extends TaxonomyNode {
  id: string;
  name: string;
  department: string;
}

export interface ProductNode extends TaxonomyNode {
  id: string;
  name: string;
  categoryId: string;
  department: string;
  subDepartment: string;
  disambiguationKeywords: string[];
  organizationSpecificNames?: string[];
}

export interface AttributeNode extends TaxonomyNode {
  id: string;
  name: string;
  dataType: string;
  applicableTo: string[];
  notApplicableTo: string[];
}

export interface ProductExclusion {
  fromProductId: string;
  toProductId: string;
  reasoning: string;
}

// =============================================================================
// TAXONOMY GRAPH SERVICE
// =============================================================================

export class TaxonomyGraphService {
  private driver: Driver | null = null;
  private config: SearchAIConfig['knowledgeGraph'];

  constructor(config: SearchAIConfig['knowledgeGraph']) {
    this.config = config;
  }

  /**
   * Initialize connection to Neo4j
   */
  async connect(): Promise<void> {
    if (this.driver) {
      return; // Already connected
    }

    this.driver = neo4j.driver(
      this.config.uri,
      neo4j.auth.basic(this.config.username, this.config.password),
      {
        maxConnectionPoolSize: this.config.neo4jMaxPoolSize || 50,
        connectionTimeout: 30000,
      },
    );

    // Verify connectivity
    await this.driver.verifyConnectivity();

    // Create constraints and indexes
    await this.createConstraintsAndIndexes();
  }

  /**
   * Close connection to Neo4j
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  /**
   * Check if the driver is connected
   */
  isConnected(): boolean {
    return this.driver !== null;
  }

  /**
   * Get a session for executing queries
   */
  private getSession(): Session {
    if (!this.driver) {
      throw new ConfigurationError(
        'neo4j.driver',
        'Neo4j driver not initialized. Call connect() first.',
      );
    }
    return this.driver.session({ database: this.config.database || 'neo4j' });
  }

  /**
   * Create constraints and indexes for taxonomy graph
   */
  private async createConstraintsAndIndexes(): Promise<void> {
    const session = this.getSession();

    try {
      // Domain uniqueness constraint
      await session.run(`
        CREATE CONSTRAINT domain_unique IF NOT EXISTS
        FOR (d:Domain)
        REQUIRE (d.tenantId, d.indexId, d.id) IS UNIQUE
      `);

      // Category uniqueness constraint
      await session.run(`
        CREATE CONSTRAINT category_unique IF NOT EXISTS
        FOR (c:Category)
        REQUIRE (c.tenantId, c.indexId, c.id) IS UNIQUE
      `);

      // Product uniqueness constraint
      await session.run(`
        CREATE CONSTRAINT product_unique IF NOT EXISTS
        FOR (p:Product)
        REQUIRE (p.tenantId, p.indexId, p.id) IS UNIQUE
      `);

      // Attribute uniqueness constraint
      await session.run(`
        CREATE CONSTRAINT attribute_unique IF NOT EXISTS
        FOR (a:Attribute)
        REQUIRE (a.tenantId, a.indexId, a.id) IS UNIQUE
      `);

      // EntityInstance uniqueness constraint (deduplicated by attributeId + normalizedValue)
      await session.run(`
        CREATE CONSTRAINT entity_instance_unique IF NOT EXISTS
        FOR (e:EntityInstance)
        REQUIRE (e.tenantId, e.indexId, e.id) IS UNIQUE
      `);

      // Index on normalizedValue for fast entity lookups
      await session.run(`
        CREATE INDEX entity_normalized_value_idx IF NOT EXISTS
        FOR (e:EntityInstance)
        ON (e.normalizedValue)
      `);

      // Index on tenantId and indexId for fast tenant-scoped queries
      await session.run(`
        CREATE INDEX domain_tenant_idx IF NOT EXISTS
        FOR (d:Domain)
        ON (d.tenantId, d.indexId)
      `);

      await session.run(`
        CREATE INDEX product_tenant_idx IF NOT EXISTS
        FOR (p:Product)
        ON (p.tenantId, p.indexId)
      `);
    } finally {
      await session.close();
    }
  }

  /**
   * Create or update taxonomy graph from taxonomy data
   */
  async createTaxonomyGraph(
    tenantId: string,
    indexId: string,
    taxonomy: {
      domain: { id: string; name: string; version: string };
      categories: Array<{ id: string; name: string; department: string }>;
      products: Array<{
        id: string;
        name: string;
        categoryId: string;
        department: string;
        subDepartment: string;
        disambiguationKeywords: string[];
        organizationSpecificNames?: string[];
      }>;
      attributes: Array<{
        id: string;
        name: string;
        dataType: string;
        applicableTo: string[];
        notApplicableTo: string[];
      }>;
      exclusions?: Array<{
        fromProductId: string;
        toProductId: string;
        reasoning: string;
      }>;
    },
  ): Promise<void> {
    const session = this.getSession();

    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // Create Domain node
        await tx.run(
          `
          MERGE (d:Domain {tenantId: $tenantId, indexId: $indexId, id: $domainId})
          SET d.name = $domainName, d.version = $domainVersion
          `,
          {
            tenantId,
            indexId,
            domainId: taxonomy.domain.id,
            domainName: taxonomy.domain.name,
            domainVersion: taxonomy.domain.version,
          },
        );

        // Create Category nodes and link to Domain (batched)
        await tx.run(
          `
          MATCH (d:Domain {tenantId: $tenantId, indexId: $indexId, id: $domainId})
          WITH d
          UNWIND $categories AS cat
          MERGE (c:Category {tenantId: $tenantId, indexId: $indexId, id: cat.id})
          SET c.name = cat.name, c.department = cat.department
          MERGE (d)-[:HAS_CATEGORY]->(c)
          `,
          {
            tenantId,
            indexId,
            domainId: taxonomy.domain.id,
            categories: taxonomy.categories,
          },
        );

        // Create Product nodes and link to Categories (batched)
        await tx.run(
          `
          UNWIND $products AS prod
          MATCH (c:Category {tenantId: $tenantId, indexId: $indexId, id: prod.categoryId})
          MERGE (p:Product {tenantId: $tenantId, indexId: $indexId, id: prod.id})
          SET p.name = prod.name,
              p.categoryId = prod.categoryId,
              p.department = prod.department,
              p.subDepartment = prod.subDepartment,
              p.disambiguationKeywords = prod.disambiguationKeywords,
              p.organizationSpecificNames = prod.organizationSpecificNames
          MERGE (c)-[:HAS_PRODUCT]->(p)
          `,
          {
            tenantId,
            indexId,
            products: taxonomy.products.map((p) => ({
              ...p,
              organizationSpecificNames: p.organizationSpecificNames || [],
            })),
          },
        );

        // Create Attribute nodes (batched)
        await tx.run(
          `
          UNWIND $attributes AS attr
          MERGE (a:Attribute {tenantId: $tenantId, indexId: $indexId, id: attr.id})
          SET a.name = attr.name,
              a.dataType = attr.dataType,
              a.applicableTo = attr.applicableTo,
              a.notApplicableTo = attr.notApplicableTo
          `,
          {
            tenantId,
            indexId,
            attributes: taxonomy.attributes,
          },
        );

        // Link Attributes to applicable Products (batched)
        const attributeProductLinks = taxonomy.attributes.flatMap((attr) =>
          attr.applicableTo.map((productId) => ({
            attributeId: attr.id,
            productId,
          })),
        );

        if (attributeProductLinks.length > 0) {
          await tx.run(
            `
            UNWIND $links AS link
            MATCH (p:Product {tenantId: $tenantId, indexId: $indexId, id: link.productId})
            MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId, id: link.attributeId})
            MERGE (p)-[:HAS_ATTRIBUTE]->(a)
            `,
            {
              tenantId,
              indexId,
              links: attributeProductLinks,
            },
          );
        }

        // Create product exclusion relationships (batched)
        if (taxonomy.exclusions && taxonomy.exclusions.length > 0) {
          await tx.run(
            `
            UNWIND $exclusions AS excl
            MATCH (from:Product {tenantId: $tenantId, indexId: $indexId, id: excl.fromProductId})
            MATCH (to:Product {tenantId: $tenantId, indexId: $indexId, id: excl.toProductId})
            MERGE (from)-[r:EXCLUDES]->(to)
            SET r.reasoning = excl.reasoning
            `,
            {
              tenantId,
              indexId,
              exclusions: taxonomy.exclusions,
            },
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Upsert entity instance (deduplicated approach)
   *
   * Creates or updates entity instance nodes based on (attributeId + normalizedValue).
   * Multiple documents with same entity value share one node with incremented documentCount.
   *
   * This prevents Neo4j from exploding to millions of nodes when 10M documents
   * contain repeated entity values (e.g., "APR: 15.99%" appears in 1000 docs).
   */
  async upsertEntityInstance(params: {
    tenantId: string;
    indexId: string;
    id: string; // Format: "attributeId:normalizedValue"
    attributeId: string;
    rawValue: string;
    normalizedValue: string | number | boolean;
    productId: string;
  }): Promise<void> {
    const session = this.getSession();

    try {
      await session.run(
        `
        MERGE (e:EntityInstance {tenantId: $tenantId, indexId: $indexId, id: $id})
        ON CREATE SET
          e.attributeId = $attributeId,
          e.rawValue = $rawValue,
          e.normalizedValue = $normalizedValue,
          e.documentCount = 1,
          e.firstSeenAt = datetime(),
          e.lastSeenAt = datetime()
        ON MATCH SET
          e.documentCount = e.documentCount + 1,
          e.lastSeenAt = datetime()

        WITH e
        MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId, id: $attributeId})
        MERGE (e)-[:INSTANCE_OF]->(a)

        WITH e
        MATCH (p:Product {tenantId: $tenantId, indexId: $indexId, id: $productId})
        MERGE (e)-[:FOUND_IN_PRODUCT]->(p)
        `,
        {
          tenantId: params.tenantId,
          indexId: params.indexId,
          id: params.id,
          attributeId: params.attributeId,
          rawValue: params.rawValue,
          normalizedValue:
            typeof params.normalizedValue === 'object'
              ? JSON.stringify(params.normalizedValue)
              : params.normalizedValue,
          productId: params.productId,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Batch upsert entity instances using UNWIND (deduplicated approach)
   *
   * Same semantics as upsertEntityInstance() but handles an array in a single
   * Cypher query, avoiding one round-trip per entity.
   */
  async batchUpsertEntityInstances(params: {
    tenantId: string;
    indexId: string;
    entities: Array<{
      id: string; // Format: "attributeId:normalizedValue"
      attributeId: string;
      rawValue: string;
      normalizedValue: string | number | boolean;
      productId: string;
    }>;
  }): Promise<void> {
    if (params.entities.length === 0) return;

    const session = this.getSession();
    try {
      // Serialize normalizedValue for Neo4j
      const serialized = params.entities.map((e) => ({
        ...e,
        normalizedValue:
          typeof e.normalizedValue === 'object'
            ? JSON.stringify(e.normalizedValue)
            : e.normalizedValue,
      }));

      await session.run(
        `
        UNWIND $entities AS ent
        MERGE (e:EntityInstance {tenantId: $tenantId, indexId: $indexId, id: ent.id})
        ON CREATE SET
          e.attributeId = ent.attributeId,
          e.rawValue = ent.rawValue,
          e.normalizedValue = ent.normalizedValue,
          e.documentCount = 1,
          e.firstSeenAt = datetime(),
          e.lastSeenAt = datetime()
        ON MATCH SET
          e.documentCount = e.documentCount + 1,
          e.lastSeenAt = datetime()
        WITH e, ent
        MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId, id: ent.attributeId})
        MERGE (e)-[:INSTANCE_OF]->(a)
        WITH e, ent
        MATCH (p:Product {tenantId: $tenantId, indexId: $indexId, id: ent.productId})
        MERGE (e)-[:FOUND_IN_PRODUCT]->(p)
        `,
        {
          tenantId: params.tenantId,
          indexId: params.indexId,
          entities: serialized,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Get top entity instances for a product by document count
   */
  async getTopEntityInstancesByProduct(
    tenantId: string,
    indexId: string,
    productId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      attributeId: string;
      rawValue: string;
      normalizedValue: string | number | boolean;
      documentCount: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }>
  > {
    const session = this.getSession();

    try {
      const result = await session.run(
        `
        MATCH (p:Product {tenantId: $tenantId, indexId: $indexId, id: $productId})<-[:FOUND_IN_PRODUCT]-(e:EntityInstance)
        RETURN e
        ORDER BY e.documentCount DESC
        LIMIT $limit
        `,
        { tenantId, indexId, productId, limit: neo4j.int(limit) },
      );

      return result.records.map((record) => {
        const e = record.get('e').properties;
        return {
          id: e.id,
          attributeId: e.attributeId,
          rawValue: e.rawValue,
          normalizedValue: e.normalizedValue,
          documentCount: e.documentCount.toInt ? e.documentCount.toInt() : e.documentCount,
          firstSeenAt: new Date(e.firstSeenAt),
          lastSeenAt: new Date(e.lastSeenAt),
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get full taxonomy graph structure for visualization
   */
  async getTaxonomyGraphStructure(
    tenantId: string,
    indexId: string,
  ): Promise<{
    nodes: Array<{
      id: string;
      label: string;
      type: 'domain' | 'category' | 'product' | 'attribute' | 'entity_instance';
      properties: Record<string, any>;
    }>;
    edges: Array<{
      from: string;
      to: string;
      type: string;
    }>;
  }> {
    const session = this.getSession();

    try {
      const result = await session.run(
        `
        MATCH path = (d:Domain {tenantId: $tenantId, indexId: $indexId})-[:HAS_CATEGORY]->(c:Category)-[:HAS_PRODUCT]->(p:Product)
        OPTIONAL MATCH (p)-[:HAS_ATTRIBUTE]->(a:Attribute)
        RETURN d, c, p, collect(a) AS attributes
        `,
        { tenantId, indexId },
      );

      const nodes: any[] = [];
      const edges: any[] = [];
      const seenNodes = new Set<string>();

      for (const record of result.records) {
        const domain = record.get('d').properties;
        const category = record.get('c').properties;
        const product = record.get('p').properties;
        const attributes = record.get('attributes');

        // Domain node
        if (!seenNodes.has(domain.id)) {
          nodes.push({
            id: domain.id,
            label: domain.name,
            type: 'domain',
            properties: domain,
          });
          seenNodes.add(domain.id);
        }

        // Category node
        if (!seenNodes.has(category.id)) {
          nodes.push({
            id: category.id,
            label: category.name,
            type: 'category',
            properties: category,
          });
          seenNodes.add(category.id);
          edges.push({
            from: domain.id,
            to: category.id,
            type: 'HAS_CATEGORY',
          });
        }

        // Product node
        if (!seenNodes.has(product.id)) {
          nodes.push({
            id: product.id,
            label: product.name,
            type: 'product',
            properties: product,
          });
          seenNodes.add(product.id);
          edges.push({
            from: category.id,
            to: product.id,
            type: 'HAS_PRODUCT',
          });
        }

        // Attribute nodes
        for (const attr of attributes) {
          if (!attr || !attr.properties) continue;
          const a = attr.properties;
          if (!seenNodes.has(a.id)) {
            nodes.push({
              id: a.id,
              label: a.name,
              type: 'attribute',
              properties: a,
            });
            seenNodes.add(a.id);
            edges.push({
              from: product.id,
              to: a.id,
              type: 'HAS_ATTRIBUTE',
            });
          }
        }
      }

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }

  /**
   * Delete taxonomy graph for a specific index
   */
  async deleteTaxonomyGraph(tenantId: string, indexId: string): Promise<void> {
    const session = this.getSession();

    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // Delete leaf nodes first, then inner nodes, then root
        // Each uses label-specific index for efficient lookup
        // NOTE: Document and Chunk nodes are not stored in the taxonomy graph.
        // Document nodes in Neo4j belong to the permission graph (packages/search-ai-internal).
        await tx.run(
          'MATCH (e:EntityInstance {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE e',
          { tenantId, indexId },
        );
        await tx.run(
          'MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE a',
          { tenantId, indexId },
        );
        await tx.run('MATCH (p:Product {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE p', {
          tenantId,
          indexId,
        });
        await tx.run(
          'MATCH (c:Category {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE c',
          { tenantId, indexId },
        );
        await tx.run('MATCH (d:Domain {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE d', {
          tenantId,
          indexId,
        });
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get products by category
   */
  async getProductsByCategory(
    tenantId: string,
    indexId: string,
    categoryId: string,
  ): Promise<ProductNode[]> {
    const session = this.getSession();

    try {
      const result = await session.run(
        `
        MATCH (c:Category {tenantId: $tenantId, indexId: $indexId, id: $categoryId})-[:HAS_PRODUCT]->(p:Product)
        RETURN p
        `,
        { tenantId, indexId, categoryId },
      );

      return result.records.map((record) => {
        const p = record.get('p').properties;
        return {
          id: p.id,
          name: p.name,
          categoryId: p.categoryId || categoryId,
          department: p.department,
          subDepartment: p.subDepartment,
          disambiguationKeywords: p.disambiguationKeywords || [],
          organizationSpecificNames: p.organizationSpecificNames || [],
          tenantId: p.tenantId,
          indexId: p.indexId,
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get attributes for a product
   */
  async getAttributesForProduct(
    tenantId: string,
    indexId: string,
    productId: string,
  ): Promise<AttributeNode[]> {
    const session = this.getSession();

    try {
      const result = await session.run(
        `
        MATCH (p:Product {tenantId: $tenantId, indexId: $indexId, id: $productId})-[:HAS_ATTRIBUTE]->(a:Attribute)
        RETURN a
        `,
        { tenantId, indexId, productId },
      );

      return result.records.map((record) => {
        const a = record.get('a').properties;
        return {
          id: a.id,
          name: a.name,
          dataType: a.dataType,
          applicableTo: a.applicableTo || [],
          notApplicableTo: a.notApplicableTo || [],
          tenantId: a.tenantId,
          indexId: a.indexId,
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get taxonomy graph statistics
   */
  async getTaxonomyStats(
    tenantId: string,
    indexId: string,
  ): Promise<{
    domainCount: number;
    categoryCount: number;
    productCount: number;
    attributeCount: number;
    entityInstanceCount: number;
  }> {
    const session = this.getSession();

    try {
      const result = await session.run(
        `
        CALL { MATCH (d:Domain {tenantId: $tenantId, indexId: $indexId}) RETURN count(d) AS domainCount }
        CALL { MATCH (c:Category {tenantId: $tenantId, indexId: $indexId}) RETURN count(c) AS categoryCount }
        CALL { MATCH (p:Product {tenantId: $tenantId, indexId: $indexId}) RETURN count(p) AS productCount }
        CALL { MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId}) RETURN count(a) AS attributeCount }
        CALL { MATCH (e:EntityInstance {tenantId: $tenantId, indexId: $indexId}) RETURN count(e) AS entityInstanceCount }
        RETURN domainCount, categoryCount, productCount, attributeCount, entityInstanceCount
        `,
        { tenantId, indexId },
      );

      const record = result.records[0];
      return {
        domainCount: record.get('domainCount').toInt(),
        categoryCount: record.get('categoryCount').toInt(),
        productCount: record.get('productCount').toInt(),
        attributeCount: record.get('attributeCount').toInt(),
        entityInstanceCount: record.get('entityInstanceCount').toInt(),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get entity instance count per product
   */
  async getEntityCountsByProduct(tenantId: string, indexId: string): Promise<Map<string, number>> {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (p:Product {tenantId: $tenantId, indexId: $indexId})<-[:FOUND_IN_PRODUCT]-(e:EntityInstance)
        RETURN p.id AS productId, count(e) AS entityCount
        `,
        { tenantId, indexId },
      );
      const map = new Map<string, number>();
      for (const record of result.records) {
        map.set(
          record.get('productId'),
          record.get('entityCount').toInt
            ? record.get('entityCount').toInt()
            : record.get('entityCount'),
        );
      }
      return map;
    } finally {
      await session.close();
    }
  }

  /**
   * Get attribute summaries — aggregate stats per attribute
   */
  async getAttributeSummaries(
    tenantId: string,
    indexId: string,
  ): Promise<
    Array<{
      attributeId: string;
      uniqueValues: number;
      topValues: Array<{ value: string; documentCount: number }>;
    }>
  > {
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId})<-[:INSTANCE_OF]-(e:EntityInstance)
        WITH a.id AS attributeId, count(e) AS uniqueValues,
             collect({value: e.rawValue, documentCount: e.documentCount})[..5] AS topValues
        RETURN attributeId, uniqueValues, topValues
        ORDER BY uniqueValues DESC
        `,
        { tenantId, indexId },
      );
      return result.records.map((record) => ({
        attributeId: record.get('attributeId'),
        uniqueValues: record.get('uniqueValues').toInt
          ? record.get('uniqueValues').toInt()
          : record.get('uniqueValues'),
        topValues: record
          .get('topValues')
          .map((tv: { value: string; documentCount: { toInt?: () => number } | number }) => ({
            value: tv.value,
            documentCount:
              tv.documentCount &&
              typeof tv.documentCount === 'object' &&
              'toInt' in tv.documentCount &&
              tv.documentCount.toInt
                ? tv.documentCount.toInt()
                : (tv.documentCount ?? 0),
          })),
      }));
    } finally {
      await session.close();
    }
  }
}

// =============================================================================
// SINGLETON (matches canonical-mapper.service.ts pattern)
// =============================================================================

let _instance: TaxonomyGraphService | null = null;

export function getTaxonomyGraphService(): TaxonomyGraphService {
  if (!_instance) {
    const config = getConfig();
    _instance = new TaxonomyGraphService(config.knowledgeGraph);
  }
  return _instance;
}

export async function initTaxonomyGraphService(): Promise<void> {
  const config = getConfig();
  if (!config.knowledgeGraph?.enabled) return; // Skip if Neo4j not provisioned
  const svc = getTaxonomyGraphService();
  if (!svc.isConnected()) {
    await svc.connect();
  }
}

export async function closeTaxonomyGraphService(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
