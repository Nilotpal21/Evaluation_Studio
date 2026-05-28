/**
 * V2 Pipeline Canvas
 *
 * Full-featured React Flow canvas showing ALL pipeline flows simultaneously
 * in a left-to-right DAG layout with compound ingress/output zones.
 *
 * Node types: compoundIngress, stage, embeddingFields, sharedStage.
 * No InsertPointNodes — stage insertion will be via edge-hover (Phase 3).
 */

import { useMemo, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
  type EdgeTypes,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslations } from 'next-intl';
import type { PipelineDefinition } from '../../../../api/pipelines';
import { usePipelineStore } from '../../../../store/pipeline-store';
import { buildPipelineGraph, type PipelineGraphLabels } from './graph-builder';
import { CompoundIngressNode } from './nodes/CompoundIngressNode';
import { EmbeddingFieldsNode } from './nodes/EmbeddingFieldsNode';
import { StageNode } from './nodes/StageNode';
import { SharedStageNode } from './nodes/SharedStageNode';
import { FlowLaneHeader } from './nodes/FlowLaneHeader';
import { FlowLaneBackground } from './nodes/FlowLaneBackground';
import { MergeNode } from './nodes/MergeNode';
import { InsertableEdge } from './edges/InsertableEdge';

// =============================================================================
// NODE TYPE REGISTRY
// =============================================================================

const nodeTypes: NodeTypes = {
  compoundIngress: CompoundIngressNode,
  embeddingFields: EmbeddingFieldsNode,
  stage: StageNode,
  sharedStage: SharedStageNode,
  merge: MergeNode,
  laneHeader: FlowLaneHeader,
  laneBackground: FlowLaneBackground,
};

const edgeTypes: EdgeTypes = {
  insertable: InsertableEdge,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface PipelineCanvasV2Props {
  definition: PipelineDefinition;
}

/** Inner canvas — must be inside ReactFlowProvider to use useReactFlow */
function PipelineCanvasInner({ definition }: PipelineCanvasV2Props) {
  const t = useTranslations('search_ai.pipeline');
  const expandStage = usePipelineStore((s) => s.expandStage);
  const closePanel = usePipelineStore((s) => s.closePanel);
  const selectFlow = usePipelineStore((s) => s.selectFlow);
  const _reactFlow = useReactFlow();
  const hasFittedRef = useRef(false);

  const graphLabels: PipelineGraphLabels = useMemo(
    () => ({
      documents: t('v2_document_ingress'),
      contentRouter: t('v2_content_router'),
      opensearch: t('v2_opensearch'),
    }),
    [t],
  );

  const { nodes, edges } = useMemo(
    () => buildPipelineGraph(definition, graphLabels),
    [definition, graphLabels],
  );

  // Fit all nodes into view on initial load with some padding.
  // Uses fitView to auto-calculate the zoom level based on pipeline width.
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodes.length === 0 || hasFittedRef.current) return;
    const raf = requestAnimationFrame(() => {
      fitView({ padding: 0.15, duration: 300, maxZoom: 1 });
      hasFittedRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [nodes, fitView]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === 'stage' && node.data.stageId) {
        expandStage(node.data.stageId as string);
      }
    },
    [expandStage],
  );

  // Click empty canvas → clear ALL selections (detail panel returns to empty state)
  const handlePaneClick = useCallback(() => {
    expandStage(null);
    closePanel();
    selectFlow(null);
  }, [expandStage, closePanel, selectFlow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      panOnDrag
      zoomOnScroll
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        position="bottom-left"
        pannable
        zoomable
        style={{ width: 120, height: 80 }}
        className="rounded border border-default"
      />
    </ReactFlow>
  );
}

export function PipelineCanvasV2({ definition }: PipelineCanvasV2Props) {
  const t = useTranslations('search_ai.pipeline');
  const isDefaultView = usePipelineStore((s) => s.isDefaultView);

  if (definition.flows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
        {t('v2_no_pipeline')}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-background-muted">
      <ReactFlowProvider>
        <PipelineCanvasInner definition={definition} />
      </ReactFlowProvider>

      {/* Fallthrough notice for custom pipelines */}
      {!isDefaultView && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-2 shadow-sm backdrop-blur-sm">
            <p className="text-xs text-foreground-muted">{t('v2_fallthrough_notice')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
