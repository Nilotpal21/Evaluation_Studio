/**
 * Canvas-to-Steps Converter
 *
 * Converts the canvas graph format (nodes + edges) stored by the Studio
 * into the linear WorkflowStep[] format expected by the workflow handler.
 *
 * Canvas format:
 *   nodes: [{ id, nodeType, name, config, position }]
 *   edges: [{ id, source, sourceHandle, target }]
 *
 * Engine format:
 *   steps: [{ id, type, ...config fields }]
 *   - Condition steps need thenSteps/elseSteps derived from edges
 *   - Steps are topologically ordered (start → ... → end)
 *
 * Timeout contract:
 *   Studio stores `config.timeout` for http / agent_invocation / tool_call /
 *   connector_action / async_webhook nodes as a plain integer in SECONDS
 *   (the input is labeled "Timeout (seconds)" in every node-config dialog —
 *   see apps/studio/src/components/workflows/canvas/config/*NodeConfig.tsx).
 *   The engine's StepDispatchResult and step-executor types expect MILLISECONDS,
 *   so this converter multiplies by 1000 at the boundary. The `function` step
 *   keeps `config.timeout` in seconds because function-executor consumes it
 *   that way. Human-task timeout uses a richer `{duration, unit}` shape and is
 *   normalized to ms inside its own case below.
 *
 *   Do NOT change this contract without updating the corresponding Studio UI
 *   labels and shipping a migration for every persisted Workflow + WorkflowVersion
 *   document. The conversion lock is enforced by canvas-to-steps.test.ts:
 *     function 10 → 10, agent 5 → 5000, tool_call 12 → 12000,
 *     http 5 → 5000, connector_action 2 → 2000.
 */

import type { WorkflowStep } from './step-dispatcher.js';
import type { HumanTaskFieldDef } from '../executors/human-task-executor.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CALLBACK_TIMEOUT_MS,
} from '../constants.js';

/** Canvas node as stored in MongoDB */
interface CanvasNode {
  id: string;
  nodeType: string;
  name: string;
  parentId?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

/** Canvas edge as stored in MongoDB */
interface CanvasEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  label?: string;
}

/** Map canvas nodeType → engine step type */
const NODE_TYPE_TO_STEP_TYPE: Record<string, string> = {
  api: 'http',
  condition: 'condition',
  delay: 'delay',
  loop: 'loop',
  function: 'function',
  integration: 'connector_action',
  human: 'human_task',
  data_entry: 'human_task',
  agentic_app: 'agent_invocation',
  agent: 'agent_invocation',
  tool: 'tool_call',
  text_to_text: 'agent_invocation',
  text_to_image: 'agent_invocation',
  audio_to_text: 'agent_invocation',
  image_to_text: 'agent_invocation',
};

/** Output variable mapping defined on the end node */
export interface OutputMapping {
  name: string;
  expression: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
}

export type OutputMappingsByEndNodeId = Record<string, OutputMapping[]>;

/**
 * Engine-consumed projection of the canvas start-node input variable.
 *
 * The canonical canvas shape (Zod `StartNodeConfigSchema` at
 * `packages/shared/src/types/workflow-schemas.ts:41-53`) additionally carries
 * `defaultValue?: unknown` and `description?: string`. Those are Studio/UI
 * metadata and are intentionally NOT projected into the engine — the engine
 * only needs `{ name, type, required }` for validation and coercion. See
 * LLD D-12 and D-13 for rationale.
 */
export interface StartInputVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
}

/** Single outgoing edge descriptor stored in the edgeMap */
export interface EdgeDescriptor {
  edgeId: string;
  sourceHandle?: string;
  target: string;
  /** Canvas source node type. Used for synthetic markers like loop_start. */
  sourceNodeType?: string;
  /** Runtime step ID used for path-state lookup when it differs from the canvas source ID. */
  sourceRuntimeId?: string;
  /** Runtime step ID used for path-state lookup when it differs from the canvas target ID. */
  targetRuntimeId?: string;
  /** Set for loop body edges — equals the loop container node ID. Absent for outer edges. */
  loopId?: string;
}

/** Result of canvas conversion including steps, name map, and output config */
export interface CanvasConversionResult {
  steps: WorkflowStep[];
  /** Map from node name → node ID (UUID) for name-based step references */
  nameToIdMap: Record<string, string>;
  /** Output mappings from the end node (if configured) */
  outputMappings: OutputMapping[];
  /** Output mappings grouped by source top-level end node ID. */
  outputMappingsByEndNodeId: OutputMappingsByEndNodeId;
  /** Input variables from the start node config */
  startInputVariables: StartInputVariable[];
  /** Count of incoming on_success edges per node ID.
   *  Used by the DAG executor for barrier counting. Empty object for empty graphs. */
  inDegreeMap: Record<string, number>;
  /**
   * Outgoing edge descriptors keyed by source nodeId.
   * Targets pointing to loop_start are normalised to the loop container.
   * Used by the workflow handler to compute per-event edge pathState.
   */
  edgeMap: Record<string, EdgeDescriptor[]>;
}

