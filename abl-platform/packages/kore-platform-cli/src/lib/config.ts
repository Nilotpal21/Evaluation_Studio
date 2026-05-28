/**
 * Configuration Management
 *
 * Manages CLI configuration file using conf package.
 */

import Conf from 'conf';

// =============================================================================
// TYPES
// =============================================================================

export interface CliConfig {
  apiUrl: string;
  runtimeApiUrl?: string;
  searchAiApiUrl?: string;
  currentProjectId?: string;
  currentProjectSlug?: string;
  currentWorkspaceId?: string;
  currentWorkspaceName?: string;
}

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_CONFIG: CliConfig = {
  apiUrl: 'https://agents.kore.ai',
  runtimeApiUrl: 'https://agents.kore.ai',
  searchAiApiUrl: 'https://agents.kore.ai',
};

// =============================================================================
// CONFIG STORE
// =============================================================================

const config = new Conf<CliConfig>({
  projectName: 'kore-platform',
  defaults: DEFAULT_CONFIG,
});

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Get the API URL (defaults to runtime)
 */
export function getApiUrl(): string {
  return process.env.KORE_API_URL || config.get('apiUrl');
}

/**
 * Get Runtime API URL (agent platform)
 */
export function getRuntimeApiUrl(): string {
  return process.env.KORE_RUNTIME_API_URL || config.get('runtimeApiUrl') || getApiUrl();
}

/**
 * Get SearchAI API URL (connectors, indexes)
 */
export function getSearchAiApiUrl(): string {
  return (
    process.env.KORE_SEARCHAI_API_URL || config.get('searchAiApiUrl') || 'https://agents.kore.ai'
  );
}

/**
 * Set the API URL
 */
export function setApiUrl(url: string): void {
  config.set('apiUrl', url);
}

/**
 * Set the Runtime API URL
 */
export function setRuntimeApiUrl(url: string): void {
  config.set('runtimeApiUrl', url);
}

/**
 * Set the SearchAI API URL
 */
export function setSearchAiApiUrl(url: string): void {
  config.set('searchAiApiUrl', url);
}

/**
 * Get current project ID
 */
export function getCurrentProjectId(): string | undefined {
  return config.get('currentProjectId');
}

/**
 * Get current project slug
 */
export function getCurrentProjectSlug(): string | undefined {
  return config.get('currentProjectSlug');
}

/**
 * Set current project
 */
export function setCurrentProject(id: string, slug: string): void {
  config.set('currentProjectId', id);
  config.set('currentProjectSlug', slug);
}

/**
 * Clear current project
 */
export function clearCurrentProject(): void {
  config.delete('currentProjectId');
  config.delete('currentProjectSlug');
}

/**
 * Get current workspace ID
 */
export function getCurrentWorkspaceId(): string | undefined {
  return config.get('currentWorkspaceId');
}

/**
 * Get current workspace name
 */
export function getCurrentWorkspaceName(): string | undefined {
  return config.get('currentWorkspaceName');
}

/**
 * Set current workspace
 */
export function setCurrentWorkspace(id: string, name: string): void {
  config.set('currentWorkspaceId', id);
  config.set('currentWorkspaceName', name);
}

/**
 * Clear current workspace
 */
export function clearCurrentWorkspace(): void {
  config.delete('currentWorkspaceId');
  config.delete('currentWorkspaceName');
}

/**
 * Get all config
 */
export function getConfig(): CliConfig {
  return config.store;
}

/**
 * Reset config to defaults
 */
export function resetConfig(): void {
  config.clear();
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return config.path;
}
