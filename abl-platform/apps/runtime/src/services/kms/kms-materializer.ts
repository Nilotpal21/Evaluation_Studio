/**
 * KMS Materializer
 *
 * WRITE PATH: Walks the 5-level KMS config inheritance chain and upserts
 * MaterializedKMSConfig documents for each active scope.
 *
 * Triggered by:
 *   - PUT /api/tenants/:tenantId/kms/config (admin save)
 *   - New project creation (inherits tenant config)
 *   - New deployment to new environment
 *   - Server startup (reconcileAll for drift recovery)
 *
 * Admin config writes currently await materialization so activation state can
 * be reported synchronously. Startup and drift recovery still rely on
 * re-materialization when sourceConfigVersion mismatches are detected later.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ITenantKMSConfig, IKMSProviderRef } from '@agent-platform/database/models';

const log = createLogger('kms-materializer');

// =============================================================================
// TYPES
// =============================================================================

interface ScopeKey {
  projectId: string;
  environment: string;
}

interface ResolvedScope {
  tenantId: string;
  projectId: string;
  environment: string;
  provider: IKMSProviderRef;
  keyId: string;
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  dekRetentionDays: number | null;
  kekRotationPeriodDays: number;
  failurePolicy: string;
}

// =============================================================================
// KMS MATERIALIZER
// =============================================================================

export class KMSMaterializer {
  /**
   * Materialize all scopes for a tenant.
   *
   * 1. Load TenantKMSConfig
   * 2. Enumerate active scopes (from Deployments + ProjectAgents)
   * 3. Walk 5-level chain for each scope
   * 4. Upsert MaterializedKMSConfig docs
   * 5. Delete stale docs for removed scopes
   */
  async materialize(tenantId: string): Promise<number> {
    const startTime = Date.now();

    try {
      const { TenantKMSConfig, MaterializedKMSConfig, Deployment, ProjectAgent } =
        await import('@agent-platform/database/models');

      // 1. Load tenant config (source of truth)
      const config = (await TenantKMSConfig.findOne({
        tenantId,
      }).lean()) as ITenantKMSConfig | null;
      if (!config) {
        // No KMS config → delete all materialized docs for this tenant
        const deleted = await MaterializedKMSConfig.deleteMany({ tenantId });
        log.info('No KMS config, cleared materialized docs', {
          tenantId,
          deletedCount: deleted.deletedCount,
        });
        return 0;
      }

      // 2. Enumerate active scopes from deployments and project agents
      const scopes = await this.enumerateActiveScopes(tenantId, Deployment, ProjectAgent);

      // 3. Resolve each scope through the 5-level chain
      const resolved = scopes.map((scope) => this.resolveScope(tenantId, scope, config));

      // 4. Upsert all materialized configs
      let upserted = 0;
      await Promise.all(
        resolved.map(async (r) => {
          try {
            await MaterializedKMSConfig.findOneAndUpdate(
              { tenantId: r.tenantId, projectId: r.projectId, environment: r.environment },
              {
                $set: {
                  resolvedProvider: r.provider,
                  resolvedKeyId: r.keyId,
                  dekEpochIntervalHours: r.dekEpochIntervalHours,
                  dekMaxUsageCount: r.dekMaxUsageCount,
                  dekRetentionDays: r.dekRetentionDays,
                  kekRotationPeriodDays: r.kekRotationPeriodDays,
                  failurePolicy: r.failurePolicy,
                  sourceConfigVersion: config._v,
                  materializedAt: new Date(),
                },
              },
              { upsert: true, new: true },
            );
            upserted++;
          } catch (err) {
            log.warn('Failed to upsert materialized config', {
              tenantId: r.tenantId,
              projectId: r.projectId,
              environment: r.environment,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );

      // 5. Delete stale docs for scopes that no longer exist
      const activeScopeKeys = new Set(resolved.map((r) => `${r.projectId}:${r.environment}`));
      const existingDocs = await MaterializedKMSConfig.find(
        { tenantId },
        { projectId: 1, environment: 1 },
      ).lean();

      const staleIds: string[] = [];
      for (const doc of existingDocs) {
        const key = `${doc.projectId}:${doc.environment}`;
        if (!activeScopeKeys.has(key)) {
          staleIds.push(doc._id);
        }
      }

      if (staleIds.length > 0) {
        await MaterializedKMSConfig.deleteMany({ _id: { $in: staleIds } });
        log.info('Deleted stale materialized configs', {
          tenantId,
          staleCount: staleIds.length,
        });
      }

      log.info('Materialization complete', {
        tenantId,
        scopeCount: scopes.length,
        upsertedCount: upserted,
        staleDeleted: staleIds.length,
        durationMs: Date.now() - startTime,
      });

      return upserted;
    } catch (err) {
      log.error('Materialization failed', {
        tenantId,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Reconcile all tenants at startup.
   * Finds all tenants with KMS configs and re-materializes.
   * Idempotent — safe to run on all pods.
   */
  async reconcileAll(): Promise<number> {
    const startTime = Date.now();
    try {
      const { TenantKMSConfig } = await import('@agent-platform/database/models');
      const configs = await TenantKMSConfig.find({}, { tenantId: 1 }).lean();

      let totalUpserted = 0;
      for (const config of configs) {
        try {
          totalUpserted += await this.materialize(config.tenantId);
        } catch (err) {
          log.warn('reconcileAll: failed for tenant', {
            tenantId: config.tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info('reconcileAll complete', {
        tenantCount: configs.length,
        totalUpserted,
        durationMs: Date.now() - startTime,
      });

      return totalUpserted;
    } catch (err) {
      log.error('reconcileAll failed', {
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Enumerate all active (projectId, environment) scopes for a tenant.
   * Sources: active Deployments + ProjectAgents with activeVersions.
   */
  private async enumerateActiveScopes(
    tenantId: string,
    Deployment: any,
    ProjectAgent: any,
  ): Promise<ScopeKey[]> {
    const scopeSet = new Set<string>();
    const scopes: ScopeKey[] = [];

    // From active deployments
    const deployments = await Deployment.find(
      { tenantId, status: { $in: ['active', 'draining'] } },
      { projectId: 1, environment: 1 },
    ).lean();

    for (const d of deployments) {
      const key = `${d.projectId}:${d.environment}`;
      if (!scopeSet.has(key)) {
        scopeSet.add(key);
        scopes.push({ projectId: d.projectId, environment: d.environment });
      }
    }

    // From project agents with active versions in various environments
    const agents = await ProjectAgent.find(
      { tenantId },
      { projectId: 1, activeVersions: 1 },
    ).lean();

    for (const agent of agents) {
      let activeVersions: Record<string, string>;
      try {
        const raw = (agent as any).activeVersions;
        activeVersions = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      } catch {
        continue;
      }

      for (const env of Object.keys(activeVersions)) {
        if (env === 'default') continue;
        const key = `${(agent as any).projectId}:${env}`;
        if (!scopeSet.has(key)) {
          scopeSet.add(key);
          scopes.push({ projectId: (agent as any).projectId, environment: env });
        }
      }
    }

    return scopes;
  }

  /**
   * 5-level KMS resolution chain:
   *   1. projects[projectId].environments[environment]
   *   2. projects[projectId].defaultProvider
   *   3. environments[environment] (tenant-level)
   *   4. defaultProvider (tenant-level)
   *   5. Platform default (local)
   */
  private resolveScope(tenantId: string, scope: ScopeKey, config: ITenantKMSConfig): ResolvedScope {
    const { projectId, environment } = scope;

    // Level 1: Project + environment specific
    const projectOverride = config.projects?.find((p) => p.projectId === projectId);
    if (projectOverride) {
      const envOverride = projectOverride.environments?.find((e) => e.environment === environment);
      if (envOverride?.provider) {
        return this.buildResolved(tenantId, scope, envOverride.provider, config);
      }

      // Level 2: Project default provider
      if (projectOverride.defaultProvider) {
        return this.buildResolved(tenantId, scope, projectOverride.defaultProvider, config);
      }
    }

    // Level 3: Tenant environment override
    const tenantEnvOverride = config.environments?.find((e) => e.environment === environment);
    if (tenantEnvOverride?.provider) {
      return this.buildResolved(tenantId, scope, tenantEnvOverride.provider, config);
    }

    // Level 4: Tenant default provider
    if (config.defaultProvider) {
      return this.buildResolved(tenantId, scope, config.defaultProvider, config);
    }

    // Level 5: Platform default
    return {
      tenantId,
      projectId,
      environment,
      provider: {
        providerType: 'local',
        keyId: 'platform-default',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      },
      keyId: 'platform-default',
      dekEpochIntervalHours: config.dekEpochIntervalHours ?? 24,
      dekMaxUsageCount: config.dekMaxUsageCount ?? 2 ** 30,
      dekRetentionDays: config.dekRetentionDays ?? null,
      kekRotationPeriodDays: config.kekRotationPeriodDays ?? 365,
      failurePolicy: config.failurePolicy ?? 'fail-closed',
    };
  }

  private buildResolved(
    tenantId: string,
    scope: ScopeKey,
    provider: IKMSProviderRef,
    config: ITenantKMSConfig,
  ): ResolvedScope {
    return {
      tenantId,
      projectId: scope.projectId,
      environment: scope.environment,
      provider,
      keyId: provider.keyId,
      dekEpochIntervalHours: config.dekEpochIntervalHours ?? 24,
      dekMaxUsageCount: config.dekMaxUsageCount ?? 2 ** 30,
      dekRetentionDays: config.dekRetentionDays ?? null,
      kekRotationPeriodDays: config.kekRotationPeriodDays ?? 365,
      failurePolicy: config.failurePolicy ?? 'fail-closed',
    };
  }
}
