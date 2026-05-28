/**
 * Security Repository — Re-export Barrel
 *
 * All security repo operations are now in @agent-platform/shared.
 * This file re-exports for backwards compatibility with existing import paths.
 */

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
} from '@agent-platform/shared/repos';
export type {
  ToolSecretFilter,
  ToolSecretUpdateData,
  OrgProxyConfigCreateData,
  OrgProxyConfigFilter,
  EnvironmentVariableCreateData,
  EnvironmentVariableFilter,
  EnvironmentVariableUpdateData,
} from '@agent-platform/shared/repos';
