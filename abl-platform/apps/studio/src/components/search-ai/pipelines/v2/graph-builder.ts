/**
 * V2 Pipeline Graph Builder
 *
 * Converts a PipelineDefinition into React Flow nodes and edges
 * showing ALL flows simultaneously in a clean left-to-right layout.
 *
 * Layout:
 *   CompoundIngress → [Per-flow stages in horizontal swim lanes] → EmbeddingFields → Embedding → OpenSearch
 *
 * The shared tail (EmbeddingFields → Embedding → OpenSearch) is vertically
 * centered and shared across all flow lanes.
 */

import type { Node, Edge } from '@xyflow/react';
import type { PipelineDefinition } from '../../../../api/pipelines';
import { getEdgeStyle } from './edge-styles';

// =============================================================================
// TYPES
// =============================================================================

export interface V2NodeData extends Record<string, unknown> {
  nodeType:
    | 'ingress'
    | 'router'
    | 'stage'
    | 'merge'
    | 'embeddingFields'
    | 'sharedStage'
    | 'compoundIngress'
    | 'compoundOutput'
    | 'laneHeader'
    | 'laneBackground';
  label: string;
  stageType?: string;
  provider?: string;
  stageId?: string;
  flowId?: string;
  flowName?: string;
  locked?: boolean;
  providerConfig?: Record<string, unknown>;
  onError?: string;
  fallbackProvider?: string;
  isShared?: boolean;
  flowCount?: number;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  flowPriority?: number;
}

/** Labels passed by the caller so that graph-builder stays i18n-free. */
export interface PipelineGraphLabels {
  documents: string;
  contentRouter: string;
  opensearch: string;
}

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

const NODE_WIDTH = 220;
const COLUMN_GAP = NODE_WIDTH + 60; // 60px gap between stages for "+" insert button
const NODE_HEIGHT = 64;
const LANE_HEADER_HEIGHT = 24;
const LANE_V_GAP = 48;
const SHARED_GAP = NODE_WIDTH + 40; // gap before shared tail nodes
const LANE_BG_HEIGHT = NODE_HEIGHT + 16;

// =============================================================================
// STAGE TYPE ORDERING (matches STAGE_ORDER in stage-insertion-rules.ts)
// =============================================================================

const STAGE_TYPE_RANK: Record<string, number> = {
  extraction: 0,
  chunking: 1,
  'content-intelligence': 2,
  'visual-analysis': 3,
};
const FALLBACK_RANK = 99;

function stageTypeRank(type: string): number {
  return STAGE_TYPE_RANK[type] ?? FALLBACK_RANK;
}

// =============================================================================
// GRAPH BUILDER
// =============================================================================

