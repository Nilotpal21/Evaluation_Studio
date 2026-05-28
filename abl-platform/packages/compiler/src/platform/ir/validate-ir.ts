/**
 * IR Validation Orchestrator
 *
 * Runs all validators against a compiled AgentIR and returns diagnostics.
 * Each validator is a pure function: (agent, allAgents) => ValidationDiagnostic[]
 */

import type {
  ActionHandlerIR,
  AgentIR,
  CompilationError,
  FlowStep,
  ToolInvocationIR,
} from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';
import { getActionHandlerActions } from './action-handler-utils.js';
import { validateCrossAgentRefs } from './validate-cross-agent.js';
import { validateCoordinationConfig } from './validate-coordination-config.js';
import { validateFieldReferences } from './validate-field-refs.js';
import { validateGuardrailsForIR } from './guardrail-validator.js';
import { validateInputMappingsForAgent } from './validate-input-mappings.js';
import { runPreflightValidation } from './validate-preflight.js';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from './compiler.js';

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export interface ValidateIROptions {
  /** Skip cross-agent reference validation when compiling a single agent in isolation. */
  skipCrossAgentValidation?: boolean;
  /** Single-agent validation scope. Suppresses validators that require full project topology. */
  singleAgentScope?: boolean;
}

/**
 * Run all validators against a single agent IR.
 * Returns combined diagnostics from all validators.
 */
export function validateIR(
  agent: AgentIR,
  allAgents: AgentIR[],
  opts?: ValidateIROptions,
): ValidationDiagnostic[] {
  const allAgentNames = allAgents.map((a) => a.metadata.name);
  const singleAgentScope = opts?.singleAgentScope || opts?.skipCrossAgentValidation;
  return [
    ...validateFlowGraph(agent),
    ...validateFlowRuntimeSemantics(agent),
    ...validateUniqueDigressionIntents(agent),
    ...validateConstraintActionTargets(agent),
    ...validateToolReferences(agent),
    ...validateToolDescriptions(agent),
    ...validateToolConfirmationPolicies(agent),
    ...(opts?.skipCrossAgentValidation && !opts?.singleAgentScope
      ? []
      : validateCrossAgentRefs(agent, allAgents, { singleAgentScope })),
    ...validateCoordinationConfig(agent),
    ...validateFieldReferences(agent),
    ...validateInputMappingsForAgent(agent),
    ...validatePersistentMemoryRefs(agent),
    ...validateReservedVariableNames(agent),
    ...validateAgentLookupTableOwnership(agent),
    ...validateGuardrailsForIR(agent),
    ...runPreflightValidation(agent, agent.metadata.name, allAgentNames, { singleAgentScope }),
  ];
}

