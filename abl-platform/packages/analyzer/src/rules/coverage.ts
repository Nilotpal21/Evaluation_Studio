/**
 * Coverage analysis rules
 *
 * COV001: Unhandled intents
 * COV002: Dead steps
 * COV003: Missing error handlers
 * COV004: Infinite loop risk
 * COV005: Missing signals
 */

import type { AnalysisRule, AnalysisResult, AnalysisContext, ProjectContext } from '../types.js';
import type {
  SupervisorDocument,
  AgentDocument,
  AgentBasedDocument,
  Step,
  StepAction,
  Flow,
  FlowDefinition,
  FlowStep,
} from '@abl/core';

/**
 * COV001: Unhandled intents
 * Detects intents defined but not mapped to any agent
 */
export const unhandledIntents: AnalysisRule = {
  id: 'COV001',
  name: 'Unhandled Intents',
  description: 'Detects intents that are not mapped to any agent',
  severity: 'warning',
  category: 'coverage',

  checkProject(project: ProjectContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!project.supervisor) return results;

    // Collect all mapped intents
    const mappedIntents = new Set<string>();

    if (project.supervisor.intents) {
      for (const mapping of project.supervisor.intents) {
        for (const intent of mapping.intents) {
          mappedIntents.add(intent);
        }
      }
    }

    // Check routing rules for intent_match targets
    for (const rule of project.supervisor.routing) {
      if (rule.then.kind === 'intent_match') {
        for (const mapping of rule.then.mappings) {
          for (const intent of mapping.intents) {
            mappedIntents.add(intent);
          }
        }
      }
    }

    // Check agents for classify actions to find declared intents
    const declaredIntents = new Set<string>();
    for (const [name, agent] of project.agents) {
      for (const step of agent.flow.steps) {
        collectIntentsFromAction(step.action, declaredIntents);
      }
    }

    // Find intents declared but not mapped
    for (const intent of declaredIntents) {
      if (!mappedIntents.has(intent)) {
        results.push({
          ruleId: 'COV001',
          severity: 'warning',
          message: `Intent "${intent}" is referenced but not mapped in supervisor routing`,
          location: {
            documentId: project.supervisor.meta.id,
            documentName: project.supervisor.meta.name,
          },
          suggestion: `Add a mapping for "${intent}" in the INTENTS section or routing rules`,
        });
      }
    }

    return results;
  },
};

/**
 * COV002: Dead steps
 * Detects steps that cannot be reached from the entry point
 */
export const deadSteps: AnalysisRule = {
  id: 'COV002',
  name: 'Dead Steps',
  description: 'Detects steps that are not reachable from the flow entry point',
  severity: 'warning',
  category: 'coverage',

  checkAgent(doc: AgentDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    const reachableSteps = findReachableSteps(doc.flow);

    for (const step of doc.flow.steps) {
      if (!reachableSteps.has(step.name)) {
        results.push({
          ruleId: 'COV002',
          severity: 'warning',
          message: `Step "${step.name}" is not reachable from the entry point`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementId: step.id,
            elementName: step.name,
          },
          suggestion: 'Remove this step or add a path to reach it',
        });
      }
    }

    return results;
  },

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.flow) return results;

    const reachableSteps = findReachableStepsAgentBased(doc.flow);

    for (const stepName of Object.keys(doc.flow.definitions)) {
      if (!reachableSteps.has(stepName)) {
        results.push({
          ruleId: 'COV002',
          severity: 'warning',
          message: `Step "${stepName}" is not reachable from the entry point`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: 'Remove this step or add a path to reach it',
        });
      }
    }

    return results;
  },
};

/**
 * COV003: Missing error handlers
 * Detects tool calls without ON_FAILURE handlers
 */
