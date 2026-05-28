/**
 * Static Graph Extractor
 *
 * Extracts a static execution graph from FlowConfig for state machine visualization.
 * This graph shows all possible execution paths before execution begins.
 */

import type {
  FlowConfig,
  FlowStep,
  StaticGraph,
  StaticGraphNode,
  StaticGraphEdge,
  StaticNodeType,
  StaticEdgeType,
  Digression,
  ConstraintConfig,
} from './schema.js';

function getDigressionActions(
  digression: Pick<
    Digression,
    'do' | 'respond' | 'clear' | 'call' | 'delegate' | 'goto' | 'resume'
  >,
): Array<{ delegate?: string; goto?: string; resume?: boolean }> {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  const actions: Array<{ delegate?: string; goto?: string; resume?: boolean }> = [];
  if (digression.respond !== undefined) actions.push({});
  if (digression.clear?.length) actions.push({});
  if (digression.call) actions.push({});
  if (digression.delegate) actions.push({ delegate: digression.delegate });
  if (digression.goto) actions.push({ goto: digression.goto, resume: digression.resume });
  else if (digression.resume) actions.push({ resume: digression.resume });
  return actions;
}

/**
 * Extract a static graph from a FlowConfig for visualization
 * @param flowConfig The flow configuration
 * @param constraintConfig Optional constraint configuration (unused after phase removal, kept for API compat)
 */