function validateFlowRuntimeSemantics(agent: AgentIR): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const validateActionHandlerTerminalOrder = (
    handlers: ActionHandlerIR[] | undefined,
    pathPrefix: string,
    location: string,
  ): void => {
    if (!handlers) return;
    for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
      const actions = getActionHandlerActions(handlers[handlerIndex]);
      for (let actionIndex = 0; actionIndex < actions.length - 1; actionIndex++) {
        const action = actions[actionIndex];
        if (isTerminalActionHandlerAction(action)) {
          diagnostics.push({
            agent: agent.metadata.name,
            message: `ON_ACTION handler ${location} has a terminal action before the end of its DO block. Actions after GOTO, HANDOFF, COMPLETE, or non-returning DELEGATE are unreachable.`,
            type: 'validation',
            severity: 'error',
            code: VALIDATION_CODES.ACTION_HANDLER_TERMINAL_NOT_LAST,
            path: `${pathPrefix}[${handlerIndex}].do[${actionIndex}]`,
          });
        }

        const rendersStructuredPayload =
          action.rich_content !== undefined ||
          action.voice_config !== undefined ||
          action.actions !== undefined;
        if (
          rendersStructuredPayload &&
          actions.slice(actionIndex + 1).some(isTerminalActionHandlerAction)
        ) {
          diagnostics.push({
            agent: agent.metadata.name,
            message: `ON_ACTION handler ${location} renders structured content before a terminal routing action. Runtime forwards that payload as a fallback only when the terminal target does not return its own channel payload; prefer rendering required channel-specific content in the terminal target or a dedicated GOTO step.`,
            type: 'validation',
            severity: 'warning',
            code: VALIDATION_CODES.ACTION_HANDLER_RICH_RESPONSE_BEFORE_TERMINAL,
            path: `${pathPrefix}[${handlerIndex}].do[${actionIndex}]`,
          });
        }
      }
    }
  };

  validateActionHandlerTerminalOrder(agent.action_handlers, 'action_handlers', 'at agent level');

  const flowDefinitions = agent.flow?.definitions;

  if (!flowDefinitions) {
    return diagnostics;
  }

  for (const [stepName, step] of Object.entries(flowDefinitions)) {
    if (typeof step.complete_when === 'string' && step.complete_when.trim().length > 0) {
      diagnostics.push({
        agent: agent.metadata.name,
        message: `FLOW step "${stepName}" uses COMPLETE_WHEN. Prefer explicit THEN: COMPLETE branches because COMPLETE_WHEN can terminate a scripted step earlier than authors expect.`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.FLOW_COMPLETE_WHEN_RISK,
        path: `flow.definitions.${stepName}.complete_when`,
      });
    }

    if (step.gather && (step.on_input?.length ?? 0) > 0) {
      diagnostics.push({
        agent: agent.metadata.name,
        message: `FLOW step "${stepName}" mixes GATHER with ON_INPUT branches. Branch evaluation happens on the same step, so authors should avoid assuming an implicit order between collection and branch matching.`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.FLOW_ON_INPUT_GATHER_ORDER_AMBIGUITY,
        path: `flow.definitions.${stepName}.on_input`,
      });
    }

    if (
      step.reasoning_zone &&
      ((step.set?.length ?? 0) > 0 || (step.clear?.length ?? 0) > 0 || !!step.transform)
    ) {
      diagnostics.push({
        agent: agent.metadata.name,
        message: `FLOW step "${stepName}" combines REASONING with post-step mutations (SET, CLEAR, or TRANSFORM). Keep mutation timing explicit because the reasoning turn can read pre-mutation state while later actions apply after it.`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.FLOW_REASONING_MUTATION_TIMING,
        path: `flow.definitions.${stepName}`,
      });
    }

    validateActionHandlerTerminalOrder(
      step.on_action,
      `flow.definitions.${stepName}.on_action`,
      `in step "${stepName}"`,
    );
  }

  return diagnostics;
}

function getDigressionActions(digression: {
  do?: Array<{
    respond?: string;
    clear?: string[];
    call?: string;
    call_spec?: ToolInvocationIR;
    delegate?: string;
    goto?: string;
    resume?: boolean;
  }>;
  respond?: string;
  clear?: string[];
  call?: string;
  call_spec?: ToolInvocationIR;
  delegate?: string;
  goto?: string;
  resume?: boolean;
}): Array<{
  respond?: string;
  clear?: string[];
  call?: string;
  call_spec?: ToolInvocationIR;
  delegate?: string;
  goto?: string;
  resume?: boolean;
}> {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  const actions: Array<{
    respond?: string;
    clear?: string[];
    call?: string;
    call_spec?: ToolInvocationIR;
    delegate?: string;
    goto?: string;
    resume?: boolean;
  }> = [];
  if (digression.respond !== undefined) actions.push({ respond: digression.respond });
  if (digression.clear?.length) actions.push({ clear: digression.clear });
  if (digression.call || digression.call_spec) {
    actions.push({ call: digression.call, call_spec: digression.call_spec });
  }
  if (digression.delegate) actions.push({ delegate: digression.delegate });
  if (digression.goto) actions.push({ goto: digression.goto });
  else if (digression.resume) actions.push({ resume: digression.resume });
  return actions;
}

function isTerminalActionHandlerAction(action: {
  goto?: string;
  handoff?: string;
  delegate?: string;
  return?: boolean;
  complete?: boolean;
}): boolean {
  return !!(
    action.goto ||
    action.handoff ||
    action.complete ||
    (action.delegate && action.return !== true)
  );
}

function extractToolCallName(
  call: string | undefined,
  callSpec?: ToolInvocationIR,
): string | undefined {
  if (callSpec?.tool) {
    return callSpec.tool;
  }
  if (!call) return undefined;
  return call.match(/^(\w+)/)?.[1] || call;
}

function formatAvailableNames(values: Iterable<string>): string {
  const names = [...values];
  return names.length > 0 ? names.join(', ') : '(none)';
}

function collectGatherFieldNames(agent: AgentIR): Set<string> {
  const gatherFieldNames = new Set<string>();

  for (const field of agent.gather?.fields ?? []) {
    gatherFieldNames.add(field.name);
  }

  for (const step of Object.values(agent.flow?.definitions ?? {})) {
    for (const field of step.gather?.fields ?? []) {
      gatherFieldNames.add(field.name);
    }
  }

  return gatherFieldNames;
}

