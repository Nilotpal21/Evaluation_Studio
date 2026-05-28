import {
  selectArchModelPolicyDefaults,
  type ArchModelPolicyCandidate,
  type ArchModelPolicyDefaults,
} from '@agent-platform/arch-ai/model-policy';
import { getModelCapabilities } from '@abl/compiler/platform/llm/model-capabilities.js';
import { ModelConfig, TenantModel } from '@agent-platform/database/models';

export { selectArchModelPolicyDefaults };

function withRegistryCapabilities(
  candidates: readonly ArchModelPolicyCandidate[],
): ArchModelPolicyCandidate[] {
  return candidates.map((candidate) => {
    if (!candidate.modelId) return candidate;
    const capabilities = getModelCapabilities(candidate.modelId);
    return {
      ...candidate,
      isReasoningModel: candidate.isReasoningModel ?? capabilities.isReasoningModel,
      supportsReasoningEffort:
        candidate.supportsReasoningEffort ?? capabilities.supportsReasoningEffort,
      supportsThinking: candidate.supportsThinking ?? capabilities.supportsThinking,
      supportsThinkingBudget:
        candidate.supportsThinkingBudget ?? capabilities.supportsThinkingBudget,
    };
  });
}

export async function resolveArchModelPolicyDefaultsForProject(input: {
  tenantId: string;
  projectId: string;
}): Promise<ArchModelPolicyDefaults> {
  const projectModels = (await ModelConfig.find({
    tenantId: input.tenantId,
    projectId: input.projectId,
    supportsTools: true,
  })
    .select('modelId tier isDefault priority supportsTools')
    .lean()) as ArchModelPolicyCandidate[];

  const projectDefaults = selectArchModelPolicyDefaults(withRegistryCapabilities(projectModels));
  if (projectDefaults.fastToolCapable || projectDefaults.reasoning || projectDefaults.research) {
    return projectDefaults;
  }

  const tenantModels = (await TenantModel.find({
    tenantId: input.tenantId,
    isActive: true,
    inferenceEnabled: true,
    supportsTools: true,
  })
    .select('modelId tier isDefault supportsTools capabilities')
    .lean()) as ArchModelPolicyCandidate[];

  return selectArchModelPolicyDefaults(withRegistryCapabilities(tenantModels));
}
