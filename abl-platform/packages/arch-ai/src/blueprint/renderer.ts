import { createHash } from 'node:crypto';

import type { BlueprintV2Output, BlueprintV2PerAgentSpec } from './v2-schema.js';
import { assertValidBlueprintV2Output } from './v2-schema.js';
import {
  deriveProjectConstructPlanFromBlueprint,
  type AgentConstructPlan,
  type ConstructToolCall,
} from '../planning/construct-plan.js';
import { filterRelationshipToolRefs } from '../planning/relationship-tool-filter.js';
import {
  inferFallbackToolSignature,
  isGenericFallbackToolSignature,
} from '../planning/tool-signature-inference.js';
import { resolveArchExecutionModel, type ArchModelPolicyDefaults } from '../model-policy.js';
import {
  FRUSTRATION_EMPATHY_PROFILE_NAME,
  PLAIN_LANGUAGE_PROFILE_NAME,
  renderArchManagedBehaviorProfiles,
  SHARED_VOICE_HANDOFF_PROFILE_NAME,
  VOICE_COMPACT_PROFILE_NAME,
  type BlueprintRenderedBehaviorProfile,
} from './managed-profiles.js';
import type {
  SourceArchitectureContract,
  SourceContractConsentPolicy,
  SourceContractTool,
} from './source-architecture-contract.js';

export interface BlueprintRenderedAgent {
  name: string;
  dslContent: string;
  sourceHash: string;
}

export interface BlueprintRenderedProject {
  projectName: string;
  entryAgentName: string;
  agents: BlueprintRenderedAgent[];
  behaviorProfiles: BlueprintRenderedBehaviorProfile[];
  markdown: string;
}

