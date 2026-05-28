/**
 * MongoDB Handler Store Implementation
 *
 * Stores page handlers in MongoDB, keyed by template fingerprint.
 * Uses constructor-injected model for testability and decoupling.
 *
 * Responsibilities (Single Responsibility Principle):
 * - Upsert handlers by (tenantId, domain, fingerprint)
 * - Query handlers with tenant isolation
 * - Track success/failure counts and confidence
 * - Maintain lastUsedAt timestamps
 *
 * Design Principles:
 * - Dependency Inversion: Accepts model via constructor, implements IHandlerStore
 * - Single Responsibility: Only handles handler storage
 * - Resource Isolation: Every query includes tenantId
 */

import type { IHandlerStore, SaveHandlerInput, StoredHandler } from './interfaces.js';
import { HandlerStoreError } from './interfaces.js';
import { createLogger } from '../../logger.js';

const log = createLogger('mongo-handler-store');

/**
 * Minimal model interface for constructor injection.
 * Matches the Mongoose Model shape for the HandlerTemplate collection.
 */
export interface HandlerTemplateModel {
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<HandlerTemplateDoc | null>;
  findOne(filter: Record<string, unknown>): { lean<T>(): Promise<T | null> };
  find(filter: Record<string, unknown>): {
    sort(s: Record<string, unknown>): { lean<T>(): Promise<T> };
  };
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): { exec(): Promise<{ modifiedCount: number }> };
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
}

/** Shape of a HandlerTemplate document from MongoDB */
export interface HandlerTemplateDoc {
  _id: string;
  tenantId: string;
  domain: string;
  urlPattern: string;
  fingerprint: string;
  handler: StoredHandler['handler'];
  trainedOn: string[];
  successCount: number;
  failureCount: number;
  confidence: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class MongoHandlerStore implements IHandlerStore {
  constructor(private readonly model: HandlerTemplateModel) {}

  /**
   * Save or update a handler. Upserts by { tenantId, domain, fingerprint }.
   */
  async saveHandler(input: SaveHandlerInput): Promise<void> {
    try {
      const { tenantId, domain, fingerprint, urlPattern, handler, trainedOn } = input;

      await this.model.findOneAndUpdate(
        { tenantId, domain, fingerprint },
        {
          $set: {
            urlPattern,
            handler,
            trainedOn,
            lastUsedAt: new Date(),
          },
          $setOnInsert: {
            tenantId,
            domain,
            fingerprint,
            successCount: 0,
            failureCount: 0,
            confidence: 0,
          },
          $currentDate: { updatedAt: true },
        },
        { upsert: true, new: true },
      );

      log.info('Handler saved', { tenantId, domain, fingerprint });
    } catch (error) {
      const msg = `Failed to save handler: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId: input.tenantId, domain: input.domain });
      throw new HandlerStoreError(msg, 'SAVE_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Find a handler by its fingerprint. Touches lastUsedAt on read.
   */
  async findByFingerprint(
    tenantId: string,
    domain: string,
    fingerprint: string,
  ): Promise<StoredHandler | null> {
    try {
      const doc = await this.model
        .findOne({ tenantId, domain, fingerprint })
        .lean<HandlerTemplateDoc>();

      if (!doc) {
        return null;
      }

      // Touch lastUsedAt (fire and forget)
      this.model
        .updateOne({ tenantId, domain, fingerprint }, { $set: { lastUsedAt: new Date() } })
        .exec()
        .catch((err: unknown) => {
          log.warn('Failed to touch lastUsedAt', {
            tenantId,
            domain,
            fingerprint,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      return this.toStoredHandler(doc);
    } catch (error) {
      const msg = `Failed to find handler by fingerprint: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId, domain, fingerprint });
      throw new HandlerStoreError(msg, 'FIND_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Find all handlers for a domain, sorted by confidence descending.
   */
  async findByDomain(tenantId: string, domain: string): Promise<StoredHandler[]> {
    try {
      const docs = await this.model
        .find({ tenantId, domain })
        .sort({ confidence: -1 })
        .lean<HandlerTemplateDoc[]>();

      return docs.map((doc) => this.toStoredHandler(doc));
    } catch (error) {
      const msg = `Failed to find handlers by domain: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId, domain });
      throw new HandlerStoreError(msg, 'FIND_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Record a successful extraction. Increments successCount and recalculates confidence.
   */
  async recordSuccess(tenantId: string, domain: string, fingerprint: string): Promise<void> {
    try {
      await this.model
        .updateOne(
          { tenantId, domain, fingerprint },
          {
            $inc: { successCount: 1 },
            $set: { lastUsedAt: new Date() },
            $currentDate: { updatedAt: true },
          },
        )
        .exec();

      // Recalculate confidence
      await this.recalculateConfidence(tenantId, domain, fingerprint);

      log.debug('Recorded handler success', { tenantId, domain, fingerprint });
    } catch (error) {
      const msg = `Failed to record success: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId, domain, fingerprint });
      throw new HandlerStoreError(msg, 'UPDATE_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Record a failed extraction. Increments failureCount and recalculates confidence.
   */
  async recordFailure(tenantId: string, domain: string, fingerprint: string): Promise<void> {
    try {
      await this.model
        .updateOne(
          { tenantId, domain, fingerprint },
          {
            $inc: { failureCount: 1 },
            $currentDate: { updatedAt: true },
          },
        )
        .exec();

      // Recalculate confidence
      await this.recalculateConfidence(tenantId, domain, fingerprint);

      log.debug('Recorded handler failure', { tenantId, domain, fingerprint });
    } catch (error) {
      const msg = `Failed to record failure: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId, domain, fingerprint });
      throw new HandlerStoreError(msg, 'UPDATE_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Delete all handlers for a domain. Returns number deleted.
   */
  async deleteByDomain(tenantId: string, domain: string): Promise<number> {
    try {
      const result = await this.model.deleteMany({ tenantId, domain });
      log.info('Deleted handlers for domain', { tenantId, domain, count: result.deletedCount });
      return result.deletedCount;
    } catch (error) {
      const msg = `Failed to delete handlers: ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { tenantId, domain });
      throw new HandlerStoreError(msg, 'DELETE_ERROR', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Recalculate confidence as successCount / (successCount + failureCount).
   * Confidence is 0 when there are no recorded outcomes.
   */
  private async recalculateConfidence(
    tenantId: string,
    domain: string,
    fingerprint: string,
  ): Promise<void> {
    const doc = await this.model
      .findOne({ tenantId, domain, fingerprint })
      .lean<HandlerTemplateDoc>();

    if (!doc) {
      return;
    }

    const total = doc.successCount + doc.failureCount;
    const confidence = total > 0 ? doc.successCount / total : 0;

    await this.model.updateOne({ tenantId, domain, fingerprint }, { $set: { confidence } }).exec();
  }

  /**
   * Convert a HandlerTemplate document to a StoredHandler.
   */
  private toStoredHandler(doc: HandlerTemplateDoc): StoredHandler {
    return {
      tenantId: doc.tenantId,
      domain: doc.domain,
      urlPattern: doc.urlPattern,
      fingerprint: doc.fingerprint,
      handler: doc.handler,
      trainedOn: doc.trainedOn,
      successCount: doc.successCount,
      failureCount: doc.failureCount,
      confidence: doc.confidence,
      lastUsedAt: doc.lastUsedAt,
      createdAt: doc.createdAt,
    };
  }
}
