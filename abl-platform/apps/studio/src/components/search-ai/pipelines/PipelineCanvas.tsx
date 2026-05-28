/**
 * Pipeline Canvas
 *
 * React Flow canvas showing pipeline stages as connected nodes.
 * Provides a visual representation of the pipeline flow.
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
  Background,
  Controls,
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslations } from 'next-intl';
import { pipelineStageIntent, getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import { usePipelineStore } from '../../../store/pipeline-store';
import type { PipelineFlow, PipelineStage } from '../../../api/pipelines';

// ─── Stage Type Colors ──────────────────────────────────────────────────

/**
 * Override map for stage types not covered by the default pipelineStageIntent.
 * 'chunking' maps to same as extraction (info), knowledge-graph to accent, multimodal to purple.
 */
const STAGE_INTENT_OVERRIDES: Record<string, SemanticIntent> = {
  chunking: 'info',
  'knowledge-graph': 'accent',
  multimodal: 'purple',
  embedding: 'success',
};

function getStageColors(stageType: string) {
  const intent = STAGE_INTENT_OVERRIDES[stageType] ?? pipelineStageIntent(stageType);
  const styles = getIntentStyles(intent);
  return {
    bg: styles.bgSubtle,
    border: styles.border,
    text: styles.text,
  };
}

const DEFAULT_COLOR = {
  bg: 'bg-background-muted',
  border: 'border-default',
  text: 'text-foreground',
};

// ─── Stage Node Component ───────────────────────────────────────────────

function StageNode({ data }: NodeProps) {
  const { openStageConfig } = usePipelineStore();
  const t = useTranslations('search_ai.pipeline');
  const colors = data.stageType ? getStageColors(data.stageType as string) : DEFAULT_COLOR;

  const stageTypeLabels: Record<string, string> = useMemo(
    () => ({
      extraction: t('stage_extraction'),
      chunking: t('stage_chunking'),
      enrichment: t('stage_enrichment'),
      embedding: t('stage_embedding'),
      'knowledge-graph': t('stage_knowledge_graph'),
      multimodal: t('stage_multimodal'),
    }),
    [t],
  );

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${colors.bg} ${colors.border} min-w-[180px] cursor-pointer hover:shadow-md transition-shadow`}
      onDoubleClick={() => openStageConfig(data.stageId as string)}
    >
      <Handle type="target" position={Position.Left} className="w-2 h-2" />
      <div className="text-center">
        <div className={`text-xs font-semibold uppercase tracking-wide ${colors.text}`}>
          {stageTypeLabels[data.stageType as string] || (data.stageType as string)}
        </div>
        <div className="text-sm font-medium text-foreground mt-1">{data.label as string}</div>
        {data.provider ? (
          <div className="text-xs text-muted mt-0.5">{data.provider as string}</div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="w-2 h-2" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  stageNode: StageNode,
};

// ─── Canvas Component ───────────────────────────────────────────────────

interface PipelineCanvasProps {
  flow: PipelineFlow;
}

export function PipelineCanvas({ flow }: PipelineCanvasProps) {
  const t = useTranslations('search_ai.pipeline');
  const { nodes, edges } = useMemo(() => buildGraph(flow), [flow]);

  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const { openStageConfig } = usePipelineStore.getState();
    if (node.data.stageId) {
      openStageConfig(node.data.stageId as string);
    }
  }, []);

  if (flow.stages.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted text-sm">
        {t('canvas_empty')}
      </div>
    );
  }

  return (
    <div className="h-64 border border-default rounded-lg overflow-hidden bg-background-muted">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        minZoom={0.5}
        maxZoom={2}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ─── Graph Builder ──────────────────────────────────────────────────────

function buildGraph(flow: PipelineFlow): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...flow.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const HORIZONTAL_GAP = 250;
  const Y_CENTER = 100;

  const nodes: Node[] = sorted.map((stage, index) => ({
    id: stage.id,
    type: 'stageNode',
    position: { x: index * HORIZONTAL_GAP, y: Y_CENTER },
    data: {
      label: stage.name,
      stageType: stage.type,
      provider: stage.provider,
      stageId: stage.id,
    },
  }));

  const edges: Edge[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    edges.push({
      id: `${sorted[i].id}-${sorted[i + 1].id}`,
      source: sorted[i].id,
      target: sorted[i + 1].id,
      animated: false,
      style: {
        stroke: 'hsl(var(--border))',
        strokeWidth: 3,
        opacity: 1,
      },
    });
  }

  return { nodes, edges };
}
