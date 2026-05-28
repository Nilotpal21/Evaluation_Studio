import type { Environment, PIIPatternConfig } from '@abl/compiler/platform';
import {
  buildNLUConfig,
  createLogger,
  PIIVault,
  PIIRecognizerRegistry,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform';
import type { PackName } from '@agent-platform/shared/validation';
import type { RuntimeSession } from '../execution/types.js';
import { isDatabaseReady } from '../../db/index.js';
import { loadProjectPIIPatterns } from './pattern-loader.js';
import { getPIIConfigEpoch } from './pii-epoch.js';
import type { PIIReadSurfaceContext } from './runtime-pii-boundary-service.js';

const log = createLogger('session-pii-context');
const PROJECT_PII_SNAPSHOT_TTL_MS = 60_000;
const MAX_PROJECT_PII_SNAPSHOT_CACHE = 500;

export type PIITier = 'basic' | 'standard' | 'advanced' | 'maximum';

export interface RuntimePIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  redactOutput: boolean;
  tier: PIITier;
  latencyBudgetMs: number;
  confidenceThreshold: number;
  enabledRecognizerPacks: PackName[];
}

export interface RuntimePIIProjectSnapshot {
  piiRedactionConfig: RuntimePIIRedactionConfig;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  piiPatternConfigs: PIIPatternConfig[];
}

/**
 * Mongoose-shaped raw view of pii_redaction. Exported (D-12) so the
 * sibling cloud-tier sub-feature can extend it additively.
 */
export interface ProjectPIIRedactionConfig {
  enabled?: boolean;
  redact_input?: boolean;
  redact_output?: boolean;
  tier?: PIITier;
  latency_budget_ms?: number;
  confidence_threshold?: number;
  enabled_recognizer_packs?: PackName[];
}

const projectPIISnapshotCache = new Map<
  string,
  { expiresAt: number; snapshot: RuntimePIIProjectSnapshot }
>();

/**
 * Single source of truth for pii_redaction defaults. Exported (D-12) so
 * the sibling cloud-tier sub-feature consumes it unchanged.
 */
export function mapProjectPIIRedactionConfig(
  pii: ProjectPIIRedactionConfig | undefined,
): RuntimePIIRedactionConfig {
  return {
    enabled: pii?.enabled ?? true,
    redactInput: pii?.redact_input ?? true,
    redactOutput: pii?.redact_output ?? false,
    tier: pii?.tier ?? 'basic',
    latencyBudgetMs: pii?.latency_budget_ms ?? 200,
    confidenceThreshold: pii?.confidence_threshold ?? 0.5,
    enabledRecognizerPacks: pii?.enabled_recognizer_packs ?? ['core'],
  };
}

function clonePatternConfigs(patternConfigs: PIIPatternConfig[]): PIIPatternConfig[] {
  return patternConfigs.map((patternConfig) => ({
    ...patternConfig,
    consumerAccess: patternConfig.consumerAccess.map((rule) => ({ ...rule })),
    ...(patternConfig.maskConfig ? { maskConfig: { ...patternConfig.maskConfig } } : {}),
    ...(patternConfig.randomConfig ? { randomConfig: { ...patternConfig.randomConfig } } : {}),
  }));
}

function cloneProjectPIISnapshot(snapshot: RuntimePIIProjectSnapshot): RuntimePIIProjectSnapshot {
  return {
    piiRedactionConfig: { ...snapshot.piiRedactionConfig },
    piiRecognizerRegistry: snapshot.piiRecognizerRegistry,
    piiPatternConfigs: clonePatternConfigs(snapshot.piiPatternConfigs),
  };
}

function getProjectPIISnapshotCacheKey(params: {
  tenantId?: string;
  projectId?: string;
  environment?: Environment | undefined;
  epoch: number;
}): string {
  return `${params.tenantId ?? ''}:${params.projectId ?? ''}:${params.environment ?? 'dev'}:${params.epoch}`;
}

function purgeExpiredProjectPIISnapshots(now: number): void {
  for (const [key, entry] of projectPIISnapshotCache) {
    if (entry.expiresAt <= now) {
      projectPIISnapshotCache.delete(key);
    }
  }
}

