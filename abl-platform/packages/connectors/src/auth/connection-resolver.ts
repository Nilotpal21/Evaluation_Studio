/**
 * ConnectionResolver
 *
 * Resolves connector connections and delegates credential resolution
 * to the auth profile system. ConnectorConnection is a pure binding
 * record — all credential storage and token refresh is handled by
 * auth profiles.
 *
 * ABLP-913: the connection layer is being collapsed into the auth profile.
 * New workflow / trigger UIs persist the auth-profile id directly into the
 * IR's `connectionId` field. To keep both old workflows (referencing
 * ConnectorConnection ids) and new ones working, `resolve()` falls back to
 * looking up the id against AuthProfile and synthesises a ResolvedConnection
 * when a real ConnectorConnection record is not found.
 */

import type { IConnectorConnection } from '@agent-platform/database/models';
import type { AuthProfileResolverLike } from '../services/connection-service.js';
import { createLogger } from '../logger.js';

export type { AuthProfileResolverLike };

const log = createLogger('connection-resolver');

/** Mongoose-like model interface for ConnectorConnection queries */
export interface ConnectorConnectionModel {
  findOne(filter: Record<string, unknown>): Promise<IConnectorConnection | null>;
}

/**
 * Minimal lookup interface for AuthProfile records used by the ABLP-913
 * fallback path. Mirrors a subset of the Mongoose model surface so the
 * resolver stays decoupled from the DB package.
 */
export interface AuthProfileLookupRecord {
  _id: string;
  name: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  usageMode?: string;
  status: string;
  connector?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthProfileLookupModel {
  findOne(filter: Record<string, unknown>): Promise<AuthProfileLookupRecord | null>;
}

/**
 * Optional resolver for OAuth grant tokens.
 * When provided, ConnectionResolver will look up durable OAuth grants
 * for oauth2_app profiles so that connector actions receive actual
 * access/refresh tokens instead of app credentials.
 */
export interface OAuthGrantResolver {
  resolveGrant(opts: {
    authProfileId: string;
    tenantId: string;
    userId?: string;
  }): Promise<{ access_token: string; refresh_token?: string } | null>;
}

export interface ResolveOptions {
  connectorName: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  connectionId?: string;
}

export interface ResolvedConnection {
  connection: IConnectorConnection;
  scope: 'tenant' | 'user';
}

export class ConnectionResolver {
  constructor(
    private readonly connectionModel: ConnectorConnectionModel,
    private readonly authProfileResolver: AuthProfileResolverLike,
    private readonly oauthGrantResolver?: OAuthGrantResolver,
    /**
     * ABLP-913 fallback: optional AuthProfile lookup so a `connectionId` that
     * is actually an auth-profile id can still be resolved. When omitted,
     * the resolver falls back to the legacy "Connection not found" behaviour.
     */
    private readonly authProfileModel?: AuthProfileLookupModel,
  ) {}

