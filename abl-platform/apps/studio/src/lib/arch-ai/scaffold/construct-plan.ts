import {
  AgentConstructPlanSchema,
  validateAgentConstructPlan,
  type AgentConstructPlan,
  type ConstructValidationIssue,
} from '@agent-platform/arch-ai/planning/construct-plan';

import { normalizeHandoffWhen } from './assembler';
import { deriveScaffoldRuntimePlan } from './runtime-flow';
import { inferOutputFieldNamesFromSignature } from './tool-signature';
import type { AblSkeleton, CreativeContent } from './types';

export interface ScaffoldConstructPlanInput {
  skeleton: AblSkeleton;
  creative: CreativeContent;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  agentNames: ReadonlyArray<string>;
}

export interface ScaffoldConstructValidationResult {
  plan: AgentConstructPlan;
  issues: ConstructValidationIssue[];
  valid: boolean;
}

export function buildConstructPlanFromScaffold(
  input: ScaffoldConstructPlanInput,
): AgentConstructPlan {
  const gathers = input.skeleton.gatherFields.map((field) => ({
    name: field.name,
    type: field.type,
    required: true,
    prompt: input.creative[field.askSlot] ?? field.name,
    source: field.source ?? 'user',
  }));

  const tools = input.skeleton.tools.map((tool) => ({
    ref: tool.name,
    signature: tool.signatureLiteral,
    purpose: tool.descriptionLiteral,
    outputFields: inferOutputFieldsFromSignature(tool.signatureLiteral),
  }));

  const runtimePlan = deriveScaffoldRuntimePlan(input.skeleton);

  const state = input.skeleton.memorySessionVars.map((name) => ({
    name,
    value: 'null',
    source: 'literal' as const,
  }));

  const handoffs = input.skeleton.handoffs.map((handoff) => ({
    to: handoff.to,
    when:
      handoff.whenSlot === null
        ? (handoff.whenLiteral ?? 'true')
        : normalizeHandoffWhen(input.creative[handoff.whenSlot] ?? 'true', {
            declaredMemoryVars: input.skeleton.memorySessionVars,
          }),
    pass: [],
    returnExpected: handoff.returnExpected,
  }));

  const completion = input.skeleton.completeSlots.map((slot) => {
    const when =
      slot.whenSlot === null
        ? (slot.whenLiteral ?? 'true')
        : (input.creative[slot.whenSlot] ?? 'true');
    const respond =
      slot.respondSlot === null ? slot.respondLiteral : input.creative[slot.respondSlot];

    return {
      when,
      ...(respond && respond.length > 0 ? { respond } : {}),
      returnsToParent: true,
    };
  });

  return AgentConstructPlanSchema.parse({
    agentName: input.skeleton.agentName,
    executionMode: input.executionMode,
    gathers,
    tools,
    toolCalls: runtimePlan.toolCalls,
    state: [...state, ...runtimePlan.toolResultState],
    flow: runtimePlan.flow,
    handoffs,
    delegates: [],
    escalations: [],
    completion,
    unsupportedConstructs: [],
    rationale: [
      'Derived from Studio scaffold skeleton before compile.',
      `Runtime pattern: ${input.skeleton.runtimePattern}.`,
    ],
  });
}

export function validateScaffoldConstructPlan(
  input: ScaffoldConstructPlanInput,
): ScaffoldConstructValidationResult {
  const plan = buildConstructPlanFromScaffold(input);
  const agentNames = new Set(
    input.agentNames.length > 0
      ? input.agentNames
      : [input.skeleton.agentName, ...input.skeleton.handoffs.map((handoff) => handoff.to)],
  );
  const issues = validateAgentConstructPlan(plan, { agentNames });

  return {
    plan,
    issues,
    valid: !issues.some((issue) => issue.severity === 'error'),
  };
}

function inferOutputFieldsFromSignature(signature: string): string[] {
  return inferOutputFieldNamesFromSignature(signature);
}
