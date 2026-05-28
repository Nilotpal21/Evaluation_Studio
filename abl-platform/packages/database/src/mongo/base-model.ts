/**
 * BaseModel Abstract Class
 *
 * Provides a typed, production-grade abstraction over Mongoose models with:
 * - CRUD operations with soft-delete support
 * - Cursor-based and offset pagination
 * - Aggregation pipeline support
 * - Bulk operations and upserts
 * - Transaction support
 * - Change stream support (opt-in)
 * - Slow query logging and error classification on every operation
 */

import mongoose from 'mongoose';
import type {
  Model,
  FilterQuery,
  PipelineStage,
  ClientSession,
  AnyBulkWriteOperation,
} from 'mongoose';
import type {
  BaseDocument,
  PaginationOptions,
  PaginatedResult,
  CursorOptions,
  CursorResult,
  QueryOptions,
  TenantScopedDocument,
} from './base-document.js';
import { wrapError, MongoAppError } from './middleware/error-handler.js';

// ─── Types ───────────────────────────────────────────────────────────────

interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

type TenantScopedLookup = Pick<TenantScopedDocument, 'tenantId'> & { _id: string };

// ─── BaseModel ───────────────────────────────────────────────────────────

export abstract class BaseModel<
  TDoc extends BaseDocument,
  TInput extends Record<string, unknown>,
  TUpdate extends Record<string, unknown>,
