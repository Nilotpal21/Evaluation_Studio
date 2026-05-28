/**
 * Base Repository with Tenant-Scoped Query Helpers
 *
 * Abstract class that enforces tenant isolation at the query level.
 * All ID-based queries include tenantId — NEVER uses findById().
 * Cross-tenant access returns null (route layer maps to 404, not 403).
 *
 * Subclasses provide the Mongoose model via `get model()`.
 * Domain-specific queries live in concrete repositories.
 */

export interface PaginationOptions {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
}

export abstract class TenantScopedRepository<T> {
  /** Mongoose model — subclasses must provide via dynamic import or getLazyModel. */
  protected abstract get model(): any;

  /**
   * Find a single document by _id scoped to tenantId.
   * Returns null when not found OR when tenantId doesn't match (isolation).
   */
  async findByIdAndTenant(id: string, tenantId: string): Promise<T | null> {
    return this.model.findOne({ _id: id, tenantId }).lean();
  }

  /**
   * Find a single document by arbitrary filter, always scoped to tenantId.
   */
  async findOneByTenant(filter: Record<string, unknown>, tenantId: string): Promise<T | null> {
    return this.model.findOne({ ...filter, tenantId }).lean();
  }

  /**
   * Find multiple documents by filter, always scoped to tenantId.
   */
  async findManyByTenant(
    filter: Record<string, unknown>,
    tenantId: string,
    options?: PaginationOptions,
  ): Promise<T[]> {
    let query = this.model.find({ ...filter, tenantId });
    if (options?.sort != null) query = query.sort(options.sort);
    if (options?.skip != null) query = query.skip(options.skip);
    if (options?.limit != null) query = query.limit(options.limit);
    return query.lean();
  }

  /**
   * Count documents matching filter, scoped to tenantId.
   */
  async countByTenant(filter: Record<string, unknown>, tenantId: string): Promise<number> {
    return this.model.countDocuments({ ...filter, tenantId });
  }

  /**
   * Update a single document by _id scoped to tenantId.
   * Returns the updated document or null if not found / wrong tenant.
   */
  async updateByIdAndTenant(
    id: string,
    tenantId: string,
    update: Record<string, unknown>,
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: update }, { new: true })
      .lean();
  }

  /**
   * Delete a single document by _id scoped to tenantId.
   * Returns true if a document was deleted, false otherwise.
   */
  async deleteByIdAndTenant(id: string, tenantId: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId });
    return result.deletedCount > 0;
  }

  /**
   * Create a new document. tenantId must be included in the data.
   */
  async create(data: Record<string, unknown> & { tenantId: string }): Promise<T> {
    const doc = await this.model.create(data);
    return doc.toObject ? doc.toObject() : doc;
  }
}
