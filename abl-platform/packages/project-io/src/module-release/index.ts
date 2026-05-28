/**
 * Module Release barrel export
 */

export {
  buildModuleRelease,
  type ModuleReleaseInput,
  type CompileFn,
  type ExtractContractFn,
  type ValidatePublishSafetyFn,
  type ModuleReleaseBuildSuccess,
  type ModuleReleaseBuildFailure,
  type ModuleReleaseBuildResult,
} from './build-module-release.js';
export {
  materializeModuleToolDefinition,
  type ModuleReleaseToolDefinition,
} from './tool-definition.js';
export { computeModuleSourceHash } from './source-hash.js';
export {
  extractModuleContract,
  type ContractAgentInput,
  type ContractToolInput,
} from './module-contract.js';
export {
  resolveSelector,
  type ModuleSelector,
  type ModuleSelectorSuccess,
  type ModuleSelectorError,
  type ModuleSelectorResult,
} from './module-selector.js';
export {
  validatePublishSafety,
  type PublishSafetySeverity,
  type PublishSafetyIssue,
  type PublishSafetyResult,
  type SafetyAgentInput,
  type SafetyToolInput,
} from './module-publish-safety.js';
export {
  validateConfigOverrides,
  type ConfigOverrideValidationResult,
  type ContractConfigKey,
} from './config-overrides-validator.js';
export {
  diffModuleContracts,
  EMPTY_MODULE_CONTRACT,
  type ContractDiffEntry,
  type ModuleContractDiff,
} from './module-contract-diff.js';
export type { ModuleReleaseContract } from '@agent-platform/database/models';
export {
  buildModuleAgentStubs,
  loadAndBuildModuleAgentStubs,
  isMountedModuleName,
  MODULE_NAME_SEPARATOR,
  type ModuleDependencyRecord,
} from './module-agent-stubs.js';
