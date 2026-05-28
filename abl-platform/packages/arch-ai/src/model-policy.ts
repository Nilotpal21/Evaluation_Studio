export type ArchModelClass = 'fast_tool_capable' | 'reasoning' | 'research';

export type ArchAgentModelType = 'classifier' | 'support' | 'dispatcher' | 'research' | 'reasoning';

export interface ArchModelPolicy {
  agentType?: ArchAgentModelType;
  reasoningRequired?: boolean;
  defaultModelClass?: ArchModelClass;
}

export interface ArchModelPolicyDefaults {
  fastToolCapable?: string;
  reasoning?: string;
  research?: string;
}

export interface ResolveArchExecutionModelInput {
  explicitModel?: string;
  /**
   * Optional capability intent emitted by topology/blueprint planning.
   * This is deliberately pass-through metadata: Arch should not use it to
   * select a concrete execution model. Tenant/project catalog policy resolves
   * accessible models later.
   */
  modelPolicy?: ArchModelPolicy;
  modelDefaults?: ArchModelPolicyDefaults;
}

export interface InferArchModelPolicyInput {
  name?: string | null;
  role?: string | null;
  description?: string | null;
  executionMode?: 'reasoning' | 'scripted' | 'hybrid' | string | null;
  isEntryPoint?: boolean;
  hasOutgoingEdges?: boolean;
}

export interface ArchModelPolicyCandidate {
  modelId?: string | null;
  tier?: string | null;
  isDefault?: boolean | null;
  priority?: number | null;
  supportsTools?: boolean | null;
  capabilities?: readonly string[] | null;
  isReasoningModel?: boolean | null;
  supportsReasoningEffort?: boolean | null;
  supportsThinking?: boolean | null;
  supportsThinkingBudget?: boolean | null;
}

const ARCH_MODEL_DEFAULT_ENV_KEYS = {
  fastToolCapable: ['ARCH_FAST_TOOL_MODEL', 'ARCH_AGENT_FAST_TOOL_MODEL'],
  reasoning: ['ARCH_REASONING_MODEL', 'ARCH_AGENT_REASONING_MODEL'],
  research: ['ARCH_RESEARCH_MODEL', 'ARCH_AGENT_RESEARCH_MODEL'],
} as const;

const FAST_TOOL_TIER_ORDER = ['fast', 'balanced', 'powerful'];
const REASONING_TIER_ORDER = ['powerful', 'balanced', 'fast'];

const LAST_RESORT_ARCH_MODEL_POLICY_DEFAULTS: Required<ArchModelPolicyDefaults> = {
  fastToolCapable: 'gpt-4o',
  reasoning: 'o4-mini',
  research: 'o4-mini',
};

const RESEARCH_POLICY_TEXT_PATTERN =
  /\b(research|literature review|source synthesis|multi-source|open-ended analysis|investigate|investigation)\b/i;

const REASONING_POLICY_TEXT_PATTERN =
  /\b(deep reasoning|complex reasoning|strategic planning|diagnosis|diagnostic|root cause|advisory|risk analysis|policy synthesis|eligibility analysis)\b/i;

const DISPATCHER_POLICY_TEXT_PATTERN =
  /\b(router|routing|triage|dispatch|dispatcher|coordinate|coordinator|handoff|classif(?:y|ier|ication))\b/i;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readFirstEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = nonBlank(env[key]);
    if (value) return value;
  }
  return undefined;
}

