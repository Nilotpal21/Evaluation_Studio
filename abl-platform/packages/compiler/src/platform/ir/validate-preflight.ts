/**
 * Pre-flight Validators
 *
 * Catch common misconfiguration bugs at compile time — before deployment.
 * Each function returns ValidationDiagnostic[] and is a pure function.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

/**
 * SUPERVISOR_NO_REASONING_STEP
 *
 * A supervisor agent with routing rules must have at least one flow step
 * with reasoning enabled. Without it, the LLM is never called and
 * handoff conditions can never be evaluated — the agent returns empty responses.
 */
export function validateSupervisorReasoningStep(
  agentIR: AgentIR,
  agentName: string,
): ValidationDiagnostic[] {
  // Only applies to supervisors with routing
  if (agentIR.metadata.type !== 'supervisor') return [];
  if (!agentIR.routing) return [];

  // If there's no flow, supervisor operates in pure reasoning mode — OK
  if (!agentIR.flow) return [];

  const steps = Object.values(agentIR.flow.definitions);
  const hasReasoningStep = steps.some((step) => step.reasoning_zone != null);

  if (!hasReasoningStep) {
    return [
      {
        agent: agentName,
        message:
          'Supervisor agent has routing rules but no flow step with REASONING enabled. ' +
          'The LLM will never be called, so handoff conditions cannot be evaluated.',
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.SUPERVISOR_NO_REASONING_STEP,
        path: 'flow',
      },
    ];
  }

  return [];
}

/**
 * REASONING_ZONE_NO_MODEL
 *
 * A flow step with REASONING enabled but no model specified anywhere in the
 * agent's execution config. This is a warning (not error) because the model
 * may resolve from the database at runtime.
 */
export function validateReasoningZoneModel(
  agentIR: AgentIR,
  agentName: string,
): ValidationDiagnostic[] {
  if (!agentIR.flow) return [];

  // If the agent has a top-level model, all reasoning zones are covered
  if (agentIR.execution.model) return [];

  const diagnostics: ValidationDiagnostic[] = [];

  for (const [stepName, step] of Object.entries(agentIR.flow.definitions)) {
    if (step.reasoning_zone == null) continue;

    diagnostics.push({
      agent: agentName,
      message:
        `Flow step "${stepName}" has REASONING enabled but no model is specified in the agent's ` +
        'execution config. The model may resolve from the database at runtime, but if not ' +
        'the step will fail.',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.REASONING_ZONE_NO_MODEL,
      path: `flow.steps.${stepName}.reasoning_zone`,
    });
  }

  return diagnostics;
}

/**
 * FLOW_STEP_NO_ACTION
 *
 * A flow step with no reasoning zone, no gather, no respond, and no call.
 * The step does nothing and exits immediately as "waiting".
 */
export function validateFlowStepActions(
  agentIR: AgentIR,
  agentName: string,
): ValidationDiagnostic[] {
  if (!agentIR.flow) return [];

  const diagnostics: ValidationDiagnostic[] = [];

  for (const [stepName, step] of Object.entries(agentIR.flow.definitions)) {
    const hasAction =
      step.reasoning_zone != null ||
      step.gather != null ||
      step.respond != null ||
      step.call != null ||
      step.set != null ||
      step.transform != null ||
      step.human_approval != null;

    if (!hasAction) {
      diagnostics.push({
        agent: agentName,
        message:
          `Flow step "${stepName}" has no reasoning zone, gather, respond, call, set, ` +
          'transform, or human approval. The step does nothing and will exit immediately.',
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.FLOW_STEP_NO_ACTION,
        path: `flow.steps.${stepName}`,
      });
    }
  }

  return diagnostics;
}

/**
 * INVALID_DEFAULT_ROUTING_TARGET
 *
 * routing.default_agent must reference an agent that exists in the compilation.
 */
export function validateDefaultRoutingTarget(
  agentIR: AgentIR,
  agentName: string,
  allAgentNames: string[],
  opts: { singleAgentScope?: boolean } = {},
): ValidationDiagnostic[] {
  if (!agentIR.routing) return [];
  if (opts.singleAgentScope) return [];
  const remoteHandoffTargets = new Set(
    (agentIR.coordination?.handoffs ?? [])
      .filter((handoff) => handoff.remote?.location === 'remote')
      .map((handoff) => handoff.to),
  );

  const defaultAgent = agentIR.routing.default_agent;
  if (!defaultAgent) return [];

  if (defaultAgent === agentName) {
    return [
      {
        agent: agentName,
        message:
          `routing.default_agent references the current agent "${defaultAgent}". ` +
          'Default routing must point to a different agent.',
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.SELF_ROUTING_TARGET,
        path: 'routing.default_agent',
        referenced_agent: defaultAgent,
      },
    ];
  }

  if (!allAgentNames.includes(defaultAgent) && !remoteHandoffTargets.has(defaultAgent)) {
    return [
      {
        agent: agentName,
        message:
          `routing.default_agent references "${defaultAgent}" which is not a known agent. ` +
          `Available agents: ${allAgentNames.join(', ') || '(none)'}`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.INVALID_DEFAULT_ROUTING_TARGET,
        path: 'routing.default_agent',
        referenced_agent: defaultAgent,
      },
    ];
  }

  return [];
}

/**
 * AUTH_JIT_WITHOUT_PROFILE
 *
 * A tool with auth_jit: true but no auth_profile_ref. JIT auth cannot
 * function without a profile to resolve credentials against.
 */
export function validateAuthJitRequiresProfile(
  agentIR: AgentIR,
  agentName: string,
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  for (const tool of agentIR.tools) {
    if (tool.jit_auth && !tool.auth_profile_ref) {
      diagnostics.push({
        agent: agentName,
        message:
          `Tool "${tool.name}" has auth_jit: true but no auth_profile specified. ` +
          'JIT auth requires an auth_profile to resolve credentials.',
        type: 'validation',
        severity: 'warning',
        code: VALIDATION_CODES.AUTH_JIT_WITHOUT_PROFILE,
        path: `tools.${tool.name}.auth_jit`,
      });
    }
  }

  return diagnostics;
}

/**
 * Run all pre-flight validators for a single agent.
 */
export function runPreflightValidation(
  agentIR: AgentIR,
  agentName: string,
  allAgentNames: string[],
  opts: { singleAgentScope?: boolean } = {},
): ValidationDiagnostic[] {
  return [
    ...validateSupervisorReasoningStep(agentIR, agentName),
    ...validateReasoningZoneModel(agentIR, agentName),
    ...validateFlowStepActions(agentIR, agentName),
    ...validateDefaultRoutingTarget(agentIR, agentName, allAgentNames, opts),
    ...validateAuthJitRequiresProfile(agentIR, agentName),
  ];
}