export function extractStaticGraph(
  flowConfig: FlowConfig,
  constraintConfig?: ConstraintConfig,
): StaticGraph {
  const nodes: StaticGraphNode[] = [];
  const edges: StaticGraphEdge[] = [];
  const nodeIds = new Set<string>();

  // Helper to add node only if not already present
  const addNode = (node: StaticGraphNode) => {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  };

  // Helper to add edge
  const addEdge = (edge: StaticGraphEdge) => {
    edges.push(edge);
  };

  // Helper to sanitize ID (remove special characters that could cause issues)
  const sanitizeId = (id: string): string => {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_');
  };

  // 1. Add entry node
  addNode({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  // Determine entry step with bounds check
  const entryStep =
    flowConfig.entry_point ||
    (flowConfig.steps && flowConfig.steps.length > 0 ? flowConfig.steps[0] : undefined);

  // Add edge from entry to first step
  if (entryStep) {
    addEdge({
      id: `__entry__->${sanitizeId(entryStep)}`,
      from: '__entry__',
      to: entryStep,
      type: 'sequential',
    });
  }

  // 2. Process each step
  for (const stepName of flowConfig.steps) {
    const step = flowConfig.definitions[stepName];
    if (!step) continue;

    // Add step node
    addNode({
      id: stepName,
      type: 'step',
      label: stepName,
      deterministic: true,
      step: {
        call: step.call,
        respond: step.respond,
        check: step.check,
      },
    });

    // Extract edges based on routing
    extractStepEdges(stepName, step, addNode, addEdge, flowConfig);
  }

  // 3. Process global digressions
  if (flowConfig.global_digressions) {
    for (const digression of flowConfig.global_digressions) {
      processDigression(digression, '__global__', addNode, addEdge);
    }
  }

  // 4. Add exit node for steps that complete the flow
  const hasExitConditions = flowConfig.steps.some((stepName) => {
    const step = flowConfig.definitions[stepName];
    return step && !step.then && !step.on_input?.length && !step.on_success && !step.on_failure;
  });

  if (hasExitConditions) {
    addNode({
      id: '__exit__',
      type: 'exit',
      label: 'End',
      deterministic: true,
    });

    // Connect terminal steps to exit
    for (const stepName of flowConfig.steps) {
      const step = flowConfig.definitions[stepName];
      if (step && isTerminalStep(step)) {
        addEdge({
          id: `${stepName}->__exit__`,
          from: stepName,
          to: '__exit__',
          type: 'sequential',
          label: 'complete',
        });
      }
    }
  }

  return {
    nodes,
    edges,
    entryPoint: entryStep || '__entry__',
  };
}

/**
 * Check if a step is terminal (no outgoing transitions)
 */
function isTerminalStep(step: FlowStep): boolean {
  return !step.then && !step.on_input?.length && !step.on_success?.then && !step.on_failure?.then;
}

/**
 * Extract edges from a flow step
 */
function extractStepEdges(
  stepName: string,
  step: FlowStep,
  addNode: (node: StaticGraphNode) => void,
  addEdge: (edge: StaticGraphEdge) => void,
  flowConfig: FlowConfig,
): void {
  // No guard nodes — CHECK evaluates inline conditions, not constraint phases
  const sourceNode = stepName;

  // Handle ON_INPUT (creates decision node + conditional edges)
  if (step.on_input?.length) {
    const decisionId = `${stepName}__decision`;

    // Add decision node
    addNode({
      id: decisionId,
      type: 'decision',
      label: 'ON_INPUT',
      deterministic: true,
      conditions: step.on_input.map((b) => b.condition || 'ELSE'),
    });

    // Edge from step to decision
    addEdge({
      id: `${sourceNode}->${decisionId}`,
      from: sourceNode,
      to: decisionId,
      type: 'sequential',
    });

    // Edges from decision to branch targets
    for (const branch of step.on_input) {
      // Ensure target step node exists
      if (branch.then && flowConfig.definitions[branch.then]) {
        const targetStep = flowConfig.definitions[branch.then];
        addNode({
          id: branch.then,
          type: 'step',
          label: branch.then,
          deterministic: true,
          step: {
            call: targetStep.call,
            respond: targetStep.respond,
            check: targetStep.check,
          },
        });
      }

      addEdge({
        id: `${decisionId}->${branch.then}`,
        from: decisionId,
        to: branch.then,
        type: 'conditional',
        label: branch.condition || 'ELSE',
        isDefault: !branch.condition,
      });
    }
  }
  // Handle simple THEN
  else if (step.then) {
    addEdge({
      id: `${sourceNode}->${step.then}`,
      from: sourceNode,
      to: step.then,
      type: 'sequential',
    });
  }

  // Handle ON_SUCCESS/ON_FAILURE (for CALL steps)
  if (step.on_success?.then) {
    addEdge({
      id: `${stepName}->success->${step.on_success.then}`,
      from: stepName,
      to: step.on_success.then,
      type: 'success',
      label: 'success',
    });
  }

  if (step.on_failure?.then) {
    addEdge({
      id: `${stepName}->failure->${step.on_failure.then}`,
      from: stepName,
      to: step.on_failure.then,
      type: 'failure',
      label: 'failure',
    });
  }

  // Handle ON_FAIL (simple error handling)
  if (step.on_fail) {
    addEdge({
      id: `${stepName}->error->${step.on_fail}`,
      from: stepName,
      to: step.on_fail,
      type: 'error',
      label: 'error',
    });
  }

  // Handle step-level digressions
  if (step.digressions) {
    for (const digression of step.digressions) {
      processDigression(digression, stepName, addNode, addEdge);
    }
  }
}

/**
 * Sanitize a string for use as a graph node ID
 */
function sanitizeNodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Process a digression and add corresponding nodes/edges
 */
function processDigression(
  digression: Digression,
  sourceStep: string,
  addNode: (node: StaticGraphNode) => void,
  addEdge: (edge: StaticGraphEdge) => void,
): void {
  // Sanitize intent name to create valid node ID
  const sanitizedIntent = sanitizeNodeId(digression.intent);

  // Create an LLM decision node for intent-based routing
  const intentNodeId = `${sourceStep}__intent_${sanitizedIntent}`;

  addNode({
    id: intentNodeId,
    type: 'llm_decision',
    label: `Intent: ${digression.intent}`,
    deterministic: false, // Intent classification is non-deterministic
    conditions: [digression.intent],
  });

  // Edge from source to intent handler
  addEdge({
    id: `${sourceStep}->intent->${sanitizedIntent}`,
    from: sourceStep === '__global__' ? '__entry__' : sourceStep,
    to: intentNodeId,
    type: 'digression',
    label: digression.intent,
  });

  // Edge from intent handler to target
  const actions = getDigressionActions(digression);
  for (const action of actions) {
    if (action.goto) {
      addEdge({
        id: `${intentNodeId}->${sanitizeNodeId(action.goto)}`,
        from: intentNodeId,
        to: action.goto,
        type: 'sequential',
        label: action.resume ? 'with resume' : undefined,
      });
    }

    if (action.delegate) {
      const sanitizedDelegate = sanitizeNodeId(action.delegate);
      const delegateNodeId = `${intentNodeId}__delegate_${sanitizedDelegate}`;
      addNode({
        id: delegateNodeId,
        type: 'step',
        label: `Delegate: ${action.delegate}`,
        deterministic: true,
      });

      addEdge({
        id: `${intentNodeId}->delegate->${sanitizedDelegate}`,
        from: intentNodeId,
        to: delegateNodeId,
        type: 'sequential',
        label: 'delegate',
      });
    }
  }
}

export default extractStaticGraph;