function joinPolicyText(input: InferArchModelPolicyInput): string {
  return [input.name, input.role, input.description, input.executionMode]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

function tierRank(tierOrder: readonly string[], tier: string | null | undefined): number {
  const normalized = tier?.toLowerCase();
  const index = normalized ? tierOrder.indexOf(normalized) : -1;
  return index >= 0 ? index : tierOrder.length;
}

function candidateModelId(candidate: ArchModelPolicyCandidate): string | undefined {
  return nonBlank(candidate.modelId ?? undefined);
}

function modelFamilyLooksReasoningCapable(modelId: string): boolean {
  const bareModelId = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  return /^(?:o[134](?:[.-]|$)|gpt-5(?:[.-]|$)|.*\b(?:reasoning|thinking)\b)/i.test(bareModelId);
}

function candidateSupportsReasoning(candidate: ArchModelPolicyCandidate): boolean {
  const capabilities = candidate.capabilities ?? [];
  if (
    capabilities.some((capability) =>
      /^(reasoning|thinking|extended_thinking|reasoning_effort)$/i.test(capability),
    )
  ) {
    return true;
  }

  const modelId = candidateModelId(candidate);
  if (!modelId) return false;
  return (
    candidate.isReasoningModel === true ||
    candidate.supportsReasoningEffort === true ||
    candidate.supportsThinking === true ||
    candidate.supportsThinkingBudget === true ||
    modelFamilyLooksReasoningCapable(modelId)
  );
}

function compareCandidates(tierOrder: readonly string[]) {
  return (left: ArchModelPolicyCandidate, right: ArchModelPolicyCandidate): number => {
    const leftTier = tierRank(tierOrder, left.tier);
    const rightTier = tierRank(tierOrder, right.tier);
    if (leftTier !== rightTier) return leftTier - rightTier;

    const leftDefault = left.isDefault === true ? 1 : 0;
    const rightDefault = right.isDefault === true ? 1 : 0;
    if (leftDefault !== rightDefault) return rightDefault - leftDefault;

    const leftPriority = typeof left.priority === 'number' ? left.priority : 0;
    const rightPriority = typeof right.priority === 'number' ? right.priority : 0;
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;

    return (candidateModelId(left) ?? '').localeCompare(candidateModelId(right) ?? '');
  };
}

function pickModel(
  candidates: readonly ArchModelPolicyCandidate[],
  tierOrder: readonly string[],
  predicate: (candidate: ArchModelPolicyCandidate) => boolean,
): string | undefined {
  return candidates
    .filter((candidate) => candidate.supportsTools !== false && candidateModelId(candidate))
    .filter(predicate)
    .slice()
    .sort(compareCandidates(tierOrder))
    .map(candidateModelId)
    .find((modelId): modelId is string => Boolean(modelId));
}

export function selectArchModelPolicyDefaults(
  candidates: readonly ArchModelPolicyCandidate[],
): ArchModelPolicyDefaults {
  const fastToolCapable = pickModel(
    candidates,
    FAST_TOOL_TIER_ORDER,
    (candidate) => !candidateSupportsReasoning(candidate),
  );
  const reasoning = pickModel(candidates, REASONING_TIER_ORDER, candidateSupportsReasoning);

  return {
    ...(fastToolCapable ? { fastToolCapable } : {}),
    ...(reasoning ? { reasoning, research: reasoning } : {}),
  };
}

export function resolveDefaultArchModelPolicyDefaults(
  env: Record<string, string | undefined> = process.env,
): Required<ArchModelPolicyDefaults> {
  return {
    fastToolCapable:
      readFirstEnv(env, ARCH_MODEL_DEFAULT_ENV_KEYS.fastToolCapable) ??
      LAST_RESORT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable,
    reasoning:
      readFirstEnv(env, ARCH_MODEL_DEFAULT_ENV_KEYS.reasoning) ??
      LAST_RESORT_ARCH_MODEL_POLICY_DEFAULTS.reasoning,
    research:
      readFirstEnv(env, ARCH_MODEL_DEFAULT_ENV_KEYS.research) ??
      LAST_RESORT_ARCH_MODEL_POLICY_DEFAULTS.research,
  };
}

export const DEFAULT_ARCH_MODEL_POLICY_DEFAULTS: Required<ArchModelPolicyDefaults> =
  resolveDefaultArchModelPolicyDefaults();

export function normalizeArchModelPolicyDefaults(
  overrides: ArchModelPolicyDefaults | undefined,
): Required<ArchModelPolicyDefaults> {
  const defaults = resolveDefaultArchModelPolicyDefaults();
  return {
    fastToolCapable: nonBlank(overrides?.fastToolCapable) ?? defaults.fastToolCapable,
    reasoning: nonBlank(overrides?.reasoning) ?? defaults.reasoning,
    research: nonBlank(overrides?.research) ?? defaults.research,
  };
}

export function resolveArchModelClass(policy: ArchModelPolicy | undefined): ArchModelClass {
  if (policy?.reasoningRequired === true) {
    return policy.defaultModelClass === 'research' || policy.agentType === 'research'
      ? 'research'
      : 'reasoning';
  }
  if (policy?.defaultModelClass) return policy.defaultModelClass;
  if (policy?.agentType === 'research') return 'research';
  if (policy?.agentType === 'reasoning') {
    return 'reasoning';
  }
  return 'fast_tool_capable';
}

export function inferArchModelPolicyFromText(input: InferArchModelPolicyInput): ArchModelPolicy {
  const text = joinPolicyText(input);
  if (RESEARCH_POLICY_TEXT_PATTERN.test(text)) {
    return {
      agentType: 'research',
      reasoningRequired: true,
      defaultModelClass: 'research',
    };
  }
  if (REASONING_POLICY_TEXT_PATTERN.test(text)) {
    return {
      agentType: 'reasoning',
      reasoningRequired: true,
      defaultModelClass: 'reasoning',
    };
  }
  if (input.hasOutgoingEdges === true || DISPATCHER_POLICY_TEXT_PATTERN.test(text)) {
    return {
      agentType: 'dispatcher',
      reasoningRequired: false,
      defaultModelClass: 'fast_tool_capable',
    };
  }
  return {
    agentType: 'support',
    reasoningRequired: false,
    defaultModelClass: 'fast_tool_capable',
  };
}

export function resolveArchExecutionModel(input: ResolveArchExecutionModelInput): string {
  const explicitModel = nonBlank(input.explicitModel);
  if (explicitModel) return explicitModel;
  const defaults = normalizeArchModelPolicyDefaults(input.modelDefaults);
  return defaults.fastToolCapable;
}
