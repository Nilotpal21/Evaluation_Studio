/**
 * Shared Repos Barrel
 *
 * Re-exports all repository functions for MCP config, project tool, and security data access.
 * Both Studio and Runtime import from here.
 */

// Base repository class for tenant-scoped data access
export { TenantScopedRepository } from './base-repository.js';
export type { PaginationOptions } from './base-repository.js';

// Transaction helpers
export { withTransaction, canUseTransactions, _resetTxCache } from './mongo-tx.js';

// MCP server config repo
export {
  findMcpServerConfigById,
  findMcpServerConfigsByProject,
  findMcpServerConfigsWithToolCount,
  createMcpServerConfig,
  updateMcpServerConfig,
  updateProjectScopedMcpServerConfig,
  updateMcpServerConnectionStatus,
  deleteMcpServerConfigWithCascade,
  deleteProjectScopedMcpServerConfigWithCascade,
  findMcpServerConfigsRaw,
} from './mcp-server-config-repo.js';
export type { McpServerConfigForIR, RawMCPServerConfig } from './mcp-server-config-repo.js';

// External agent config repo
export {
  findExternalAgentConfigById,
  findExternalAgentConfigsByProject,
  findExternalAgentConfigByName,
  createExternalAgentConfig,
  updateExternalAgentConfig,
  patchExternalAgentConnectionStatus,
  deleteExternalAgentConfig,
  testExternalAgentConnection,
} from './external-agent-config-repo.js';
export type {
  NormalizedExternalAgentConfig,
  ExternalAgentLookupResult,
  LookupExternalAgent,
  ConnectionTestResult,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
  ConnectionStatusPatch,
  TestConnectionDeps,
  ExternalAgentAuthConfig,
} from './external-agent-config-repo.js';
// HTTP wire-shape view (encryptedAuthConfig stripped → authConfigured boolean).
// Consumed by Studio executor + ExternalAgentCard widget; runtime route emits it.
export type { ExternalAgentConfigView } from '../types/external-agent.js';

// Project tool repo (DSL-native tools)
export {
  findProjectToolById,
  findProjectToolsByProject,
  findProjectToolByName,
  createProjectTool,
  updateProjectTool,
  deleteProjectTool,
  countProjectToolsByProject,
  findProjectToolsByNames,
} from './project-tool-repo.js';

// Security repo (secrets, proxy, OAuth, environment variables)
export {
  createToolSecret,
  findToolSecrets,
  countToolSecrets,
  findToolSecretById,
  updateToolSecret,
  deleteToolSecret,
  createOrgProxyConfig,
  findOrgProxyConfigs,
  countOrgProxyConfigs,
  findOrgProxyConfigById,
  updateOrgProxyConfig,
  deleteOrgProxyConfig,
  findEndUserOAuthTokens,
  countEndUserOAuthTokens,
  createEnvironmentVariable,
  findEnvironmentVariables,
  countEnvironmentVariables,
  findEnvironmentVariableById,
  findEnvironmentVariableByKey,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  bulkUpsertEnvironmentVariables,
} from './security-repo.js';
export type {
  ToolSecretFilter,
  ToolSecretUpdateData,
  OrgProxyConfigCreateData,
  OrgProxyConfigFilter,
  EnvironmentVariableCreateData,
  EnvironmentVariableFilter,
  EnvironmentVariableUpdateData,
} from './security-repo.js';