export function buildPipelineGraph(
  definition: PipelineDefinition,
  labels?: PipelineGraphLabels,
): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const allFlows = definition.flows.filter((f) => f.enabled);
  if (allFlows.length === 0) {
    return { nodes, edges };
  }

  // ─── Sort stages per flow ──────────────────────────────────────────
  const allFlowMeta = allFlows.map((flow) => {
    const sorted = [...flow.stages]
      .filter((s) => s.type !== 'embedding' && s.type !== 'enrichment')
      .sort((a, b) => {
        const rankDiff = stageTypeRank(a.type) - stageTypeRank(b.type);
        if (rankDiff !== 0) return rankDiff;
        return (a.order ?? 0) - (b.order ?? 0);
      });
    return { flow, sorted, stageCount: sorted.length };
  });

  // Separate flows with stages from empty flows — empty flows get a placeholder
  // lane but must not participate in shared-stage detection or edge routing.
  const flowMeta = allFlowMeta.filter((m) => m.stageCount > 0);
  const emptyFlowMeta = allFlowMeta.filter((m) => m.stageCount === 0);
  const flows = flowMeta.map((m) => m.flow);

  // If ALL flows are empty, nothing to render
  if (flowMeta.length === 0) {
    return { nodes, edges };
  }

  // ─── Detect shared stages (diamond branch optimization) ────────────
  // Only consider flows with stages — empty flows are excluded.

  let branchEndIndex = 0;
  if (flows.length > 1) {
    const maxLen = Math.max(...flowMeta.map((m) => m.sorted.length));

    for (let i = 0; i < maxLen; i++) {
      const stageKeys = flowMeta.map((m) => {
        const s = m.sorted[i];
        if (!s) return '';
        return `${s.type}:${s.provider}:${s.fallbackProvider ?? ''}`;
      });
      const allSame = stageKeys.every((k) => k === stageKeys[0] && k !== '');
      if (!allSame) {
        branchEndIndex = i + 1;
      }
    }

    if (branchEndIndex === 0 && flows.length > 1) {
      branchEndIndex = 1;
    }
  }

  // Split into branching stages (per-flow) and shared stages (single path)
  const branchMeta = flowMeta.map((m) => ({
    ...m,
    branchStages: m.sorted.slice(0, branchEndIndex),
    sharedStages: m.sorted.slice(branchEndIndex),
  }));

  const hasSharedStages = branchMeta[0]?.sharedStages.length > 0;
  const maxBranchCount = Math.max(...branchMeta.map((m) => m.branchStages.length), 1);
  const sharedStages = branchMeta[0]?.sharedStages ?? [];

  // ─── Compute lane heights and Y offsets ────────────────────────────
  const laneHeight = LANE_HEADER_HEIGHT + 8 + LANE_BG_HEIGHT;
  const totalLaneCount = flowMeta.length + emptyFlowMeta.length;
  let cumulativeY = 0;
  const laneOffsets: number[] = [];
  for (let i = 0; i < flowMeta.length; i++) {
    laneOffsets.push(cumulativeY);
    cumulativeY += laneHeight + LANE_V_GAP;
  }
  const emptyLaneOffsets: number[] = [];
  for (let i = 0; i < emptyFlowMeta.length; i++) {
    emptyLaneOffsets.push(cumulativeY);
    cumulativeY += laneHeight + LANE_V_GAP;
  }
  const totalFlowHeight = cumulativeY > 0 ? cumulativeY - LANE_V_GAP : 0;

  // ─── Column positions ──────────────────────────────────────────────
  const ingressX = 0;
  const firstStageX = ingressX + COLUMN_GAP;
  const mergeX = firstStageX + maxBranchCount * COLUMN_GAP;
  const sharedStartX = hasSharedStages ? mergeX + COLUMN_GAP / 2 : mergeX;
  const outputX = sharedStartX + sharedStages.length * COLUMN_GAP;

  // ─── Shared rail Y: centered, nudged into a gap if it overlaps a lane ─
  const allLaneStageYs = [
    ...laneOffsets.map((o) => o + LANE_HEADER_HEIGHT + 8),
    ...emptyLaneOffsets.map((o) => o + LANE_HEADER_HEIGHT + 8),
  ];
  let sharedY: number;
  if (totalLaneCount <= 1) {
    sharedY = allLaneStageYs[0] ?? 0;
  } else {
    let candidate = totalFlowHeight / 2;
    const MARGIN = 8;
    for (const stageY of allLaneStageYs) {
      if (candidate >= stageY - MARGIN && candidate <= stageY + NODE_HEIGHT + MARGIN) {
        candidate = stageY + NODE_HEIGHT + MARGIN + LANE_V_GAP / 2;
        break;
      }
    }
    sharedY = candidate;
  }

  // ─── Compound Ingress Node ─────────────────────────────────────────

  const ingressId = 'ingress';
  nodes.push({
    id: ingressId,
    type: 'compoundIngress',
    position: { x: ingressX, y: sharedY },
    data: {
      nodeType: 'compoundIngress',
      label: labels?.documents ?? 'Documents',
      flowCount: totalLaneCount,
      isShared: true,
    } satisfies V2NodeData,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });

  // ─── Per-Flow BRANCHING Stage Nodes (only stages that differ) ──────

  const lastBranchIds: { nodeId: string; flowId: string; lastStageId: string | null }[] = [];

  branchMeta.forEach((meta, laneIndex) => {
    const { flow, branchStages } = meta;
    const laneBaseY = laneOffsets[laneIndex];
    const stageY = laneBaseY + LANE_HEADER_HEIGHT + 8;

    // ─── Lane Background (only for branch portion) ───────────
    const stageCount = Math.max(branchStages.length, 1);
    const laneBgWidth = stageCount * COLUMN_GAP + NODE_WIDTH - COLUMN_GAP + 32;
    nodes.push({
      id: `lane-bg-${flow.id}`,
      type: 'laneBackground',
      position: { x: firstStageX - 16, y: stageY - 8 },
      data: {
        nodeType: 'laneBackground' as const,
        label: '',
        flowId: flow.id,
      } satisfies V2NodeData,
      width: laneBgWidth,
      height: LANE_BG_HEIGHT,
      draggable: false,
      selectable: false,
      style: { width: laneBgWidth, height: LANE_BG_HEIGHT, zIndex: -1 },
    });

    // ─── Lane Header ─────────────────────────────────────────
    nodes.push({
      id: `lane-header-${flow.id}`,
      type: 'laneHeader',
      position: { x: firstStageX, y: laneBaseY },
      data: {
        nodeType: 'laneHeader' as const,
        label: flow.name,
        flowName: flow.name,
        flowPriority: flow.priority,
        flowId: flow.id,
      } satisfies V2NodeData,
      width: NODE_WIDTH,
      height: LANE_HEADER_HEIGHT,
      draggable: false,
      selectable: false,
    });

    // ─── Branch Stage Nodes ──────────────────────────────────
    let prevNodeId = ingressId;
    let prevStageId: string | null = null;

    branchStages.forEach((stage, stageIndex) => {
      const nodeId = `stage-${flow.id}-${stage.id}`;

      nodes.push({
        id: nodeId,
        type: 'stage',
        position: { x: firstStageX + stageIndex * COLUMN_GAP, y: stageY },
        data: {
          nodeType: 'stage',
          label: stage.name,
          stageType: stage.type,
          provider: stage.provider,
          stageId: stage.id,
          flowId: flow.id,
          flowName: flow.name,
          locked: false,
          providerConfig: stage.providerConfig,
          onError: stage.onError,
          fallbackProvider: stage.fallbackProvider,
        } satisfies V2NodeData,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });

      const isFromIngress = prevNodeId === ingressId;
      edges.push({
        id: `${prevNodeId}-${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        type: isFromIngress ? 'default' : 'insertable',
        sourceHandle: isFromIngress ? undefined : 'right',
        targetHandle: 'left',
        style: getEdgeStyle(stage.type),
        data: isFromIngress
          ? undefined
          : {
              flowId: flow.id,
              afterStageId: prevStageId,
              beforeStageId: stage.id,
            },
      });

      prevStageId = stage.id;
      prevNodeId = nodeId;
    });

    lastBranchIds.push({ nodeId: prevNodeId, flowId: flow.id, lastStageId: prevStageId });
  });

  // ─── Empty Flow Placeholder Lanes ─────────────────────────────────
  emptyFlowMeta.forEach((meta, idx) => {
    const { flow } = meta;
    const laneBaseY = emptyLaneOffsets[idx];
    const stageY = laneBaseY + LANE_HEADER_HEIGHT + 8;

    // Lane header
    nodes.push({
      id: `lane-header-${flow.id}`,
      type: 'laneHeader',
      position: { x: firstStageX, y: laneBaseY },
      data: {
        nodeType: 'laneHeader' as const,
        label: flow.name,
        flowName: flow.name,
        flowPriority: flow.priority,
        flowId: flow.id,
      } satisfies V2NodeData,
      width: NODE_WIDTH,
      height: LANE_HEADER_HEIGHT,
      draggable: false,
      selectable: false,
    });

    // Empty lane background
    const laneBgWidth = NODE_WIDTH + 32;
    nodes.push({
      id: `lane-bg-${flow.id}`,
      type: 'laneBackground',
      position: { x: firstStageX - 16, y: stageY - 8 },
      data: {
        nodeType: 'laneBackground' as const,
        label: '',
        flowId: flow.id,
      } satisfies V2NodeData,
      width: laneBgWidth,
      height: LANE_BG_HEIGHT,
      draggable: false,
      selectable: false,
      style: { width: laneBgWidth, height: LANE_BG_HEIGHT, zIndex: -1 },
    });

    // Placeholder stage node so the empty lane has a visible target
    const emptyStageId = `empty-placeholder-${flow.id}`;
    nodes.push({
      id: emptyStageId,
      type: 'stage',
      position: { x: firstStageX, y: stageY },
      data: {
        nodeType: 'stage',
        label: flow.name,
        stageType: 'extraction',
        flowId: flow.id,
        flowName: flow.name,
        locked: true,
      } satisfies V2NodeData,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      style: { opacity: 0.4 },
    });

    // Connect ingress → empty flow placeholder
    edges.push({
      id: `${ingressId}-${emptyStageId}`,
      source: ingressId,
      target: emptyStageId,
      type: 'default',
      targetHandle: 'left',
      style: getEdgeStyle('extraction'),
    });
  });

  // ─── Shared Stages (single path after merge) ──────────────────────
  // These use the first flow's stage data since they're identical across flows.

  let lastSharedNodeId: string;

  if (hasSharedStages && flows.length > 1) {
    // Add merge node
    const mergeId = 'merge';
    nodes.push({
      id: mergeId,
      type: 'merge',
      position: { x: mergeX, y: sharedY },
      data: { nodeType: 'merge', label: '', isShared: true } satisfies V2NodeData,
      width: 12,
      height: 12,
    });

    // Connect all branch ends → merge
    lastBranchIds.forEach((entry) => {
      edges.push({
        id: `${entry.nodeId}-${mergeId}`,
        source: entry.nodeId,
        target: mergeId,
        type: 'default',
        sourceHandle: 'right',
        targetHandle: 'left',
        style: getEdgeStyle('extraction'),
      });
    });

    // Render shared stages as single path
    let prevNodeId = mergeId;
    const refFlow = flows[0]; // use first flow's stage data

    sharedStages.forEach((stage, stageIndex) => {
      const nodeId = `shared-${stage.type}-${stageIndex}`;

      nodes.push({
        id: nodeId,
        type: 'stage',
        position: { x: sharedStartX + stageIndex * COLUMN_GAP, y: sharedY },
        data: {
          nodeType: 'stage',
          label: stage.name,
          stageType: stage.type,
          provider: stage.provider,
          stageId: stage.id,
          flowId: refFlow.id,
          flowName: 'Shared',
          locked: false,
          providerConfig: stage.providerConfig,
          onError: stage.onError,
          fallbackProvider: stage.fallbackProvider,
          isShared: true,
        } satisfies V2NodeData,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });

      edges.push({
        id: `${prevNodeId}-${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        type: 'insertable',
        sourceHandle: 'right',
        targetHandle: 'left',
        style: getEdgeStyle(stage.type),
        data: {
          flowId: refFlow.id,
          afterStageId: stageIndex === 0 ? null : (sharedStages[stageIndex - 1]?.id ?? null),
          beforeStageId: stage.id,
        },
      });

      prevNodeId = nodeId;
    });

    lastSharedNodeId = prevNodeId;
  } else {
    // No shared stages or single flow — connect branch ends directly
    lastSharedNodeId = lastBranchIds[0]?.nodeId ?? ingressId;

    // For single flow, treat lastBranchIds as the connection points
    if (flows.length === 1 && sharedStages.length > 0) {
      let prevNodeId = lastBranchIds[0]?.nodeId ?? ingressId;
      const refFlow = flows[0];

      sharedStages.forEach((stage, stageIndex) => {
        const nodeId = `stage-${refFlow.id}-${stage.id}`;

        nodes.push({
          id: nodeId,
          type: 'stage',
          position: { x: sharedStartX + stageIndex * COLUMN_GAP, y: sharedY },
          data: {
            nodeType: 'stage',
            label: stage.name,
            stageType: stage.type,
            provider: stage.provider,
            stageId: stage.id,
            flowId: refFlow.id,
            flowName: refFlow.name,
            locked: false,
            providerConfig: stage.providerConfig,
            onError: stage.onError,
            fallbackProvider: stage.fallbackProvider,
          } satisfies V2NodeData,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        });

        edges.push({
          id: `${prevNodeId}-${nodeId}`,
          source: prevNodeId,
          target: nodeId,
          type: 'insertable',
          sourceHandle: 'right',
          targetHandle: 'left',
          style: getEdgeStyle(stage.type),
          data: {
            flowId: refFlow.id,
            afterStageId:
              stageIndex === 0 ? lastBranchIds[0]?.lastStageId : sharedStages[stageIndex - 1]?.id,
            beforeStageId: stage.id,
          },
        });

        prevNodeId = nodeId;
      });

      lastSharedNodeId = prevNodeId;
    }
  }

  // Replace lastStageIds for the output connection
  const lastStageIds = hasSharedStages
    ? [
        {
          nodeId: lastSharedNodeId,
          flowId: flows[0].id,
          lastStageId: sharedStages[sharedStages.length - 1]?.id ?? null,
        },
      ]
    : lastBranchIds;

  // ─── Shared: Embedding Fields → Embedding → OpenSearch ─────────────

  const embeddingFieldsId = 'embedding-fields';
  nodes.push({
    id: embeddingFieldsId,
    type: 'embeddingFields',
    position: { x: outputX, y: sharedY },
    data: {
      nodeType: 'embeddingFields',
      label: 'Embedding Fields',
      isShared: true,
    } satisfies V2NodeData,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });

  const embeddingId = 'embedding';
  nodes.push({
    id: embeddingId,
    type: 'sharedStage',
    position: { x: outputX + SHARED_GAP, y: sharedY },
    data: {
      nodeType: 'sharedStage',
      label: definition.activeEmbeddingConfig?.provider ?? 'Embedding',
      stageType: 'embedding',
      provider: definition.activeEmbeddingConfig?.provider,
      isShared: true,
      embeddingProvider: definition.activeEmbeddingConfig?.provider,
      embeddingModel: definition.activeEmbeddingConfig?.model,
      embeddingDimensions: definition.activeEmbeddingConfig?.dimensions,
    } satisfies V2NodeData,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });

  const opensearchId = 'opensearch';
  nodes.push({
    id: opensearchId,
    type: 'sharedStage',
    position: { x: outputX + SHARED_GAP * 2, y: sharedY },
    data: {
      nodeType: 'sharedStage',
      label: labels?.opensearch ?? 'OpenSearch',
      stageType: 'output',
      isShared: true,
      isTerminal: true,
    } satisfies V2NodeData,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });

  // Connect all last flow stages → Embedding Fields
  lastStageIds.forEach((entry) => {
    const isFlowStage = entry.nodeId !== ingressId;
    edges.push({
      id: `${entry.nodeId}-${embeddingFieldsId}`,
      source: entry.nodeId,
      target: embeddingFieldsId,
      type: isFlowStage ? 'insertable' : 'default',
      sourceHandle: isFlowStage ? 'right' : undefined,
      targetHandle: 'left',
      style: getEdgeStyle('embedding'),
      data: isFlowStage
        ? {
            flowId: entry.flowId,
            afterStageId: entry.lastStageId,
            beforeStageId: null,
          }
        : undefined,
    });
  });

  // Embedding Fields → Embedding
  edges.push({
    id: `${embeddingFieldsId}-${embeddingId}`,
    source: embeddingFieldsId,
    target: embeddingId,
    type: 'default',
    sourceHandle: 'right',
    targetHandle: 'left',
    style: getEdgeStyle('embedding'),
  });

  // Embedding → OpenSearch
  edges.push({
    id: `${embeddingId}-${opensearchId}`,
    source: embeddingId,
    target: opensearchId,
    type: 'default',
    sourceHandle: 'right',
    targetHandle: 'left',
    style: getEdgeStyle('output'),
  });

  return { nodes, edges };
}
