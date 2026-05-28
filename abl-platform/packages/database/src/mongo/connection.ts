/**
 * MongoDB Connection Manager (Singleton)
 *
 * Manages the Mongoose connection lifecycle with:
 * - Singleton pattern (follows Redis client pattern)
 * - Exponential backoff reconnection
 * - APM command monitoring for slow query detection
 * - Graceful shutdown with pool draining
 * - Health check endpoint support
 */

import mongoose from 'mongoose';
import type { ConnectOptions, Connection } from 'mongoose';
import type { MongoDBConfig } from './types.js';
import { leanIdPlugin } from './plugins/lean-id.plugin.js';

async function ensureSharedAuditTTLIndex(): Promise<void> {
  const { ensureAuditLogTTLIndex } = await import('../models/audit-log.model.js');
  await ensureAuditLogTTLIndex();
}

// ─── Types ───────────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface HealthCheckResult {
  ok: boolean;
  state: ConnectionState;
  latencyMs: number;
  replicaSet?: string;
  host?: string;
}

/** Payload passed to pool checkout failure callbacks. */
export interface PoolCheckoutFailureEvent {
  reason: string;
  timestamp: number;
}

/** Callback type for pool monitoring hooks. */
export type PoolEventCallback = (event: PoolCheckoutFailureEvent) => void;

/** Simple callback for pool lifecycle events (no payload needed). */
export type PoolLifecycleCallback = () => void;

interface CommandEvent {
  requestId: number;
  commandName: string;
  databaseName: string;
  duration?: number;
  failure?: string;
}

// ─── Logger (lazy, avoids circular deps) ─────────────────────────────────

interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function getLogger(): Logger {
  // Minimal console-based logger — can be replaced by platform logger
  return {
    debug: (msg, data) => console.debug(`[MongoDB] ${msg}`, data ?? ''),
    info: (msg, data) => console.log(`[MongoDB] ${msg}`, data ?? ''),
    warn: (msg, data) => console.warn(`[MongoDB] ${msg}`, data ?? ''),
    error: (msg, data) => console.error(`[MongoDB] ${msg}`, data ?? ''),
  };
}

// ─── Connection Manager ──────────────────────────────────────────────────

export class MongoConnectionManager {
  private static instance: MongoConnectionManager | null = null;

  private config: MongoDBConfig;
  private _state: ConnectionState = 'disconnected';
  private retryCount = 0;
  private readonly MAX_RETRIES = 5;
  private readonly logger: Logger;
  private commandTimers = new Map<number, { start: number; command: string }>();
  private listenerRegistered = false;
  private monitoringRegistered = false;
  private poolCheckoutFailureCallbacks: PoolEventCallback[] = [];
  private poolCheckedOutCallbacks: PoolLifecycleCallback[] = [];
  private poolCheckedInCallbacks: PoolLifecycleCallback[] = [];
  private poolConnectionCreatedCallbacks: PoolLifecycleCallback[] = [];
  private poolConnectionClosedCallbacks: PoolLifecycleCallback[] = [];
  private isDisconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_BASE_DELAY_MS = 1_000;
  private readonly RECONNECT_MAX_DELAY_MS = 30_000;

  private constructor(config: MongoDBConfig) {
    this.config = config;
    this.logger = getLogger();
  }

  // ─── Singleton Access ────────────────────────────────────────────────

  /** Get the existing instance. Throws if not initialized. */
  static getInstance(): MongoConnectionManager {
    if (!MongoConnectionManager.instance) {
      throw new Error(
        'MongoConnectionManager not initialized. Call MongoConnectionManager.initialize(config) first.',
      );
    }
    return MongoConnectionManager.instance;
  }

  /** Initialize and connect. Idempotent — returns existing instance if already connected. */
  static async initialize(config: MongoDBConfig): Promise<MongoConnectionManager> {
    if (MongoConnectionManager.instance) {
      return MongoConnectionManager.instance;
    }

    const manager = new MongoConnectionManager(config);
    MongoConnectionManager.instance = manager;

    await manager.connect();

    // Apply lean-id plugin to all already-compiled schemas (models are
    // imported at module-load time, before initialize() runs). Mongoose
    // buffers queries until connected, so the hooks are in place before
    // any query actually executes.
    for (const name of mongoose.modelNames()) {
      mongoose.model(name).schema.plugin(leanIdPlugin);
    }
    // Also register globally for any schemas compiled after this point.
    mongoose.plugin(leanIdPlugin);
    return manager;
  }

  /** Check if a connection is available without throwing. */
  static isAvailable(): boolean {
    return (
      MongoConnectionManager.instance !== null &&
      MongoConnectionManager.instance._state === 'connected'
    );
  }