/**
 * Convert canvas graph format to engine step array.
 *
 * Skips start/end nodes (they are control flow markers, not executable steps).
 * Topologically orders steps by walking from the start node via edges.
 */
export function convertCanvasToSteps(nodes: CanvasNode[], edges: CanvasEdge[]): WorkflowStep[];
export function convertCanvasToSteps(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  opts: { full: true },
): CanvasConversionResult;
export function convertCanvasToSteps(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  opts?: { full: true },
): WorkflowStep[] | CanvasConversionResult {
  const result = convertCanvasToStepsInternal(nodes, edges);
  if (opts?.full) return result;
  return result.steps;
}

/**
 * Convert a WorkflowVersion document (or any object with a `definition.nodes` /
 * `definition.edges` shape) into the full `CanvasConversionResult`.
 *
 * Centralizes the type-assertion + nullish-coalescing boilerplate that was
 * copy-pasted across trigger-engine, trigger-scheduler, and the execute route
 * every time a version doc was unpacked. Callers that previously wrote:
 *
 *   const def = (versionDoc.definition ?? {}) as Record<string, unknown>;
 *   const conversion = convertCanvasToSteps(
 *     (def.nodes ?? []) as CanvasNode[],
 *     (def.edges ?? []) as CanvasEdge[],
 *     { full: true },
 *   );
 *
 * collapse to a single call. Also hardens the missing-nameToIdMap drift: the
 * returned object always has concrete (possibly empty) arrays/maps, so
 * downstream `?? {}` fallbacks become unnecessary.
 */
export function convertVersionDocToSteps(
  versionDoc: { definition?: unknown } | null | undefined,
): CanvasConversionResult {
  if (!versionDoc) return EMPTY_RESULT;
  const definition = (versionDoc.definition ?? {}) as {
    nodes?: unknown;
    edges?: unknown;
  };
  return convertRawCanvas(definition.nodes, definition.edges);
}

/**
 * Convert a Workflow document (with top-level `nodes`/`edges` — the legacy
 * working-copy shape) into the full `CanvasConversionResult`. Separate from
 * `convertVersionDocToSteps` because the two shapes are distinct: version docs
 * wrap the canvas inside `definition`, workflow docs expose it directly.
 */
export function convertWorkflowDocToSteps(
  workflowDoc: { nodes?: unknown; edges?: unknown } | null | undefined,
): CanvasConversionResult {
  if (!workflowDoc) return EMPTY_RESULT;
  return convertRawCanvas(workflowDoc.nodes, workflowDoc.edges);
}

function convertRawCanvas(rawNodes: unknown, rawEdges: unknown): CanvasConversionResult {
  const nodes = Array.isArray(rawNodes) ? (rawNodes as CanvasNode[]) : [];
  const edges = Array.isArray(rawEdges) ? (rawEdges as CanvasEdge[]) : [];
  return convertCanvasToStepsInternal(nodes, edges);
}

const EMPTY_RESULT: CanvasConversionResult = {
  steps: [],
  nameToIdMap: {},
  outputMappings: [],
  outputMappingsByEndNodeId: {},
  startInputVariables: [],
  inDegreeMap: {},
  edgeMap: {},
};

function extractOutputMappingsFromConfig(config?: Record<string, unknown>): OutputMapping[] {
  if (config?.outputMappings && Array.isArray(config.outputMappings)) {
    return config.outputMappings as OutputMapping[];
  }

  if (config?.outputMapping && typeof config.outputMapping === 'object') {
    const mapping = config.outputMapping as Record<string, unknown>;
    return Object.entries(mapping)
      .filter(([name]) => name.length > 0)
      .map(([name, raw]) => {
        if (typeof raw === 'string') {
          return { name, expression: raw };
        }
        if (
          raw &&
          typeof raw === 'object' &&
          typeof (raw as { expression?: unknown }).expression === 'string'
        ) {
          const typedRaw = raw as {
            expression: string;
            type?: unknown;
            description?: unknown;
          };
          return {
            name,
            expression: typedRaw.expression,
            ...(typeof typedRaw.type === 'string' ? { type: typedRaw.type } : {}),
            ...(typeof typedRaw.description === 'string'
              ? { description: typedRaw.description }
              : {}),
          } as OutputMapping;
        }
        // Unknown shape — emit an empty expression so the mapping still
        // appears in the IR and surfaces as an invalid binding downstream
        // rather than silently disappearing.
        return { name, expression: '' };
      });
  }

  return [];
}

function extractOutputMappingsFromEndNodes(endNodes: CanvasNode[]): {
  outputMappings: OutputMapping[];
  outputMappingsByEndNodeId: OutputMappingsByEndNodeId;
} {
  const outputMappingsByEndNodeId: OutputMappingsByEndNodeId = {};
  const outputMappings: OutputMapping[] = [];

  for (const endNode of endNodes) {
    const mappings = extractOutputMappingsFromConfig(endNode.config);
    if (mappings.length === 0) continue;
    outputMappingsByEndNodeId[endNode.id] = mappings;
    outputMappings.push(...mappings);
  }

  return { outputMappings, outputMappingsByEndNodeId };
}