export interface BlueprintRenderOptions {
  modelDefaults?: ArchModelPolicyDefaults;
  sourceContract?: SourceArchitectureContract | null;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function block(value: string, spaces = 2): string {
  const indent = ' '.repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function condition(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'true';
}

function conditionLine(value: string): string {
  return condition(value).replace(/\r?\n/g, ' ');
}

type BlueprintToolRef = BlueprintV2PerAgentSpec['tools'][number];

const SIDE_EFFECT_TOOL_PATTERN =
  /\b(apply|approve|assign|book|cancel|charge|close|create|delete|execute|finalize|initiate|issue|provision|refund|replace|replacement|request|schedule|send|submit|transfer|update|write)\b/i;

const READ_ONLY_TOOL_PREFIX_PATTERN =
  /^(authenticate|calculate|check|classify|diagnose|fetch|find|get|list|load|lookup|parse|read|screen|score|search|validate|verify)(_|$)/i;

const CONSENT_SCOPE_PRIORITY = [
  'order_id',
  'invoice_id',
  'account_id',
  'customer_id',
  'case_id',
  'ticket_id',
  'transaction_id',
  'payment_id',
  'refund_amount',
  'credit_amount',
  'amount',
];

function constraintKind(kind: string): string {
  if (kind === 'warning') return 'WARN';
  return kind.toUpperCase();
}

function renderExecution(
  agent: BlueprintV2PerAgentSpec,
  modelDefaults: ArchModelPolicyDefaults | undefined,
): string[] {
  return [
    '',
    'EXECUTION:',
    `  model: ${resolveArchExecutionModel({
      explicitModel: agent.model,
      modelPolicy: agent.modelPolicy,
      modelDefaults,
    })}`,
  ];
}

function isSideEffectingTool(tool: BlueprintToolRef): boolean {
  if (tool.sideEffects !== undefined) return tool.sideEffects;
  const text = `${tool.ref} ${tool.purpose} ${tool.description ?? ''}`.toLowerCase();
  if (READ_ONLY_TOOL_PREFIX_PATTERN.test(tool.ref)) {
    return SIDE_EFFECT_TOOL_PATTERN.test(text) && !/^get|lookup|search|fetch|list/i.test(tool.ref);
  }
  return SIDE_EFFECT_TOOL_PATTERN.test(text);
}

function parseSignatureParamNames(signature: string | undefined): string[] {
  if (!signature) return [];
  const params = signature.match(/\(([^)]*)\)/)?.[1];
  if (!params) return [];
  return params
    .split(',')
    .map((param) => param.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function inferConsentAction(tool: BlueprintToolRef): string {
  const text = `${tool.ref} ${tool.purpose} ${tool.description ?? ''}`.toLowerCase();
  if (/\b(replacement|replace|resend)\b/.test(text)) return 'replacement';
  if (/\brefund\b/.test(text)) return 'refund';
  if (/\bcredit\b/.test(text)) return 'credit';
  if (/\b(charge|payment|pay)\b/.test(text)) return 'payment';
  if (/\b(book|booking|reservation|appointment|schedule)\b/.test(text)) return 'booking';
  if (/\bcancel\b/.test(text)) return 'cancellation';
  return tool.ref.replace(/_/g, ' ');
}

function inferConsentScope(tool: BlueprintToolRef): string[] {
  const params = parseSignatureParamNames(tool.signature);
  if (params.length === 0) return [];
  return CONSENT_SCOPE_PRIORITY.filter((field) => params.includes(field));
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function findConsentPolicyForTool(
  tool: BlueprintToolRef,
  sourceContract: SourceArchitectureContract | null | undefined,
): SourceContractConsentPolicy | undefined {
  const policies = sourceContract?.consentPolicies ?? [];
  if (policies.length === 0) return undefined;

  const toolName = normalizeToolName(tool.ref);
  const explicitPolicy = policies.find(
    (policy) => policy.toolName && normalizeToolName(policy.toolName) === toolName,
  );
  if (explicitPolicy) return explicitPolicy;

  const searchableToolText = `${tool.ref} ${tool.purpose} ${tool.description ?? ''}`.toLowerCase();
  return policies.find(
    (policy) => !policy.toolName && searchableToolText.includes(policy.action.toLowerCase()),
  );
}

function findSourceContractTool(
  tool: BlueprintToolRef,
  sourceContract: SourceArchitectureContract | null | undefined,
): SourceContractTool | undefined {
  const sourceTools = sourceContract?.tools ?? [];
  if (sourceTools.length === 0) return undefined;
  const toolName = normalizeToolName(tool.ref);
  return sourceTools.find((candidate) => normalizeToolName(candidate.name) === toolName);
}

function renderToolDescription(
  tool: BlueprintToolRef,
  sourceTool: SourceContractTool | undefined,
): string {
  const parts = [sourceTool?.description ?? tool.description ?? tool.purpose];
  if (sourceTool?.callWhen?.length) {
    parts.push(`Call when ${sourceTool.callWhen.join('; ')}.`);
  }
  if (sourceTool?.doNotCallWhen?.length) {
    parts.push(`Do not call when ${sourceTool.doNotCallWhen.join('; ')}.`);
  }
  return parts.join(' ');
}

function normalizeSourceToolSignature(
  toolName: string,
  sourceSignature: string | undefined,
): string | undefined {
  const signature = sourceSignature?.trim();
  if (!signature) return undefined;
  const namedSignature = signature.match(
    /^[A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z_][A-Za-z0-9_]*)*\s*(\(.*)$/s,
  );
  if (namedSignature?.[1]) return `${normalizeToolName(toolName)}${namedSignature[1]}`;
  if (/^\(/.test(signature)) return `${normalizeToolName(toolName)}${signature}`;
  return undefined;
}

function renderToolConfirmation(
  tool: BlueprintToolRef,
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  const sourcePolicy = findConsentPolicyForTool(tool, sourceContract);
  const confirmation =
    tool.confirmation ??
    (sourcePolicy
      ? {
          require: sourcePolicy.mode,
          immutableParams: sourcePolicy.scopeFields,
          consentRequiredIn: sourcePolicy.requiredIn,
          consentScope: sourcePolicy.scopeFields,
          consentAction: sourcePolicy.action,
          consentFallback: sourcePolicy.fallback,
        }
      : undefined);
  const sideEffects = isSideEffectingTool(tool) || Boolean(sourcePolicy);
  if (!confirmation && !sideEffects) return [];

  const require = confirmation?.require ?? 'when_side_effects';
  const scope = confirmation?.consentScope?.length
    ? confirmation.consentScope
    : inferConsentScope(tool);
  const immutableParams = confirmation?.immutableParams?.length
    ? confirmation.immutableParams
    : scope;
  const consentRequiredIn = confirmation?.consentRequiredIn ?? 'conversation';
  const consentAction = confirmation?.consentAction ?? inferConsentAction(tool);
  const consentFallback = confirmation?.consentFallback ?? 'explicit_prompt';

  const lines = sideEffects ? ['    side_effects: true'] : [];
  lines.push(`    confirm: ${require}`);
  if (require === 'never') return lines;
  if (immutableParams.length > 0) {
    lines.push(`    immutable: [${immutableParams.join(', ')}]`);
  }
  lines.push(`    consent_required_in: ${consentRequiredIn}`);
  if (scope.length > 0) {
    lines.push(`    consent_scope: [${scope.join(', ')}]`);
  }
  lines.push(`    consent_action: ${quote(consentAction)}`);
  lines.push(`    consent_fallback: ${consentFallback}`);
  return lines;
}

function renderTools(
  agent: BlueprintV2PerAgentSpec,
  relationshipTargets: ReadonlyArray<string>,
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  const tools = filterRelationshipToolRefs(agent.tools, relationshipTargets, (tool) => tool.ref);
  if (tools.length === 0) return [];
  const lines = ['', 'TOOLS:'];
  for (const tool of tools) {
    const sourceTool = findSourceContractTool(tool, sourceContract);
    const sourceSignature = normalizeSourceToolSignature(tool.ref, sourceTool?.signature);
    const signature =
      tool.signature && !isGenericFallbackToolSignature(tool.signature)
        ? tool.signature
        : (sourceSignature ??
          tool.signature ??
          inferFallbackToolSignature(tool.ref, sourceContract));
    lines.push(`  ${signature}`);
    lines.push(`    description: ${quote(renderToolDescription(tool, sourceTool))}`);
    lines.push(...renderToolConfirmation(tool, sourceContract));
  }
  return lines;
}

function renderGather(
  agent: BlueprintV2PerAgentSpec,
  contextProvidedFields: ReadonlySet<string>,
): string[] {
  const fields = agent.gather.fields.filter(
    (field) => field.source === 'user' && !contextProvidedFields.has(field.name),
  );
  if (fields.length === 0) return [];
  const lines = ['', 'GATHER:'];
  for (const field of fields) {
    lines.push(`  ${field.name}:`);
    lines.push(`    type: ${field.type}`);
    lines.push(`    required: ${field.required ? 'true' : 'false'}`);
    lines.push(`    prompt: ${quote(field.prompt)}`);
    if (field.enumValues && field.enumValues.length > 0) {
      lines.push(`    enum: [${field.enumValues.map(quote).join(', ')}]`);
    }
    if (field.validation) {
      lines.push(`    validation: ${quote(field.validation)}`);
    }
    if (field.sensitive) {
      lines.push('    sensitive: true');
    }
    if (field.piiType) {
      lines.push(`    pii_type: ${field.piiType}`);
    }
  }
  return lines;
}

function collectIncomingContextFields(
  blueprint: BlueprintV2Output,
  agentName: string,
): Set<string> {
  const fields = new Set<string>();
  for (const sourceAgent of Object.values(blueprint.perAgent)) {
    for (const handoff of sourceAgent.handoffs) {
      if (handoff.to !== agentName) continue;
      for (const field of handoff.context.pass) {
        fields.add(field);
      }
    }
  }
  return fields;
}

function shouldUseSharedVoiceContinuity(blueprint: BlueprintV2Output, agentName: string): boolean {
  if (agentName === blueprint.topology.entryPoint) return false;
  return blueprint.topology.edges.some((edge) => {
    if (edge.to !== agentName) return false;
    if (edge.type === 'escalate') return false;
    if (edge.experienceMode === 'visible_handoff') return false;
    if (edge.experienceMode === 'silent_delegate') return false;
    if (edge.experienceMode === 'human_escalation') return false;
    return edge.experienceMode === 'shared_voice_handoff';
  });
}

function channelNamesForProfiles(
  blueprint: BlueprintV2Output,
  sourceContract: SourceArchitectureContract | null | undefined,
): Set<string> {
  return new Set(
    resolveBehaviorProfileChannels(blueprint, sourceContract).map((channel) =>
      channel.trim().toLowerCase(),
    ),
  );
}

function sourceRuleText(sourceContract: SourceArchitectureContract | null | undefined): string {
  return [
    ...(sourceContract?.universalRules ?? []),
    ...(sourceContract?.channelRules ?? []).flatMap((rule) => rule.rules),
  ].join(' ');
}

function shouldUsePlainLanguageProfile(
  sourceContract: SourceArchitectureContract | null | undefined,
): boolean {
  return /\b(plain language|jargon|forbidden phrase|abbreviation|acronym)\b/i.test(
    sourceRuleText(sourceContract),
  );
}

function shouldUseVoiceCompactProfile(
  blueprint: BlueprintV2Output,
  sourceContract: SourceArchitectureContract | null | undefined,
): boolean {
  const channels = channelNamesForProfiles(blueprint, sourceContract);
  return channels.has('voice') || channels.has('phone');
}

function shouldUseEmpathyProfile(
  sourceContract: SourceArchitectureContract | null | undefined,
): boolean {
  return /\b(empathy|empathetic|frustrat|upset|angry|sentiment|apolog)\b/i.test(
    sourceRuleText(sourceContract),
  );
}

function isCustomerFacingAgent(blueprint: BlueprintV2Output, agentName: string): boolean {
  if (blueprint.topology.entryPoint === agentName) return true;
  const incomingEdges = blueprint.topology.edges.filter((edge) => edge.to === agentName);
  if (incomingEdges.some((edge) => edge.experienceMode === 'silent_delegate')) return false;
  if (incomingEdges.some((edge) => edge.experienceMode === 'human_escalation')) return false;
  return incomingEdges.some(
    (edge) =>
      edge.experienceMode === 'shared_voice_handoff' ||
      edge.experienceMode === 'visible_handoff' ||
      edge.type === 'transfer',
  );
}

function collectBehaviorProfileUses(
  blueprint: BlueprintV2Output,
  agentName: string,
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  const uses: string[] = [];
  if (shouldUseSharedVoiceContinuity(blueprint, agentName)) {
    uses.push(SHARED_VOICE_HANDOFF_PROFILE_NAME);
  }
  if (!isCustomerFacingAgent(blueprint, agentName)) {
    return uses;
  }
  if (shouldUsePlainLanguageProfile(sourceContract)) {
    uses.push(PLAIN_LANGUAGE_PROFILE_NAME);
  }
  if (shouldUseVoiceCompactProfile(blueprint, sourceContract)) {
    uses.push(VOICE_COMPACT_PROFILE_NAME);
  }
  if (shouldUseEmpathyProfile(sourceContract)) {
    uses.push(FRUSTRATION_EMPATHY_PROFILE_NAME);
  }
  return [...new Set(uses)];
}

function renderBehaviorProfileUses(
  blueprint: BlueprintV2Output,
  agentName: string,
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  const uses = collectBehaviorProfileUses(blueprint, agentName, sourceContract);
  return uses.flatMap((profileName) => ['', `USE BEHAVIOR_PROFILE: ${profileName}`]);
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveBehaviorProfileChannels(
  blueprint: BlueprintV2Output,
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  return uniqueOrdered([
    ...blueprint.specification.channels,
    ...(sourceContract?.channels ?? []),
    ...(sourceContract?.channelRules ?? []).map((rule) => rule.channel),
  ]);
}

function renderBehaviorProfiles(
  blueprint: BlueprintV2Output,
  sourceContract: SourceArchitectureContract | null | undefined,
): BlueprintRenderedBehaviorProfile[] {
  const profileNames = new Set(
    blueprint.buildOrder.flatMap((agentName) =>
      collectBehaviorProfileUses(blueprint, agentName, sourceContract),
    ),
  );
  const sharedTone = [
    ...new Set(
      Object.values(blueprint.perAgent)
        .flatMap((agent) => agent.persona.tone)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (profileNames.size === 0) {
    return [];
  }

  return renderArchManagedBehaviorProfiles({
    channels: resolveBehaviorProfileChannels(blueprint, sourceContract),
    tone: sharedTone,
    universalRules: sourceContract?.universalRules,
    channelRules: sourceContract?.channelRules,
    includeSharedVoiceHandoff: profileNames.has(SHARED_VOICE_HANDOFF_PROFILE_NAME),
    includePlainLanguage: profileNames.has(PLAIN_LANGUAGE_PROFILE_NAME),
    includeVoiceCompact: profileNames.has(VOICE_COMPACT_PROFILE_NAME),
    includeEmpathy: profileNames.has(FRUSTRATION_EMPATHY_PROFILE_NAME),
  });
}

function renderMemory(agent: BlueprintV2PerAgentSpec): string[] {
  const hasSession = agent.memory.session.length > 0;
  const hasPersistent = agent.memory.persistent.length > 0;
  if (!hasSession && !hasPersistent) return [];
  const lines = ['', 'MEMORY:'];
  if (hasSession) {
    lines.push('  session:');
    for (const item of agent.memory.session) {
      lines.push(`    - ${item}`);
    }
  }
  if (hasPersistent) {
    lines.push('  persistent:');
    for (const item of agent.memory.persistent) {
      lines.push(`    - PATH: ${item.path}`);
      lines.push(`      SCOPE: ${item.scope}`);
      lines.push(`      ACCESS: ${item.access}`);
    }
  }
  return lines;
}

function renderConstraints(agent: BlueprintV2PerAgentSpec): string[] {
  if (agent.constraints.length === 0) return [];
  const lines = ['', 'CONSTRAINTS:'];
  const grouped = new Map<string, typeof agent.constraints>();
  for (const constraint of agent.constraints) {
    const group = grouped.get(constraint.label) ?? [];
    group.push(constraint);
    grouped.set(constraint.label, group);
  }
  for (const [label, constraints] of grouped.entries()) {
    lines.push(`  ${label}:`);
    for (const constraint of constraints) {
      const before = constraint.before ? ` BEFORE ${constraint.before}` : '';
      lines.push(`    - ${constraintKind(constraint.kind)} ${constraint.condition}${before}`);
      if (constraint.when) {
        lines.push(`      WHEN: ${conditionLine(constraint.when)}`);
      }
      lines.push(`      ON_FAIL: ${quote(constraint.onFail)}`);
    }
  }
  return lines;
}

function renderGuardrails(agent: BlueprintV2PerAgentSpec): string[] {
  if (agent.guardrails.length === 0) return [];
  const lines = ['', 'GUARDRAILS:'];
  for (const guardrail of agent.guardrails) {
    lines.push(`  ${guardrail.name}:`);
    lines.push(`    kind: ${guardrail.kind}`);
    if (guardrail.provider) {
      lines.push(`    provider: ${guardrail.provider}`);
      if (guardrail.category) {
        lines.push(`    category: ${guardrail.category}`);
      }
    } else if (guardrail.llmCheck) {
      lines.push(`    llm_check: ${quote(guardrail.llmCheck)}`);
    } else if (guardrail.check) {
      lines.push(`    check: ${quote(guardrail.check)}`);
    }
    if (guardrail.threshold !== undefined) {
      lines.push(`    threshold: ${guardrail.threshold}`);
    }
    lines.push(`    action: ${guardrail.action}`);
    if (guardrail.message) {
      lines.push(`    message: ${quote(guardrail.message)}`);
    }
    if (guardrail.priority !== undefined) {
      lines.push(`    priority: ${guardrail.priority}`);
    }
  }
  return lines;
}

function renderHandoffs(
  blueprint: BlueprintV2Output,
  agentName: string,
  agent: BlueprintV2PerAgentSpec,
): string[] {
  if (agent.handoffs.length === 0) return [];
  const lines = ['', 'HANDOFF:'];
  for (const handoff of agent.handoffs) {
    const topologyEdge = blueprint.topology.edges.find(
      (edge) => edge.from === agentName && edge.to === handoff.to,
    );
    lines.push(`  - TO: ${handoff.to}`);
    lines.push(`    WHEN: ${conditionLine(handoff.when)}`);
    if (topologyEdge?.experienceMode) {
      lines.push(`    EXPERIENCE_MODE: ${topologyEdge.experienceMode}`);
    }
    lines.push('    CONTEXT:');
    lines.push(`      pass: [${handoff.context.pass.join(', ')}]`);
    if (handoff.context.summary.includes('\n')) {
      lines.push('      summary: |');
      lines.push(block(handoff.context.summary, 8));
    } else {
      lines.push(`      summary: ${quote(handoff.context.summary)}`);
    }
    lines.push(`    EXPECT_RETURN: ${handoff.return ? 'true' : 'false'}`);
    if (handoff.onFailure) {
      lines.push(`    ON_FAILURE: ${handoff.onFailure.toUpperCase()}`);
    }
  }
  return lines;
}

function renderFlow(plan: AgentConstructPlan | undefined): string[] {
  if (!plan || plan.flow.length === 0 || plan.toolCalls.length === 0) return [];

  const toolCallByStep = new Map(plan.toolCalls.map((call) => [call.step, call] as const));
  const lines = ['', 'FLOW:', '  steps:'];
  for (const step of plan.flow) {
    lines.push(`    - ${step.name}`);
  }

  for (const step of plan.flow) {
    lines.push(`  ${step.name}:`);
    lines.push(`    REASONING: ${step.reasoning ? 'true' : 'false'}`);
    if (step.respond) {
      lines.push(`    RESPOND: ${quote(step.respond)}`);
    }
    const call = step.call ? toolCallByStep.get(step.name) : undefined;
    if (call) {
      lines.push(...renderFlowToolCall(call));
    }
    if (step.set) {
      for (const [field, expression] of Object.entries(step.set)) {
        lines.push(`    SET: ${field} = ${expression}`);
      }
    }
    if (call) {
      continue;
    }
    if (step.complete) {
      lines.push('    THEN: COMPLETE');
    } else if (step.then) {
      lines.push(`    THEN: ${step.then === 'COMPLETE' ? 'COMPLETE' : step.then}`);
    }
  }

  return lines;
}

function renderFlowToolCall(call: ConstructToolCall): string[] {
  const lines = [`    CALL: ${call.tool}`];
  const withEntries = Object.entries(call.with);
  if (withEntries.length > 0) {
    lines.push('      WITH:');
    for (const [arg, expression] of withEntries) {
      lines.push(`        ${arg}: ${expression}`);
    }
  }
  if (call.as) {
    lines.push(`      AS: ${call.as}`);
  }
  if (call.resultFieldsUsed.length > 0) {
    lines.push('    ON_RESULT:');
    lines.push('      - ELSE:');
    for (const resultField of call.resultFieldsUsed) {
      lines.push(`        SET: ${stateNameFromResultField(resultField)} = ${resultField}`);
    }
    lines.push(`        THEN: ${call.onSuccess?.then ?? 'complete'}`);
  } else if (call.onSuccess) {
    lines.push('    ON_SUCCESS:');
    if (call.onSuccess.respond) {
      lines.push(`      RESPOND: ${quote(call.onSuccess.respond)}`);
    }
    for (const [field, expression] of Object.entries(call.onSuccess.set ?? {})) {
      lines.push(`      SET: ${field} = ${expression}`);
    }
    if (call.onSuccess.then) {
      lines.push(`      THEN: ${call.onSuccess.then}`);
    }
  }
  if (call.onFailure) {
    lines.push('    ON_FAILURE:');
    if (call.onFailure.respond) {
      lines.push(`      RESPOND: ${quote(call.onFailure.respond)}`);
    }
    if (call.onFailure.then) {
      lines.push(`      THEN: ${call.onFailure.then}`);
    }
  }
  return lines;
}

function stateNameFromResultField(resultField: string): string {
  const [alias, ...fieldParts] = resultField.split('.');
  const raw = `${alias}_${fieldParts.join('_') || 'result'}`;
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  if (!normalized) return 'result';
  return /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
}

function renderComplete(agent: BlueprintV2PerAgentSpec): string[] {
  const conditions =
    agent.complete.conditions.length > 0
      ? agent.complete.conditions
      : [{ when: 'true', respond: 'Done.' }];
  const lines = ['', 'COMPLETE:'];
  for (const complete of conditions) {
    lines.push(`  - WHEN: ${conditionLine(complete.when)}`);
    if (complete.respond) {
      lines.push(`    RESPOND: ${quote(complete.respond)}`);
    }
    if (complete.store) {
      lines.push(`    STORE: ${complete.store}`);
    }
  }
  return lines;
}

export function renderAgentDslFromBlueprint(
  blueprintInput: BlueprintV2Output,
  agentName: string,
  constructPlan?: AgentConstructPlan,
  options: BlueprintRenderOptions = {},
): string {
  const blueprint = assertValidBlueprintV2Output(blueprintInput);
  const modelDefaults = {
    ...blueprint.modelDefaults,
    ...options.modelDefaults,
  };
  const topologyAgent = blueprint.topology.agents.find((agent) => agent.name === agentName);
  const agent = blueprint.perAgent[agentName];
  if (!topologyAgent || !agent) {
    throw new Error(`Agent "${agentName}" is not present in the blueprint`);
  }

  const lines = [
    `AGENT: ${agentName}`,
    `GOAL: ${quote(agent.goal)}`,
    'PERSONA: |',
    block(agent.persona.summary),
  ];

  lines.push(...renderBehaviorProfileUses(blueprint, agentName, options.sourceContract));

  if (agent.persona.limitations.length > 0) {
    lines.push('', 'LIMITATIONS:');
    for (const limitation of agent.persona.limitations) {
      lines.push(`  - ${limitation}`);
    }
  }

  lines.push(...renderExecution(agent, modelDefaults));
  lines.push(...renderMemory(agent));
  const relationshipTargets = [
    ...agent.handoffs.map((handoff) => handoff.to),
    ...blueprint.topology.edges.filter((edge) => edge.from === agentName).map((edge) => edge.to),
  ];
  const contextProvidedFields = collectIncomingContextFields(blueprint, agentName);

  lines.push(...renderTools(agent, relationshipTargets, options.sourceContract));
  lines.push(...renderGather(agent, contextProvidedFields));
  lines.push(...renderFlow(constructPlan));
  lines.push(...renderConstraints(agent));
  lines.push(...renderGuardrails(agent));
  lines.push(...renderHandoffs(blueprint, agentName, agent));
  lines.push(...renderComplete(agent));

  return `${lines.join('\n')}\n`;
}

export function renderProjectFromBlueprint(
  input: BlueprintV2Output,
  options: BlueprintRenderOptions = {},
): BlueprintRenderedProject {
  const blueprint = assertValidBlueprintV2Output(input);
  const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
  const agents = blueprint.buildOrder.map((agentName) => {
    const dslContent = renderAgentDslFromBlueprint(
      blueprint,
      agentName,
      constructPlan.agents[agentName],
      options,
    );
    return {
      name: agentName,
      dslContent,
      sourceHash: hashText(dslContent),
    };
  });

  return {
    projectName: blueprint.metadata.projectName,
    entryAgentName: blueprint.topology.entryPoint,
    agents,
    behaviorProfiles: renderBehaviorProfiles(blueprint, options.sourceContract),
    markdown: renderBlueprintMarkdown(blueprint),
  };
}

export function renderBlueprintMarkdown(input: BlueprintV2Output): string {
  const blueprint = assertValidBlueprintV2Output(input);
  const lines: string[] = [];
  const pushList = (items: readonly string[], fallback: string): void => {
    if (items.length === 0) {
      lines.push(fallback);
      return;
    }
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  };

  lines.push(`# ${blueprint.metadata.projectName} Blueprint`);
  lines.push('');
  lines.push(`Schema version: ${blueprint.version}`);
  lines.push(`Generated: ${blueprint.metadata.generatedAt}`);
  lines.push('');
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(blueprint.specification.summary);
  lines.push('');
  lines.push('## 2. Why This Should Win');
  lines.push('');
  pushList(blueprint.specification.successCriteria, 'Success criteria are not yet declared.');
  lines.push('');
  lines.push('## 3. Platform Config');
  lines.push('');
  lines.push(`Users: ${blueprint.specification.users.join(', ') || 'unspecified'}`);
  lines.push(`Channels: ${blueprint.specification.channels.join(', ') || 'unspecified'}`);
  lines.push(`Languages: ${blueprint.specification.languages.join(', ') || 'English'}`);
  lines.push('');
  lines.push('## 4. Topology');
  lines.push('');
  lines.push(`Pattern: ${blueprint.topology.pattern}`);
  lines.push(`Entry point: ${blueprint.topology.entryPoint}`);
  lines.push('');
  for (const agent of blueprint.topology.agents) {
    lines.push(`- ${agent.name}: ${agent.description}`);
  }
  lines.push('');
  lines.push('## 5. Solution Architecture');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    lines.push(`- ${agentName}: ${agent.role}; execution=${agent.executionMode}`);
  }
  lines.push('');
  lines.push('## 6. Call Control');
  lines.push('');
  if (blueprint.topology.edges.length === 0) {
    lines.push('Single-agent flow; no inter-agent routing required.');
  } else {
    for (const edge of blueprint.topology.edges) {
      lines.push(`- ${edge.from} -> ${edge.to}: ${edge.condition}`);
    }
  }
  lines.push('');
  lines.push('## 7. System Prompts');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    lines.push(`### ${agentName}`);
    lines.push('');
    lines.push(`Goal: ${agent.goal}`);
    lines.push(`Persona: ${agent.persona.summary}`);
    lines.push('');
  }
  lines.push('## 8. Knowledge');
  lines.push('');
  lines.push('Knowledge requirements are represented by tool refs, memory refs, and assumptions.');
  pushList(blueprint.specification.assumptions, 'No explicit assumptions declared.');
  lines.push('');
  lines.push('## 9. Inputs and Outputs');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    const gathers = agent.gather.fields.map((field) => field.name).join(', ') || 'none';
    const completes =
      agent.complete.conditions.map((complete) => complete.when).join('; ') || 'fallback true';
    lines.push(`- ${agentName}: gathers=${gathers}; completes=${completes}`);
  }
  lines.push('');
  lines.push('## 10. Tools');
  lines.push('');
  if (blueprint.integrations.tools.length === 0) {
    lines.push('No project tools required.');
  } else {
    for (const tool of blueprint.integrations.tools) {
      lines.push(`- ${tool.name} (${tool.type}): ${tool.description}`);
    }
  }
  lines.push('');
  lines.push('## 11. Memory');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    const sessionMemory = agent.memory.session.join(', ') || 'none';
    const persistentMemory =
      agent.memory.persistent.map((item) => `${item.path} (${item.scope})`).join(', ') || 'none';
    lines.push(`- ${agentName}: session=${sessionMemory}; persistent=${persistentMemory}`);
  }
  lines.push('');
  lines.push('## 12. Decision Logic');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    const constraints = agent.constraints.map((item) => `${agentName}: ${item.condition}`);
    pushList(constraints, `- ${agentName}: no explicit constraints.`);
  }
  lines.push('');
  lines.push('## 13. Multi-Agent Relationships');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    if (agent.handoffs.length === 0) {
      lines.push(`- ${agentName}: no handoffs.`);
      continue;
    }
    for (const handoff of agent.handoffs) {
      lines.push(`- ${agentName} -> ${handoff.to}: ${handoff.when}`);
    }
  }
  lines.push('');
  lines.push('## 14. Guardrails');
  lines.push('');
  pushList(blueprint.governance.compliance, 'No explicit compliance regime declared.');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    for (const guardrail of agent.guardrails) {
      const summary = guardrail.provider ?? guardrail.llmCheck ?? guardrail.check ?? guardrail.name;
      lines.push(`- ${agentName}.${guardrail.name}: ${summary}`);
    }
  }
  lines.push('');
  lines.push('## 15. Error Handling');
  lines.push('');
  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    const failures = agent.handoffs
      .filter((handoff) => handoff.onFailure)
      .map((handoff) => `${agentName} -> ${handoff.to}: ${handoff.onFailure}`);
    pushList(failures, `- ${agentName}: default respond/retry policy.`);
  }
  lines.push('');
  lines.push('## 16. Eval and QA');
  lines.push('');
  pushList(blueprint.specification.successCriteria, 'Add eval scenarios before production.');
  lines.push('');
  lines.push('## 17. Configuration Checklist');
  lines.push('');
  pushList(
    [
      `Lock blueprint version ${blueprint.approvedAt ? 'approved' : 'before build'}.`,
      `Create or link ${blueprint.integrations.tools.length} project tool(s).`,
      `Render ${blueprint.buildOrder.length} agent DSL file(s) in build order: ${blueprint.buildOrder.join(', ')}.`,
    ],
    'No configuration checklist items.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}
