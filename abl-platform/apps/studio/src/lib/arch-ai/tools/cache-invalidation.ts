/**
 * Shared cache invalidation for Arch AI tools.
 *
 * When project metadata or settings change, multiple tool caches may hold stale data.
 * This module provides helpers that invalidate known keys across tool caches.
 */

import { projectCache as platformContextCache } from './platform-context';

// project-config cache is set after module init to avoid circular imports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let projectConfigCache: { invalidate: (key: string) => void } | null = null;

/**
 * Called once from project-config.ts to register its cache for cross-module invalidation.
 */
export function registerProjectConfigCache(cache: { invalidate: (key: string) => void }): void {
  projectConfigCache = cache;
}

/**
 * Invalidate all project-scoped cache entries across platform_context and project_config caches.
 * Call after update_config to ensure stale summaries/agent lists are cleared.
 */
export function invalidateProjectCaches(tenantId: string, projectId: string): void {
  const prefix = `${tenantId}:${projectId}`;

  // platform-context cache keys
  platformContextCache.invalidate(`${prefix}:get_summary`);
  platformContextCache.invalidate(`${prefix}:list_agents`);
  platformContextCache.invalidate(`${prefix}:list_tools`);
  platformContextCache.invalidate(`${prefix}:list_channels`);
  platformContextCache.invalidate(`${prefix}:list_auth_profiles`);

  // project-config cache keys
  if (projectConfigCache) {
    projectConfigCache.invalidate(`${prefix}:get_config`);
    projectConfigCache.invalidate(`${prefix}:get_settings`);
  }
}

/**
 * Invalidate only the settings cache entry.
 * Call after update_settings.
 */
export function invalidateSettingsCache(tenantId: string, projectId: string): void {
  if (projectConfigCache) {
    projectConfigCache.invalidate(`${tenantId}:${projectId}:get_settings`);
  }
}
