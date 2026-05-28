/**
 * Pipeline Node Preview Service (ABLP-564 Phase 7)
 *
 * Executes the upstream sub-graph of a target node in-process without
 * Restate durability. Nodes with sideEffectClass 'write' or 'external'
 * are short-circuited with a synthetic success response so no data is
 * written and no external calls are made.
 */

import type * as restate from '@restatedev/restate-sdk';
import type { PipelineNode, PipelineStepContext, StepOutput } from '../types.js';
import { ContractRegistry } from '../contracts/registry.js';
import { SERVICE_HANDLERS } from '../handlers/activity-router.service.js';
import { buildExecutionContext } from '../execution-context.js';
import { resolveTransition } from '../graph-utils.js';
import { buildStepOutputReferences } from '../node-references.js';

const contractRegistry = new ContractRegistry();

// ── Preview context mock ────────────────────────────────────────────────────

/**
 * Minimal Restate context mock for in-process preview execution.
 * ctx.run(name, fn) calls fn() directly; ctx.console is a no-op.
 */
function makePreviewContext(): restate.Context {
  const base = {
    run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  };
  return new Proxy(base as unknown as restate.Context, {
    get(target, prop) {
      if (prop in target)
        return (target as unknown as Record<string | symbol, unknown>)[prop as string];
      return () => {
        throw new Error(`Preview context: "${String(prop)}" not supported in preview mode`);
      };
    },
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PreviewNodeArgs {
  tenantId: string;
  projectId: string;
  pipelineId: string;
  nodeId: string;
  sampleSessionId: string;
  nodes: PipelineNode[];
  entryNodeId: string;
  pipelineInput: Record<string, unknown>;
  triggerId?: string;
  pipelineName?: string;
}

export interface PreviewNodeResult {
  status: 'success' | 'fail';
  output: Record<string, unknown>;
  cached: boolean;
  skippedNodes: string[];
}

// ── Executor ────────────────────────────────────────────────────────────────

const SYNTHETIC_SKIP: StepOutput = {
  status: 'success',
  data: { skipped: 'preview', reason: 'write/external nodes are not executed in preview mode' },
};

const UNKNOWN_CONTRACT_SKIP: StepOutput = {
  status: 'success',
  data: { skipped: 'preview', reason: 'node contract is not registered for preview mode' },
};

const PREVIEW_UNSUPPORTED: StepOutput = {
  status: 'fail',
  data: { error: 'This node type is not supported in preview mode' },
};

async function executePreviewNode(
  previewCtx: restate.Context,
  node: PipelineNode,
  stepContextBase: Omit<PipelineStepContext, 'config' | 'stepId' | 'stepType'>,
): Promise<{ output: StepOutput; skipped: boolean }> {
  const contract = contractRegistry.getNode(node.type);
  if (!contract) {
    return { output: UNKNOWN_CONTRACT_SKIP, skipped: true };
  }
  const sideEffectClass = contract.sideEffectClass;

  if (sideEffectClass === 'write' || sideEffectClass === 'external') {
    return { output: SYNTHETIC_SKIP, skipped: true };
  }

  if (node.type === 'delay') {
    return {
      output: {
        status: 'success',
        data: {
          skipped: 'preview',
          reason: 'delay nodes are not slept in preview mode',
          delayed: node.config?.durationMs ?? 0,
        },
      },
      skipped: true,
    };
  }

  if (node.type === 'wait-for-event') {
    return { output: PREVIEW_UNSUPPORTED, skipped: false };
  }

  if (node.type === 'node-group' && node.children?.length) {
    const childOutputs: Record<string, StepOutput> = {};
    let skipped = false;

    for (const child of node.children) {
      const childAsNode: PipelineNode = {
        id: child.id,
        type: child.type,
        label: child.label,
        config: child.config,
        transitions: [],
        timeout: child.timeout,
        retries: child.retries,
        onFailure: child.onFailure,
      };
      const childResult = await executePreviewNode(previewCtx, childAsNode, stepContextBase);
      childOutputs[child.id] = childResult.output;
      skipped = skipped || childResult.skipped;
    }

    return { output: { status: 'success', data: { children: childOutputs } }, skipped };
  }

  const handler = SERVICE_HANDLERS[node.type];
  if (!handler) {
    return {
      output: {
        status: 'fail',
        data: { error: `No handler registered for activity type: '${node.type}'` },
      },
      skipped: false,
    };
  }

  const stepContext: PipelineStepContext = {
    ...stepContextBase,
    stepId: node.id,
    stepType: node.type,
    config: node.config ?? {},
  };

  const output = await handler(previewCtx, stepContext);
  return { output, skipped: false };
}

export async function previewNode(args: PreviewNodeArgs): Promise<PreviewNodeResult> {
  const {
    tenantId,
    projectId,
    pipelineId,
    nodeId,
    sampleSessionId,
    nodes,
    entryNodeId,
    pipelineInput,
    triggerId,
    pipelineName,
  } = args;

  if (!entryNodeId)
    throw new Error('Pipeline has no entryNodeId — cannot determine execution path');

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const previewCtx = makePreviewContext();
  const previousSteps: Record<string, StepOutput> = {};
  const executionContext: Record<string, Record<string, any>> = {};
  const skippedNodes: string[] = [];
  const visitCounts: Record<string, number> = {};

  let currentNodeId: string | null = entryNodeId;
  while (currentNodeId) {
    const node = nodeMap.get(currentNodeId);
    if (!node) throw new Error(`Node "${currentNodeId}" not found in pipeline graph`);

    visitCounts[node.id] = (visitCounts[node.id] ?? 0) + 1;
    const maxVisits = Math.max(1, Math.min(node.maxVisits ?? 1, nodes.length + 1));
    if (visitCounts[node.id] > maxVisits) {
      throw new Error(`Max visits (${maxVisits}) exceeded for node "${node.id}" in preview`);
    }

    const stepContextBase: Omit<PipelineStepContext, 'config' | 'stepId' | 'stepType'> = {
      tenantId,
      projectId,
      sessionId: sampleSessionId,
      pipelineId,
      pipelineName,
      pipelineType: 'custom',
      previousSteps: buildStepOutputReferences(nodes, previousSteps),
      executionContext,
      pipelineInput: { ...pipelineInput, sessionId: sampleSessionId, tenantId, projectId },
      executionMode: 'batch',
      triggerId: triggerId ?? 'preview',
    };

    try {
      const { output, skipped } = await executePreviewNode(previewCtx, node, stepContextBase);
      previousSteps[node.id] = output;
      if (skipped) skippedNodes.push(node.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      previousSteps[node.id] = { status: 'fail', data: { error: msg } };
    }

    const targetOutput = previousSteps[nodeId];
    if (targetOutput) {
      return {
        status: targetOutput.status === 'success' ? 'success' : 'fail',
        output: targetOutput.data ?? {},
        cached: false,
        skippedNodes,
      };
    }

    const currentOutput = previousSteps[node.id];
    buildExecutionContext(executionContext, node.type, currentOutput, undefined, node.children);

    if (currentOutput.status === 'fail') {
      const failStrategy = node.onFailure ?? 'stop';
      if (failStrategy === 'stop') break;
    }

    currentNodeId = resolveTransition(node.transitions, currentOutput, {
      input: stepContextBase.pipelineInput,
      nodeOutputs: buildStepOutputReferences(nodes, previousSteps),
    });
  }

  throw new Error(`Node "${nodeId}" was not reached from entry node "${entryNodeId}"`);
}