function extractLoopBodyOutputMappings(loopNode?: CanvasNode): OutputMapping[] {
  return extractOutputMappingsFromConfig({
    outputMappings: loopNode?.config?.bodyOutputMappings,
    outputMapping: loopNode?.config?.bodyOutputMapping,
  });
}

function convertCanvasToStepsInternal(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasConversionResult {
  if (!Array.isArray(nodes) || nodes.length === 0) return EMPTY_RESULT;

  // Node lookup
  const nodeMap = new Map<string, CanvasNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Build edge lookup: source → [{ edgeId, sourceHandle, target }]
  const outEdges = new Map<
    string,
    Array<{
      edgeId: string;
      sourceHandle?: string;
      target: string;
      sourceRuntimeId?: string;
      targetRuntimeId?: string;
    }>
  >();
  const endNodeIds = new Set(
    nodes.filter((node) => node.nodeType === 'end').map((node) => node.id),
  );
  for (const edge of edges) {
    const list = outEdges.get(edge.source) || [];
    const sourceNode = nodeMap.get(edge.source);
    list.push({
      edgeId: edge.id,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      ...(sourceNode?.nodeType ? { sourceNodeType: sourceNode.nodeType } : {}),
      ...(sourceNode?.nodeType === 'start' ? { sourceRuntimeId: 'start' } : {}),
      ...(endNodeIds.has(edge.target) ? { targetRuntimeId: 'end' } : {}),
    });
    outEdges.set(edge.source, list);
  }

  // Find start node
  const startNode = nodes.find((n) => n.nodeType === 'start');
  if (!startNode) return EMPTY_RESULT;

  // Normalize outer → loop_start edges: redirect them to the loop container.
  // The canvas allows outer nodes to connect to the loop_start circle (visual
  // entry socket), but the topological walk and step routing need to reference
  // the loop container node, not the loop_start child.
  for (const targets of outEdges.values()) {
    for (const t of targets) {
      const targetNode = nodeMap.get(t.target);
      if (targetNode?.nodeType === 'loop_start' && targetNode.parentId) {
        t.target = targetNode.parentId;
      }
    }
  }

  // Topological walk from start node
  const visited = new Set<string>();
  const orderedSteps: WorkflowStep[] = [];
  const queue: string[] = [startNode.id];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    // Skip start and end nodes — they are not executable steps
    if (node.nodeType === 'start' || node.nodeType === 'end') {
      // Still follow their edges to discover next nodes
      const targets = outEdges.get(nodeId) || [];
      for (const t of targets) {
        if (!visited.has(t.target)) queue.push(t.target);
      }
      continue;
    }

    const stepType = NODE_TYPE_TO_STEP_TYPE[node.nodeType];
    if (!stepType) {
      // Unknown node type, skip
      const targets = outEdges.get(nodeId) || [];
      for (const t of targets) {
        if (!visited.has(t.target)) queue.push(t.target);
      }
      continue;
    }

    const step = convertNodeToStep(node, stepType, outEdges);
    if (step) {
      // Attach canvas node name for display in execution records
      step.name = node.name;

      // Attach success/failure/reject routing from canvas edges.
      // The handler uses these to determine next steps per outcome.
      if (stepType !== 'condition') {
        const targets = outEdges.get(node.id) || [];
        const successTargets: string[] = [];
        const failureTargets: string[] = [];
        const rejectTargets: string[] = [];
        for (const t of targets) {
          if (t.sourceHandle === 'on_reject' || t.sourceHandle === 'on_decline') {
            rejectTargets.push(t.target);
          } else if (t.sourceHandle === 'on_failure' || t.sourceHandle === 'on_timeout') {
            failureTargets.push(t.target);
          } else {
            successTargets.push(t.target);
          }
        }
        // Attach success routing when targets exist. Omitting onSuccessSteps
        // lets the handler treat this as a terminal step (natural completion).
        if (successTargets.length > 0) {
          step.onSuccessSteps = successTargets;
        }
        if (failureTargets.length > 0) {
          step.onFailureSteps = failureTargets;
        }
        if (rejectTargets.length > 0) {
          step.onRejectSteps = rejectTargets;
        }
      }

      // Mark as canvas-routed and attach required-predecessor config.
      step.canvasRouted = true;
      if (Array.isArray(node.config?.requiredPredecessors)) {
        step.requiredPredecessors = node.config.requiredPredecessors as string[];
      }

      orderedSteps.push(step);
    }

    // Follow edges to next nodes
    const targets = outEdges.get(nodeId) || [];
    for (const t of targets) {
      if (!visited.has(t.target)) queue.push(t.target);
    }
  }

  // ── Build loop body steps ──────────────────────────────────────────────────
  // Loop body nodes (parentId pointing to a loop container) are not reachable
  // from the main topological walk because no outer edge leads to them.
  // For each loop step, walk from the loop_start child via the loop_body handle
  // to collect body steps, add them to orderedSteps (for stepIndex lookup),
  // and populate config.body so the dispatcher executes them per iteration.
  const loopBodyStepIds = new Set<string>();

  for (const step of [...orderedSteps]) {
    if (step.type !== 'loop') continue;

    // Find the loop_start child and gather loop_end child IDs
    const loopStartNode = nodes.filter(
      (n) => n.parentId === step.id && n.nodeType === 'loop_start',
    )[0];
    if (!loopStartNode) continue;
    const loopEndNodeIds = new Set(
      nodes.filter((n) => n.parentId === step.id && n.nodeType === 'loop_end').map((n) => n.id),
    );

    // Body root steps are reached via the loop_body handle from loop_start.
    // Multiple edges are valid here: they represent parallel branches inside the loop body.
    const loopStartEdges = outEdges.get(loopStartNode.id) ?? [];
    const firstBodyEdges = loopStartEdges.filter((e) => e.sourceHandle === 'loop_body');
    const bodyRootEdges = firstBodyEdges.length > 0 ? firstBodyEdges : loopStartEdges;
    if (bodyRootEdges.length === 0) continue;

    // Walk body nodes topologically from all body roots.
    const bodyIds: string[] = [];
    const bodyQueue: string[] = bodyRootEdges.map((edge) => edge.target);
    const bodyVisited = new Set<string>();
    const bodyOutputMappings: OutputMapping[] = extractLoopBodyOutputMappings(nodeMap.get(step.id));

    while (bodyQueue.length > 0) {
      const bid = bodyQueue.shift()!;
      if (bodyVisited.has(bid)) continue;
      bodyVisited.add(bid);

      const bNode = nodeMap.get(bid);
      if (!bNode) continue;

      // Strip edges targeting the loop container (legacy loop_body_end) or a loop_end
      // child node — both are terminal signals and must not bleed into routing.
      const loopContainerId = step.id;
      const bodyOutEdges = (outEdges.get(bid) ?? []).filter(
        (t) => t.target !== loopContainerId && !loopEndNodeIds.has(t.target),
      );

      // Skip control-flow markers that are not executable steps
      if (
        bNode.nodeType === 'start' ||
        bNode.nodeType === 'end' ||
        bNode.nodeType === 'loop_start' ||
        bNode.nodeType === 'loop_end' ||
        bNode.nodeType === 'loop'
      ) {
        for (const t of bodyOutEdges) {
          if (!bodyVisited.has(t.target)) bodyQueue.push(t.target);
        }
        continue;
      }

      const bStepType = NODE_TYPE_TO_STEP_TYPE[bNode.nodeType];
      if (!bStepType) {
        for (const t of bodyOutEdges) {
          if (!bodyVisited.has(t.target)) bodyQueue.push(t.target);
        }
        continue;
      }

      const bStep = convertNodeToStep(bNode, bStepType, outEdges);
      if (!bStep) {
        for (const t of bodyOutEdges) {
          if (!bodyVisited.has(t.target)) bodyQueue.push(t.target);
        }
        continue;
      }

      bStep.name = bNode.name;

      // Attach canvas routing (mirrors the main walk logic for non-condition steps).
      // Uses bodyOutEdges so loop_body_end connections are excluded from routing.
      if (bStepType !== 'condition') {
        const bSuccess: string[] = [];
        const bFailure: string[] = [];
        const bReject: string[] = [];
        for (const t of bodyOutEdges) {
          if (t.sourceHandle === 'on_reject' || t.sourceHandle === 'on_decline') {
            bReject.push(t.target);
          } else if (t.sourceHandle === 'on_failure' || t.sourceHandle === 'on_timeout') {
            bFailure.push(t.target);
          } else {
            bSuccess.push(t.target);
          }
        }
        if (bSuccess.length > 0) bStep.onSuccessSteps = bSuccess;
        if (bFailure.length > 0) bStep.onFailureSteps = bFailure;
        if (bReject.length > 0) (bStep as { onRejectSteps?: string[] }).onRejectSteps = bReject;
      }

      bStep.canvasRouted = true;
      if (Array.isArray(bNode.config?.requiredPredecessors)) {
        bStep.requiredPredecessors = bNode.config.requiredPredecessors as string[];
      }

      bodyIds.push(bNode.id);
      loopBodyStepIds.add(bNode.id);
      orderedSteps.push(bStep);

      for (const t of bodyOutEdges) {
        if (!bodyVisited.has(t.target)) bodyQueue.push(t.target);
      }
    }

    // Compute bodyInDegreeMap for fan-in support (branching + merging inside loop body).
    // Only counts edges between body steps — outer/end-node targets are excluded.
    const bodyStepIdSet = new Set(bodyIds);
    const bodyInDegreeMap: Record<string, number> = {};
    for (const bid of bodyIds) {
      if (!(bid in bodyInDegreeMap)) bodyInDegreeMap[bid] = 0;
      const bStep = orderedSteps.find((s) => s.id === bid);
      if (!bStep) continue;
      for (const targetId of getAllStepSuccessorIds(bStep)) {
        if (!bodyStepIdSet.has(targetId)) continue;
        bodyInDegreeMap[targetId] = (bodyInDegreeMap[targetId] ?? 0) + 1;
      }
    }

    // Attach the ordered body step IDs and fan-in map to the loop step config
    (
      step as unknown as { config: { body?: string[]; bodyInDegreeMap?: Record<string, number> } }
    ).config.body = bodyIds;
    (
      step as unknown as { config: { body?: string[]; bodyInDegreeMap?: Record<string, number> } }
    ).config.bodyInDegreeMap = bodyInDegreeMap;
    if (bodyOutputMappings.length > 0) {
      (
        step as unknown as {
          config: {
            bodyOutputMappings?: OutputMapping[];
          };
        }
      ).config.bodyOutputMappings = bodyOutputMappings;
    }
  }

  // Post-process: filter all step ID references to only include IDs that
  // exist as executable steps. Edges may reference start/end nodes which
  // are not in the step array — the handler would throw on unknown IDs.
  const stepIds = new Set(orderedSteps.map((s) => s.id));
  // Keep IDs that are executable steps OR end nodes. The handler skips
  // unknown step IDs (including end nodes) gracefully, so keeping end
  // node IDs prevents branches pointing to End from being treated as
  // "no path defined".
  const keepId = (id: string) => stepIds.has(id) || endNodeIds.has(id);
  for (const step of orderedSteps) {
    if (step.type === 'condition') {
      const condStep = step as {
        thenSteps?: string[];
        elseSteps?: string[];
        conditions?: Array<{ targetSteps: string[] }>;
      };
      if (condStep.thenSteps) {
        condStep.thenSteps = condStep.thenSteps.filter(keepId);
      }
      if (condStep.elseSteps) {
        condStep.elseSteps = condStep.elseSteps.filter(keepId);
      }
      if (condStep.conditions) {
        for (const branch of condStep.conditions) {
          branch.targetSteps = branch.targetSteps.filter(keepId);
        }
      }
    }
    // Filter onSuccessSteps/onFailureSteps/onRejectSteps — keep IDs that are
    // executable steps OR end nodes. The handler skips unknown step IDs
    // (including end nodes) gracefully at line ~640, so keeping end node IDs
    // ensures the queue is cleared and the workflow terminates correctly.
    // Previously, deleting these arrays when they pointed to End caused the
    // handler to fall through without clearing the queue, executing unrelated
    // steps that remained in the queue.
    if (step.onSuccessSteps) {
      step.onSuccessSteps = step.onSuccessSteps.filter(keepId);
    }
    if (step.onFailureSteps) {
      step.onFailureSteps = step.onFailureSteps.filter(keepId);
    }
    if (step.onRejectSteps) {
      step.onRejectSteps = step.onRejectSteps.filter(keepId);
    }
  }

  // Build name → ID map for all nodes (including start/end for reference)
  const nameToIdMap: Record<string, string> = {};
  for (const node of nodes) {
    if (node.name) {
      nameToIdMap[node.name] = node.id;
    }
  }

  // Extract output mappings from every top-level end node config.
  //
  // Supported shapes (in priority order):
  //   1. `outputMappings: [{name, expression}]` — legacy array form
  //   2. `outputMapping: { fieldName: 'expression' }` — original Studio shape
  //   3. `outputMapping: { fieldName: { expression, type?, description? } }`
  //      — enriched Studio shape introduced when design-time schema derivation
  //      was added. Types/descriptions are design-time metadata only; the IR
  //      keeps the flat {name, expression} pair so the execution path is
  //      unchanged.
  const topLevelEndNodes = nodes.filter((n) => n.nodeType === 'end' && !n.parentId);
  const endNodes =
    topLevelEndNodes.length > 0 ? topLevelEndNodes : nodes.filter((n) => n.nodeType === 'end');
  const { outputMappings, outputMappingsByEndNodeId } = extractOutputMappingsFromEndNodes(endNodes);

  // Extract start node input variable definitions
  const startInputVariables = (startNode.config?.inputVariables as StartInputVariable[]) ?? [];

  // Compute inDegreeMap: count ALL incoming edges per node ID (success, failure,
  // reject, and condition branches). Counting only onSuccessSteps caused on_reject /
  // on_failure targets to get in-degree 0, making them fire as phantom root steps.
  function getAllStepSuccessorIds(step: WorkflowStep): string[] {
    const all = new Set<string>();
    for (const id of step.onSuccessSteps ?? []) all.add(id);
    for (const id of step.onFailureSteps ?? []) all.add(id);
    for (const id of (step as { onRejectSteps?: string[] }).onRejectSteps ?? []) all.add(id);
    // Condition steps store outgoing edges in conditions[].targetSteps (and legacy thenSteps/elseSteps)
    const cs = step as {
      thenSteps?: string[];
      elseSteps?: string[];
      conditions?: Array<{ targetSteps?: string[] }>;
    };
    for (const t of cs.thenSteps ?? []) all.add(t);
    for (const t of cs.elseSteps ?? []) all.add(t);
    for (const branch of cs.conditions ?? []) {
      for (const t of branch.targetSteps ?? []) all.add(t);
    }
    return [...all];
  }

  // Loop body steps are executed via executeStepChain inside the loop iteration,
  // not by the DAG executor. Exclude them from inDegreeMap so they are not
  // treated as DAG root nodes and don't corrupt barrier counts for outer steps.
  const inDegreeMap: Record<string, number> = {};
  for (const step of orderedSteps) {
    if (loopBodyStepIds.has(step.id)) continue;
    if (!(step.id in inDegreeMap)) inDegreeMap[step.id] = 0;
    for (const targetId of getAllStepSuccessorIds(step)) {
      if (loopBodyStepIds.has(targetId)) continue;
      inDegreeMap[targetId] = (inDegreeMap[targetId] ?? 0) + 1;
    }
  }

  // Execution-time cycle detection (FR-9 layer 3 defense-in-depth via Kahn's algorithm).
  // Builds a working in-degree copy and peels off zero-in-degree nodes. If any remain,
  // a cycle exists. Uses the same getAllStepSuccessorIds helper so condition branches
  // are included in the adjacency list.
  // Loop body steps are excluded (they are not DAG nodes).
  const workingInDegree = { ...inDegreeMap };
  const topoQueue: string[] = Object.keys(workingInDegree).filter(
    (id) => workingInDegree[id] === 0,
  );
  let processed = 0;
  while (topoQueue.length > 0) {
    const id = topoQueue.shift()!;
    processed++;
    const step = orderedSteps.find((s) => s.id === id);
    if (!step) continue;
    for (const sucId of getAllStepSuccessorIds(step)) {
      if (loopBodyStepIds.has(sucId)) continue;
      workingInDegree[sucId] = (workingInDegree[sucId] ?? 1) - 1;
      if (workingInDegree[sucId] === 0) topoQueue.push(sucId);
    }
  }
  const outerStepCount = orderedSteps.filter((s) => !loopBodyStepIds.has(s.id)).length;
  if (processed < outerStepCount) {
    throw new Error('Workflow graph contains a cycle');
  }

  // Serialise the Map to a plain Record so it survives JSON round-trips (Restate payload).
  // Body edges (source has parentId) are tagged with loopId so the handler can compute
  // per-iteration body edge pathState without mixing them into the outer pathState.
  const edgeMap: Record<string, EdgeDescriptor[]> = {};
  for (const [nodeId, edges] of outEdges) {
    const sourceNode = nodeMap.get(nodeId);
    if (sourceNode?.parentId) {
      edgeMap[nodeId] = edges.map((e) => ({ ...e, loopId: sourceNode.parentId }));
    } else {
      edgeMap[nodeId] = edges;
    }
  }

  return {
    steps: orderedSteps,
    nameToIdMap,
    outputMappings,
    outputMappingsByEndNodeId,
    startInputVariables,
    inDegreeMap,
    edgeMap,
  };
}