function getCachedProjectPIISnapshot(cacheKey: string): RuntimePIIProjectSnapshot | undefined {
  const now = Date.now();
  purgeExpiredProjectPIISnapshots(now);

  const cached = projectPIISnapshotCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now) {
    if (cached) {
      projectPIISnapshotCache.delete(cacheKey);
    }
    return undefined;
  }

  return cloneProjectPIISnapshot(cached.snapshot);
}

function setCachedProjectPIISnapshot(cacheKey: string, snapshot: RuntimePIIProjectSnapshot): void {
  const now = Date.now();
  purgeExpiredProjectPIISnapshots(now);

  if (
    !projectPIISnapshotCache.has(cacheKey) &&
    projectPIISnapshotCache.size >= MAX_PROJECT_PII_SNAPSHOT_CACHE
  ) {
    const oldestKey = projectPIISnapshotCache.keys().next().value;
    if (oldestKey) {
      projectPIISnapshotCache.delete(oldestKey);
    }
  }

  projectPIISnapshotCache.set(cacheKey, {
    expiresAt: now + PROJECT_PII_SNAPSHOT_TTL_MS,
    snapshot: cloneProjectPIISnapshot(snapshot),
  });
}

function createRecognizerRegistry(): PIIRecognizerRegistry {
  const recognizerRegistry = new PIIRecognizerRegistry();
  registerBuiltInRecognizers(recognizerRegistry);
  return recognizerRegistry;
}

export function resolveDefaultPIIRedactionConfig(
  environment: Environment | undefined,
): RuntimePIIRedactionConfig {
  const nluConfig = buildNLUConfig({
    environment: environment ?? 'dev',
    envVars: process.env as Record<string, string>,
  });
  // Run NLU defaults through the mapper so the four new fields pick up
  // their canonical defaults ('basic', 200, 0.5, ['core']) — single
  // source of default truth.
  return mapProjectPIIRedactionConfig({
    enabled: nluConfig.piiRedaction.enabled,
    redact_input: nluConfig.piiRedaction.redactInput,
    redact_output: nluConfig.piiRedaction.redactOutput,
  });
}

