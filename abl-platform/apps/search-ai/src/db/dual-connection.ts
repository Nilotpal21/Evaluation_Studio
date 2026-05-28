/**
 * Dual Database Connection Manager for SearchAI
 *
 * SearchAI uses TWO MongoDB databases:
 * 1. Platform DB (abl_platform) - Application config (KB metadata, projects, tenant models)
 * 2. Content DB (search_ai) - Search content (chunks, documents, extracted data)
 *
 * This enables:
 * - Separation of concerns (config vs content)
 * - Independent scaling (content DB can grow massive)
 * - Different backup/retention policies
 * - Performance isolation
 */

import mongoose, { Connection } from 'mongoose';
import type { MongoDBConfig } from '@agent-platform/database';

interface DualConnectionConfig {
  platformDb: MongoDBConfig;
  contentDb: MongoDBConfig;
}

export class SearchAIDualConnection {
  private static instance: SearchAIDualConnection | null = null;

  private platformConnection: Connection | null = null;
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
      SearchAIDualConnection.instance.platformConnection?.readyState === 1 &&
      SearchAIDualConnection.instance.contentConnection?.readyState === 1
    );
  }

  /**
   * Connect to both databases
   */
  private async connect(): Promise<void> {
    const { platformDb, contentDb } = this.config;

    console.log('[SearchAI] Connecting to Platform DB...', {
      database: platformDb.database,
    });

    // Platform connection (abl_platform)
    this.platformConnection = await mongoose
      .createConnection(platformDb.url, {
        dbName: platformDb.database,
        maxPoolSize: platformDb.maxPoolSize,
        minPoolSize: platformDb.minPoolSize,
        serverSelectionTimeoutMS: platformDb.serverSelectionTimeoutMs,
        socketTimeoutMS: platformDb.socketTimeoutMs,
        heartbeatFrequencyMS: platformDb.heartbeatFrequencyMs,
        retryWrites: true,
        w: 'majority',
        bufferCommands: false,
      })
      .asPromise();

    console.log('[SearchAI] Connected to Platform DB', {
      database: platformDb.database,
      host: this.platformConnection.host,
    });

    console.log('[SearchAI] Connecting to Content DB...', {
      database: contentDb.database,
    });

    // Content connection (search_ai)
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
      })
      .asPromise();

    console.log('[SearchAI] Connected to Content DB', {
      database: contentDb.database,
      host: this.contentConnection.host,
    });
  }

  /**
   * Get platform connection (for app config models)
   * Models: KnowledgeBase, SearchIndex, TenantModel, LLMCredential, Project, User
   */
  getPlatformConnection(): Connection {
    if (!this.platformConnection) {
      throw new Error('Platform connection not initialized');
    }
    return this.platformConnection;
  }

  /**
   * Get content connection (for search data models)
   * Models: SearchChunk, SearchDocument, SearchSource (file uploads, extracted content)
   */
  getContentConnection(): Connection {
    if (!this.contentConnection) {
      throw new Error('Content connection not initialized');
    }
    return this.contentConnection;
  }

  /**
   * Disconnect both databases
   */
  async disconnect(): Promise<void> {
    if (this.platformConnection) {
      await this.platformConnection.close();
      this.platformConnection = null;
    }
    if (this.contentConnection) {
      await this.contentConnection.close();
      this.contentConnection = null;
    }
    SearchAIDualConnection.instance = null;
  }

  /**
   * Health check for both connections
   */
  async healthCheck(): Promise<{
    platform: boolean;
    content: boolean;
    ok: boolean;
  }> {
    const platformOk = this.platformConnection?.readyState === 1;
    const contentOk = this.contentConnection?.readyState === 1;

    return {
      platform: platformOk,
      content: contentOk,
      ok: platformOk && contentOk,
    };
  }
}