> {
  protected model: Model<TDoc>;
  protected collectionName: string;
  protected slowQueryMs: number;
  protected logger: Logger;

  constructor(
    model: Model<TDoc>,
    collectionName: string,
    options?: { slowQueryMs?: number; logger?: Logger },
  ) {
    this.model = model;
    this.collectionName = collectionName;
    this.slowQueryMs = options?.slowQueryMs ?? 200;
    this.logger = options?.logger ?? {
      debug: () => {},
      info: () => {},
      warn: (msg, data) => console.warn(`[${collectionName}] ${msg}`, data ?? ''),
      error: (msg, data) => console.error(`[${collectionName}] ${msg}`, data ?? ''),
    };
  }

  // ─── CRUD ──────────────────────────────────────────────────────────

  async create(input: TInput): Promise<TDoc> {
    return this.executeWithLogging('create', async () => {
      const doc = await this.model.create(input as any);
      return doc.toObject() as TDoc;
    });
  }

  async createMany(inputs: TInput[]): Promise<TDoc[]> {
    return this.executeWithLogging(
      'createMany',
      async () => {
        const docs = await this.model.insertMany(inputs as any[]);
        return docs.map((d) => d.toObject() as TDoc);
      },
      { count: inputs.length },
    );
  }

  async findOneScoped(
    scope: FilterQuery<TDoc> & TenantScopedLookup,
    opts?: QueryOptions,
  ): Promise<TDoc | null> {
    return this.executeWithLogging(
      'findOneScoped',
      () => {
        const filter = this.applySoftDeleteFilter(scope as FilterQuery<TDoc>, opts);
        const query = this.model.findOne(filter);
        this.applyQueryOptions(query, opts);
        return query.lean<TDoc>().exec();
      },
      { id: scope._id, tenantId: scope.tenantId },
    );
  }

  /**
   * @deprecated Use findOneScoped({ _id, tenantId }) for tenant-scoped lookups, or
   * findOne({ ... }) for explicitly scoped non-tenant lookups.
   */
  async findById(id: string, opts?: QueryOptions): Promise<TDoc | null> {
    return this.executeWithLogging(
      'findById',
      () => {
        const query = this.model.findOne({ _id: id } as any);
        this.applyQueryOptions(query, opts);
        return query.lean<TDoc>().exec();
      },
      { id },
    );
  }

  async findOne(filter: FilterQuery<TDoc>, opts?: QueryOptions): Promise<TDoc | null> {
    return this.executeWithLogging('findOne', () => {
      const f = this.applySoftDeleteFilter(filter, opts);
      const query = this.model.findOne(f);
      this.applyQueryOptions(query, opts);
      return query.lean<TDoc>().exec();
    });
  }

  async find(filter: FilterQuery<TDoc>, opts?: QueryOptions): Promise<TDoc[]> {
    return this.executeWithLogging('find', async () => {
      const f = this.applySoftDeleteFilter(filter, opts);
      const query = this.model.find(f);
      this.applyQueryOptions(query, opts);
      const results = await query.lean().exec();
      return results as TDoc[];
    });
  }

  async updateById(id: string, update: TUpdate): Promise<TDoc | null> {
    return this.executeWithLogging(
      'updateById',
      () =>
        this.model
          .findOneAndUpdate({ _id: id } as any, { $set: update } as any, { new: true })
          .lean<TDoc>()
          .exec(),
      { id },
    );
  }

  async updateMany(filter: FilterQuery<TDoc>, update: TUpdate): Promise<number> {
    return this.executeWithLogging('updateMany', async () => {
      const result = await this.model.updateMany(filter, {
        $set: update,
      } as any);
      return result.modifiedCount;
    });
  }

  async deleteById(id: string): Promise<boolean> {
    return this.executeWithLogging(
      'deleteById',
      async () => {
        const result = await this.model.deleteOne({ _id: id } as any);
        return result.deletedCount > 0;
      },
      { id },
    );
  }

  async softDelete(id: string): Promise<TDoc | null> {
    return this.executeWithLogging(
      'softDelete',
      () =>
        this.model
          .findOneAndUpdate({ _id: id } as any, { $set: { deletedAt: new Date() } } as any, {
            new: true,
          })
          .lean<TDoc>()
          .exec(),
      { id },
    );
  }

  async restore(id: string): Promise<TDoc | null> {
    return this.executeWithLogging(
      'restore',
      () =>
        this.model
          .findOneAndUpdate({ _id: id } as any, { $set: { deletedAt: null } } as any, { new: true })
          .lean<TDoc>()
          .exec(),
      { id },
    );
  }

  // ─── Pagination ────────────────────────────────────────────────────

  async paginate(
    filter: FilterQuery<TDoc>,
    opts: PaginationOptions = {},
  ): Promise<PaginatedResult<TDoc>> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const sort = opts.sort ?? { createdAt: -1 as const };

    return this.executeWithLogging(
      'paginate',
      async () => {
        const f = this.applySoftDeleteFilter(filter);

        const [data, total] = await Promise.all([
          this.model
            .find(f)
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean<TDoc[]>()
            .exec(),
          this.model.countDocuments(f).exec(),
        ]);

        const totalPages = Math.ceil(total / limit);

        return {
          data,
          total,
          page,
          limit,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        };
      },
      { page, limit },
    );
  }

  async cursorPaginate(
    filter: FilterQuery<TDoc>,
    opts: CursorOptions = {},
  ): Promise<CursorResult<TDoc>> {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const sort = opts.sort ?? { _id: -1 as const };
    const direction = opts.direction ?? 'forward';

    return this.executeWithLogging(
      'cursorPaginate',
      async () => {
        const f = this.applySoftDeleteFilter(filter);
        const cursorFilter = { ...f } as Record<string, unknown>;

        // Apply cursor — use _id as cursor value
        if (opts.cursor) {
          const sortField = Object.keys(sort)[0] ?? '_id';
          const sortDir = Object.values(sort)[0] ?? -1;
          const op =
            (direction === 'forward' && sortDir === -1) ||
            (direction === 'backward' && sortDir === 1)
              ? '$lt'
              : '$gt';

          cursorFilter[sortField] = { [op]: opts.cursor };
        }

        // Fetch one extra to detect hasMore
        const data = await this.model
          .find(cursorFilter as FilterQuery<TDoc>)
          .sort(sort)
          .limit(limit + 1)
          .lean<TDoc[]>()
          .exec();

        const hasMore = data.length > limit;
        if (hasMore) data.pop();

        const nextCursor =
          hasMore && data.length > 0 ? (data[data.length - 1]._id as string) : null;

        const prevCursor = opts.cursor && data.length > 0 ? (data[0]._id as string) : null;

        return { data, nextCursor, prevCursor, hasMore };
      },
      { cursor: opts.cursor, limit },
    );
  }

  // ─── Aggregation ───────────────────────────────────────────────────

  async aggregate<T = unknown>(pipeline: PipelineStage[]): Promise<T[]> {
    return this.executeWithLogging('aggregate', () => this.model.aggregate<T>(pipeline).exec(), {
      pipelineStages: pipeline.length,
    });
  }

  async count(filter: FilterQuery<TDoc>): Promise<number> {
    return this.executeWithLogging('count', () => {
      const f = this.applySoftDeleteFilter(filter);
      return this.model.countDocuments(f).exec();
    });
  }

  async exists(filter: FilterQuery<TDoc>): Promise<boolean> {
    return this.executeWithLogging('exists', async () => {
      const f = this.applySoftDeleteFilter(filter);
      const doc = await this.model.findOne(f).select('_id').lean().exec();
      return doc !== null;
    });
  }

  async distinct<T = unknown>(field: string, filter?: FilterQuery<TDoc>): Promise<T[]> {
    return this.executeWithLogging('distinct', () => {
      const f = filter ? this.applySoftDeleteFilter(filter) : {};
      return this.model.distinct(field, f).exec() as Promise<T[]>;
    });
  }

  // ─── Bulk Operations ───────────────────────────────────────────────

  async bulkWrite(ops: AnyBulkWriteOperation<TDoc>[]): Promise<mongoose.mongo.BulkWriteResult> {
    return this.executeWithLogging('bulkWrite', () => this.model.bulkWrite(ops as any), {
      opCount: ops.length,
    });
  }

  async upsert(filter: FilterQuery<TDoc>, update: TUpdate): Promise<TDoc> {
    return this.executeWithLogging('upsert', async () => {
      const doc = await this.model
        .findOneAndUpdate(filter, { $set: update } as any, {
          new: true,
          upsert: true,
        })
        .lean<TDoc>()
        .exec();
      return doc!;
    });
  }

  // ─── Transactions ──────────────────────────────────────────────────

  async withTransaction<T>(fn: (session: ClientSession | null) => Promise<T>): Promise<T> {
    // Check if transactions are supported (replica set / mongos)
    let useTx = false;
    try {
      const admin = mongoose.connection.db!.admin();
      const info = await admin.command({ hello: 1 });
      useTx = !!(info['setName'] || info['msg'] === 'isdbgrid');
    } catch {
      useTx = false;
    }

    if (!useTx) {
      return fn(null);
    }

    const session = await mongoose.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  // ─── Change Streams ────────────────────────────────────────────────

  watch(
    pipeline?: Record<string, unknown>[],
    options?: mongoose.mongo.ChangeStreamOptions,
  ): mongoose.mongo.ChangeStream<TDoc> {
    return this.model.watch(pipeline, options) as any;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Execute an operation with timing, slow query logging, and error classification.
   */
  protected async executeWithLogging<T>(
    operation: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>,
  ): Promise<T> {
    const start = Date.now();

    try {
      const result = await fn();
      const duration = Date.now() - start;

      if (duration > this.slowQueryMs) {
        this.logger.warn('[SLOW_QUERY]', {
          collection: this.collectionName,
          operation,
          durationMs: duration,
          threshold: this.slowQueryMs,
          ...meta,
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - start;

      const appError = wrapError(error, this.collectionName, operation, duration);

      this.logger.error('[MONGO_ERROR]', {
        collection: this.collectionName,
        operation,
        code: appError.code,
        durationMs: duration,
        retryable: appError.retryable,
        error: appError.message,
        ...meta,
      });

      throw appError;
    }
  }

  /**
   * Auto-exclude soft-deleted documents unless explicitly requested.
   */
  private applySoftDeleteFilter(filter: FilterQuery<TDoc>, opts?: QueryOptions): FilterQuery<TDoc> {
    if (opts?.includeSoftDeleted) return filter;

    return {
      ...filter,
      deletedAt: { $eq: null },
    } as FilterQuery<TDoc>;
  }

  /**
   * Apply common query options to a Mongoose query.
   */
  private applyQueryOptions(query: any, opts?: QueryOptions): void {
    if (!opts) return;
    if (opts.sort) query.sort(opts.sort);
    if (opts.limit) query.limit(opts.limit);
    if (opts.skip) query.skip(opts.skip);
    if (opts.readPreference) query.read(opts.readPreference);
  }
}
