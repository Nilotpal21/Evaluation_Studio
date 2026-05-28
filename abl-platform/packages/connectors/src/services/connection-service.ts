/**
 * ConnectionService
 *
 * Framework-agnostic CRUD for connector connections.
 * Used by both Studio (Next.js) and workflow-engine (Express).
 *
 * Connections are pure binding records that link a connector to an auth profile.
 * All credential storage and encryption is handled by the auth profile system.
 *
 * Every query is scoped to { tenantId, projectId } for tenant isolation.
 */

import crypto from 'crypto';
import type { ConnectorRegistry } from '../registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('connection-service');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectionRecord {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  userId?: string;
  authProfileId: string;
  metadata?: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectionInput {
  connectorName: string;
  displayName: string;
  authProfileId: string;
  metadata?: Record<string, unknown>;
  scope?: 'tenant' | 'user';
}

export interface UpdateConnectionInput {
  displayName?: string;
  authProfileId?: string;
  metadata?: Record<string, unknown> | null;
  status?: 'active' | 'expired' | 'revoked';
}

export interface TestResult {
  success: boolean;
  error?: string;
  latencyMs: number;
}

/** Mongoose-like model interface so we don't import mongoose directly. */
export interface ConnectionModel {
  find(filter: Record<string, unknown>): {
    sort(sort: Record<string, unknown>): {
      lean(): Promise<ConnectionRecord[]>;
    };
  };
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<ConnectionRecord | null>;
  };
  create(data: Record<string, unknown>): Promise<ConnectionRecord>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ConnectionRecord | null>;
  findOneAndDelete(filter: Record<string, unknown>): Promise<ConnectionRecord | null>;
}

/** Auth profile resolver for credential resolution during connection tests */
export interface AuthProfileResolverLike {
  resolve(opts: {
    authProfileId: string;
    tenantId: string;
    projectId?: string;
    environment?: string;
  }): Promise<Record<string, unknown>>;
}