  /** Reset singleton (for tests). Disconnects if connected. */
  static async reset(): Promise<void> {
    if (MongoConnectionManager.instance) {
      const instance = MongoConnectionManager.instance;
      await instance.disconnect();
      // Reset listener flags so a new instance can register them
      instance.listenerRegistered = false;
      instance.monitoringRegistered = false;
      instance.poolCheckoutFailureCallbacks = [];
      instance.poolCheckedOutCallbacks = [];
      instance.poolCheckedInCallbacks = [];
      instance.poolConnectionCreatedCallbacks = [];
      instance.poolConnectionClosedCallbacks = [];
      MongoConnectionManager.instance = null;
    }
  }

  // ─── State ───────────────────────────────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  get connection(): Connection {
    return mongoose.connection;
  }

  // ─── Pool Event Hooks ─────────────────────────────────────────────────

  /**
   * Register a callback invoked when a MongoDB connection pool checkout fails.
   * This allows consumers (e.g., the runtime) to wire OTEL metrics or alerting
   * without the database package depending on observability libraries.
   */
  onPoolCheckoutFailed(callback: PoolEventCallback): void {
    this.poolCheckoutFailureCallbacks.push(callback);
  }

  /** Register a callback invoked when a connection is checked out from the pool. */
  onPoolCheckedOut(callback: PoolLifecycleCallback): void {
    this.poolCheckedOutCallbacks.push(callback);
  }

  /** Register a callback invoked when a connection is checked back into the pool. */
  onPoolCheckedIn(callback: PoolLifecycleCallback): void {
    this.poolCheckedInCallbacks.push(callback);
  }

  /** Register a callback invoked when a new pool connection is created. */
  onPoolConnectionCreated(callback: PoolLifecycleCallback): void {
    this.poolConnectionCreatedCallbacks.push(callback);
  }

  /** Register a callback invoked when a pool connection is closed. */
  onPoolConnectionClosed(callback: PoolLifecycleCallback): void {
    this.poolConnectionClosedCallbacks.push(callback);
  }

  // ─── Connect / Disconnect ────────────────────────────────────────────

  async connect(): Promise<void> {
    // Check mongoose connection state first - prevents duplicate connection attempts
    if (mongoose.connection.readyState === 1) {
      await ensureSharedAuditTTLIndex();
      this.logger.info('Already connected to MongoDB (readyState=1)');
      this._state = 'connected';
      return;
    }

    if (this._state === 'connected') return;
    if (this._state === 'connecting') return;

    this._state = 'connecting';
    this.setupEventListeners();
    await this.connectWithRetry();
    await ensureSharedAuditTTLIndex();

    // APM command monitoring requires the driver topology to exist,
    // so it must be registered AFTER the connection is established.
    this.setupMonitoring();
  }

  async disconnect(): Promise<void> {
    if (this._state === 'disconnected') return;

    this.logger.info('Disconnecting from MongoDB...');
    this.isDisconnecting = true;

    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      // false = drain pool, don't force close
      await mongoose.connection.close(false);
      this._state = 'disconnected';
      this.commandTimers.clear();
      this.logger.info('Disconnected from MongoDB');
    } catch (error) {
      this.logger.error('Error disconnecting from MongoDB', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.isDisconnecting = false;
    }
  }

  // ─── Health Check ────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    if (this._state !== 'connected') {
      return {
        ok: false,
        state: this._state,
        latencyMs: 0,
      };
    }

    const start = Date.now();
    try {
      const admin = mongoose.connection.db!.admin();
      const result = await admin.ping();
      const latencyMs = Date.now() - start;

      const serverStatus = await admin.serverStatus().catch(() => null);

      return {
        ok: result.ok === 1,
        state: this._state,
        latencyMs,
        replicaSet: serverStatus?.repl?.setName,
        host: mongoose.connection.host ?? undefined,
      };
    } catch {
      return {
        ok: false,
        state: this._state,
        latencyMs: Date.now() - start,
      };
    }
  }

  // ─── Connection Options Builder ──────────────────────────────────────

  private buildConnectionOptions(): ConnectOptions {
    const opts: ConnectOptions = {
      dbName: this.config.database,

      // Pool
      maxPoolSize: this.config.maxPoolSize,
      minPoolSize: this.config.minPoolSize,
      maxIdleTimeMS: this.config.maxIdleTimeMs,
      waitQueueTimeoutMS: this.config.waitQueueTimeoutMs ?? 10_000,

      // Timeouts
      connectTimeoutMS: this.config.connectTimeoutMs,
      socketTimeoutMS: this.config.socketTimeoutMs,
      serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMs,
      heartbeatFrequencyMS: this.config.heartbeatFrequencyMs,

      // Write/Read
      w:
        this.config.writeConcern === '0'
          ? 0
          : this.config.writeConcern === '1'
            ? 1
            : this.config.writeConcern,
      readPreference: this.config.readPreference,
      retryWrites: this.config.retryWrites,
      retryReads: this.config.retryReads,

      // Performance
      autoIndex: this.config.autoIndex,
      appName: this.config.appName,

      // Sharding
      directConnection: this.config.directConnection,

      // APM — enable command monitoring for slow query detection
      monitorCommands: true,
    };

    // Auth
    if (this.config.authSource) {
      opts.authSource = this.config.authSource;
    }
    if (this.config.authMechanism) {
      opts.authMechanism = this.config.authMechanism as any;
    }

    // Replica set (if not auto-detected from SRV)
    if (this.config.replicaSet) {
      opts.replicaSet = this.config.replicaSet;
    }

    // Read concern
    if (this.config.readConcern) {
      opts.readConcern = { level: this.config.readConcern };
    }

    // TLS/SSL
    if (this.config.tls) {
      opts.tls = true;
      if (this.config.tlsCAFile) {
        opts.tlsCAFile = this.config.tlsCAFile;
      }
      if (this.config.tlsCertFile) {
        opts.tlsCertificateKeyFile = this.config.tlsCertFile;
      }
      if (this.config.tlsAllowInvalidCertificates) {
        opts.tlsAllowInvalidCertificates = true;
      }
    }

    // Compression
    if (this.config.compressors) {
      opts.compressors = this.config.compressors as any;
    }

    return opts;
  }

  // ─── Event Listeners ─────────────────────────────────────────────────

  private setupEventListeners(): void {
    // Prevent duplicate event listener registration
    if (this.listenerRegistered) {
      this.logger.debug('Event listeners already registered, skipping');
      return;
    }

    this.listenerRegistered = true;
    const conn = mongoose.connection;

    conn.on('connected', () => {
      this._state = 'connected';
      this.retryCount = 0;
      this.reconnectAttempts = 0;
      this.logger.info('Connected to MongoDB', {
        database: this.config.database,
        host: conn.host ?? 'unknown',
      });
    });

    conn.on('disconnected', () => {
      if (this._state !== 'disconnected') {
        const wasConnected = this._state === 'connected';
        this._state = 'disconnected';
        if (!this.isDisconnecting) {
          this.logger.warn('Disconnected from MongoDB');

          // Attempt automatic reconnection if this was an unexpected disconnect
          if (wasConnected) {
            this.scheduleReconnect();
          }
        }
      }
    });

    conn.on('error', (error) => {
      this._state = 'error';
      this.logger.error('MongoDB connection error', {
        error: error.message,
      });
    });

    conn.on('reconnected', () => {
      this._state = 'connected';
      this.logger.info('Reconnected to MongoDB');
    });
  }

  private setupMonitoring(): void {
    // Prevent duplicate monitoring listener registration
    if (this.monitoringRegistered) {
      this.logger.debug('Monitoring listeners already registered, skipping');
      return;
    }

    this.monitoringRegistered = true;
    const conn = mongoose.connection;
    const threshold = this.config.slowQueryThresholdMs;

    conn.on('commandStarted', (event: CommandEvent) => {
      this.commandTimers.set(event.requestId, {
        start: Date.now(),
        command: event.commandName,
      });
    });

    conn.on('commandSucceeded', (event: CommandEvent & { duration: number }) => {
      const timer = this.commandTimers.get(event.requestId);
      this.commandTimers.delete(event.requestId);

      const durationMs = timer ? Date.now() - timer.start : event.duration;

      if (durationMs > threshold) {
        this.logger.warn('[SLOW_QUERY]', {
          command: event.commandName,
          database: event.databaseName,
          durationMs,
          threshold,
        });
      }
    });

    conn.on('commandFailed', (event: CommandEvent & { failure: string }) => {
      this.commandTimers.delete(event.requestId);
      if (this.isDisconnecting) {
        return;
      }
      this.logger.error('[COMMAND_FAILED]', {
        command: event.commandName,
        database: event.databaseName,
        failure: event.failure,
      });
    });

    // Topology events
    conn.on('serverHeartbeatFailed', (event: any) => {
      this.logger.warn('[HEARTBEAT_FAILED]', {
        connectionId: event?.connectionId,
        failure: event?.failure?.message,
      });
    });

    // Pool checkout failure monitoring (pool exhaustion signal)
    // The `topology` property is internal to the MongoDB Node.js driver and
    // not exposed in the public TypeScript types. Cast through `any` to access
    // the CMAP (Connection Monitoring and Pooling) event emitter.
    const topology = (conn.getClient() as any).topology;
    if (topology) {
      topology.on('connectionCheckOutFailed', (event: any) => {
        const reason = event?.reason ?? 'unknown';
        if (this.isDisconnecting && reason === 'poolClosed') {
          return;
        }
        this.logger.warn('[POOL_CHECKOUT_FAILED]', { reason });
        const payload: PoolCheckoutFailureEvent = {
          reason,
          timestamp: Date.now(),
        };
        for (const cb of this.poolCheckoutFailureCallbacks) {
          try {
            cb(payload);
          } catch (err) {
            this.logger.error('Pool checkout failure callback error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      // Pool utilization CMAP events
      topology.on('connectionCheckedOut', () => {
        for (const cb of this.poolCheckedOutCallbacks) {
          try {
            cb();
          } catch (err) {
            this.logger.error('Pool lifecycle callback error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      topology.on('connectionCheckedIn', () => {
        for (const cb of this.poolCheckedInCallbacks) {
          try {
            cb();
          } catch (err) {
            this.logger.error('Pool lifecycle callback error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      topology.on('connectionCreated', () => {
        for (const cb of this.poolConnectionCreatedCallbacks) {
          try {
            cb();
          } catch (err) {
            this.logger.error('Pool lifecycle callback error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      topology.on('connectionClosed', () => {
        for (const cb of this.poolConnectionClosedCallbacks) {
          try {
            cb();
          } catch (err) {
            this.logger.error('Pool lifecycle callback error', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
    }
  }

  // ─── Auto-Reconnect ──────────────────────────────────────────────────

  /**
   * Schedule an automatic reconnection attempt with exponential backoff.
   * Called when an unexpected disconnect is detected (not during shutdown).
   */
  private scheduleReconnect(): void {
    if (this.isDisconnecting) return;
    if (this.reconnectTimer) return; // already scheduled

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Auto-reconnect exhausted after ${this.MAX_RECONNECT_ATTEMPTS} attempts — manual restart required`,
      );
      this._state = 'error';
      return;
    }

    const delay = Math.min(
      this.RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      this.RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;

    this.logger.warn(
      `Scheduling auto-reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isDisconnecting || mongoose.connection.readyState === 1) return;

      try {
        this._state = 'connecting';
        const url = this.config.url;
        const options = this.buildConnectionOptions();
        await mongoose.connect(url, options);
        await ensureSharedAuditTTLIndex();
        this.reconnectAttempts = 0;
        this.logger.info('Auto-reconnect succeeded');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error('Auto-reconnect failed', { attempt: this.reconnectAttempts, error: msg });
        this._state = 'disconnected';
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ─── Connect with Retry ──────────────────────────────────────────────

  private async connectWithRetry(): Promise<void> {
    const url = this.config.url;
    const options = this.buildConnectionOptions();

    this.logger.info('MongoDB connection options', {
      writeConcern: options.w,
      readPreference: options.readPreference,
      database: options.dbName,
      maxPoolSize: options.maxPoolSize,
    });

    while (this.retryCount <= this.MAX_RETRIES) {
      try {
        const readyState = mongoose.connection.readyState;
        this.logger.info(
          `Connecting to MongoDB (attempt ${this.retryCount + 1}/${this.MAX_RETRIES + 1})...`,
          {
            database: this.config.database,
            currentReadyState: readyState,
            readyStateDescription:
              ['disconnected', 'connected', 'connecting', 'disconnecting'][readyState] || 'unknown',
          },
        );

        // Additional safety check - if already connected, don't call mongoose.connect()
        if (readyState === 1) {
          this.logger.info('Connection already established (readyState=1), skipping connect()');
          this._state = 'connected';
          return;
        }

        if (process.env.NODE_ENV === 'production') {
          try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'mongodb+srv:' && !options.tls) {
              this.logger.warn(
                'MongoDB connection without TLS in production — strongly recommended',
              );
            }
          } catch {
            // URL parsing failed — don't block startup
          }
        }

        await mongoose.connect(url, options);
        return;
      } catch (error) {
        this.retryCount++;

        if (this.retryCount > this.MAX_RETRIES) {
          this._state = 'error';
          this.logger.error(`Failed to connect to MongoDB after ${this.MAX_RETRIES + 1} attempts`, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw new Error(
            `MongoDB connection failed after ${this.MAX_RETRIES + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delay = Math.min(1000 * 2 ** (this.retryCount - 1), 16_000);
        this.logger.warn(`MongoDB connection failed, retrying in ${delay}ms...`, {
          attempt: this.retryCount,
          maxRetries: this.MAX_RETRIES,
          error: error instanceof Error ? error.message : String(error),
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
