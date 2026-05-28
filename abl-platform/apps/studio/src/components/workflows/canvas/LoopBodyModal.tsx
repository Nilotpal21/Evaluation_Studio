'use client';

import { memo, useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import type { NodeTypes, EdgeTypes, Connection, Edge, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { StopCircle, X } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import type { WorkflowFlowNode, WorkflowFlowEdge } from '../../../store/workflow-canvas-store';
import { isValidWorkflowConnection } from '../../../store/workflow-canvas-helpers';
import { WorkflowNodeComponent } from './nodes/WorkflowNodeComponent';
import { LoopStartNodeComponent } from './nodes/LoopStartNodeComponent';
import { EndNodeComponent } from './nodes/EndNodeComponent';
import { WorkflowEdgeComponent } from './edges/WorkflowEdgeComponent';

// Visible card variant — used only in the modal where there's no right rectangle to hide behind.
const LoopEndModalNode = memo(function LoopEndModalNodeInner({ id }: NodeProps) {
  return (
    <div
      className="relative bg-background-elevated border border-default rounded-lg shadow-sm p-2 flex items-center justify-center nodrag"
      data-testid={`workflow-node-${id}`}
      data-node-type="loop_end"
    >
      <Handle
        type="target"
        position={Position.Left}
        id="loop_body_end"
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3"
      />
      <StopCircle className="w-5 h-5 text-error" />
    </div>
  );
});

const modalNodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent,
  loopStartNode: LoopStartNodeComponent,
  loopEndNode: LoopEndModalNode,
  endNode: EndNodeComponent,
};

const modalEdgeTypes: EdgeTypes = {
  workflowEdge: WorkflowEdgeComponent,
};

// =============================================================================
// Inner canvas — must live inside ReactFlowProvider
// =============================================================================

function LoopBodyCanvas({ loopId }: { loopId: string }) {
  const allNodes = useWorkflowCanvasStore((s) => s.nodes);
  const allEdges = useWorkflowCanvasStore((s) => s.edges);
  const selectNode = useWorkflowCanvasStore((s) => s.selectNode);
  const setConfigPanelOpen = useWorkflowCanvasStore((s) => s.setConfigPanelOpen);
  const onNodesChange = useWorkflowCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowCanvasStore((s) => s.onEdgesChange);
  const onConnect = useWorkflowCanvasStore((s) => s.onConnect);
  const { fitView } = useReactFlow();

  // Derive loop child nodes from store — includes loop_start, loop_end, and body nodes
  const storeNodes = useMemo<WorkflowFlowNode[]>(
    () =>
      allNodes
        .filter((n) => n.parentId === loopId)
        .map(({ parentId: _p, extent: _e, ...rest }) => rest as WorkflowFlowNode),
    [allNodes, loopId],
  );

  const childIds = useMemo(() => new Set(storeNodes.map((n) => n.id)), [storeNodes]);

  // All edges where both endpoints are children — loop_end is now a child so
  // edges body → loop_end pass this filter naturally.
  const storeEdges = useMemo<WorkflowFlowEdge[]>(
    () => allEdges.filter((e) => childIds.has(e.source) && childIds.has(e.target)),
    [allEdges, childIds],
  );

  // Re-fit after node count changes — wait one frame so ReactFlow has rendered the new node
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      fitView({ padding: 0.3, maxZoom: 1, duration: 250 });
    });
    return () => cancelAnimationFrame(id);
  }, [storeNodes.length, fitView]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => isValidWorkflowConnection(allEdges, allNodes, connection),
    [allEdges, allNodes],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: WorkflowFlowNode) => {
      if (node.data?.nodeType === 'loop_start' || node.data?.nodeType === 'loop_end') return;
      selectNode(node.id);
      setConfigPanelOpen(true);
    },
    [selectNode, setConfigPanelOpen],
  );

  const onPaneClick = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  return (
    <ReactFlow
      nodes={storeNodes}
      edges={storeEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      nodeTypes={modalNodeTypes}
      edgeTypes={modalEdgeTypes}
      defaultEdgeOptions={{ type: 'workflowEdge' }}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={2}
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <Controls />
    </ReactFlow>
  );
}

// =============================================================================
// Modal shell
// =============================================================================

export function LoopBodyModal() {
  const expandedLoopId = useWorkflowCanvasStore((s) => s.expandedLoopId);
  const setExpandedLoopId = useWorkflowCanvasStore((s) => s.setExpandedLoopId);
  const selectNode = useWorkflowCanvasStore((s) => s.selectNode);
  const allNodes = useWorkflowCanvasStore((s) => s.nodes);

  if (!expandedLoopId) return null;

  const loopNode = allNodes.filter((n) => n.id === expandedLoopId)[0];
  const loopLabel = (loopNode?.data?.label as string) ?? 'Loop';

  const handleClose = () => {
    selectNode(null);
    setExpandedLoopId(null);
  };

  return (
    /* Absolute within canvas container — stays inside ReactFlow bounds */
    <div className="absolute inset-0 z-20 flex items-center justify-center p-8 bg-black/40">
      {/* Modal card */}
      <div className="relative flex flex-col w-full h-full max-w-4xl max-h-[85%] rounded-xl border border-default bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-default bg-background-elevated shrink-0">
          <span className="text-sm font-semibold text-foreground">{loopLabel}</span>
          <span className="text-xs text-foreground-muted">— Loop body</span>
          <button
            onClick={handleClose}
            className="ml-auto p-1.5 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          <ReactFlowProvider>
            <LoopBodyCanvas loopId={expandedLoopId} />
          </ReactFlowProvider>
        </div>
      </div>
    </div>
  );
}