/**
 * Compile the Studio delay config (`{ duration: number, unit: string }` or
 * `{ duration: string }` template / ISO 8601, or legacy `{ durationMs }`)
 * into an ISO 8601 duration string the engine understands.
 *
 * The engine's `resolveDelay()` calls `resolveExpression()` on this value, so
 * it MUST be a string — passing a raw number crashes with
 * `template.replace is not a function`.
 */
function compileDelayDuration(config: Record<string, unknown>): string {
  const rawDuration = config.duration;
  const unit = typeof config.unit === 'string' ? config.unit : 'seconds';

  // String input: either an expression template (`{{vars.delayMs}}`) or an
  // ISO 8601 / raw-ms string the runtime will parse as-is.
  if (typeof rawDuration === 'string' && rawDuration.trim() !== '') {
    return rawDuration;
  }

  // Numeric input from the Studio delay config — combine with unit.
  if (typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0) {
    const n = Math.max(1, Math.round(rawDuration));
    switch (unit) {
      case 'minutes':
        return `PT${n}M`;
      case 'hours':
        return `PT${n}H`;
      case 'days':
        return `P${n}D`;
      case 'seconds':
      default:
        return `PT${n}S`;
    }
  }

  // Legacy field used by older canvases.
  if (typeof config.durationMs === 'number' && config.durationMs > 0) {
    return `PT${Math.round(config.durationMs / 1000)}S`;
  }

  return 'PT1S';
}

