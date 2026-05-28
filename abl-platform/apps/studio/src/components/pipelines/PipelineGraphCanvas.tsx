/**
 * PipelineGraphCanvas
 *
 * React Flow canvas for the pipeline graph editor.
 * Handles node/edge rendering, drag-and-drop from NodePalette,
 * selection, deletion, and auto-layout.
 *
 * Pattern: follows ProjectCanvas.tsx setup.
 */

'use client';

import { useCallback, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Background,
  Controls,
  BackgroundVariant,
  ConnectionLineType,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import type {
  NodeTypes,
  EdgeTypes,
  NodeChange,
  EdgeChange,
  Node,
  Edge,
  Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { PipelineNode } from './PipelineNodeComponent';
import type { PipelineNodeData } from './PipelineNodeComponent';
import { PipelineGroupNode } from './PipelineGroupNode';
import { PipelineTriggerNode } from './PipelineTriggerNode';
import { PipelineEdge } from './PipelineEdgeComponent';
import { TRIGGER_NODE_ID, TRIGGER_EDGE_ID_PREFIX } from './pipeline-trigger-constants';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import type { NodeTypeDefinition } from '@agent-platform/pipeline-engine';

// =============================================================================
// Node / Edge type registrations
// =============================================================================

const pipelineNodeTypes: NodeTypes = {
  pipelineNode: PipelineNode,
  pipelineGroupNode: PipelineGroupNode,
  pipelineTriggerNode: PipelineTriggerNode,
};

const pipelineEdgeTypes: EdgeTypes = {
  pipelineEdge: PipelineEdge,
};

// =============================================================================
// Types
// =============================================================================

export interface PipelineGraphCanvasProps {
  className?: string;
}

// =============================================================================
// Wrapper with ReactFlowProvider
// =============================================================================

export function PipelineGraphCanvas({ className }: PipelineGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <PipelineGraphCanvasInner className={className} />
    </ReactFlowProvider>
  );
}

// =============================================================================
// Inner component (must be inside ReactFlowProvider)
// =============================================================================

function PipelineGraphCanvasInner({ className }: PipelineGraphCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  // ── Store state ──
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const edges = usePipelineEditorStore((s) => s.edges);
  const replaceNodes = usePipelineEditorStore((s) => s.replaceNodes);
  const replaceEdges = usePipelineEditorStore((s) => s.replaceEdges);
  const setNodes = usePipelineEditorStore((s) => s.setNodes);
  const setEdges = usePipelineEditorStore((s) => s.setEdges);
  const addNode = usePipelineEditorStore((s) => s.addNode);
  const addChildNode = usePipelineEditorStore((s) => s.addChildNode);
  const removeNode = usePipelineEditorStore((s) => s.removeNode);
  const removeEdge = usePipelineEditorStore((s) => s.removeEdge);
  const selectNode = usePipelineEditorStore((s) => s.selectNode);
  const selectEdge = usePipelineEditorStore((s) => s.selectEdge);
  const clearSelection = usePipelineEditorStore((s) => s.clearSelection);
  const selectedNodeId = usePipelineEditorStore((s) => s.selectedNodeId);
  const selectedEdgeId = usePipelineEditorStore((s) => s.selectedEdgeId);

  const nodeIdCounter = useRef(0);

  // ── Node/Edge change handlers ──

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const filtered = changes.filter((change) => {
        // Prevent removing the trigger node
        if (
          change.type === 'remove' &&
          'id' in change &&
          (change as { id: string }).id === TRIGGER_NODE_ID
        )
          return false;
        // Prevent dragging child nodes (they're auto-positioned inside groups)
        if (change.type === 'position' && 'id' in change) {
          const node = nodes.find((n) => n.id === change.id);
          if (node?.parentId) return false;
        }
        return true;
      });
      const nextNodes = applyNodeChanges(filtered, nodes);
      const hasPersistedChange = filtered.some(
        (change) => change.type !== 'dimensions' && change.type !== 'select',
      );

      if (hasPersistedChange) {
        setNodes(nextNodes);
        return;
      }

      replaceNodes(nextNodes);
    },
    [nodes, replaceNodes, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const nextEdges = applyEdgeChanges(changes, edges);
      const hasPersistedChange = changes.some((change) => change.type !== 'select');

      if (hasPersistedChange) {
        setEdges(nextEdges);
        return;
      }

      replaceEdges(nextEdges);
    },
    [edges, replaceEdges, setEdges],
  );

  // ── Connection handler ──

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      // Prevent connections TO the trigger node
      if (connection.target === TRIGGER_NODE_ID) return;

      // Trigger node: replace existing trigger edge (only one outgoing edge allowed)
      if (connection.source === TRIGGER_NODE_ID) {
        const targetNode = nodes.find((n) => n.id === connection.target);
        if (targetNode?.parentId) return; // Can't point trigger at a group child node

        const withoutOldTriggerEdge = edges.filter((e) => e.source !== TRIGGER_NODE_ID);
        const newEdge: Edge = {
          id: `${TRIGGER_EDGE_ID_PREFIX}${connection.target}`,
          source: TRIGGER_NODE_ID,
          target: connection.target,
          type: 'pipelineEdge',
        };
        setEdges([...withoutOldTriggerEdge, newEdge]);
        return;
      }

      // Prevent connecting from/to child nodes directly
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (sourceNode?.parentId || targetNode?.parentId) return;

      const newEdge: Edge = {
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        source: connection.source,
        target: connection.target,
        type: 'pipelineEdge',
      };

      setEdges([...edges, newEdge]);
    },
    [edges, setEdges, nodes],
  );

  // ── Drag and Drop from NodePalette ──

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      const raw = event.dataTransfer.getData('application/pipeline-node');
      if (!raw) return;

      let nodeType: NodeTypeDefinition;
      try {
        nodeType = JSON.parse(raw) as NodeTypeDefinition;
      } catch {
        return;
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      nodeIdCounter.current += 1;
      const nodeId = `node-${Date.now()}-${nodeIdCounter.current}`;

      // Check if dropped inside a group node
      const groupNode = nodes.find((n) => {
        if (n.type !== 'pipelineGroupNode') return false;
        const w = (n.style?.width as number) ?? 280;
        const h = (n.style?.height as number) ?? 200;
        return (
          position.x >= n.position.x &&
          position.x <= n.position.x + w &&
          position.y >= n.position.y &&
          position.y <= n.position.y + h
        );
      });

      // Don't allow nesting groups inside groups
      if (groupNode && nodeType.type === 'node-group') return;

      if (groupNode && nodeType.type !== 'node-group') {
        // Add as child of the group
        const nodeData: PipelineNodeData = {
          label: nodeType.label,
          activityType: nodeType.type,
          category: nodeType.category,
          config: {},
        };
        addChildNode(groupNode.id, {
          id: nodeId,
          type: 'pipelineNode',
          position: { x: 0, y: 0 }, // repositioned by addChildNode
          data: nodeData,
        });
      } else if (nodeType.type === 'node-group') {
        // Create an empty group node
        addNode({
          id: nodeId,
          type: 'pipelineGroupNode',
          position,
          style: { width: 280, height: 176 },
          data: {
            label: nodeType.label,
          },
        });
      } else {
        // Regular top-level node
        const nodeData: PipelineNodeData = {
          label: nodeType.label,
          activityType: nodeType.type,
          category: nodeType.category,
          config: {},
        };
        addNode({
          id: nodeId,
          type: 'pipelineNode',
          position,
          data: nodeData,
        });
      }
    },
    [screenToFlowPosition, addNode, addChildNode, nodes],
  );

  // ── Selection handlers ──

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      selectNode(node.id);
    },
    [selectNode],
  );

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      selectEdge(edge.id);
    },
    [selectEdge],
  );

  const handlePaneClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // ── Delete key handler ──

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Don't hijack input/textarea typing
      const target = event.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;
      if (isInput) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedNodeId === TRIGGER_NODE_ID) return;
        if (selectedNodeId) {
          removeNode(selectedNodeId);
        } else if (selectedEdgeId) {
          removeEdge(selectedEdgeId);
          clearSelection();
        }
      }
    },
    [selectedNodeId, selectedEdgeId, removeNode, removeEdge, clearSelection],
  );

  // ── MiniMap node color ──

  const miniMapNodeColor = useCallback((_node: Node) => {
    return 'hsl(var(--foreground-subtle))';
  }, []);

  return (
    <div className={className} onKeyDown={handleKeyDown} tabIndex={0} style={{ outline: 'none' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={pipelineNodeTypes}
        edgeTypes={pipelineEdgeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{
          stroke: 'hsl(var(--accent))',
          strokeWidth: 2,
          strokeDasharray: '5 5',
        }}
        defaultEdgeOptions={{ type: 'pipelineEdge' }}
        minZoom={0.1}
        maxZoom={2}
        snapToGrid
        snapGrid={[20, 20]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        className="pipeline-canvas-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls
          showInteractive={false}
          position="bottom-right"
          className="pipeline-canvas-controls"
        />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeStrokeWidth={2}
          maskColor="rgba(128, 128, 128, 0.15)"
          nodeColor={miniMapNodeColor}
          nodeBorderRadius={6}
          style={{ width: 160, height: 100 }}
        />
      </ReactFlow>
    </div>
  );
}
