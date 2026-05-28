/**
 * Graph Walker — Pure function that traverses a pipeline graph from an entry
 * node, executing each node via a provided executor function and following
 * transitions based on conditions.
 */

import type { PipelineNode, StepOutput } from './types.js';
import { resolveTransition } from './graph-utils.js';

// ── Public Types ──

export type NodeExecutorFn = (
  nodeId: string,
  nodeType: string,
  config: Record<string, any>,
) => Promise<StepOutput>;

export interface GraphWalkResult {
  status: 'completed' | 'failed';
  nodeOutputs: Record<string, StepOutput>;
  visitCounts: Record<string, number>;
}

// ── Constants ──

const DEFAULT_MAX_VISITS = 1;
const MAX_VISITS_HARD_CAP = 100;

// ── Public API ──

/**
 * Walks a pipeline graph starting from `entryNodeId`, executing each node
 * via the provided `executeNode` function, and following transitions based
 * on condition evaluation.
 *
 * This is a pure function with no side effects beyond calling `executeNode`.
 */
export async function walkGraph(
  nodes: PipelineNode[],
  entryNodeId: string,
  pipelineInput: Record<string, any>,
  executeNode: NodeExecutorFn,
  options?: {
    defaultOnFailure?: 'stop' | 'skip' | 'continue';
    maxVisitsHardCap?: number;
  },
): Promise<GraphWalkResult> {
  // Build lookup map: id → PipelineNode
  const nodeMap = new Map<string, PipelineNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const nodeOutputs: Record<string, StepOutput> = {};
  const visitCounts: Record<string, number> = {};
  const hardCap = options?.maxVisitsHardCap ?? MAX_VISITS_HARD_CAP;
  let hasFailed = false;

  let currentNodeId: string | null = entryNodeId;

  while (currentNodeId !== null) {
    const node = nodeMap.get(currentNodeId);
    if (!node) {
      break;
    }

    // Check visit limits before executing
    const currentCount = visitCounts[node.id] ?? 0;
    const maxVisits = Math.min(node.maxVisits ?? DEFAULT_MAX_VISITS, hardCap);
    if (currentCount >= maxVisits) {
      nodeOutputs[node.id] = {
        status: 'fail',
        data: {
          error: `Node "${node.id}" exceeded maxVisits limit of ${maxVisits}`,
        },
      };
      hasFailed = true;
      break;
    }

    // Increment visit count
    visitCounts[node.id] = currentCount + 1;

    // Execute the node
    const output = await executeNode(node.id, node.type, node.config);
    nodeOutputs[node.id] = output;

    // Handle failure
    if (output.status === 'fail') {
      hasFailed = true;
      const failureStrategy = node.onFailure ?? options?.defaultOnFailure ?? 'stop';
      if (failureStrategy === 'stop') {
        break;
      }
      // 'skip' and 'continue' both proceed to the next node
    }

    // Resolve next transition
    const context = {
      input: pipelineInput,
      nodeOutputs: nodeOutputs as Record<string, unknown>,
    };
    currentNodeId = resolveTransition(node.transitions, output, context);
  }

  return {
    status: hasFailed ? 'failed' : 'completed',
    nodeOutputs,
    visitCounts,
  };
}
