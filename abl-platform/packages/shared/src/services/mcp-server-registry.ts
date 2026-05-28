/**
 * MCP Server Registry Service (Shared)
 *
 * Loads MCP server configurations from the database (MCPServerConfig table)
 * for a given project, decrypts encrypted env vars, and returns configs
 * ready for MCPServerManager.registerServer().
 *
 * G3: Dynamic imports updated to use local repos in packages/shared.
 * G1: MCPDecryptor updated to async to match shared EncryptionService.
 *
 * Uses a short TTL cache per project to avoid repeated DB queries within a session.
 */

// ─── Minimal output type matching @abl/compiler MCPServerConfig ─────────────
// Re-declared here to avoid a hard dependency on @abl/compiler.
// Consumers can cast to compiler's MCPServerConfig if needed.

import type { NormalizedMCPServerConfig } from '../types/mcp-server.js';
import { dualReadCredentials } from './auth-profile/index.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('mcp-server-registry');

export interface MCPServerConfigOutput {
  /** DB record _id (UUIDv7). Use this as the canonical server identifier. */
  id: string;
  /** Human-readable server name (for display only). */
  name: string;
  transport: 'sse' | 'http';
  tenantId?: string;
  env?: Record<string, string>;
  url?: string;
  allowedUrlPatterns?: string[];
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  priority?: number;
  tags?: string[];
  /** SSRF validation options — pass { allowLocalhost: true } for dev mode */
  ssrfOptions?: { allowLocalhost?: boolean; allowPrivateRanges?: boolean };
  /** Auth type for the MCP server connection */
  authType?: string;
  /** Pre-resolved auth headers (decrypted + resolved at load time) */
  headers?: Record<string, string>;
  /** Auth profile backing the MCP auth headers (when profile-backed). */
  authProfileId?: string;
  /** Auth profile version used to resolve current headers. */
  authProfileVersion?: number;
  /** Auth header/token expiry hint (ISO) for proactive refresh scheduling. */
  authProfileExpiresAt?: string;
  /** Pre-resolved TLS material for profile-backed mTLS connections. */
  tlsOptions?: { cert: string; key: string; ca?: string };
}

/** Minimal async decryptor interface — matches shared EncryptionService.decryptForTenant */
export interface MCPDecryptor {
  decryptForTenant(encryptedData: string, tenantId: string): Promise<string>;
}

/** Callback to verify project ownership — injected by the consuming app */
export type ProjectVerifier = (projectId: string, tenantId: string) => Promise<boolean>;

/** Callback to validate URLs for SSRF safety — injected by the consuming app */
export type UrlValidator = (url: string) => { safe: boolean; reason?: string };