function collectPersistentMemoryPaths(
  agent: AgentIR,
): Map<string, AgentIR['memory']['persistent'][number]> {
  return new Map((agent.memory?.persistent ?? []).map((entry) => [entry.path, entry]));
}

function normalizeDigressionIntentKey(intent: string | undefined): string | undefined {
  const normalized = intent?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function validateConstraintActionTargets(agent: AgentIR): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const constraints = agent.constraints?.constraints ?? [];

  if (constraints.length === 0) {
    return diagnostics;
  }

  const agentName = agent.metadata.name;
  const stepNames = new Set(Object.keys(agent.flow?.definitions ?? {}));
  const gatherFieldNames = collectGatherFieldNames(agent);
  const availableSteps = formatAvailableNames(stepNames);
  const availableGatherFields = formatAvailableNames(gatherFieldNames);

  const pushDanglingStepRef = (
    constraintIndex: number,
    target: string,
    path: string,
    actionType: string,
  ) => {
    diagnostics.push({
      agent: agentName,
      message: `Constraint on_fail ${actionType} references nonexistent step "${target}". Available steps: ${availableSteps}`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.DANGLING_STEP_REF,
      path,
    });
  };

  for (let i = 0; i < constraints.length; i++) {
    const onFail = constraints[i].on_fail;

    if (onFail.type === 'goto_step') {
      const target = onFail.then_step ?? onFail.target;
      if (target && !stepNames.has(target)) {
        pushDanglingStepRef(
          i,
          target,
          `constraints[${i}].on_fail.${onFail.then_step ? 'then_step' : 'target'}`,
          'goto_step',
        );
      }
      continue;
    }

    if (onFail.type !== 'collect_field') {
      continue;
    }

    const collectFields = onFail.collect_fields ?? [];
    for (let j = 0; j < collectFields.length; j++) {
      const fieldName = collectFields[j];
      if (!gatherFieldNames.has(fieldName)) {
        diagnostics.push({
          agent: agentName,
          message: `Constraint on_fail collect_field references undeclared gather field "${fieldName}". Available gather fields: ${availableGatherFields}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_CONSTRAINT_COLLECT_FIELD,
          path: `constraints[${i}].on_fail.collect_fields[${j}]`,
        });
      }
    }

    if (onFail.then_step && !stepNames.has(onFail.then_step)) {
      pushDanglingStepRef(
        i,
        onFail.then_step,
        `constraints[${i}].on_fail.then_step`,
        'collect_field',
      );
    }
  }

  return diagnostics;
}

function validatePersistentMemoryRefs(agent: AgentIR): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const memory = agent.memory;

  if (!memory) {
    return diagnostics;
  }

  const agentName = agent.metadata.name;
  const persistentPaths = collectPersistentMemoryPaths(agent);
  const availablePaths = formatAvailableNames(persistentPaths.keys());

  const pushMissingPath = (pathValue: string, path: string, usage: string) => {
    diagnostics.push({
      agent: agentName,
      message: `${usage} references undeclared persistent memory path "${pathValue}". Declared persistent paths: ${availablePaths}`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_REF,
      path,
    });
  };

  const pushAccessError = (
    pathValue: string,
    access: 'read' | 'write' | 'readwrite',
    path: string,
    usage: string,
  ) => {
    diagnostics.push({
      agent: agentName,
      message: `${usage} cannot use persistent memory path "${pathValue}" with ACCESS "${access}"`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.INVALID_PERSISTENT_MEMORY_ACCESS,
      path,
    });
  };

  for (let i = 0; i < (memory.remember ?? []).length; i++) {
    const target = memory.remember[i].store.target;
    const declaration = persistentPaths.get(target);

    if (!declaration) {
      pushMissingPath(target, `memory.remember[${i}].store.target`, 'REMEMBER store target');
      continue;
    }

    if (declaration.access === 'read') {
      pushAccessError(
        target,
        declaration.access,
        `memory.remember[${i}].store.target`,
        'REMEMBER store target',
      );
    }
  }

  for (let i = 0; i < (memory.recall ?? []).length; i++) {
    const action = memory.recall[i].action;
    if (action?.type !== 'inject_context') {
      continue;
    }

    for (let j = 0; j < action.paths.length; j++) {
      const pathValue = action.paths[j];
      const declaration = persistentPaths.get(pathValue);

      if (!declaration) {
        pushMissingPath(
          pathValue,
          `memory.recall[${i}].action.paths[${j}]`,
          'RECALL inject_context path',
        );
        continue;
      }

      if (declaration.access === 'write') {
        pushAccessError(
          pathValue,
          declaration.access,
          `memory.recall[${i}].action.paths[${j}]`,
          'RECALL inject_context path',
        );
      }
    }
  }

  return diagnostics;
}

function validateUniqueDigressionIntents(agent: AgentIR): ValidationDiagnostic[] {
  if (!agent.flow) {
    return [];
  }

  const diagnostics: ValidationDiagnostic[] = [];
  const seen = new Map<string, { intent: string; path: string }>();
  const agentName = agent.metadata.name;

  const registerDigression = (intent: string | undefined, path: string) => {
    const normalizedIntent = normalizeDigressionIntentKey(intent);
    if (!normalizedIntent) {
      return;
    }

    const existing = seen.get(normalizedIntent);
    if (existing) {
      diagnostics.push({
        agent: agentName,
        message: `Digression intent "${intent}" is declared multiple times in this flow. First declaration: ${existing.path}. Digression intents must be unique across global and step digressions.`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.DUPLICATE_DIGRESSION_INTENT,
        path,
      });
      return;
    }

    seen.set(normalizedIntent, { intent: intent!, path });
  };

  for (let i = 0; i < (agent.flow.global_digressions?.length ?? 0); i++) {
    registerDigression(
      agent.flow.global_digressions![i].intent,
      `flow.global_digressions[${i}].intent`,
    );
  }

  for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
    for (let i = 0; i < (step.digressions?.length ?? 0); i++) {
      registerDigression(
        step.digressions![i].intent,
        `flow.steps.${stepName}.digressions[${i}].intent`,
      );
    }
  }

  return diagnostics;
}

// =============================================================================
// FLOW GRAPH VALIDATOR
// =============================================================================

/**
 * Validate flow step connectivity and reachability.
 * Only runs for agents with a flow config.
 */
function isTerminalFlowTarget(target: string | undefined): boolean {
  if (!target) {
    return true;
  }

  const normalized = target.trim().toUpperCase();
  return (
    normalized === 'COMPLETE' ||
    normalized === 'ESCALATE' ||
    /^ESCALATE\s+WITH\s+REASON\b/.test(normalized)
  );
}

export function validateFlowGraph(agent: AgentIR): ValidationDiagnostic[] {
  // Skip agents without flow
  if (!agent.flow) {
    return [];
  }

  const agentName = agent.metadata.name;
  const flow = agent.flow;
  const definitions = flow.definitions;
  const stepNames = new Set(Object.keys(definitions));
  const diagnostics: ValidationDiagnostic[] = [];

  // Check for empty flow
  if (stepNames.size === 0) {
    diagnostics.push({
      agent: agentName,
      message: 'Agent has FLOW but no steps defined',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.EMPTY_FLOW,
      path: 'flow',
    });
    return diagnostics;
  }

  // Check entry_point
  if (!flow.entry_point || !stepNames.has(flow.entry_point)) {
    diagnostics.push({
      agent: agentName,
      message: `Entry point "${flow.entry_point ?? '(undefined)'}" does not match any defined step. Available steps: ${[...stepNames].join(', ')}`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.MISSING_ENTRY_POINT,
      path: 'flow.entry_point',
    });
  }

  // Check all step transitions
  for (const [stepName, step] of Object.entries(definitions)) {
    const checkRef = (target: string | undefined, location: string) => {
      if (!target || isTerminalFlowTarget(target)) {
        return;
      }
      if (!stepNames.has(target)) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" references nonexistent step "${target}" in ${location}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.DANGLING_STEP_REF,
          path: `flow.steps.${stepName}.${location}`,
        });
      }
    };

    // Direct transitions
    checkRef(step.then, 'then');
    checkRef(step.on_fail, 'on_fail');

    // on_input branches
    if (step.on_input) {
      for (let i = 0; i < step.on_input.length; i++) {
        checkRef(step.on_input[i].then, `on_input[${i}].then`);
      }
    }

    // on_result branches
    if (step.on_result) {
      for (let i = 0; i < step.on_result.length; i++) {
        checkRef(step.on_result[i].then, `on_result[${i}].then`);
      }
    }

    // on_success
    if (step.on_success) {
      checkRef(step.on_success.then, 'on_success.then');
      if (step.on_success.branches) {
        for (let i = 0; i < step.on_success.branches.length; i++) {
          checkRef(step.on_success.branches[i].then, `on_success.branches[${i}].then`);
        }
      }
    }

    // on_failure
    if (step.on_failure) {
      checkRef(step.on_failure.then, 'on_failure.then');
      if (step.on_failure.branches) {
        for (let i = 0; i < step.on_failure.branches.length; i++) {
          checkRef(step.on_failure.branches[i].then, `on_failure.branches[${i}].then`);
        }
      }
    }

    // on_action ordered actions
    if (step.on_action) {
      for (let i = 0; i < step.on_action.length; i++) {
        const handlerActions = getActionHandlerActions(step.on_action[i]);
        for (let j = 0; j < handlerActions.length; j++) {
          checkRef(handlerActions[j].goto, `on_action[${i}].do[${j}].goto`);
        }
      }
    }

    // digressions
    if (step.digressions) {
      for (let i = 0; i < step.digressions.length; i++) {
        const digression = step.digressions[i];
        const gotoTargets = getDigressionActions(digression)
          .map((action) => action.goto)
          .filter((target): target is string => !!target);
        for (const target of gotoTargets) {
          checkRef(target, `digressions[${i}].goto`);
        }
      }
    }

    // await_attachment
    if (step.await_attachment) {
      checkRef(step.await_attachment.on_timeout, 'await_attachment.on_timeout');

      // Validate variable (must be non-empty, no spaces)
      if (
        !step.await_attachment.variable ||
        step.await_attachment.variable.trim() === '' ||
        /\s/.test(step.await_attachment.variable)
      ) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" AWAIT_ATTACHMENT has invalid variable name "${step.await_attachment.variable || ''}" — must be non-empty with no spaces`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT,
          path: `flow.steps.${stepName}.await_attachment.variable`,
        });
      }

      // Validate prompt (must be non-empty)
      if (!step.await_attachment.prompt || step.await_attachment.prompt.trim() === '') {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" AWAIT_ATTACHMENT requires a non-empty prompt`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT,
          path: `flow.steps.${stepName}.await_attachment.prompt`,
        });
      }

      // Validate category (must be one of valid values if present)
      const validCategories = ['image', 'document', 'audio', 'video'];
      if (
        step.await_attachment.category &&
        !validCategories.includes(step.await_attachment.category)
      ) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" AWAIT_ATTACHMENT has invalid category "${step.await_attachment.category}" — must be one of: ${validCategories.join(', ')}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT,
          path: `flow.steps.${stepName}.await_attachment.category`,
        });
      }

      // Validate timeout_seconds (must be > 0 if present)
      if (
        step.await_attachment.timeout_seconds !== undefined &&
        step.await_attachment.timeout_seconds <= 0
      ) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" AWAIT_ATTACHMENT timeout_seconds must be greater than 0, got ${step.await_attachment.timeout_seconds}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT,
          path: `flow.steps.${stepName}.await_attachment.timeout_seconds`,
        });
      }
    }
  }

  // Check global digressions
  if (flow.global_digressions) {
    for (let i = 0; i < flow.global_digressions.length; i++) {
      const d = flow.global_digressions[i];
      const gotoTargets = getDigressionActions(d)
        .map((action) => action.goto)
        .filter((target): target is string => !!target);
      for (const target of gotoTargets) {
        if (!stepNames.has(target)) {
          diagnostics.push({
            agent: agentName,
            message: `Global digression "${d.intent}" references nonexistent step "${target}"`,
            type: 'validation',
            severity: 'error',
            code: VALIDATION_CODES.DANGLING_STEP_REF,
            path: `flow.global_digressions[${i}].goto`,
          });
        }
      }
    }
  }

  // Orphan detection via BFS from entry_point
  if (flow.entry_point && stepNames.has(flow.entry_point)) {
    const reachable = new Set<string>();
    const queue: string[] = [flow.entry_point];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      const step = definitions[current];
      if (!step) continue;

      // Collect all transition targets from this step
      const targets = collectStepTargets(step);

      // Add global digression targets
      if (flow.global_digressions) {
        for (const d of flow.global_digressions) {
          for (const action of getDigressionActions(d)) {
            if (action.goto) targets.add(action.goto);
          }
        }
      }

      for (const target of targets) {
        if (stepNames.has(target) && !reachable.has(target)) {
          queue.push(target);
        }
      }
    }

    for (const stepName of stepNames) {
      if (!reachable.has(stepName)) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" is unreachable from entry point "${flow.entry_point}"`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.ORPHANED_STEP,
          path: `flow.steps.${stepName}`,
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Collect all step name targets reachable from a single FlowStep.
 */
function collectStepTargets(step: FlowStep): Set<string> {
  const targets = new Set<string>();

  if (step.then && !isTerminalFlowTarget(step.then)) targets.add(step.then);
  if (step.on_fail && !isTerminalFlowTarget(step.on_fail)) targets.add(step.on_fail);

  if (step.on_input) {
    for (const b of step.on_input) {
      if (b.then && !isTerminalFlowTarget(b.then)) targets.add(b.then);
    }
  }
  if (step.on_result) {
    for (const b of step.on_result) {
      if (b.then && !isTerminalFlowTarget(b.then)) targets.add(b.then);
    }
  }
  if (step.on_success) {
    if (step.on_success.then && !isTerminalFlowTarget(step.on_success.then))
      targets.add(step.on_success.then);
    if (step.on_success.branches) {
      for (const b of step.on_success.branches) {
        if (b.then && !isTerminalFlowTarget(b.then)) targets.add(b.then);
      }
    }
  }
  if (step.on_failure) {
    if (step.on_failure.then && !isTerminalFlowTarget(step.on_failure.then))
      targets.add(step.on_failure.then);
    if (step.on_failure.branches) {
      for (const b of step.on_failure.branches) {
        if (b.then && !isTerminalFlowTarget(b.then)) targets.add(b.then);
      }
    }
  }
  if (step.digressions) {
    for (const d of step.digressions) {
      for (const action of getDigressionActions(d)) {
        if (action.goto) targets.add(action.goto);
      }
    }
  }
  if (step.on_action) {
    for (const handler of step.on_action) {
      for (const action of getActionHandlerActions(handler)) {
        if (action.goto) targets.add(action.goto);
      }
    }
  }
  if (step.await_attachment?.on_timeout) {
    targets.add(step.await_attachment.on_timeout);
  }

  return targets;
}

// =============================================================================
// TOOL REFERENCE VALIDATOR
// =============================================================================

/**
 * Validate that all tool references (call fields) point to defined tools.
 * System tools (names starting with __) are skipped.
 */
export function validateToolReferences(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const toolNames = new Set(agent.tools.map((t) => t.name));
  const diagnostics: ValidationDiagnostic[] = [];

  const checkCall = (call: string | undefined, path: string, callSpec?: ToolInvocationIR) => {
    const toolName = extractToolCallName(call, callSpec);
    if (!toolName) return;
    // Skip system tools (auto-injected by compiler)
    if (toolName.startsWith('__')) return;
    if (!toolNames.has(toolName)) {
      diagnostics.push({
        agent: agentName,
        message: `Tool "${toolName}" is not defined in this agent's tools. Available tools: ${[...toolNames].filter((n) => !n.startsWith('__')).join(', ') || '(none)'}`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.UNDEFINED_TOOL_CALL,
        path,
      });
    }
  };

  // Flow steps
  if (agent.flow) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      checkCall(step.call, `flow.steps.${stepName}.call`, step.call_spec);

      if (step.on_input) {
        for (let i = 0; i < step.on_input.length; i++) {
          checkCall(
            step.on_input[i].call,
            `flow.steps.${stepName}.on_input[${i}].call`,
            step.on_input[i].call_spec,
          );
        }
      }
      if (step.on_result) {
        for (let i = 0; i < step.on_result.length; i++) {
          checkCall(
            step.on_result[i].call,
            `flow.steps.${stepName}.on_result[${i}].call`,
            step.on_result[i].call_spec,
          );
        }
      }
      if (step.on_success) {
        if (step.on_success.branches) {
          for (let i = 0; i < step.on_success.branches.length; i++) {
            checkCall(
              step.on_success.branches[i].call,
              `flow.steps.${stepName}.on_success.branches[${i}].call`,
              step.on_success.branches[i].call_spec,
            );
          }
        }
      }
      if (step.on_failure) {
        if (step.on_failure.branches) {
          for (let i = 0; i < step.on_failure.branches.length; i++) {
            checkCall(
              step.on_failure.branches[i].call,
              `flow.steps.${stepName}.on_failure.branches[${i}].call`,
              step.on_failure.branches[i].call_spec,
            );
          }
        }
      }
      if (step.on_action) {
        for (let i = 0; i < step.on_action.length; i++) {
          const handlerActions = getActionHandlerActions(step.on_action[i]);
          for (let j = 0; j < handlerActions.length; j++) {
            checkCall(
              handlerActions[j].call,
              `flow.steps.${stepName}.on_action[${i}].do[${j}].call`,
              handlerActions[j].call_spec,
            );
          }
        }
      }
      if (step.digressions) {
        for (let i = 0; i < step.digressions.length; i++) {
          const digression = step.digressions[i];
          const digressionActions = getDigressionActions(digression);
          for (let j = 0; j < digressionActions.length; j++) {
            checkCall(
              digressionActions[j].call,
              `flow.steps.${stepName}.digressions[${i}].do[${j}].call`,
              digressionActions[j].call_spec,
            );
          }
        }
      }
      if (step.sub_intents) {
        for (let i = 0; i < step.sub_intents.length; i++) {
          checkCall(
            step.sub_intents[i].call,
            `flow.steps.${stepName}.sub_intents[${i}].call`,
            step.sub_intents[i].call_spec,
          );
        }
      }
    }

    // Global digressions
    if (agent.flow.global_digressions) {
      for (let i = 0; i < agent.flow.global_digressions.length; i++) {
        const digression = agent.flow.global_digressions[i];
        const digressionActions = getDigressionActions(digression);
        for (let j = 0; j < digressionActions.length; j++) {
          checkCall(
            digressionActions[j].call,
            `flow.global_digressions[${i}].do[${j}].call`,
            digressionActions[j].call_spec,
          );
        }
      }
    }
  }

  // Hooks
  if (agent.hooks) {
    for (const hookKey of ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as const) {
      const hook = agent.hooks[hookKey];
      if (hook?.call || hook?.call_spec) {
        checkCall(hook?.call, `hooks.${hookKey}.call`, hook?.call_spec);
      }
    }
  }

  // on_start
  if (agent.on_start?.call || agent.on_start?.call_spec) {
    checkCall(agent.on_start?.call, 'on_start.call', agent.on_start?.call_spec);
  }

  if (agent.action_handlers) {
    for (let i = 0; i < agent.action_handlers.length; i++) {
      const handlerActions = getActionHandlerActions(agent.action_handlers[i]);
      for (let j = 0; j < handlerActions.length; j++) {
        checkCall(
          handlerActions[j].call,
          `action_handlers[${i}].do[${j}].call`,
          handlerActions[j].call_spec,
        );
      }
    }
  }

  return diagnostics;
}

