/**
 * Delta Token Manager
 *
 * Manages per-drive delta tokens for SharePoint incremental sync.
 * Each drive maintains its own delta token for efficient change tracking.
 *
 * Delta tokens enable the connector to fetch only changed items since the last sync,
 * improving performance by ~10x compared to full enumeration.
 */

import type { IDriveDeltaToken } from '@agent-platform/database';
import type { Model } from 'mongoose';

// ─── Delta Token Manager ─────────────────────────────────────────────────────

export class DeltaTokenManager {
  private tenantId: string;
  private connectorId: string;
  private model: Model<IDriveDeltaToken>;

  constructor(tenantId: string, connectorId: string, model: Model<IDriveDeltaToken>) {
    this.tenantId = tenantId;
    this.connectorId = connectorId;
    this.model = model;
  }

  /**
   * Get delta token for a specific drive.
   * Returns null if no token exists (first sync).
   */
  async getToken(driveId: string): Promise<string | null> {
    const record = await this.model
      .findOne({
        tenantId: this.tenantId,
        connectorId: this.connectorId,
        driveId,
      })
      .lean();

    return record?.deltaLink || null;
  }

  /**
   * Save or update delta token for a drive.
   * Records the token, timestamp, and items processed count.
   */
  async saveToken(driveId: string, deltaLink: string, itemsProcessed: number = 0): Promise<void> {
    await this.model.findOneAndUpdate(
      {
        tenantId: this.tenantId,
        connectorId: this.connectorId,
        driveId,
      },
      {
        $set: {
          deltaLink,
          lastSyncAt: new Date(),
        },
        $inc: {
          itemsProcessedSinceToken: itemsProcessed,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  }

  /**
   * Reset (delete) delta token for a drive.
   * Next sync will perform full enumeration and establish a new token.
   */
  async resetToken(driveId: string): Promise<void> {
    await this.model.deleteOne({
      tenantId: this.tenantId,
      connectorId: this.connectorId,
      driveId,
    });
  }

  /**
   * Get all delta tokens for this connector.
   * Returns Map<driveId, deltaLink> for all drives with tokens.
   */
  async getAllTokens(): Promise<Map<string, string>> {
    const records = await this.model
      .find({
        tenantId: this.tenantId,
        connectorId: this.connectorId,
      })
      .lean();

    const tokens = new Map<string, string>();
    for (const record of records) {
      tokens.set(record.driveId, record.deltaLink);
    }

    return tokens;
  }

  /**
   * Get all delta token records for this connector.
   * Returns full token metadata including timestamps and item counts.
   */
  async getAllTokenRecords(): Promise<IDriveDeltaToken[]> {
    return await this.model
      .find({
        tenantId: this.tenantId,
        connectorId: this.connectorId,
      })
      .lean();
  }

  /**
   * Reset all delta tokens for this connector.
   * Forces full sync on next run.
   */
  async resetAllTokens(): Promise<void> {
    await this.model.deleteMany({
      tenantId: this.tenantId,
      connectorId: this.connectorId,
    });
  }

  /**
   * Get stale tokens that haven't been updated in a specified time.
   * Useful for detecting abandoned drives or cleanup.
   *
   * @param olderThanHours - Consider tokens stale if not synced in this many hours
   */
  async getStaleTokens(olderThanHours: number = 48): Promise<IDriveDeltaToken[]> {
    const staleThreshold = new Date();
    staleThreshold.setHours(staleThreshold.getHours() - olderThanHours);

    return await this.model
      .find({
        tenantId: this.tenantId,
        connectorId: this.connectorId,
        lastSyncAt: { $lt: staleThreshold },
      })
      .lean();
  }

  /**
   * Get token statistics for monitoring.
   */
  async getTokenStats(): Promise<{
    totalTokens: number;
    totalItemsProcessed: number;
    oldestSync: Date | null;
    newestSync: Date | null;
  }> {
    const records = await this.getAllTokenRecords();

    if (records.length === 0) {
      return {
        totalTokens: 0,
        totalItemsProcessed: 0,
        oldestSync: null,
        newestSync: null,
      };
    }

    const totalItemsProcessed = records.reduce((sum, r) => sum + r.itemsProcessedSinceToken, 0);

    const syncDates = records.map((r) => r.lastSyncAt).sort((a, b) => a.getTime() - b.getTime());

    return {
      totalTokens: records.length,
      totalItemsProcessed,
      oldestSync: syncDates[0],
      newestSync: syncDates[syncDates.length - 1],
    };
  }
}
