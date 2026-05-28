/**
 * DEK Facade Factory
 *
 * Shared initialization for DEKManager + TenantEncryptionFacade.
 * Eliminates ~30 lines of duplicated init code across server entry points.
 *
 * All heavy dependencies (KMSProviderPool, KMSResolver, DEKManager) are
 * dynamically imported so that bundlers (Turbopack/webpack) do not pull
 * the entire KMS provider graph into lightweight consumers like Studio.
 */

// Only type-level imports — no runtime module resolution at parse time
import type { KMSResolver } from './kms-resolver.js';
import type { DEKManager } from './dek-manager.js';

export interface DEKFacadeInitResult {
  facade: import('@agent-platform/shared-encryption').TenantEncryptionFacade;
  dekManager: DEKManager;
  resolver: KMSResolver;
  /** Startup-time inspection of legacy DEKs that still rely on implicit local-provider fallback. */
  implicitLocalDekCheck: {
    checked: boolean;
    hasMatches: boolean;
    sample: {
      dekId: string;
      tenantId: string;
      projectId: string;
      environment: string;
    } | null;
  };
}

export interface DEKFacadeInitOptions {
  masterKeyHex: string;
  defaultKekKeyId?: string;
  tenantContextRunner?: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
  logger?: {
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Initialize the full DEK encryption stack and inject the facade into
 * the Mongoose encryption plugin via `setEncryptionFacade`.
 *
 * This is the single entry point that all server processes should call.
 * Throws if KMS pool/facade initialization fails.
 */
export async function initDEKFacade(opts: DEKFacadeInitOptions): Promise<DEKFacadeInitResult> {
  const warn = (msg: string, meta?: Record<string, unknown>): void => {
    if (opts.logger) {
      opts.logger.warn(msg, meta);
      return;
    }
    process.stderr.write(
      `[dek-facade-factory] WARN: ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`,
    );
  };

  // Dynamic imports to avoid pulling KMS providers into the module graph
  // at parse time — critical for Next.js/Turbopack consumers (Studio).
  const { setKMSProviderPool, isKMSProviderPoolAvailable } = await import('./kms-registry.js');
  const { KMSProviderPool } = await import('./kms-provider-pool.js');
  const { KMSResolver } = await import('./kms-resolver.js');
  const { DEKManager } = await import('./dek-manager.js');

  // Ensure KMS provider pool is initialized
  if (!isKMSProviderPoolAvailable()) {
    const pool = new KMSProviderPool({ masterKeyHex: opts.masterKeyHex });
    await pool.initialize();
    setKMSProviderPool(pool);
  }

  const resolver = new KMSResolver({
    logger: opts.logger
      ? {
          debug() {},
          warn: opts.logger.warn.bind(opts.logger),
          info() {},
        }
      : undefined,
    tenantContextRunner: opts.tenantContextRunner,
  });
  const dekManager = new DEKManager(resolver);

  // Dynamic imports to avoid circular deps at module load time
  const { TenantEncryptionFacade } = await import('@agent-platform/shared-encryption');
  // Use the named-package import (not a relative path) so that bundlers like Turbopack
  // resolve this to the same module instance as every other consumer of
  // @agent-platform/database/models. A relative-path import creates a second instance
  // in Turbopack, splitting the encryptionFacade singleton and breaking the Mongoose plugin.
  const { setEncryptionFacade } = await import('@agent-platform/database/models');

  const facade = new TenantEncryptionFacade(dekManager, opts.defaultKekKeyId ?? 'platform-default');

  setEncryptionFacade(facade);

  const implicitLocalDekCheck: DEKFacadeInitResult['implicitLocalDekCheck'] = {
    checked: false,
    hasMatches: false,
    sample: null,
  };
  try {
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState === 1) {
      const { DEKEntry } = await import('@agent-platform/database/models');
      implicitLocalDekCheck.checked = true;
      const sample = (await DEKEntry.findOne(
        { wrappingProvider: null },
        { dekId: 1, tenantId: 1, projectId: 1, environment: 1 },
      ).lean()) as {
        dekId: string;
        tenantId: string;
        projectId: string;
        environment: string;
      } | null;
      if (sample) {
        implicitLocalDekCheck.hasMatches = true;
        implicitLocalDekCheck.sample = sample;
        warn(
          'found DEK entry missing wrappingProvider metadata; treating entry as platform local KMS',
          {
            tenantId: sample.tenantId,
            projectId: sample.projectId,
            environment: sample.environment,
            dekId: sample.dekId,
          },
        );
      }
    }
  } catch (err) {
    warn('failed to inspect DEK metadata coverage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { facade, dekManager, resolver, implicitLocalDekCheck };
}