/**
 * Warn when side-effecting tools omit an explicit confirmation policy.
 * Keeps runtime behavior explicit without silently defaulting confirmation.
 */
export function validateToolConfirmationPolicies(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  for (const tool of agent.tools) {
    if (tool.name.startsWith('__')) continue;
    if (tool.hints?.side_effects !== true) continue;
    if (tool.confirmation) continue;

    diagnostics.push({
      agent: agentName,
      message: `Tool "${tool.name}" declares side_effects: true but has no explicit confirm policy. Add "confirm: when_side_effects" (recommended), "confirm: always", or "confirm: never" so confirmation behavior stays intentional.`,
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.SIDE_EFFECT_TOOL_WITHOUT_CONFIRMATION,
      path: `tools.${tool.name}.confirm`,
    });
  }

  return diagnostics;
}

// =============================================================================
// TOOL DESCRIPTION VALIDATOR
// =============================================================================

/**
 * Validate that tools and their required parameters have descriptions.
 * Emits warnings (not errors) for missing descriptions.
 * System tools (names starting with __) are skipped.
 */
export function validateToolDescriptions(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  for (const tool of agent.tools) {
    // Skip system tools — they get descriptions injected by the runtime
    if (tool.name.startsWith('__')) continue;

    if (!tool.description) {
      diagnostics.push({
        agent: agentName,
        message: `Tool "${tool.name}" has no description. LLM tool selection works best with descriptive text.`,
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.MISSING_TOOL_DESCRIPTION,
        path: `tools.${tool.name}.description`,
      });
    }

    if (tool.parameters) {
      for (const param of tool.parameters) {
        if (typeof param === 'string') continue;
        if (param.required !== false && !param.description) {
          diagnostics.push({
            agent: agentName,
            message: `Required parameter "${param.name}" of tool "${tool.name}" has no description.`,
            type: 'validation',
            severity: 'warning',
            code: VALIDATION_CODES.MISSING_PARAM_DESCRIPTION,
            path: `tools.${tool.name}.parameters.${param.name}.description`,
          });
        }
      }
    }
  }

  return diagnostics;
}