interface CacheEntry {
  configs: MCPServerConfigOutput[];
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const MAX_CACHE_SIZE = 500;

function isMcpAuthProfileEnabled(): boolean {
  return process.env.MCP_AUTH_PROFILE_ENABLED !== 'false';
}

export class MCPServerRegistryService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private decryptor: MCPDecryptor,
    private verifyProject?: ProjectVerifier,
    private urlValidator?: UrlValidator,
  ) {}

  /**
   * Load MCP server configs for a project from the database.
   * Results are cached for CACHE_TTL_MS per (tenantId, projectId).
   */
  async getServerConfigs(tenantId: string, projectId: string): Promise<MCPServerConfigOutput[]> {
    const cacheKey = `${tenantId}:${projectId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.configs;
    }

    try {
      // Verify project ownership if verifier provided
      if (this.verifyProject) {
        const owned = await this.verifyProject(projectId, tenantId);
        if (!owned) return [];
      }

      const { findMcpServerConfigsByProject } = await import('../repos/mcp-server-config-repo.js');
      const rows = await findMcpServerConfigsByProject(tenantId, projectId);

      const configs: MCPServerConfigOutput[] = [];
      for (const row of rows) {
        const cfg = await this.toServerConfig(row, tenantId);
        if (cfg) configs.push(cfg);
      }

      // Bounded cache: evict oldest if at capacity
      if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(cacheKey)) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, { configs, loadedAt: Date.now() });

      return configs;
    } catch (error) {
      log.error('Failed to load MCP server configs', {
        tenantId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  invalidate(tenantId: string, projectId: string): void {
    this.cache.delete(`${tenantId}:${projectId}`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async toServerConfig(
    row: NormalizedMCPServerConfig,
    tenantId: string,
  ): Promise<MCPServerConfigOutput | null> {
    // ── Auth Profile dual-read for MCP env vars ──
    // envProfileId is the split field; authProfileId is retained as legacy fallback.
    const envProfileId = (row as Record<string, unknown>).envProfileId as string | null | undefined;
    const legacyAuthProfileId = (row as Record<string, unknown>).authProfileId as
      | string
      | null
      | undefined;
    const effectiveEnvProfileId = envProfileId ?? legacyAuthProfileId;

    const { credentials: env } = await dualReadCredentials<Record<string, string> | undefined>({
      authProfileId: effectiveEnvProfileId,
      tenantId,
      consumer: 'MCPServerConfig',
      resolve: async () => {
        const { AuthProfile } = await import('@agent-platform/database/models');
        const now = new Date();
        const projectScopeFilter = row.projectId
          ? [{ projectId: row.projectId }, { projectId: null }, { projectId: { $exists: false } }]
          : [{ projectId: null }, { projectId: { $exists: false } }];
        const profile = await (AuthProfile as any).findOne({
          _id: effectiveEnvProfileId,
          tenantId,
          status: 'active',
          visibility: { $ne: 'personal' },
          $and: [
            { $or: projectScopeFilter },
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
          ],
        });
        if (!profile) return undefined;
        let secrets: Record<string, unknown>;
        if (typeof profile.encryptedSecrets === 'string') {
          try {
            secrets = JSON.parse(profile.encryptedSecrets);
          } catch {
            secrets = {};
          }
        } else {
          secrets = profile.encryptedSecrets ?? {};
        }
        // Auth profile secrets map directly to env vars for MCP
        const envMap: Record<string, string> = {};
        for (const [k, v] of Object.entries(secrets)) {
          if (typeof v === 'string') envMap[k] = v;
        }
        return Object.keys(envMap).length > 0 ? envMap : undefined;
      },
      legacyFallback: async () => {
        if (!row.encryptedEnv) return undefined;
        try {
          // encryptedEnv is already-decrypted JSON when the Mongoose plugin ran;
          // only fall back to explicit decrypt if the value is still ciphertext
          // (legacy records that bypassed the plugin).
          const rawEnv = row.encryptedEnv;
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawEnv);
          } catch {
            const decrypted = await this.decryptor.decryptForTenant(rawEnv, tenantId);
            parsed = JSON.parse(decrypted);
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            log.warn('Skipping MCP server — env must be a JSON object', {
              tenantId,
              server: row.name,
            });
            return undefined;
          }
          const envObj = parsed as Record<string, unknown>;
          for (const [k, v] of Object.entries(envObj)) {
            if (typeof v !== 'string') {
              log.warn('Skipping MCP server — env values must be strings', {
                tenantId,
                server: row.name,
                key: k,
              });
              return undefined;
            }
          }
          return envObj as Record<string, string>;
        } catch (error) {
          log.error('Skipping MCP server — env decryption failed', {
            tenantId,
            server: row.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      },
    });

    // If encryptedEnv was present but env resolved to undefined, decryption/validation failed — skip server
    if (row.encryptedEnv && !env) {
      return null;
    }

    let tags: string[] | undefined;
    if (row.tags) {
      try {
        tags = JSON.parse(row.tags);
      } catch {
        // Non-critical, skip
      }
    }

    // Resolve {{env.KEY}} placeholders in the server URL.
    // Priority: server-scoped env → project-level EnvironmentVariable fallback.
    let serverUrl = row.url ?? undefined;
    if (serverUrl && /\{\{env\.\w+\}\}/.test(serverUrl)) {
      serverUrl = await this.resolveServerUrlPlaceholders(serverUrl, env, tenantId, row.projectId);
    }

    // Validate URL for SSRF safety (after placeholder resolution)
    if (serverUrl && this.urlValidator) {
      const result = this.urlValidator(serverUrl);
      if (!result.safe) {
        log.warn('Skipping MCP server — URL blocked by SSRF validator', {
          tenantId,
          server: row.name,
          url: serverUrl,
          reason: result.reason,
        });
        return null;
      }
    }

    // Resolve auth headers. `encryptedAuthConfig` arrives already-decrypted
    // (plaintext JSON) because the Mongoose encryption plugin's post-find hook
    // decrypts the field even on .lean() reads in Mongoose 8. Fall back to an
    // explicit decrypt only if the value still looks like ciphertext — this
    // covers legacy records that slipped past the plugin.
    let authHeaders: Record<string, string> | undefined;
    const authType = row.authType ?? 'none';
    let resolvedAuthType: string | undefined = authType !== 'none' ? authType : undefined;
    const authProfileId = (row as Record<string, unknown>).authProfileId as
      | string
      | null
      | undefined;
    let authProfileVersion: number | undefined;
    let authProfileExpiresAt: string | undefined;
    let authTlsOptions: MCPServerConfigOutput['tlsOptions'];
    const mcpAuthProfileEnabled = isMcpAuthProfileEnabled();

    if (
      mcpAuthProfileEnabled &&
      typeof authProfileId === 'string' &&
      authProfileId.trim().length > 0
    ) {
      try {
        const { resolveAuthHeadersFromProfileDetailed } = await import('./mcp-auth-resolver.js');
        const resolved = await resolveAuthHeadersFromProfileDetailed({
          authProfileId: authProfileId.trim(),
          tenantId,
          projectId: row.projectId,
          transport: row.transport,
        });
        authHeaders = resolved.headers;
        resolvedAuthType = resolved.authType;
        authProfileVersion = resolved.profileVersion;
        authProfileExpiresAt = resolved.expiresAt;
        authTlsOptions = resolved.tlsOptions;
      } catch (error) {
        log.error('Skipping MCP server — failed to resolve auth profile headers', {
          tenantId,
          server: row.name,
          authProfileId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    } else if (
      !mcpAuthProfileEnabled &&
      typeof authProfileId === 'string' &&
      authProfileId.trim().length > 0
    ) {
      log.info('MCP auth-profile resolution disabled by feature flag', {
        tenantId,
        projectId: row.projectId,
        server: row.name,
        authProfileId: authProfileId.trim(),
      });
    }

    if (!authHeaders && row.encryptedAuthConfig && authType !== 'none') {
      try {
        const rawAuth = row.encryptedAuthConfig;
        let authConfig: unknown;
        try {
          authConfig = JSON.parse(rawAuth);
        } catch {
          // Not JSON — assume legacy ciphertext that bypassed the plugin.
          const decryptedAuth = await this.decryptor.decryptForTenant(rawAuth, tenantId);
          authConfig = JSON.parse(decryptedAuth);
        }
        if (!authConfig || typeof authConfig !== 'object') {
          throw new Error('auth config must be a JSON object');
        }
        const { resolveAuthHeaders } = await import('./mcp-auth-resolver.js');
        authHeaders = await resolveAuthHeaders(
          { type: authType, ...(authConfig as Record<string, unknown>) } as Parameters<
            typeof resolveAuthHeaders
          >[0],
          tenantId,
        );
      } catch (error) {
        log.error('Skipping MCP server — failed to resolve auth headers', {
          tenantId,
          server: row.name,
          authType,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      env,
      url: serverUrl,
      priority: row.priority,
      tags,
      connectionTimeoutMs: row.connectionTimeoutMs,
      requestTimeoutMs: row.requestTimeoutMs,
      autoReconnect: row.autoReconnect,
      maxReconnectAttempts: row.maxReconnectAttempts,
      authType: resolvedAuthType,
      headers: authHeaders,
      authProfileId: authProfileId?.trim() || undefined,
      authProfileVersion,
      authProfileExpiresAt,
      tlsOptions: authTlsOptions,
    };
  }

  /**
   * Resolve {{env.KEY}} placeholders in a server URL.
   * Tries server-scoped env first, then falls back to project-level EnvironmentVariable.
   */
  private async resolveServerUrlPlaceholders(
    url: string,
    serverEnv: Record<string, string> | undefined,
    tenantId: string,
    projectId: string,
  ): Promise<string> {
    let result = url;
    const unresolvedAfterServerEnv: Array<{ placeholder: string; key: string }> = [];

    // First pass: resolve from server-scoped env
    result = result.replace(/\{\{env\.(\w+)\}\}/g, (placeholder, key) => {
      const value = serverEnv?.[key];
      if (value !== undefined) return value;
      unresolvedAfterServerEnv.push({ placeholder, key });
      return placeholder; // keep placeholder for second pass
    });

    // Second pass: resolve remaining placeholders from project-level env vars
    if (unresolvedAfterServerEnv.length > 0) {
      try {
        const { EnvironmentVariable } = await import('@agent-platform/database/models');

        for (const { placeholder, key } of unresolvedAfterServerEnv) {
          const envVar = await EnvironmentVariable.findOne({
            tenantId,
            projectId,
            key,
            environment: 'dev',
          })
            .select('encryptedValue')
            .lean();

          if (envVar?.encryptedValue) {
            try {
              const value = await this.decryptor.decryptForTenant(
                envVar.encryptedValue as string,
                tenantId,
              );
              result = result.replace(placeholder, value);
            } catch {
              // Decryption failed — leave placeholder as empty
              result = result.replace(placeholder, '');
            }
          } else {
            // Not found in project env vars either — replace with empty
            result = result.replace(placeholder, '');
          }
        }
      } catch (error) {
        log.error('Failed to resolve project env vars for URL placeholders', {
          tenantId,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall back to empty replacement for unresolved placeholders
        for (const { placeholder } of unresolvedAfterServerEnv) {
          result = result.replace(placeholder, '');
        }
      }
    }

    return result;
  }
}