export const missingErrorHandlers: AnalysisRule = {
  id: 'COV003',
  name: 'Missing Error Handlers',
  description: 'Detects tool calls that lack error handling',
  severity: 'warning',
  category: 'coverage',

  checkAgent(doc: AgentDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    for (const step of doc.flow.steps) {
      checkActionForErrorHandler(step.action, step, doc, results);
    }

    return results;
  },

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.flow) return results;

    for (const [stepName, step] of Object.entries(doc.flow.definitions)) {
      // Check if step has a CALL without onFail handler
      if (step.call && !step.onFail) {
        results.push({
          ruleId: 'COV003',
          severity: 'warning',
          message: `Tool call "${step.call}" in step "${stepName}" lacks ON_FAIL handler`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: 'Add an ON_FAIL handler to gracefully handle tool errors',
        });
      }

      // Check tool calls within ON_INPUT branches
      if (step.onInput) {
        for (const branch of step.onInput) {
          if (branch.call) {
            // ON_INPUT branches with CALL don't have individual error handlers
            // This is a design limitation - warn about it
            results.push({
              ruleId: 'COV003',
              severity: 'info',
              message: `Tool call "${branch.call}" in ON_INPUT branch of step "${stepName}" has no error handling`,
              location: {
                documentId: doc.meta.id,
                documentName: doc.meta.name,
                elementName: stepName,
              },
              suggestion: 'Consider handling tool errors at the step level or in ON_ERROR handlers',
            });
          }
        }
      }
    }

    return results;
  },
};

/**
 * COV004: Infinite loop risk
 * Detects potential infinite loops in step transitions
 */
export const infiniteLoopRisk: AnalysisRule = {
  id: 'COV004',
  name: 'Infinite Loop Risk',
  description: 'Detects potential infinite loops in agent flows',
  severity: 'warning',
  category: 'coverage',

  checkAgent(doc: AgentDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Build transition graph
    const transitions = buildTransitionGraph(doc.flow);

    // Find cycles
    const cycles = findCycles(transitions);

    for (const cycle of cycles) {
      // Check if cycle has a way out (conditional or signal)
      if (!cycleHasExit(cycle, doc.flow)) {
        results.push({
          ruleId: 'COV004',
          severity: 'warning',
          message: `Potential infinite loop detected: ${cycle.join(' -> ')} -> ${cycle[0]}`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: cycle[0],
          },
          suggestion: 'Ensure the loop has an exit condition or maximum iteration limit',
        });
      }
    }

    return results;
  },

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.flow) return results;

    // Build transition graph for agent-based flow
    const transitions = buildTransitionGraphAgentBased(doc.flow);

    // Find cycles
    const cycles = findCycles(transitions);

    for (const cycle of cycles) {
      // Check if cycle has a way out (conditional branches)
      if (!cycleHasExitAgentBased(cycle, doc.flow)) {
        results.push({
          ruleId: 'COV004',
          severity: 'warning',
          message: `Potential infinite loop detected: ${cycle.join(' -> ')} -> ${cycle[0]}`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: cycle[0],
          },
          suggestion: 'Ensure the loop has an exit condition via ON_INPUT branches',
        });
      }
    }

    return results;
  },
};

/**
 * COV005: Missing signals
 * Detects flows that don't end with a signal
 */
export const missingSignals: AnalysisRule = {
  id: 'COV005',
  name: 'Missing Signals',
  description: 'Detects agent flows that lack terminal signals',
  severity: 'error',
  category: 'coverage',

  checkAgent(doc: AgentDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Find terminal steps (steps with no outgoing transitions)
    const transitions = buildTransitionGraph(doc.flow);
    const terminalSteps = doc.flow.steps.filter((step) => {
      const targets = transitions.get(step.name);
      return !targets || targets.length === 0;
    });

    for (const step of terminalSteps) {
      if (!hasSignalAction(step.action)) {
        results.push({
          ruleId: 'COV005',
          severity: 'error',
          message: `Terminal step "${step.name}" does not emit a signal`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementId: step.id,
            elementName: step.name,
          },
          suggestion: 'Add a SIGNAL action (CONTINUE, COMPLETE, HANDOFF_READY, or ESCALATE)',
        });
      }
    }

    return results;
  },

  checkAgentBased(doc: AgentBasedDocument, context: AnalysisContext): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    if (!doc.flow) return results;

    // Find terminal steps (steps that transition to COMPLETE or have no transitions)
    const transitions = buildTransitionGraphAgentBased(doc.flow);

    for (const [stepName, targets] of transitions) {
      // If step has no targets and no COMPLETE path, it might be problematic
      if (targets.length === 0) {
        results.push({
          ruleId: 'COV005',
          severity: 'error',
          message: `Step "${stepName}" has no defined transitions`,
          location: {
            documentId: doc.meta.id,
            documentName: doc.meta.name,
            elementName: stepName,
          },
          suggestion: 'Add a THEN clause or ON_INPUT branches to define transitions',
        });
      }
    }

    // Also check that at least one step leads to COMPLETE
    const allTargets = Array.from(transitions.values()).flat();
    const hasAnyCompletePath = allTargets.some((t) => t.toUpperCase() === 'COMPLETE');

    if (!hasAnyCompletePath && Object.keys(doc.flow.definitions).length > 0) {
      results.push({
        ruleId: 'COV005',
        severity: 'warning',
        message: 'Flow has no path to COMPLETE',
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
        },
        suggestion: 'Ensure at least one step has THEN: COMPLETE or leads to completion',
      });
    }

    return results;
  },
};