// =============================================================================
// RESERVED VARIABLE NAME VALIDATOR
// =============================================================================

/** Variable names assigned by the runtime that should not be used as SET targets */
const RESERVED_VARIABLE_NAMES = new Set([
  'match', // Assigned by regex capture groups after 'matches' operator
  'input', // Current user input (used internally)
]);

const IMMUTABLE_SYSTEM_IDENTIFIERS = new Set(['user_id', 'session_id', 'tenant_id', 'project_id']);

/**
 * Warn when SET actions target a system-reserved variable name.
 * Only applies to scripted agents with flow steps containing SET assignments.
 */
export function validateReservedVariableNames(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  if (agent.flow) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      if (!step.set) continue;
      for (const assignment of step.set) {
        if (RESERVED_VARIABLE_NAMES.has(assignment.variable)) {
          diagnostics.push({
            agent: agentName,
            message: `"${assignment.variable}" is a system-reserved variable name and may be overwritten during execution (e.g., by regex capture groups)`,
            type: 'validation',
            severity: 'warning',
            code: VALIDATION_CODES.RESERVED_VARIABLE_NAME,
            path: `flow.steps.${stepName}.set.${assignment.variable}`,
          });
        }

        if (IMMUTABLE_SYSTEM_IDENTIFIERS.has(assignment.variable)) {
          diagnostics.push({
            agent: agentName,
            message: `"${assignment.variable}" is system-owned and should not be mutated in public ABL authoring. Use explicit pass-through, memory grants, or runtime bootstrap instead.`,
            type: 'validation',
            severity: 'warning',
            code: VALIDATION_CODES.IMMUTABLE_SYSTEM_IDENTIFIER,
            path: `flow.steps.${stepName}.set.${assignment.variable}`,
          });
        }
      }
    }
  }

  if (agent.on_start?.set) {
    for (const variable of Object.keys(agent.on_start.set)) {
      if (IMMUTABLE_SYSTEM_IDENTIFIERS.has(variable)) {
        diagnostics.push({
          agent: agentName,
          message: `"${variable}" is system-owned and should not be mutated in ON_START. Use runtime bootstrap or handoff/pass-through behavior instead.`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.IMMUTABLE_SYSTEM_IDENTIFIER,
          path: `on_start.set.${variable}`,
        });
      }
    }
  }

  return diagnostics;
}

