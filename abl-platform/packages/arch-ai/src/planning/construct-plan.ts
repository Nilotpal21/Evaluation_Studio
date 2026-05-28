import { z } from 'zod';

import type { BlueprintV2Output, BlueprintV2PerAgentSpec } from '../blueprint/v2-schema.js';
import { assertValidBlueprintV2Output } from '../blueprint/v2-schema.js';
import { computeArchitecturePlans } from './agent-architecture-planner.js';
import { filterRelationshipToolRefs } from './relationship-tool-filter.js';
import { inferFallbackToolSignature } from './tool-signature-inference.js';
import type { AgentArchitecturePlan, PlannerTopologyInput } from './types.js';

const ConstructExpressionSchema = z.string().min(1);

export const ConstructGatherItemSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean().default(true),
    prompt: z.string().min(1),
    source: z.enum(['user', 'context', 'tool', 'memory']).default('user'),
  })
  .strict();

export const ConstructToolItemSchema = z
  .object({
    ref: z.string().min(1),
    signature: z.string().min(1),
    purpose: z.string().min(1),
    outputFields: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const ConstructToolCallBranchSchema = z
  .object({
    condition: ConstructExpressionSchema.optional(),
    respond: z.string().min(1).optional(),
    set: z.record(z.string().min(1)).optional(),
    then: z.string().min(1).optional(),
  })
  .strict();

export const ConstructToolCallSchema = z
  .object({
    step: z.string().min(1),
    tool: z.string().min(1),
    with: z.record(z.string().min(1)).default({}),
    as: z.string().min(1).optional(),
    resultFieldsUsed: z.array(z.string().min(1)).default([]),
    onResult: z.array(ConstructToolCallBranchSchema).default([]),
    onSuccess: ConstructToolCallBranchSchema.optional(),
    onFailure: ConstructToolCallBranchSchema.optional(),
  })
  .strict();

export const ConstructStateAssignmentSchema = z
  .object({
    name: z.string().min(1),
    value: z.string().min(1),
    source: z.enum(['tool_result', 'gather', 'memory', 'literal', 'expression', 'context']),
  })
  .strict();

export const ConstructFlowStepSchema = z
  .object({
    name: z.string().min(1),
    reasoning: z.boolean().default(false),
    respond: z.string().min(1).optional(),
    call: z.string().min(1).optional(),
    set: z.record(z.string().min(1)).optional(),
    then: z.string().min(1).optional(),
    complete: z.boolean().optional(),
  })
  .strict();

export const ConstructHandoffSchema = z
  .object({
    to: z.string().min(1),
    when: ConstructExpressionSchema,
    pass: z.array(z.string().min(1)).default([]),
    returnExpected: z.boolean().default(true),
    summary: z.string().min(1).optional(),
  })
  .strict();

export const ConstructDelegateSchema = z
  .object({
    to: z.string().min(1),
    when: ConstructExpressionSchema,
    input: z.record(z.string().min(1)).default({}),
    returns: z.record(z.string().min(1)).default({}),
    useResult: z.string().min(1).optional(),
  })
  .strict();

export const ConstructEscalationSchema = z
  .object({
    destination: z.string().min(1),
    when: ConstructExpressionSchema,
    packetFields: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const ConstructCompletionSchema = z
  .object({
    when: ConstructExpressionSchema,
    respond: z.string().min(1).optional(),
    returnsToParent: z.boolean().default(false),
  })
  .strict();

export const UnsupportedConstructNoteSchema = z
  .object({
    construct: z.string().min(1),
    reason: z.string().min(1),
    alternative: z.string().min(1),
  })
  .strict();

export const AgentConstructPlanSchema = z
  .object({
    agentName: z.string().min(1),
    executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
    gathers: z.array(ConstructGatherItemSchema).default([]),
    tools: z.array(ConstructToolItemSchema).default([]),
    toolCalls: z.array(ConstructToolCallSchema).default([]),
    state: z.array(ConstructStateAssignmentSchema).default([]),
    flow: z.array(ConstructFlowStepSchema).default([]),
    handoffs: z.array(ConstructHandoffSchema).default([]),
    delegates: z.array(ConstructDelegateSchema).default([]),
    escalations: z.array(ConstructEscalationSchema).default([]),
    completion: z.array(ConstructCompletionSchema).default([]),
    unsupportedConstructs: z.array(UnsupportedConstructNoteSchema).default([]),
    rationale: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const ProjectConstructPlanSchema = z
  .object({
    projectName: z.string().min(1),
    entryAgentName: z.string().min(1),
    agents: z.record(AgentConstructPlanSchema),
  })
  .strict();

export type ConstructGatherItem = z.infer<typeof ConstructGatherItemSchema>;
export type ConstructToolItem = z.infer<typeof ConstructToolItemSchema>;
export type ConstructToolCall = z.infer<typeof ConstructToolCallSchema>;
export type ConstructStateAssignment = z.infer<typeof ConstructStateAssignmentSchema>;
export type ConstructFlowStep = z.infer<typeof ConstructFlowStepSchema>;
export type ConstructHandoff = z.infer<typeof ConstructHandoffSchema>;
export type ConstructDelegate = z.infer<typeof ConstructDelegateSchema>;
export type ConstructEscalation = z.infer<typeof ConstructEscalationSchema>;
export type ConstructCompletion = z.infer<typeof ConstructCompletionSchema>;
export type UnsupportedConstructNote = z.infer<typeof UnsupportedConstructNoteSchema>;
export type AgentConstructPlan = z.infer<typeof AgentConstructPlanSchema>;
export type ProjectConstructPlan = z.infer<typeof ProjectConstructPlanSchema>;

export type ConstructValidationSeverity = 'error' | 'warning';

export interface ConstructValidationIssue {
  code: string;
  message: string;
  path: string;
  severity: ConstructValidationSeverity;
}

export interface ConstructValidationResult {
  issues: ConstructValidationIssue[];
  valid: boolean;
}

interface SymbolTable {
  variables: Set<string>;
  toolRefs: Set<string>;
  toolOutputs: Map<string, Set<string>>;
  flowSteps: Set<string>;
}

interface BranchValidationOptions {
  conditionCode: string;
  setCode: string;
  path: string;
  requireResultAlias?: boolean;
}

const CEL_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IN', 'true', 'false', 'null', 'if', 'else']);

const CEL_FUNCTIONS = new Set([
  'ABS',
  'ARRAY_FIND',
  'COALESCE',
  'CONTAINS',
  'FORMAT_CURRENCY',
  'FORMAT_DATE',
  'JOIN',
  'LENGTH',
  'LOWER',
  'MASK',
  'NOW',
  'ROUND',
  'SPLIT',
  'TRIM',
  'UNIQUE_ID',
  'UPPER',
]);

// Keep this dependency-free for CLI eval: importing @abl/compiler statically from
// the planner pulls parser internals into tsx before the battle harness can load
// them behind its graceful compiler-availability guard.
const CONSTRUCT_PLAN_BUILTIN_REFERENCE_VARS = [
  'channel',
  'language',
  'locale',
  'turn_count',
  'session_id',
  'project_id',
  'tenant_id',
  'user_id',
  'customer_id',
  'input',
  'last_input',
  'intent',
  'abl',
  'result',
  'always',
  'previous_system_message_was_offer',
  '_abl_constraint_checkpoint_kind',
  '_abl_constraint_checkpoint_target',
];

function issue(
  code: string,
  message: string,
  path: string,
  severity: ConstructValidationSeverity = 'error',
): ConstructValidationIssue {
  return { code, message, path, severity };
}

export function deriveProjectConstructPlanFromBlueprint(
  blueprintInput: BlueprintV2Output,
): ProjectConstructPlan {
  const blueprint = assertValidBlueprintV2Output(blueprintInput);
  const topology = toPlannerTopology(blueprint);
  const architecture = computeArchitecturePlans(topology);
  const agents: Record<string, AgentConstructPlan> = {};

  for (const agentName of blueprint.buildOrder) {
    const agent = blueprint.perAgent[agentName];
    const architecturePlan = architecture.plans.get(agentName);
    agents[agentName] = deriveAgentConstructPlan(blueprint, agentName, agent, architecturePlan);
  }

  return ProjectConstructPlanSchema.parse({
    projectName: blueprint.metadata.projectName,
    entryAgentName: blueprint.topology.entryPoint,
    agents,
  });
}

export function validateProjectConstructPlan(
  planInput: ProjectConstructPlan,
): ConstructValidationResult {
  const parsed = ProjectConstructPlanSchema.safeParse(planInput);
  if (!parsed.success) {
    const schemaIssues = parsed.error.issues.map((zodIssue) =>
      issue('CONSTRUCT_PLAN_SCHEMA_INVALID', zodIssue.message, zodIssue.path.join('.') || '$'),
    );
    return { valid: false, issues: schemaIssues };
  }

  const plan = parsed.data;
  const issues: ConstructValidationIssue[] = [];
  const agentNames = new Set(Object.keys(plan.agents));

  if (!agentNames.has(plan.entryAgentName)) {
    issues.push(
      issue(
        'ENTRY_AGENT_UNKNOWN',
        `Entry agent "${plan.entryAgentName}" is not present in construct plan`,
        'entryAgentName',
      ),
    );
  }

  for (const [agentName, agent] of Object.entries(plan.agents)) {
    issues.push(...validateAgentConstructPlan(agent, { agentNames, agents: plan.agents }));
    if (agent.agentName !== agentName) {
      issues.push(
        issue(
          'AGENT_KEY_MISMATCH',
          `Agent plan key "${agentName}" does not match agentName "${agent.agentName}"`,
          `agents.${agentName}.agentName`,
        ),
      );
    }
  }

  return { valid: !issues.some((item) => item.severity === 'error'), issues };
}

export function validateAgentConstructPlan(
  planInput: AgentConstructPlan,
  ctx: { agentNames: ReadonlySet<string>; agents?: Record<string, AgentConstructPlan> },
): ConstructValidationIssue[] {
  const parsed = AgentConstructPlanSchema.safeParse(planInput);
  if (!parsed.success) {
    return parsed.error.issues.map((zodIssue) =>
      issue('CONSTRUCT_PLAN_SCHEMA_INVALID', zodIssue.message, zodIssue.path.join('.') || '$'),
    );
  }

  const plan = parsed.data;
  const symbols = buildSymbolTable(plan);
  const issues: ConstructValidationIssue[] = [];

  for (const [index, note] of plan.unsupportedConstructs.entries()) {
    issues.push(
      issue(
        'UNSUPPORTED_CONSTRUCT',
        `Construct "${note.construct}" is intentionally unsupported here: ${note.reason}. Use ${note.alternative}.`,
        `unsupportedConstructs.${index}.construct`,
      ),
    );
  }

  for (const [index, call] of plan.toolCalls.entries()) {
    if (!symbols.toolRefs.has(call.tool)) {
      issues.push(
        issue(
          'TOOL_CALL_UNKNOWN_TOOL',
          `Tool call "${call.step}" references undeclared tool "${call.tool}"`,
          `toolCalls.${index}.tool`,
        ),
      );
    }

    if ((call.resultFieldsUsed.length > 0 || call.onResult.length > 0) && !call.as) {
      issues.push(
        issue(
          'TOOL_RESULT_REUSED_WITHOUT_ALIAS',
          `Tool call "${call.step}" reuses tool output but does not declare an AS result alias`,
          `toolCalls.${index}.as`,
        ),
      );
    }

    for (const [argName, expression] of Object.entries(call.with)) {
      issues.push(
        ...validateExpressionRefs(
          expression,
          symbols,
          `toolCalls.${index}.with.${argName}`,
          'TOOL_ARG_UNDECLARED_VARIABLE',
        ),
      );
    }

    for (const resultField of call.resultFieldsUsed) {
      issues.push(...validateResultField(call, resultField, symbols, `toolCalls.${index}`));
    }

    for (const [branchIndex, branch] of call.onResult.entries()) {
      issues.push(
        ...validateToolCallBranch(branch, symbols, {
          conditionCode: 'ON_RESULT_UNDECLARED_VARIABLE',
          setCode: 'ON_RESULT_SET_UNDECLARED_VARIABLE',
          path: `toolCalls.${index}.onResult.${branchIndex}`,
          requireResultAlias: Boolean(call.as),
        }),
      );
    }

    if (call.onSuccess) {
      issues.push(
        ...validateToolCallBranch(call.onSuccess, symbols, {
          conditionCode: 'ON_SUCCESS_UNDECLARED_VARIABLE',
          setCode: 'ON_SUCCESS_SET_UNDECLARED_VARIABLE',
          path: `toolCalls.${index}.onSuccess`,
        }),
      );
    }

    if (call.onFailure) {
      issues.push(
        ...validateToolCallBranch(call.onFailure, symbols, {
          conditionCode: 'ON_FAILURE_UNDECLARED_VARIABLE',
          setCode: 'ON_FAILURE_SET_UNDECLARED_VARIABLE',
          path: `toolCalls.${index}.onFailure`,
        }),
      );
    }
  }

  for (const [index, state] of plan.state.entries()) {
    if (state.source === 'literal') continue;
    issues.push(
      ...validateExpressionRefs(
        state.value,
        symbols,
        `state.${index}.value`,
        'SET_UNDECLARED_VARIABLE',
      ),
    );
  }

  for (const [index, step] of plan.flow.entries()) {
    if (
      step.call &&
      !plan.toolCalls.some((call) => call.step === step.name || call.tool === step.call)
    ) {
      issues.push(
        issue(
          'FLOW_STEP_CALL_WITHOUT_TOOL_PLAN',
          `Flow step "${step.name}" calls "${step.call}" but no matching toolCalls entry exists`,
          `flow.${index}.call`,
          'warning',
        ),
      );
    }
    if (step.respond) {
      issues.push(...validateTemplateRefs(step.respond, symbols, `flow.${index}.respond`));
    }
    if (step.set) {
      for (const [field, expression] of Object.entries(step.set)) {
        issues.push(
          ...validateExpressionRefs(
            expression,
            symbols,
            `flow.${index}.set.${field}`,
            'SET_UNDECLARED_VARIABLE',
          ),
        );
      }
    }
    if (step.then && step.then !== 'COMPLETE' && !symbols.flowSteps.has(step.then)) {
      issues.push(
        issue(
          'FLOW_THEN_UNKNOWN_STEP',
          `Flow step "${step.name}" transitions to unknown step "${step.then}"`,
          `flow.${index}.then`,
        ),
      );
    }
  }

  for (const [index, handoff] of plan.handoffs.entries()) {
    if (!ctx.agentNames.has(handoff.to)) {
      issues.push(
        issue(
          'HANDOFF_TARGET_UNKNOWN',
          `Handoff targets unknown agent "${handoff.to}"`,
          `handoffs.${index}.to`,
        ),
      );
    }
    issues.push(
      ...validateExpressionRefs(
        handoff.when,
        symbols,
        `handoffs.${index}.when`,
        'HANDOFF_WHEN_UNDECLARED_VARIABLE',
      ),
    );
    for (const [passIndex, passField] of handoff.pass.entries()) {
      if (!symbols.variables.has(passField)) {
        issues.push(
          issue(
            'HANDOFF_PASS_UNDECLARED_VARIABLE',
            `Handoff passes "${passField}" but this agent does not declare or set it`,
            `handoffs.${index}.pass.${passIndex}`,
          ),
        );
      }
    }
    const target = ctx.agents?.[handoff.to];
    if (handoff.returnExpected && target && target.completion.length === 0) {
      issues.push(
        issue(
          'RETURN_TARGET_MISSING_COMPLETION',
          `Handoff expects return from "${handoff.to}" but the target has no completion plan`,
          `handoffs.${index}.returnExpected`,
        ),
      );
    }
  }

  for (const [index, delegate] of plan.delegates.entries()) {
    if (!ctx.agentNames.has(delegate.to)) {
      issues.push(
        issue(
          'DELEGATE_TARGET_UNKNOWN',
          `Delegate targets unknown agent "${delegate.to}"`,
          `delegates.${index}.to`,
        ),
      );
    }
    issues.push(
      ...validateExpressionRefs(
        delegate.when,
        symbols,
        `delegates.${index}.when`,
        'DELEGATE_WHEN_UNDECLARED_VARIABLE',
      ),
    );
    for (const [field, expression] of Object.entries(delegate.input)) {
      issues.push(
        ...validateExpressionRefs(
          expression,
          symbols,
          `delegates.${index}.input.${field}`,
          'DELEGATE_INPUT_UNDECLARED_VARIABLE',
        ),
      );
    }
    if (delegate.useResult && Object.keys(delegate.returns).length === 0) {
      issues.push(
        issue(
          'DELEGATE_RESULT_WITHOUT_RETURN_MAPPING',
          `Delegate stores result "${delegate.useResult}" but declares no return mapping`,
          `delegates.${index}.returns`,
        ),
      );
    }
  }

  for (const [index, escalation] of plan.escalations.entries()) {
    issues.push(
      ...validateExpressionRefs(
        escalation.when,
        symbols,
        `escalations.${index}.when`,
        'ESCALATE_WHEN_UNDECLARED_VARIABLE',
      ),
    );
    for (const [fieldIndex, packetField] of escalation.packetFields.entries()) {
      if (!symbols.variables.has(packetField)) {
        issues.push(
          issue(
            'ESCALATION_PACKET_UNDECLARED_VARIABLE',
            `Escalation packet includes "${packetField}" but this agent does not declare or set it`,
            `escalations.${index}.packetFields.${fieldIndex}`,
          ),
        );
      }
    }
  }

  for (const [index, completion] of plan.completion.entries()) {
    issues.push(
      ...validateExpressionRefs(
        completion.when,
        symbols,
        `completion.${index}.when`,
        'COMPLETE_UNDECLARED_VARIABLE',
      ),
    );
    if (completion.respond) {
      issues.push(
        ...validateTemplateRefs(completion.respond, symbols, `completion.${index}.respond`),
      );
    }
  }

  return issues;
}

function validateToolCallBranch(
  branch: z.infer<typeof ConstructToolCallBranchSchema>,
  symbols: SymbolTable,
  options: BranchValidationOptions,
): ConstructValidationIssue[] {
  const issues: ConstructValidationIssue[] = [];

  if (options.requireResultAlias === false) {
    return issues;
  }

  if (branch.condition) {
    issues.push(
      ...validateExpressionRefs(
        branch.condition,
        symbols,
        `${options.path}.condition`,
        options.conditionCode,
      ),
    );
  }

  if (branch.respond) {
    issues.push(...validateTemplateRefs(branch.respond, symbols, `${options.path}.respond`));
  }

  if (branch.set) {
    for (const [field, expression] of Object.entries(branch.set)) {
      issues.push(
        ...validateExpressionRefs(
          expression,
          symbols,
          `${options.path}.set.${field}`,
          options.setCode,
        ),
      );
    }
  }

  if (branch.then && branch.then !== 'COMPLETE' && !symbols.flowSteps.has(branch.then)) {
    issues.push(
      issue(
        'FLOW_THEN_UNKNOWN_STEP',
        `Tool branch transitions to unknown step "${branch.then}"`,
        `${options.path}.then`,
      ),
    );
  }

  return issues;
}

function deriveAgentConstructPlan(
  blueprint: BlueprintV2Output,
  agentName: string,
  agent: BlueprintV2PerAgentSpec,
  architecturePlan: AgentArchitecturePlan | undefined,
): AgentConstructPlan {
  const topologyAgent = blueprint.topology.agents.find((item) => item.name === agentName);
  const gatherNames = agent.gather.fields.map((field) => field.name);
  const contextProvidedFields = collectIncomingContextFields(blueprint, agentName);
  const relationshipTargets = [
    ...agent.handoffs.map((handoff) => handoff.to),
    ...blueprint.topology.edges.filter((edge) => edge.from === agentName).map((edge) => edge.to),
  ];
  const tools = filterRelationshipToolRefs(
    agent.tools,
    relationshipTargets,
    (tool) => tool.ref,
  ).map((tool) => {
    const signature = tool.signature ?? inferFallbackToolSignature(tool.ref);
    return {
      ref: tool.ref,
      signature,
      purpose: tool.purpose,
      outputFields: inferOutputFieldsFromSignature(signature),
    };
  });
  const toolCalls = deriveDefaultToolCalls(tools, gatherNames);
  const toolResultState = toolCalls.flatMap((call) =>
    call.resultFieldsUsed.map((resultField) => ({
      name: stateNameFromResultField(resultField),
      value: resultField,
      source: 'tool_result' as const,
    })),
  );
  const state: ConstructStateAssignment[] = [
    ...agent.memory.session.map((name) => ({
      name,
      value: 'null',
      source: 'memory' as const,
    })),
    ...toolResultState,
  ];
  const shouldAddFlow =
    toolCalls.length > 0 ||
    architecturePlan?.flow.recommended === true ||
    agent.executionMode === 'scripted' ||
    agent.executionMode === 'hybrid';
  const flow = shouldAddFlow ? deriveDefaultFlow(agent, toolCalls) : [];
  const escalations = agent.handoffs
    .filter((handoff) => {
      const edge = blueprint.topology.edges.find(
        (candidate) => candidate.from === agentName && candidate.to === handoff.to,
      );
      return edge?.type === 'escalate';
    })
    .map((handoff) => ({
      destination: handoff.to,
      when: handoff.when,
      packetFields: handoff.context.pass,
    }));

  const handoffs = agent.handoffs
    .filter((handoff) => !escalations.some((escalation) => escalation.destination === handoff.to))
    .map((handoff) => ({
      to: handoff.to,
      when: handoff.when,
      pass: handoff.context.pass,
      returnExpected: handoff.return,
      summary: handoff.context.summary,
    }));

  return AgentConstructPlanSchema.parse({
    agentName,
    executionMode: architecturePlan?.complexity.selectedExecutionMode ?? agent.executionMode,
    gathers: agent.gather.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      prompt: field.prompt,
      source: contextProvidedFields.has(field.name) ? ('context' as const) : field.source,
    })),
    tools,
    toolCalls,
    state,
    flow,
    handoffs,
    delegates: blueprint.topology.edges
      .filter(
        (edge) =>
          edge.from === agentName &&
          edge.type === 'delegate' &&
          edge.experienceMode !== 'shared_voice_handoff' &&
          edge.experienceMode !== 'visible_handoff' &&
          edge.experienceMode !== 'human_escalation',
      )
      .map((edge) => ({
        to: edge.to,
        when: edge.condition,
        input: Object.fromEntries(
          (architecturePlan?.allowedPassFields ?? []).map((field) => [field, field]),
        ),
        returns: Object.fromEntries(
          architecturePlan?.handoffs.targets
            .find((target) => target.to === edge.to)
            ?.returnFieldSeeds?.map((field) => [field, field]) ?? [],
        ),
      })),
    escalations,
    completion: agent.complete.conditions.map((condition) => ({
      when: condition.when,
      respond: condition.respond,
      returnsToParent: Boolean(architecturePlan?.complete.required),
    })),
    unsupportedConstructs: [],
    rationale: [
      topologyAgent
        ? `${agentName} role: ${topologyAgent.role}; topology mode: ${topologyAgent.executionMode}.`
        : `${agentName} derived from blueprint per-agent spec.`,
      architecturePlan?.complexity.reason ?? 'No topology architecture plan was available.',
    ],
  });
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

function deriveDefaultToolCalls(
  tools: ConstructToolItem[],
  gatherNames: string[],
): ConstructToolCall[] {
  return tools.map((tool, index) => {
    const alias = `${toCamelIdentifier(tool.ref)}Result`;
    const nextStep = tools[index + 1]
      ? `call_${toSnakeIdentifier(tools[index + 1].ref)}`
      : 'complete';
    const outputFields = tool.outputFields.length > 0 ? tool.outputFields : ['result'];
    const resultFieldsUsed = outputFields.slice(0, 3).map((field) => `${alias}.${field}`);
    const withArgs = Object.fromEntries(
      inferInputFieldsFromSignature(tool.signature).map((fieldName) => [
        fieldName,
        gatherNames.includes(fieldName)
          ? fieldName
          : (gatherNames[index] ?? gatherNames[0] ?? 'input'),
      ]),
    );

    return {
      step: `call_${toSnakeIdentifier(tool.ref)}`,
      tool: tool.ref,
      with: withArgs,
      as: alias,
      resultFieldsUsed,
      onResult: [],
      onSuccess: {
        set: Object.fromEntries(
          resultFieldsUsed.map((field) => [stateNameFromResultField(field), field]),
        ),
        then: nextStep,
      },
      onFailure: {
        then: 'complete',
      },
    };
  });
}

function deriveDefaultFlow(
  agent: BlueprintV2PerAgentSpec,
  toolCalls: ConstructToolCall[],
): ConstructFlowStep[] {
  if (toolCalls.length > 0) {
    return [
      ...toolCalls.map((call, index) => ({
        name: call.step,
        reasoning: false,
        call: call.tool,
        then: toolCalls[index + 1]?.step ?? 'complete',
      })),
      {
        name: 'complete',
        reasoning: false,
        complete: true,
      },
    ];
  }

  return [
    {
      name: 'start',
      reasoning: agent.executionMode === 'hybrid',
      then: 'complete',
    },
    {
      name: 'complete',
      reasoning: false,
      complete: true,
    },
  ];
}

function toPlannerTopology(blueprint: BlueprintV2Output): PlannerTopologyInput {
  return {
    agents: blueprint.topology.agents.map((agent) => {
      const perAgent = blueprint.perAgent[agent.name];
      const contextProvidedFields = collectIncomingContextFields(blueprint, agent.name);
      return {
        name: agent.name,
        role: agent.role,
        executionMode: agent.executionMode,
        description: agent.description,
        tools: perAgent?.tools.map((tool) => tool.ref),
        gatherFields: perAgent?.gather.fields
          .filter((field) => field.source === 'user' && !contextProvidedFields.has(field.name))
          .map((field) => field.name),
      };
    }),
    edges: blueprint.topology.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      experienceMode: edge.experienceMode,
      condition: edge.condition,
      expectReturn: edge.expectReturn,
      allowCycle: edge.allowCycle,
    })),
    entryPoint: blueprint.topology.entryPoint,
  };
}

function buildSymbolTable(plan: AgentConstructPlan): SymbolTable {
  const variables = new Set<string>(CONSTRUCT_PLAN_BUILTIN_REFERENCE_VARS);
  for (const gather of plan.gathers) variables.add(gather.name);
  for (const assignment of plan.state) variables.add(assignment.name);
  for (const step of plan.flow) {
    for (const field of Object.keys(step.set ?? {})) {
      variables.add(field);
    }
  }
  for (const call of plan.toolCalls) {
    if (call.as) variables.add(call.as);
    for (const branch of call.onResult) {
      for (const field of Object.keys(branch.set ?? {})) {
        variables.add(field);
      }
    }
    for (const field of Object.keys(call.onSuccess?.set ?? {})) {
      variables.add(field);
    }
    for (const field of Object.keys(call.onFailure?.set ?? {})) {
      variables.add(field);
    }
  }
  for (const delegate of plan.delegates) {
    if (delegate.useResult) variables.add(delegate.useResult);
    for (const parentField of Object.values(delegate.returns)) {
      variables.add(parentField);
    }
  }

  const toolRefs = new Set(plan.tools.map((tool) => tool.ref));
  const toolOutputs = new Map<string, Set<string>>();
  for (const call of plan.toolCalls) {
    if (!call.as) continue;
    const declaredFields = plan.tools.find((tool) => tool.ref === call.tool)?.outputFields ?? [];
    toolOutputs.set(call.as, new Set([...declaredFields, ...call.resultFieldsUsed]));
  }

  return {
    variables,
    toolRefs,
    toolOutputs,
    flowSteps: new Set(plan.flow.map((step) => step.name)),
  };
}

function validateResultField(
  call: ConstructToolCall,
  resultField: string,
  symbols: SymbolTable,
  path: string,
): ConstructValidationIssue[] {
  if (!call.as) return [];
  const [alias, field] = splitResultRef(resultField, call.as);
  if (alias !== call.as) {
    return [
      issue(
        'TOOL_RESULT_UNKNOWN_ALIAS',
        `Tool result reference "${resultField}" does not use the declared alias "${call.as}"`,
        `${path}.resultFieldsUsed`,
      ),
    ];
  }

  const knownFields = symbols.toolOutputs.get(alias);
  if (field && knownFields && knownFields.size > 0 && !knownFields.has(field)) {
    return [
      issue(
        'TOOL_RESULT_UNKNOWN_FIELD',
        `Tool result reference "${resultField}" is not declared in output fields for "${call.tool}"`,
        `${path}.resultFieldsUsed`,
        'warning',
      ),
    ];
  }

  return [];
}

function validateExpressionRefs(
  expression: string,
  symbols: SymbolTable,
  path: string,
  code: string,
): ConstructValidationIssue[] {
  const refs = extractExpressionRefs(expression);
  const issues: ConstructValidationIssue[] = [];
  for (const ref of refs) {
    if (isKnownReference(ref, symbols)) continue;
    issues.push(issue(code, `Expression references undeclared variable "${ref}"`, path));
  }
  return issues;
}

function validateTemplateRefs(
  template: string,
  symbols: SymbolTable,
  path: string,
): ConstructValidationIssue[] {
  const refs = extractTemplateRefs(template);
  const issues: ConstructValidationIssue[] = [];
  for (const ref of refs) {
    if (isKnownReference(ref, symbols)) continue;
    issues.push(
      issue(
        'RESPOND_UNDECLARED_VARIABLE',
        `Response references undeclared variable "${ref}"`,
        path,
      ),
    );
  }
  return issues;
}

function isKnownReference(ref: string, symbols: SymbolTable): boolean {
  const [root, field] = ref.split('.', 2);
  if (symbols.variables.has(root)) {
    if (!field) return true;
    const outputFields = symbols.toolOutputs.get(root);
    return !outputFields || outputFields.size === 0 || outputFields.has(field);
  }
  return false;
}

function extractExpressionRefs(expression: string): string[] {
  const stripped = stripStringLiterals(expression);
  const refs = new Set<string>();
  const matches = stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g);
  for (const match of matches) {
    const token = match[0];
    const root = token.split('.')[0];
    if (CEL_KEYWORDS.has(token) || CEL_KEYWORDS.has(root)) continue;
    if (CEL_FUNCTIONS.has(token.toUpperCase()) || CEL_FUNCTIONS.has(root.toUpperCase())) continue;
    if (/^\d/.test(token)) continue;
    refs.add(token);
  }
  return [...refs];
}