// Helper functions

function collectIntentsFromAction(action: StepAction, intents: Set<string>): void {
  if (action.kind === 'classify_intent') {
    for (const intent of Object.keys(action.intents)) {
      intents.add(intent);
    }
  } else if (action.kind === 'multi_step') {
    for (const subAction of action.steps) {
      collectIntentsFromAction(subAction, intents);
    }
  } else if (action.kind === 'condition') {
    collectIntentsFromAction(action.then, intents);
    if (action.else) {
      collectIntentsFromAction(action.else, intents);
    }
  }
}

function findReachableSteps(flow: Flow): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [flow.entryPoint];

  // Build step lookup
  const stepsByName = new Map(flow.steps.map((s) => [s.name, s]));
  const stepsById = new Map(flow.steps.map((s) => [String(s.number), s]));

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (reachable.has(current)) continue;
    reachable.add(current);

    const step = stepsByName.get(current) || stepsById.get(current);
    if (!step) continue;

    const targets = getActionTargets(step.action);
    for (const target of targets) {
      const targetStep = stepsByName.get(target) || stepsById.get(target);
      if (targetStep && !reachable.has(targetStep.name)) {
        queue.push(targetStep.name);
      }
    }
  }

  return reachable;
}

function getActionTargets(action: StepAction): string[] {
  const targets: string[] = [];

  switch (action.kind) {
    case 'call_tool':
      if (action.onSuccess) targets.push(action.onSuccess);
      if (action.onFailure) targets.push(action.onFailure);
      break;
    case 'wait_input':
      for (const target of Object.values(action.routes)) {
        targets.push(target);
      }
      if (action.onMaxExceeded) targets.push(action.onMaxExceeded);
      break;
    case 'goto':
      targets.push(action.target);
      break;
    case 'condition':
      targets.push(...getActionTargets(action.then));
      if (action.else) targets.push(...getActionTargets(action.else));
      break;
    case 'classify_intent':
      for (const target of Object.values(action.intents)) {
        targets.push(target);
      }
      if (action.default) targets.push(action.default);
      break;
    case 'multi_step':
      for (const subAction of action.steps) {
        targets.push(...getActionTargets(subAction));
      }
      break;
  }

  return targets;
}

function checkActionForErrorHandler(
  action: StepAction,
  step: Step,
  doc: AgentDocument,
  results: AnalysisResult[],
): void {
  if (action.kind === 'call_tool') {
    if (!action.onFailure) {
      results.push({
        ruleId: 'COV003',
        severity: 'warning',
        message: `Tool call "${action.tool}" in step "${step.name}" lacks ON_FAILURE handler`,
        location: {
          documentId: doc.meta.id,
          documentName: doc.meta.name,
          elementId: step.id,
          elementName: step.name,
        },
        suggestion: 'Add an ON_FAILURE handler to gracefully handle tool errors',
      });
    }
  } else if (action.kind === 'multi_step') {
    for (const subAction of action.steps) {
      checkActionForErrorHandler(subAction, step, doc, results);
    }
  }
}