function validateAgentLookupTableOwnership(agent: AgentIR): ValidationDiagnostic[] {
  if (!agent.lookup_tables || Object.keys(agent.lookup_tables).length === 0) {
    return [];
  }

  return [
    {
      agent: agent.metadata.name,
      message:
        'Agent-local LOOKUP_TABLES remain experimental. Prefer project runtime config lookup_tables plus GATHER semantics.lookup for shared reference data.',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.AGENT_LOOKUP_TABLE_EXPERIMENTAL,
      path: 'lookup_tables',
    },
  ];
}

// =============================================================================
// STANDALONE VALIDATION FUNCTION
// =============================================================================

/**
 * Standalone validation function for the import pipeline.
 * Parses, compiles, and validates ABL source files.
 * Returns errors and warnings without requiring the caller to
 * understand the compilation pipeline.
 */
export function validateABL(documents: Array<{ filename: string; source: string }>): {
  errors: CompilationError[];
  warnings: CompilationError[];
} {
  try {
    const parsed = [];
    const parseErrors: CompilationError[] = [];
    const parseWarnings: CompilationError[] = [];

    for (const doc of documents) {
      const result = parseAgentBasedABL(doc.source);
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          parseErrors.push({
            agent: doc.filename,
            message: err.message,
            type: 'parse',
          });
        }
      }
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          parseWarnings.push({
            agent: doc.filename,
            message: warning.message,
            type: 'parse',
            severity: 'warning',
          });
        }
      }
      if (result.document) {
        parsed.push(result.document);
      }
    }

    if (parsed.length === 0) {
      return { errors: parseErrors, warnings: parseWarnings };
    }

    const output = compileABLtoIR(parsed);
    const errors = [...parseErrors, ...(output.compilation_errors ?? [])];
    const warnings = [...parseWarnings, ...(output.compilation_warnings ?? [])];

    return { errors, warnings };
  } catch (err: any) {
    return {
      errors: [{ agent: '(global)', message: err.message || String(err), type: 'compilation' }],
      warnings: [],
    };
  }
}