  /**
   * Resolve a connection for a connector. Tries user-scoped first, then tenant-scoped.
   * Both queries include tenantId in the filter (no findById).
   */
  async resolve(opts: ResolveOptions): Promise<ResolvedConnection> {
    // If a specific connectionId is provided, look it up directly (with tenant isolation)
    if (opts.connectionId) {
      // Sentinel handling: auth.type='none' connectors are auto-bound to the
      // synthetic id `system-<connector>-none`. There's no AuthProfile doc and
      // no ConnectorConnection with that as its `_id` — the value lives in
      // the connection's `authProfileId` field. Look up by that field first
      // so the standard resolver path succeeds without inventing a real id
      // in the workflow IR.
      //
      // The connector-name charset matches the registry naming convention
      // (lowercase + digits + hyphen). Using `.+` here would let a malformed
      // workflow IR pass arbitrary substrings as the resolver's
      // `connectorName` filter; bounding the charset is a defensive guard
      // against an injection vector that the project/tenant scope already
      // bounds — defense in depth.
      const sentinelMatch = /^system-([a-z0-9-]+)-none$/.exec(opts.connectionId);
      if (sentinelMatch) {
        const sentinelConn = await this.connectionModel.findOne({
          authProfileId: opts.connectionId,
          connectorName: sentinelMatch[1],
          tenantId: opts.tenantId,
          projectId: opts.projectId,
          status: 'active',
        });
        if (sentinelConn) {
          return {
            connection: sentinelConn,
            scope: sentinelConn.scope === 'user' ? 'user' : 'tenant',
          };
        }
      }

      const conn = await this.connectionModel.findOne({
        _id: opts.connectionId,
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        status: 'active',
      });
      if (conn) {
        return { connection: conn, scope: conn.scope === 'user' ? 'user' : 'tenant' };
      }

      // ABLP-913 fallback: treat the id as an auth-profile id. Workflow /
      // trigger UIs now write auth-profile ids into the IR's `connectionId`
      // field, so the resolver must synthesise a ConnectorConnection-shaped
      // record from the profile when no real ConnectorConnection exists.
      if (this.authProfileModel) {
        const profile = await this.authProfileModel.findOne({
          _id: opts.connectionId,
          tenantId: opts.tenantId,
          $or: [{ projectId: opts.projectId }, { projectId: null, scope: 'tenant' }],
          status: 'active',
        });

        if (profile) {
          // Preconfigured profiles share a tenant-level token; user_token /
          // jit / preflight resolve to the caller's per-user grant.
          const usageMode = profile.usageMode ?? 'preconfigured';
          const isShared = usageMode === 'preconfigured';
          const synthetic: IConnectorConnection = {
            _id: profile._id,
            tenantId: profile.tenantId,
            projectId: opts.projectId,
            connectorName: profile.connector ?? opts.connectorName,
            displayName: profile.name,
            scope: isShared ? 'tenant' : 'user',
            userId: isShared ? undefined : opts.userId,
            authProfileId: profile._id,
            metadata: null,
            status: 'active',
            createdAt: profile.createdAt ?? new Date(0),
            updatedAt: profile.updatedAt ?? new Date(0),
          };
          return { connection: synthetic, scope: synthetic.scope };
        }
      }

      throw new Error('Connection not found');
    }

    // Try user-scoped connection first (if userId provided)
    if (opts.userId) {
      const userConn = await this.connectionModel.findOne({
        connectorName: opts.connectorName,
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        scope: 'user',
        userId: opts.userId,
        status: 'active',
      });
      if (userConn) {
        return { connection: userConn, scope: 'user' };
      }
    }

    // Fall back to tenant-scoped connection
    const tenantConn = await this.connectionModel.findOne({
      connectorName: opts.connectorName,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      scope: 'tenant',
      status: 'active',
    });

    if (!tenantConn) {
      throw new Error('No connection configured for this connector');
    }

    return { connection: tenantConn, scope: 'tenant' };
  }

  /**
   * Resolve credentials for a connection by delegating to the auth profile system.
   * authProfileId is always set — no fallback to inline credentials.
   *
   * For OAuth2 app profiles, the auth profile only contains app credentials
   * (clientId/clientSecret). If an OAuthGrantResolver is configured, this method
   * also looks up the durable grant store for actual access/refresh tokens —
   * which is what connector actions (Activepieces pieces) need.
   */
  async resolveAuth(connection: IConnectorConnection): Promise<Record<string, unknown>> {
    // No-auth short-circuit (LLD Phase 2 Task 2.6 / FR-15). The Docling
    // toggle endpoint upserts a synthetic `ConnectorConnection` bound to an
    // `authType: 'none'` AuthProfile and stamps the hint on `metadata`. We
    // skip the auth-profile resolve call entirely so the
    // `tenant-encryption-facade` is never asked to decrypt empty secrets.
    const noAuthHint = (connection.metadata as { authType?: unknown } | null | undefined)?.authType;
    if (noAuthHint === 'none') {
      return {};
    }

    const profileAuth = await this.authProfileResolver.resolve({
      authProfileId: connection.authProfileId,
      tenantId: connection.tenantId,
      projectId: connection.projectId,
    });

    // If we have an OAuth grant resolver and the profile looks like oauth2_app
    // (has clientId/clientSecret but no access_token/accessToken), resolve the grant.
    // Wrapped in try/catch: a transient refresh failure should not crash the entire
    // workflow step — fall back to app-level credentials instead.
    if (
      this.oauthGrantResolver &&
      typeof profileAuth.clientId === 'string' &&
      typeof profileAuth.clientSecret === 'string' &&
      !profileAuth.access_token &&
      !profileAuth.accessToken
    ) {
      try {
        const grant = await this.oauthGrantResolver.resolveGrant({
          authProfileId: connection.authProfileId,
          tenantId: connection.tenantId,
          userId: connection.scope === 'user' ? connection.userId : undefined,
        });
        if (grant) {
          return { ...profileAuth, ...grant };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('OAuth grant resolution failed, connector action may fail with app credentials', {
          authProfileId: connection.authProfileId,
          tenantId: connection.tenantId,
          error: message,
        });
        // Fall through to return profileAuth (app credentials) as fallback.
        // App credentials alone may fail for connector actions that require user tokens.
      }
    }

    return profileAuth;
  }
}