function buildTransitionGraph(flow: Flow): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const step of flow.steps) {
    const targets = getActionTargets(step.action);
    graph.set(step.name, targets);
  }

  return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const path: string[] = [];
  const pathSet = new Set<string>();

  function dfs(node: string): void {
    if (pathSet.has(node)) {
      // Found a cycle
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart));
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    path.push(node);
    pathSet.add(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }

    path.pop();
    pathSet.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }

  return cycles;
}

function cycleHasExit(cycle: string[], flow: Flow): boolean {
  // Check if any step in the cycle has a conditional or leads to a signal
  const stepsByName = new Map(flow.steps.map((s) => [s.name, s]));

  for (const stepName of cycle) {
    const step = stepsByName.get(stepName);
    if (!step) continue;

    // Check for conditional actions
    if (step.action.kind === 'condition') {
      return true;
    }

    // Check for wait_input with max_attempts
    if (step.action.kind === 'wait_input' && step.action.maxAttempts) {
      return true;
    }

    // Check for classify_intent (could break the loop)
    if (step.action.kind === 'classify_intent') {
      return true;
    }
  }

  return false;
}

function hasSignalAction(action: StepAction): boolean {
  if (action.kind === 'signal') {
    return true;
  }

  if (action.kind === 'multi_step') {
    return action.steps.some(hasSignalAction);
  }

  if (action.kind === 'condition') {
    const thenHasSignal = hasSignalAction(action.then);
    const elseHasSignal = action.else ? hasSignalAction(action.else) : false;
    return thenHasSignal || elseHasSignal;
  }

  return false;
}

// =============================================================================
// AGENT-BASED FLOW HELPERS
// =============================================================================

/**
 * Find reachable steps in an AgentBasedDocument flow
 */
function findReachableStepsAgentBased(flow: FlowDefinition): Set<string> {
  const reachable = new Set<string>();
  const entryPoint = flow.steps[0]; // First step is entry point

  if (!entryPoint) return reachable;

  const queue: string[] = [entryPoint];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (reachable.has(current) || current.toUpperCase() === 'COMPLETE') continue;
    reachable.add(current);

    const step = flow.definitions[current];
    if (!step) continue;

    // Get all targets from this step
    const targets = getStepTargetsAgentBased(step);
    for (const target of targets) {
      if (!reachable.has(target) && target.toUpperCase() !== 'COMPLETE') {
        queue.push(target);
      }
    }
  }

  return reachable;
}

/**
 * Get all target steps from an AgentBasedDocument flow step
 */
function getStepTargetsAgentBased(step: FlowStep): string[] {
  const targets: string[] = [];

  // Direct THEN transition
  if (step.then) {
    targets.push(step.then);
  }

  // ON_FAIL transition
  if (step.onFail) {
    targets.push(step.onFail);
  }

  // ON_INPUT branches
  if (step.onInput) {
    for (const branch of step.onInput) {
      if (branch.then) {
        targets.push(branch.then);
      }
    }
  }

  return targets;
}

/**
 * Build transition graph for AgentBasedDocument flow
 */
function buildTransitionGraphAgentBased(flow: FlowDefinition): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const [stepName, step] of Object.entries(flow.definitions)) {
    const targets = getStepTargetsAgentBased(step);
    graph.set(
      stepName,
      targets.filter((t) => t.toUpperCase() !== 'COMPLETE'),
    );
  }

  return graph;
}

/**
 * Check if a cycle has an exit in AgentBasedDocument flow
 */
function cycleHasExitAgentBased(cycle: string[], flow: FlowDefinition): boolean {
  for (const stepName of cycle) {
    const step = flow.definitions[stepName];
    if (!step) continue;

    // If step has ON_INPUT with multiple branches, it has conditional exits
    if (step.onInput && step.onInput.length > 1) {
      // Check if any branch leads outside the cycle
      for (const branch of step.onInput) {
        if (
          branch.then &&
          (branch.then.toUpperCase() === 'COMPLETE' || !cycle.includes(branch.then))
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Export all coverage rules
 */
export const coverageRules: AnalysisRule[] = [
  unhandledIntents,
  deadSteps,
  missingErrorHandlers,
  infiniteLoopRisk,
  missingSignals,
];