export async function resolveProjectPIIRedactionConfig(params: {
  tenantId?: string;
  projectId?: string;
}): Promise<RuntimePIIRedactionConfig | undefined> {
  if (!params.tenantId || !params.projectId) {
    return undefined;
  }

  if (!isDatabaseReady()) {
    log.debug('PII redaction config unavailable because database is not ready', {
      tenantId: params.tenantId,
      projectId: params.projectId,
    });
    return undefined;
  }

  try {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database/models');
    const doc = await ProjectRuntimeConfig.findOne(
      { tenantId: params.tenantId, projectId: params.projectId },
      { pii_redaction: 1 },
    ).lean();

    if (!doc?.pii_redaction) {
      return undefined;
    }

    return mapProjectPIIRedactionConfig(doc.pii_redaction as ProjectPIIRedactionConfig);
  } catch (err) {
    log.debug('PII redaction config unavailable', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function resolveSessionPIIRedactionConfig(
  session: RuntimeSession,
): Promise<RuntimePIIRedactionConfig> {
  return (
    (await resolveProjectPIIRedactionConfig({
      tenantId: session.tenantId,
      projectId: session.projectId,
    })) ?? resolveDefaultPIIRedactionConfig(session.versionInfo?.environment as Environment)
  );
}

export async function resolveProjectPIISnapshot(params: {
  tenantId?: string;
  projectId?: string;
  environment?: Environment | undefined;
}): Promise<RuntimePIIProjectSnapshot> {
  const epoch =
    params.tenantId && params.projectId
      ? await getPIIConfigEpoch(params.tenantId, params.projectId)
      : 0;
  const cacheKey = getProjectPIISnapshotCacheKey({ ...params, epoch });
  const cached = getCachedProjectPIISnapshot(cacheKey);
  if (cached) {
    return cached;
  }

  const piiRedactionConfig =
    (await resolveProjectPIIRedactionConfig({
      tenantId: params.tenantId,
      projectId: params.projectId,
    })) ?? resolveDefaultPIIRedactionConfig(params.environment);

  if (!piiRedactionConfig.enabled) {
    const disabledSnapshot: RuntimePIIProjectSnapshot = {
      piiRedactionConfig,
      piiPatternConfigs: [],
    };
    setCachedProjectPIISnapshot(cacheKey, disabledSnapshot);
    return cloneProjectPIISnapshot(disabledSnapshot);
  }

  const piiRecognizerRegistry = createRecognizerRegistry();
  const piiPatternConfigs =
    params.tenantId && params.projectId
      ? await loadProjectPIIPatterns(params.tenantId, params.projectId, piiRecognizerRegistry, {
          enabledRecognizerPacks: piiRedactionConfig.enabledRecognizerPacks,
        })
      : [];

  const snapshot: RuntimePIIProjectSnapshot = {
    piiRedactionConfig,
    piiRecognizerRegistry,
    piiPatternConfigs,
  };
  setCachedProjectPIISnapshot(cacheKey, snapshot);
  return cloneProjectPIISnapshot(snapshot);
}

export function createPIIVaultForProjectSnapshot(
  snapshot: RuntimePIIProjectSnapshot,
): PIIVault | undefined {
  return snapshot.piiRecognizerRegistry
    ? new PIIVault({ recognizerRegistry: snapshot.piiRecognizerRegistry })
    : undefined;
}

export async function buildProjectPIIReadSurfaceContext(params: {
  tenantId?: string;
  projectId?: string;
  environment?: Environment | undefined;
}): Promise<PIIReadSurfaceContext | undefined> {
  const snapshot = await resolveProjectPIISnapshot(params);
  if (!snapshot.piiRedactionConfig.enabled) {
    return undefined;
  }

  const piiVault = createPIIVaultForProjectSnapshot(snapshot);
  if (!piiVault) {
    return undefined;
  }

  return {
    piiRedactionConfig: snapshot.piiRedactionConfig,
    piiVault,
    piiPatternConfigs: snapshot.piiPatternConfigs,
  };
}

export async function buildStoredPIIReadSurfaceContext(params: {
  tenantId?: string;
  projectId?: string;
  piiVaultData?: string;
  fallbackPIIRedactionConfig?: RuntimePIIRedactionConfig;
}): Promise<PIIReadSurfaceContext | undefined> {
  const piiRedactionConfig =
    (await resolveProjectPIIRedactionConfig({
      tenantId: params.tenantId,
      projectId: params.projectId,
    })) ?? params.fallbackPIIRedactionConfig;

  if (!piiRedactionConfig?.enabled) {
    return undefined;
  }

  const piiRecognizerRegistry = createRecognizerRegistry();
  const piiPatternConfigs =
    params.tenantId && params.projectId
      ? await loadProjectPIIPatterns(params.tenantId, params.projectId, piiRecognizerRegistry, {
          enabledRecognizerPacks: piiRedactionConfig.enabledRecognizerPacks,
        })
      : [];
  const piiVault = params.piiVaultData
    ? PIIVault.deserialize(params.piiVaultData, { recognizerRegistry: piiRecognizerRegistry })
    : new PIIVault({ recognizerRegistry: piiRecognizerRegistry });

  return {
    piiRedactionConfig,
    piiVault,
    piiPatternConfigs,
  };
}

export function resetProjectPIISnapshotCacheForTest(): void {
  projectPIISnapshotCache.clear();
}

export async function refreshSessionPIIContext(session: RuntimeSession): Promise<void> {
  const snapshot = await resolveProjectPIISnapshot({
    tenantId: session.tenantId,
    projectId: session.projectId,
    environment: session.versionInfo?.environment as Environment | undefined,
  });
  session.piiRedactionConfig = snapshot.piiRedactionConfig;

  if (!session.piiRedactionConfig.enabled) {
    session.piiRecognizerRegistry = undefined;
    session.piiPatternConfigs = [];
    if (session.piiVault) {
      session.piiVault.setRecognizerRegistry(undefined);
    }
    return;
  }
  const piiRecognizerRegistry = snapshot.piiRecognizerRegistry;
  session.piiRecognizerRegistry = piiRecognizerRegistry;
  session.piiPatternConfigs = snapshot.piiPatternConfigs;

  if (session.piiVault) {
    session.piiVault.setRecognizerRegistry(piiRecognizerRegistry);
  } else {
    session.piiVault = new PIIVault({ recognizerRegistry: piiRecognizerRegistry });
  }
}