export interface ConnectionServiceDeps {
  connectionModel: ConnectionModel;
  registry: ConnectorRegistry;
  authProfileResolver?: AuthProfileResolverLike;
  /** Connector names accepted without registry validation (e.g. agent desktop providers). */
  allowedConnectorNames?: ReadonlySet<string>;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ConnectionService {
  private readonly model: ConnectionModel;
  private readonly registry: ConnectorRegistry;
  private readonly authProfileResolver?: AuthProfileResolverLike;
  private readonly allowedConnectorNames: ReadonlySet<string>;

  constructor(deps: ConnectionServiceDeps) {
    this.model = deps.connectionModel;
    this.registry = deps.registry;
    this.authProfileResolver = deps.authProfileResolver;
    this.allowedConnectorNames = deps.allowedConnectorNames ?? new Set();
  }

  /** List all connections for a project. User-scoped connections filtered by userId. */
  async list(tenantId: string, projectId: string, userId?: string): Promise<ConnectionRecord[]> {
    const filter: Record<string, unknown> = { tenantId, projectId };
    // User-scoped connections: show tenant-scoped + user's own user-scoped
    if (userId) {
      filter.$or = [{ scope: { $ne: 'user' } }, { scope: 'user', userId }];
    }
    return this.model.find(filter).sort({ createdAt: -1 }).lean();
  }

  /** Get a single connection by ID. Returns null if not found. */
  async getById(tenantId: string, projectId: string, id: string): Promise<ConnectionRecord | null> {
    return this.model.findOne({ _id: id, tenantId, projectId }).lean();
  }

  /** Create a new connection binding. userId required when scope is 'user'. */
  async create(
    tenantId: string,
    projectId: string,
    input: CreateConnectionInput,
    userId?: string,
  ): Promise<ConnectionRecord> {
    if (!input.connectorName || !input.displayName) {
      throw new ConnectionServiceError(
        'connectorName and displayName are required',
        'VALIDATION_ERROR',
      );
    }

    if (!input.authProfileId) {
      throw new ConnectionServiceError('authProfileId is required', 'VALIDATION_ERROR');
    }

    // Connector name validation: accept if in registry, allowed list, or backed by
    // an auth profile (catalog-only connectors like Gmail aren't in the registry
    // but are valid when an auth profile provides their credentials).
    if (
      !this.registry.has(input.connectorName) &&
      !this.allowedConnectorNames.has(input.connectorName)
    ) {
      log.debug('Connector not in registry or allowed list, accepted via authProfileId', {
        connectorName: input.connectorName,
      });
    }

    const scope = input.scope || 'tenant';
    if (scope === 'user' && !userId) {
      throw new ConnectionServiceError(
        'userId is required for user-scoped connections',
        'VALIDATION_ERROR',
      );
    }

    const now = new Date();

    // Upsert on the unique index {tenantId, projectId, connectorName, authProfileId}.
    // The auth-profiles POST route auto-creates a bridge ConnectorConnection via
    // createBridgeForProfile, so a plain INSERT would race and 11000 against it.
    // $setOnInsert handles the immutable fields; $set corrects displayName/metadata
    // that the bridge may have set from the auth-profile name rather than the
    // user-supplied connection name.
    const connection = await this.model.findOneAndUpdate(
      {
        tenantId,
        projectId,
        connectorName: input.connectorName,
        authProfileId: input.authProfileId,
      },
      {
        $setOnInsert: {
          _id: crypto.randomUUID(),
          scope,
          ...(scope === 'user' && userId ? { userId } : {}),
          status: 'active',
          createdAt: now,
        },
        $set: {
          displayName: input.displayName,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    if (!connection) {
      throw new ConnectionServiceError(
        'Failed to create or retrieve connection',
        'VALIDATION_ERROR',
      );
    }

    return connection;
  }

  /** Update a connection. Returns null if not found. */
  async update(
    tenantId: string,
    projectId: string,
    id: string,
    input: UpdateConnectionInput,
  ): Promise<ConnectionRecord | null> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.authProfileId !== undefined) {
      if (!input.authProfileId) {
        throw new ConnectionServiceError('authProfileId is required', 'VALIDATION_ERROR');
      }
      updates.authProfileId = input.authProfileId;
    }
    if (input.metadata !== undefined) updates.metadata = input.metadata;
    if (input.status !== undefined) updates.status = input.status;

    return this.model.findOneAndUpdate(
      { _id: id, tenantId, projectId },
      { $set: updates },
      { returnDocument: 'after' },
    );
  }

  /** Delete a connection. Returns false if not found. */
  async delete(tenantId: string, projectId: string, id: string): Promise<boolean> {
    const deleted = await this.model.findOneAndDelete({
      _id: id,
      tenantId,
      projectId,
    });
    return !!deleted;
  }

  /** Test a connection by resolving auth via profile and calling the connector's test action. */
  async test(tenantId: string, projectId: string, id: string): Promise<TestResult> {
    const connection = await this.model
      .findOne({
        _id: id,
        tenantId,
        projectId,
      })
      .lean();

    if (!connection) {
      throw new ConnectionServiceError('Connection not found', 'NOT_FOUND');
    }

    if (!this.authProfileResolver) {
      throw new ConnectionServiceError('Auth profile resolver not configured', 'VALIDATION_ERROR');
    }

    const start = Date.now();

    try {
      // No-auth short-circuit. Mirrors the runtime path in
      // connection-resolver.ts: connectors that declare `auth: { type: 'none' }`
      // (Docling, HTTP) carry a synthetic `metadata.authType === 'none'` hint and
      // an unresolvable placeholder authProfileId. Calling the auth-profile
      // resolver here would always throw "Auth profile not found", which then
      // flips the connection to `expired`. Resolving auth is only meaningful
      // when the connector actually consumes credentials.
      const noAuthHint = (connection.metadata as { authType?: unknown } | null | undefined)
        ?.authType;
      const auth: Record<string, unknown> =
        noAuthHint === 'none'
          ? {}
          : await this.authProfileResolver.resolve({
              authProfileId: connection.authProfileId,
              tenantId,
              projectId,
            });

      // Run test_connection action if the connector is in the registry;
      // catalog-only connectors (e.g., Gmail via Nango) aren't registered
      // so successful auth resolution is sufficient for a passing test.
      if (this.registry.has(connection.connectorName)) {
        const connector = await this.registry.get(connection.connectorName);
        const testAction = connector.actions.find(
          (a) => a.name === 'test_connection' || a.name === 'test',
        );

        if (testAction) {
          const noopStore = {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
          };
          await testAction.run({
            auth,
            params: {},
            tenantId,
            projectId,
            connectionScope: connection.scope,
            executionId: `test-${id}`,
            store: noopStore,
          });
        } else {
          log.debug('No test_connection action, treating registry lookup as success', {
            connectorName: connection.connectorName,
          });
        }
      } else {
        log.debug('Connector not in registry, auth resolution success is sufficient', {
          connectorName: connection.connectorName,
        });
      }

      // Update status to active on success
      await this.model.findOneAndUpdate(
        { _id: id, tenantId, projectId },
        { $set: { status: 'active', updatedAt: new Date() } },
      );

      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn('Connection test failed', {
        connectorName: connection.connectorName,
        error: errorMessage,
      });

      // Update status to expired on failure
      await this.model.findOneAndUpdate(
        { _id: id, tenantId, projectId },
        { $set: { status: 'expired', updatedAt: new Date() } },
      );

      return {
        success: false,
        error: errorMessage || 'Connection test failed',
        latencyMs: Date.now() - start,
      };
    }
  }
}

// ─── Error ──────────────────────────────────────────────────────────────────

export class ConnectionServiceError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'UNKNOWN_CONNECTOR',
  ) {
    super(message);
    this.name = 'ConnectionServiceError';
  }
}
