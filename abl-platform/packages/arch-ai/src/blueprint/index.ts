export {
  BlueprintAgentNameSchema,
  BlueprintExecutionModeSchema,
  BlueprintV2ModelDefaultsSchema,
  BlueprintV2ModelPolicySchema,
  BlueprintV2OutputSchema,
  BlueprintV2PerAgentSpecSchema,
  assertValidBlueprintV2Output,
  validateBlueprintV2Output,
} from './v2-schema.js';
export type {
  BlueprintV2Output,
  BlueprintV2PerAgentSpec,
  BlueprintV2ValidationIssue,
} from './v2-schema.js';

export {
  renderAgentDslFromBlueprint,
  renderBlueprintMarkdown,
  renderProjectFromBlueprint,
} from './renderer.js';
export type {
  BlueprintRenderedAgent,
  BlueprintRenderedProject,
  BlueprintRenderOptions,
} from './renderer.js';
export {
  ARCH_MANAGED_BEHAVIOR_PROFILE_NAMES,
  FRUSTRATION_EMPATHY_PROFILE_NAME,
  PLAIN_LANGUAGE_PROFILE_NAME,
  renderArchManagedBehaviorProfiles,
  SHARED_VOICE_HANDOFF_PROFILE_NAME,
  VOICE_COMPACT_PROFILE_NAME,
  isArchManagedBehaviorProfileName,
} from './managed-profiles.js';
export type {
  ArchManagedBehaviorProfileName,
  ArchManagedBehaviorProfileOptions,
  ArchManagedChannelRule,
  BlueprintRenderedBehaviorProfile,
} from './managed-profiles.js';

export { BLUEPRINT_BATTLE_TEST_FIXTURES } from './fixtures.js';

export { BlueprintService } from './service.js';
export type { BlueprintLookup, CreateBlueprintInput, BlueprintEditInput } from './service.js';

export {
  extractSourceArchitectureContractFromFiles,
  extractSourceArchitectureContractFromText,
  getSourceArchitectureContractFromMetadata,
  renderSourceArchitectureContractPrompt,
  synthesizeTopologyFromSourceContract,
  validateTopologyAgainstSourceContract,
} from './source-architecture-contract.js';
export type {
  SourceArchitectureContract,
  SourceContractAgent,
  SourceContractBehaviorProfile,
  SourceContractChannelRule,
  SourceContractConsentPolicy,
  SourceContractScenarioFixture,
  SourceContractTool,
  SourceContractWelcomeShape,
} from './source-architecture-contract.js';
