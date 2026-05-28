/**
 * Dual Database Connection Manager for SearchAI Runtime
 *
 * SearchAI Runtime uses TWO MongoDB databases:
 * 1. Platform DB (abl_platform) - Application config (KB metadata, tenant models, LLM credentials)
 * 2. Content DB (search_ai) - Search content (chunks, documents, vocabulary, schemas)
 *
 * This enables:
 * - Separation of concerns (config vs content)
 * - Independent scaling (content DB can grow massive)
 * - Different backup/retention policies
 * - Performance isolation
 *
 * IMPORTANT: The platform connection IS the default `mongoose.connection`,
 * managed via the shared `MongoConnectionManager` (same as runtime / studio /
 * workflow-engine / multimodal-service / academy). This is required because
 * several models (notably DEKEntry) are bound at module-import time to
 * `mongoose.connection`. If we used `mongoose.createConnection()` for the
 * platform DB instead, queries against those default-bound models would
 * buffer for `bufferTimeoutMS` (10s default) and time out — and every
 * encrypted-field decrypt would fail because `dekManager.unwrapDEK` reads
 * `DEKEntry`. The content DB is a separate named connection because it
 * holds different data and may be scaled independently.
 */

import mongoose, { Connection } from 'mongoose';
import type { MongoDBConfig } from '@agent-platform/database';
import { MongoConnectionManager } from '@agent-platform/database/mongo';

interface DualConnectionConfig {
  platformDb: MongoDBConfig;
  contentDb: MongoDBConfig;
}

export class SearchAIDualConnection {
  private static instance: SearchAIDualConnection | null = null;

  private contentConnection: Connection | null = null;
  private config: DualConnectionConfig;

  private constructor(config: DualConnectionConfig) {
    this.config = config;
  }

  /**
   * Initialize both database connections
   */
  static async initialize(config: DualConnectionConfig): Promise<SearchAIDualConnection> {
    if (SearchAIDualConnection.instance) {
      return SearchAIDualConnection.instance;
    }

    const manager = new SearchAIDualConnection(config);
    SearchAIDualConnection.instance = manager;

    await manager.connect();
    return manager;
  }

  static getInstance(): SearchAIDualConnection {
    if (!SearchAIDualConnection.instance) {
      throw new Error('SearchAIDualConnection not initialized. Call initialize() first.');
    }
    return SearchAIDualConnection.instance;
  }

  static isAvailable(): boolean {
    return (
      SearchAIDualConnection.instance !== null &&
      mongoose.connection.readyState === 1 &&
      SearchAIDualConnection.instance.contentConnection?.readyState === 1
    );
  }

  /**
   * Connect to both databases.
   *
   * - Platform DB: connected via the shared `MongoConnectionManager`, which
   *   uses `mongoose.connect()` and exposes the connection as the default
   *   `mongoose.connection`. This makes module-level model bindings (e.g.
   *   `DEKEntry = model('DEKEntry', schema)`) point at a real backend.
   * - Content DB: connected via `mongoose.createConnection()` as a separate
   *   named connection (no module-level models target it).
   */
  private async connect(): Promise<void> {
    const { platformDb, contentDb } = this.config;

    // Platform connection (abl_platform) — bound to default mongoose.connection
    await MongoConnectionManager.initialize(platformDb);

    // Content connection (search_ai) — separate named connection
    this.contentConnection = await mongoose
      .createConnection(contentDb.url, {
        dbName: contentDb.database,
        maxPoolSize: contentDb.maxPoolSize,
        minPoolSize: contentDb.minPoolSize,
        serverSelectionTimeoutMS: contentDb.serverSelectionTimeoutMs,
        socketTimeoutMS: contentDb.socketTimeoutMs,
        heartbeatFrequencyMS: contentDb.heartbeatFrequencyMs,
        retryWrites: true,
        w: 'majority',
        bufferCommands: false,
        appName: contentDb.appName,
      })
      .asPromise();
  }

  /**
   * Returns the platform connection — i.e. the default `mongoose.connection`.
   * Use this when binding platform-DB models (LLMCredential, KnowledgeBase, etc.)
   * to a connection in `ModelRegistry.bindModelsForSearchAI`.
   */
  getPlatformConnection(): Connection {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Platform connection not initialized');
    }
    return mongoose.connection;
  }

  getContentConnection(): Connection {
    if (!this.contentConnection) {
      throw new Error('Content connection not initialized');
    }
    return this.contentConnection;
  }

  async disconnect(): Promise<void> {
    // Platform: drain the default connection via the shared manager
    if (mongoose.connection.readyState === 1) {
      await MongoConnectionManager.getInstance().disconnect();
    }
    // Content: close the named connection
    if (this.contentConnection) {
      await this.contentConnection.close();
      this.contentConnection = null;
    }
    SearchAIDualConnection.instance = null;
  }

  async healthCheck(): Promise<{
    platform: boolean;
    content: boolean;
    ok: boolean;
  }> {
    const platformOk = mongoose.connection.readyState === 1;
    const contentOk = this.contentConnection?.readyState === 1;

    return {
      platform: platformOk,
      content: contentOk,
      ok: platformOk && contentOk,
    };
  }
}