function extractTemplateRefs(template: string): string[] {
  const refs = new Set<string>();
  const matches = template.matchAll(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g,
  );
  for (const match of matches) {
    refs.add(match[1]);
  }
  return [...refs];
}

function stripStringLiterals(value: string): string {
  return value.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, ' ');
}

function splitResultRef(value: string, fallbackAlias: string): [string, string | undefined] {
  const parts = value.split('.');
  if (parts.length === 1) return [fallbackAlias, parts[0]];
  return [parts[0], parts.slice(1).join('.')];
}

function inferOutputFieldsFromSignature(signature: string | undefined): string[] {
  if (!signature) return [];
  const output = signature.match(/->\s*\{([^}]+)\}/)?.[1];
  if (!output) return [];
  return output
    .split(',')
    .map((part) => part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter((field): field is string => Boolean(field));
}

function inferInputFieldsFromSignature(signature: string | undefined): string[] {
  if (!signature) return [];
  const input = signature.match(/\(([^)]*)\)/)?.[1];
  if (!input) return [];
  return input
    .split(',')
    .map((part) => part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter((field): field is string => Boolean(field));
}

function stateNameFromResultField(resultField: string): string {
  const [alias, ...fieldParts] = resultField.split('.');
  return toSnakeIdentifier(`${alias}_${fieldParts.join('_') || 'result'}`);
}

function toCamelIdentifier(value: string): string {
  const snake = toSnakeIdentifier(value);
  return snake.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toSnakeIdentifier(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  if (!normalized) return 'result';
  return /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
}