/**
 * Resolve the canvas body config for the HTTP executor.
 * The Studio stores body as `{ type: "none"|"json"|"form"|"xml"|"custom", content: "..." }`.
 * Returns the content string and body type. Content is undefined for "none"
 * type or missing content.
 * For JSON type, returns the content string as-is — the executor passes it
 * through resolveExpressionTyped then JSON.stringify, so valid JSON strings
 * and expression templates both work correctly.
 */
function resolveBodyConfig(raw: unknown): {
  body: string | undefined;
  bodyType: 'none' | 'json' | 'form' | 'xml' | 'custom' | undefined;
} {
  if (raw == null) return { body: undefined, bodyType: undefined };
  if (typeof raw === 'string') return { body: raw || undefined, bodyType: undefined };
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const bodyType = (typeof obj.type === 'string' ? obj.type : undefined) as
      | 'none'
      | 'json'
      | 'form'
      | 'xml'
      | 'custom'
      | undefined;
    if (obj.type === 'none') return { body: undefined, bodyType: 'none' };
    const content = obj.content;
    const body = typeof content === 'string' && content.trim() ? content : undefined;
    return { body, bodyType };
  }
  return { body: undefined, bodyType: undefined };
}

/**
 * Normalise the Studio headers config into a flat `Record<string, string>`.
 *
 * The canvas UI (ApiNodeConfig) stores headers as `Array<{key, value}>` and
 * the Zod schema (`ApiNodeConfigSchema`) validates that shape. The HTTP
 * executor and `resolveExpressionMap` expect `Record<string, string>`, so we
 * convert here. If headers are already an object (legacy / step-editor), pass
 * through unchanged.
 */
