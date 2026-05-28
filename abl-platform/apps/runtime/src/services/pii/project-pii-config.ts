/**
 * Project PII Config — reads project-level PII configuration from
 * `project_runtime_configs` and exposes the enabled recognizer packs.
 *
 * Uses a simple Map-based LRU cache (max 500, 60s TTL) modeled on
 * `tenantProviderLoadCache` in `pipeline-factory.ts`.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('project-pii-config');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectPIIConfig {
  enabledPacks: string[];
  /** Forward-compat placeholder — not used in v1 */
  customRecognizers?: unknown;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** All built-in recognizer packs, used when project has no explicit config. */
const DEFAULT_ENABLED_PACKS: readonly string[] = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
];

// ---------------------------------------------------------------------------
// LRU cache — Map<key, { config, ts }> with max size + TTL eviction
// ---------------------------------------------------------------------------

interface CacheEntry {
  config: ProjectPIIConfig;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

/** Maximum number of cached entries. */
const CACHE_MAX_SIZE = 500;

/** TTL for each entry: 60 seconds. */
const CACHE_TTL_MS = 60_000;

function cacheKey(tenantId: string, projectId: string): string {
  return `${tenantId}:${projectId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the PII configuration for a project.
 *
 * Checks an in-memory LRU cache first (500 entries, 60s TTL).
 * On miss, reads from `project_runtime_configs` via Mongoose.
 * If no config exists or `pii_redaction.enabled_recognizer_packs` is absent, returns all
 * built-in packs enabled.
 */
export async function getProjectPIIConfig(params: {
  tenantId: string;
  projectId: string;
}): Promise<ProjectPIIConfig> {
  const { tenantId, projectId } = params;
  const key = cacheKey(tenantId, projectId);
  const now = Date.now();

  // Cache hit check
  const cached = cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    // Refresh insertion order (LRU): delete + re-set moves to end
    cache.delete(key);
    cache.set(key, cached);
    return cached.config;
  }

  // Cache miss or stale — load from DB
  const config = await loadFromDB(tenantId, projectId);

  // Evict oldest if at capacity (Map iterates in insertion order)
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  // Delete stale entry (if any) then set fresh
  cache.delete(key);
  cache.set(key, { config, ts: now });

  return config;
}

/** Invalidate cached PII config for a specific project. Call on every write to pii_redaction config. */
export function invalidateProjectPIIConfig(tenantId: string, projectId: string): void {
  const key = cacheKey(tenantId, projectId);
  cache.delete(key);
  log.info('Invalidated project PII config cache', { tenantId, projectId });
}

/**
 * Reset the entire cache (for testing only).
 */
export function resetProjectPIIConfigCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Internal — DB lookup
// ---------------------------------------------------------------------------

async function loadFromDB(tenantId: string, projectId: string): Promise<ProjectPIIConfig> {
  try {
    const { ProjectRuntimeConfig } = await import('@agent-platform/database/models');
    const doc = await ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean();

    if (!doc) {
      return { enabledPacks: [...DEFAULT_ENABLED_PACKS] };
    }

    const piiRedaction = (doc as Record<string, unknown>).pii_redaction as
      | Record<string, unknown>
      | undefined;

    if (
      !piiRedaction ||
      !Array.isArray(piiRedaction.enabled_recognizer_packs) ||
      piiRedaction.enabled_recognizer_packs.length === 0
    ) {
      return { enabledPacks: [...DEFAULT_ENABLED_PACKS] };
    }

    // Validate each pack entry is a non-empty string
    const packs = piiRedaction.enabled_recognizer_packs.filter(
      (p: unknown): p is string => typeof p === 'string' && p.length > 0,
    );

    return {
      enabledPacks: packs.length > 0 ? packs : [...DEFAULT_ENABLED_PACKS],
      customRecognizers: piiRedaction.customRecognizers,
    };
  } catch (err) {
    log.warn('Failed to load project PII config from DB, using defaults', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { enabledPacks: [...DEFAULT_ENABLED_PACKS] };
  }
}
