/**
 * Knowledge Graph Repository
 *
 * Tenant-scoped data access for KG taxonomy, domains, and knowledge bases.
 * Consolidates scattered inline model queries from kg-taxonomy and
 * kg-enrichment routes into a single repository layer.
 *
 * IMPORTANT: All ID-based queries include tenantId — NEVER uses findById().
 * Cross-tenant access returns null (404 at route level, not 403).
 */

import { TenantScopedRepository } from '@agent-platform/shared/repos';
import { getLazyModel } from '../db/index.js';
import type {
  IKnowledgeGraphTaxonomy,
  IKnowledgeGraphDomain,
  IKnowledgeBase,
} from '@agent-platform/database/models';

// ─── Taxonomy Repository ──────────────────────────────────────────────────

class KGTaxonomyRepository extends TenantScopedRepository<IKnowledgeGraphTaxonomy> {
  protected get model() {
    return getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');
  }

  /**
   * Find taxonomy for a specific index within a tenant.
   */
  async findByIndex(tenantId: string, indexId: string): Promise<IKnowledgeGraphTaxonomy | null> {
    return this.findOneByTenant({ indexId }, tenantId);
  }

  /**
   * Upsert taxonomy for an index (create or update).
   * Uses findOneAndUpdate with upsert to avoid race conditions.
   */
  async upsertByIndex(
    tenantId: string,
    indexId: string,
    taxonomyData: Record<string, unknown>,
  ): Promise<IKnowledgeGraphTaxonomy> {
    const result = await this.model.findOneAndUpdate(
      { tenantId, indexId },
      { $set: { ...taxonomyData, tenantId, indexId } },
      { new: true, upsert: true },
    );
    return result;
  }

  /**
   * Delete taxonomy for a specific index.
   * Returns true if a document was deleted.
   */
  async deleteByIndex(tenantId: string, indexId: string): Promise<boolean> {
    const result = await this.model.deleteOne({ tenantId, indexId });
    return result.deletedCount > 0;
  }
}

// ─── Domain Repository ────────────────────────────────────────────────────

class KGDomainRepository extends TenantScopedRepository<IKnowledgeGraphDomain> {
  protected get model() {
    return getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');
  }

  /**
   * Find a domain by name within a tenant.
   */
  async findByName(tenantId: string, domainName: string): Promise<IKnowledgeGraphDomain | null> {
    return this.findOneByTenant({ name: domainName }, tenantId);
  }

  /**
   * List all domains for a tenant, sorted by creation date.
   */
  async listByTenant(tenantId: string): Promise<IKnowledgeGraphDomain[]> {
    return this.findManyByTenant({}, tenantId, { sort: { createdAt: -1 } });
  }

  /**
   * Delete a domain by name within a tenant.
   * Returns true if a document was deleted.
   */
  async deleteByName(tenantId: string, domainName: string): Promise<boolean> {
    const result = await this.model.deleteOne({ tenantId, name: domainName });
    return result.deletedCount > 0;
  }

  /**
   * Check if a domain name is referenced in any active taxonomy.
   * Prevents deletion of in-use domains.
   */
  async isDomainInUse(tenantId: string, domainName: string): Promise<boolean> {
    const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy');
    const count = await KnowledgeGraphTaxonomy.countDocuments({
      tenantId,
      'taxonomy.domainSources': { $elemMatch: { name: domainName } },
    });
    return count > 0;
  }
}

// ─── Knowledge Base Repository ────────────────────────────────────────────

class KGKnowledgeBaseRepository extends TenantScopedRepository<IKnowledgeBase> {
  protected get model() {
    return getLazyModel<IKnowledgeBase>('KnowledgeBase');
  }

  /**
   * List knowledge bases for a project within a tenant.
   */
  async listByProject(
    tenantId: string,
    projectId: string,
    filter?: { status?: string },
  ): Promise<IKnowledgeBase[]> {
    const where: Record<string, unknown> = { projectId };
    if (filter?.status) where.status = filter.status;
    return this.findManyByTenant(where, tenantId, { sort: { createdAt: -1 } });
  }

  /**
   * Find a knowledge base by name within a project.
   */
  async findByName(
    tenantId: string,
    projectId: string,
    name: string,
  ): Promise<IKnowledgeBase | null> {
    return this.findOneByTenant({ projectId, name }, tenantId);
  }
}

// ─── Singleton Exports ────────────────────────────────────────────────────

export const kgTaxonomyRepo = new KGTaxonomyRepository();
export const kgDomainRepo = new KGDomainRepository();
export const kgKnowledgeBaseRepo = new KGKnowledgeBaseRepository();
