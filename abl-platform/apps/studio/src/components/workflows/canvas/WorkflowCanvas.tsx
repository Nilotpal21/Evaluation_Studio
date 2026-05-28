/**
 * WorkflowCanvas
 *
 * Core XY Flow canvas for the workflow node editor.
 * Handles node/edge rendering, drag-and-drop from the assets sidebar,
 * selection, deletion, and background.
 */

'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  ReactFlow,
  MiniMap,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  useReactFlow,
  PanOnScrollMode,
} from '@xyflow/react';
import type { NodeTypes, EdgeTypes, Node, Edge, Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles/canvas-animations.css';
import { LayoutGrid, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import type { WorkflowNodeData } from '../../../store/workflow-canvas-store';
import { isValidWorkflowConnection } from '../../../store/workflow-canvas-helpers';
import { WorkflowNodeComponent } from './nodes/WorkflowNodeComponent';
import { StartNodeComponent } from './nodes/StartNodeComponent';
import { EndNodeComponent } from './nodes/EndNodeComponent';
import { LoopNodeComponent } from './nodes/LoopNodeComponent';
import { LoopStartNodeComponent } from './nodes/LoopStartNodeComponent';
import { LoopEndNodeComponent } from './nodes/LoopEndNodeComponent';
import { WorkflowEdgeComponent } from './edges/WorkflowEdgeComponent';
import { useWorkflowAutoLayout } from './hooks/useWorkflowAutoLayout';
import type { NodeType } from '@agent-platform/shared-kernel/types';

// =============================================================================
// Node / Edge type registrations (stable reference outside component)
// =============================================================================

const workflowNodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent,
  startNode: StartNodeComponent,
  endNode: EndNodeComponent,
  loopNode: LoopNodeComponent,
  loopStartNode: LoopStartNodeComponent,
  loopEndNode: LoopEndNodeComponent,
};

const workflowEdgeTypes: EdgeTypes = {
  workflowEdge: WorkflowEdgeComponent,
};

// =============================================================================
// Component
// =============================================================================

export function WorkflowCanvas() {
  const t = useTranslations('workflows.canvas');
  const { screenToFlowPosition, fitView } = useReactFlow();
  const { autoLayout, isComputing } = useWorkflowAutoLayout();

  // Store state
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const onNodesChange = useWorkflowCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowCanvasStore((s) => s.onEdgesChange);
  const onConnect = useWorkflowCanvasStore((s) => s.onConnect);
  const addNode = useWorkflowCanvasStore((s) => s.addNode);
  const arrangeNodes = useWorkflowCanvasStore((s) => s.arrangeNodes);
  const selectNode = useWorkflowCanvasStore((s) => s.selectNode);
  const setConfigPanelOpen = useWorkflowCanvasStore((s) => s.setConfigPanelOpen);
  const setDebugPanelOpen = useWorkflowCanvasStore((s) => s.setDebugPanelOpen);

  const handleAutoArrange = useCallback(async () => {
    if (nodes.length === 0) return;
    const positioned = await autoLayout(nodes, edges);
    arrangeNodes(positioned);
    // Give React a tick to apply the new positions before fitting the viewport.
    requestAnimationFrame(() =>
      fitView({ padding: 0.2, minZoom: 0.9, maxZoom: 1.2, duration: 300 }),
    );
  }, [nodes, edges, autoLayout, arrangeNodes, fitView]);

  // Live connection validity — called every mouse move during a connect drag.
  // Blocks self-loops and cycles (with a carve-out for edges targeting `loop`
  // nodes so loop back-edges still work). Also emits one toast per invalid
  // drag so the user knows why the connector turned red.
  const lastRejectToastRef = useRef<number>(0);
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const ok = isValidWorkflowConnection(edges, nodes, c);
      if (!ok && c.source && c.target) {
        const sourceNode = nodes.find((n) => n.id === c.source);
        const targetNode = nodes.find((n) => n.id === c.target);
        const sourceType = sourceNode?.data?.nodeType;
        const now = Date.now();
        // loop_start sources and cross-boundary attempts are rejected silently.
        if (sourceType === 'loop_start' || sourceNode?.parentId !== targetNode?.parentId) {
          return false;
        }
        if (now - lastRejectToastRef.current > 1500) {
          lastRejectToastRef.current = now;
          toast.error(
            c.source === c.target
              ? 'Self-connections are not allowed'
              : 'Cannot connect: this would create an infinite loop in the workflow.',
          );
        }
      }
      return ok;
    },
    [edges, nodes],
  );

  // Drag-and-drop from sidebar
  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      const nodeType = event.dataTransfer.getData('application/workflow-node');
      if (!nodeType) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // When dropping onto a loop container (but not a loop itself), add as a child node
      if (nodeType !== 'loop') {
        const loopUnder = nodes.find(
          (n) =>
            n.data?.nodeType === 'loop' &&
            n.style?.width &&
            n.style?.height &&
            position.x >= n.position.x &&
            position.x <= n.position.x + Number(n.style.width) &&
            position.y >= n.position.y &&
            position.y <= n.position.y + Number(n.style.height),
        );

        if (loopUnder) {
          const relativePos = {
            x: position.x - loopUnder.position.x,
            y: position.y - loopUnder.position.y,
          };
          const loopStartChild = nodes.find(
            (n) => n.parentId === loopUnder.id && n.data?.nodeType === 'loop_start',
          );
          if (loopStartChild) {
            addNode(nodeType as NodeType, relativePos, {
              nodeId: loopStartChild.id,
              handleId: 'loop_body',
            });
            return;
          }
        }
      }

      addNode(nodeType as NodeType, position);
    },
    [screenToFlowPosition, addNode, nodes],
  );

  // Selection handlers — skip config panel when clicking handle/plus-menu elements
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const target = event.target as HTMLElement;
      // Don't open config panel when interacting with handles, plus menu, or loop dropdown
      if (
        target.closest('[data-testid^="handle-plus-"]') ||
        target.closest('[data-testid="handle-plus-menu"]') ||
        target.closest('.react-flow__handle') ||
        target.closest('[data-loop-dropdown]')
      ) {
        return;
      }
      // loop_start is an internal marker — no config panel
      const data = node.data as WorkflowNodeData | undefined;
      if (data?.nodeType === 'loop_start') return;

      selectNode(node.id);
      setConfigPanelOpen(true);
      setDebugPanelOpen(false);
    },
    [selectNode, setConfigPanelOpen, setDebugPanelOpen],
  );

  const handlePaneClick = useCallback(() => {
    selectNode(null);
    setConfigPanelOpen(false);
  }, [selectNode, setConfigPanelOpen]);

  // Delete handlers
  const handleNodesDelete = useCallback((deletedNodes: Node[]) => {
    const store = useWorkflowCanvasStore.getState();
    for (const node of deletedNodes) {
      store.removeNode(node.id);
    }
  }, []);

  // MiniMap node color
  const miniMapNodeColor = useCallback((node: Node) => {
    const data = node.data as WorkflowNodeData | undefined;
    return data?.color ?? 'hsl(var(--foreground-subtle))';
  }, []);

  return (
    <div className="h-full w-full relative canvas-vignette" data-testid="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodesDelete={handleNodesDelete}
        nodeTypes={workflowNodeTypes}
        edgeTypes={workflowEdgeTypes}
        defaultEdgeOptions={{ type: 'workflowEdge' }}
        snapToGrid={false}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.8, maxZoom: 1.2 }}
        minZoom={0.1}
        maxZoom={2}
        /* Figma-like canvas interaction:
           - Scroll wheel = horizontal pan (panOnScroll + free mode)
           - Ctrl+scroll / pinch = zoom
           - Click+drag on pane = pan */
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={0.8}
          color="rgba(148, 163, 184, 0.5)"
        />
        <Panel position="top-left">
          <button
            type="button"
            onClick={handleAutoArrange}
            disabled={isComputing || nodes.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-default bg-background-elevated text-xs text-foreground-muted hover:text-foreground hover:bg-background-muted shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Auto-arrange nodes (left-to-right)"
            data-testid="workflow-canvas-auto-arrange"
          >
            {isComputing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LayoutGrid className="w-3.5 h-3.5" />
            )}
            {t('arrange')}
          </button>
        </Panel>
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeStrokeWidth={2}
          maskColor="rgba(128, 128, 128, 0.15)"
          nodeColor={miniMapNodeColor}
          nodeBorderRadius={6}
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>
    </div>
  );
}