function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) {
        out[entry.key] = typeof entry.value === 'string' ? entry.value : String(entry.value ?? '');
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (typeof raw === 'object') {
    return raw as Record<string, string>;
  }
  return undefined;
}

/**
 * Convert a single canvas node to an engine WorkflowStep.
 */
function convertNodeToStep(
  node: CanvasNode,
  stepType: string,
  outEdges: Map<string, Array<{ edgeId: string; sourceHandle?: string; target: string }>>,
): WorkflowStep | null {
  const config = node.config || {};
  const targets = outEdges.get(node.id) || [];

  switch (stepType) {
    case 'http': {
      // When Mode is set to "Asynchronous" in the Studio, compile as async_webhook so
      // the engine injects a callbackUrl and suspends until the external system responds.
      if (config.mode === 'async') {
        return {
          id: node.id,
          type: 'async_webhook' as const,
          method: (config.method as 'POST' | 'PUT' | 'PATCH') || 'POST',
          url: (config.url as string) || '',
          headers: normalizeHeaders(config.headers),
          timeout:
            config.timeout != null ? (config.timeout as number) * 1000 : DEFAULT_STEP_TIMEOUT_MS,
        };
      }
      const { body, bodyType } = resolveBodyConfig(config.body);
      return {
        id: node.id,
        type: 'http',
        method: (config.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') || 'GET',
        url: (config.url as string) || '',
        headers: normalizeHeaders(config.headers),
        body,
        bodyType,
        timeout:
          config.timeout != null ? (config.timeout as number) * 1000 : DEFAULT_STEP_TIMEOUT_MS,
      };
    }

    case 'condition': {
      // Derive per-condition target steps and else targets from edges.
      // Condition edges use sourceHandle matching condition IDs (e.g. "if_0", "if_1")
      // or "else" for the default branch.
      const elseTargets: string[] = [];
      const handleTargets = new Map<string, string[]>();
      for (const t of targets) {
        if (t.sourceHandle === 'else') {
          elseTargets.push(t.target);
        } else {
          const handle = t.sourceHandle || 'if_0';
          const list = handleTargets.get(handle) || [];
          list.push(t.target);
          handleTargets.set(handle, list);
        }
      }

      // Build per-condition branches with individual expressions and target steps
      const conditionsConfig = config.conditions as
        | Array<{ id: string; field?: string; operator?: string; value?: string }>
        | undefined;

      const conditionBranches: Array<{ id: string; expression: string; targetSteps: string[] }> =
        [];
      let firstExpression = 'true';

      if (conditionsConfig && conditionsConfig.length > 0) {
        for (const cond of conditionsConfig) {
          const op = cond.operator || 'equals';
          // Ensure the field is wrapped in {{}} for the expression resolver.
          // Canvas config may store raw paths like "steps.API0001.output.status".
          const field = cond.field || '';
          const wrappedField = field.startsWith('{{') ? field : `{{${field}}}`;
          const expression = `${wrappedField} ${op} ${cond.value ?? ''}`;
          conditionBranches.push({
            id: cond.id,
            expression,
            targetSteps: handleTargets.get(cond.id) || [],
          });
        }
        firstExpression = conditionBranches[0]?.expression || 'true';
      }

      // thenSteps: all non-else targets (backward compat for legacy single-expression mode)
      const allThenTargets = Array.from(handleTargets.values()).flat();

      return {
        id: node.id,
        type: 'condition',
        expression: firstExpression,
        thenSteps: allThenTargets,
        elseSteps: elseTargets,
        conditions: conditionBranches,
        canvasRouted: true,
      };
    }

    case 'delay':
      return {
        id: node.id,
        type: 'delay',
        duration: compileDelayDuration(config),
      };

    case 'loop':
      return {
        id: node.id,
        type: 'loop',
        config: {
          ...config,
          // Studio saves the array expression as `source`; the executor reads `collection`
          collection:
            (config.collection as string | undefined) ??
            (config.source as string | undefined) ??
            (config.items as string | undefined),
          // Studio saves the item name as `itemAlias`; the executor reads `itemVariable`
          itemVariable:
            (config.itemVariable as string | undefined) ??
            (config.itemAlias as string | undefined) ??
            (config.as as string | undefined) ??
            'currentItem',
        },
      } as unknown as WorkflowStep;

    case 'transform':
      return {
        id: node.id,
        type: 'transform',
        config: config,
      } as unknown as WorkflowStep;

    case 'function':
      return {
        id: node.id,
        type: 'function',
        config: {
          code: config.code ?? '',
          timeout: config.timeout ?? 10,
        },
      } as unknown as WorkflowStep;

    case 'connector_action':
      return {
        id: node.id,
        type: 'connector_action',
        connector: (config.connectorId as string) || (config.connector as string) || '',
        action: (config.actionName as string) || (config.action as string) || '',
        params: (config.params as Record<string, string>) || {},
        paramModes: (config.paramModes as Record<string, 'static' | 'expression'>) || undefined,
        connectionId: config.connectionId as string | undefined,
        timeout:
          config.timeout != null ? (config.timeout as number) * 1000 : DEFAULT_STEP_TIMEOUT_MS,
      };

    case 'human_task': {
      // Timeout config from UI is { duration: number, unit: string } when enabled, undefined when disabled.
      // When no timeout is configured the step waits indefinitely for the user.
      const rawTimeout = config.timeout as { duration: number; unit: string } | number | undefined;
      let humanTimeout: number | undefined;
      if (rawTimeout != null) {
        if (typeof rawTimeout === 'number') {
          humanTimeout = rawTimeout;
        } else if (
          typeof rawTimeout === 'object' &&
          typeof rawTimeout.duration === 'number' &&
          rawTimeout.duration > 0
        ) {
          const unit = rawTimeout.unit ?? 'minutes';
          const multiplier =
            unit === 'seconds'
              ? 1_000
              : unit === 'hours'
                ? 3_600_000
                : unit === 'days'
                  ? 86_400_000
                  : 60_000; // default: minutes
          humanTimeout = rawTimeout.duration * multiplier;
        }
      }
      // Map UI onTimeout values to engine values
      const rawOnTimeout = config.onTimeout as string | undefined;
      const onTimeout =
        rawOnTimeout === 'terminate'
          ? 'expire'
          : rawOnTimeout === 'skip'
            ? ('skip' as const)
            : (rawOnTimeout as 'expire' | 'escalate' | 'auto_complete' | 'skip' | undefined);

      // Resolve assignTo: 'everyone' → ['everyone'], 'specific' → use config.assignees array
      let resolvedAssignTo: string[] | undefined;
      if (config.assignTo === 'specific' && Array.isArray(config.assignees)) {
        const list = (config.assignees as string[]).filter(Boolean);
        resolvedAssignTo = list.length > 0 ? list : undefined;
      } else if (config.assignTo === 'everyone') {
        resolvedAssignTo = ['everyone'];
      } else if (Array.isArray(config.assignTo)) {
        resolvedAssignTo = config.assignTo as string[];
      } else if (typeof config.assignTo === 'string') {
        resolvedAssignTo = [config.assignTo];
      }

      return {
        id: node.id,
        type: 'human_task',
        taskType:
          (config.taskType as 'approval' | 'data_entry' | 'review' | 'decision') ||
          (node.nodeType === 'data_entry' ? 'data_entry' : 'approval'),
        title: (config.title as string) || (config.subject as string) || node.name,
        description:
          (config.description as string) ||
          (config.message as string) ||
          (config.instructions as string),
        assignTo: resolvedAssignTo,
        priority:
          (config.priority as 'low' | 'medium' | 'high' | 'critical' | undefined) || undefined,
        fields: Array.isArray(config.fields)
          ? (config.fields as Record<string, unknown>[]).map(
              (f) =>
                ({
                  ...f,
                  label: (f.label as string) || (f.name as string) || '',
                  required: f.required === true,
                }) as unknown as HumanTaskFieldDef,
            )
          : undefined,
        timeout: humanTimeout,
        onTimeout,
      };
    }

    case 'agent_invocation':
      return {
        id: node.id,
        type: 'agent_invocation',
        agentId: (config.agentId as string) || (config.agentName as string) || '',
        message:
          (config.message as string) ||
          (config.input
            ? typeof config.input === 'string'
              ? config.input
              : JSON.stringify(config.input)
            : ''),
        timeout:
          config.timeout != null ? (config.timeout as number) * 1000 : DEFAULT_AGENT_TIMEOUT_MS,
      };

    case 'tool_call':
      return {
        id: node.id,
        type: 'tool_call',
        toolName: (config.toolName as string) || (config.toolId as string) || '',
        params: (config.params as Record<string, unknown>) || {},
        executionMode:
          (config.executionMode as 'sync' | 'async_continue' | 'async_wait' | undefined) || 'sync',
        ...(config.callbackConfig
          ? {
              callbackConfig: config.callbackConfig as {
                enabled: boolean;
                location: 'body' | 'query' | 'header';
                callbackUrlKey: string;
                callbackSecretKey: string;
              },
            }
          : {}),
        ...(config.asyncHttpSuccess
          ? {
              asyncHttpSuccess: config.asyncHttpSuccess as {
                acceptedStatusCodes?: number[];
                acceptedBodyPath?: string;
                acceptedBodyEquals?: string;
              },
            }
          : {}),
        timeout:
          config.timeout != null ? (config.timeout as number) * 1000 : DEFAULT_STEP_TIMEOUT_MS,
      };

    default:
      return null;
  }
}
