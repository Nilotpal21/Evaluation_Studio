/**
 * ABL Canvas - Main React Flow canvas for visual editing
 */

import React, { useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeTypes,
  type Node,
  type Edge,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
  BackgroundVariant,
  Panel,
} from '@xyflow/react';
import { useEditorStore } from '../store/editorStore.js';
import { nodeTypes } from './nodes/index.js';
import type { DSLNode, DSLEdge, BaseNodeData, DSLEdgeData } from '../types.js';

// Import React Flow styles
import '@xyflow/react/dist/style.css';

export interface ABLCanvasProps {
  className?: string;
  onNodeDoubleClick?: (nodeId: string, data: BaseNodeData) => void;
}

export const ABLCanvas: React.FC<ABLCanvasProps> = ({ className = '', onNodeDoubleClick }) => {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Store state and actions
  const nodes = useEditorStore((state) => state.nodes);
  const edges = useEditorStore((state) => state.edges);
  const showGrid = useEditorStore((state) => state.showGrid);
  const showMinimap = useEditorStore((state) => state.showMinimap);
  const selection = useEditorStore((state) => state.selection);

  const setNodes = useEditorStore((state) => state.setNodes);
  const setEdges = useEditorStore((state) => state.setEdges);
  const selectNode = useEditorStore((state) => state.selectNode);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const pushHistory = useEditorStore((state) => state.pushHistory);

  // Handle node changes (position, selection, removal)
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const newNodes = applyNodeChanges(changes, nodes);
      setNodes(newNodes as DSLNode[]);
    },
    [nodes, setNodes],
  );

  // Handle edge changes
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const newEdges = applyEdgeChanges(changes, edges);
      setEdges(newEdges as DSLEdge[]);
    },
    [edges, setEdges],
  );

  // Handle new connections
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const newEdge: DSLEdge = {
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle || undefined,
        targetHandle: connection.targetHandle || undefined,
        data: {
          type: 'step-flow',
        },
      };

      setEdges([...edges, newEdge]);
      pushHistory('Added connection');
    },
    [edges, setEdges, pushHistory],
  );

  // Handle node click for selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const isMultiSelect = _event.shiftKey || _event.metaKey;
      selectNode(node.id, isMultiSelect);
    },
    [selectNode],
  );

  // Handle node double click
  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onNodeDoubleClick) {
        onNodeDoubleClick(node.id, node.data as BaseNodeData);
      }
    },
    [onNodeDoubleClick],
  );

  // Handle pane click to clear selection
  const onPaneClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // Handle drag over for drop zone
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Handle drop to add new nodes
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      if (!reactFlowWrapper.current) return;

      const data = event.dataTransfer.getData('application/dsl-node');
      if (!data) return;

      try {
        const nodeData = JSON.parse(data);
        const bounds = reactFlowWrapper.current.getBoundingClientRect();
        const position = {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        };

        const newNode: DSLNode = {
          id: `node-${Date.now()}`,
          type: nodeData.type,
          position,
          data: {
            ...nodeData.data,
            label: nodeData.data.label || `New ${nodeData.type}`,
          },
        };

        setNodes([...nodes, newNode]);
        pushHistory(`Added ${nodeData.type} node`);
      } catch (e) {
        console.error('Failed to parse dropped node data:', e);
      }
    },
    [nodes, setNodes, pushHistory],
  );

  // Edge styling based on type
  const getEdgeStyle = (edge: Edge) => {
    const data = edge.data as DSLEdgeData | undefined;
    if (!data) return {};

    const styles: Record<string, React.CSSProperties> = {
      routing: { stroke: '#f97316', strokeWidth: 2 },
      'step-flow': { stroke: '#6366f1', strokeWidth: 2 },
      'tool-call': { stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '5,5' },
      'agent-reference': { stroke: '#10b981', strokeWidth: 2 },
      'state-update': { stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '3,3' },
    };

    return styles[data.type] || {};
  };

  return (
    <div ref={reactFlowWrapper} className={`dsl-canvas ${className}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes as NodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={onPaneClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        snapToGrid
        snapGrid={[15, 15]}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
        }}
        connectionLineStyle={{ stroke: '#6366f1', strokeWidth: 2 }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift', 'Meta']}
      >
        {showGrid && (
          <Background variant={BackgroundVariant.Dots} gap={15} size={1} color="#e5e7eb" />
        )}

        <Controls showInteractive={false} />

        {showMinimap && (
          <MiniMap
            nodeColor={(node) => {
              const colors: Record<string, string> = {
                supervisor: '#8b5cf6',
                agent: '#6366f1',
                step: '#3b82f6',
                'routing-rule': '#f97316',
                tool: '#8b5cf6',
                guardrail: '#10b981',
              };
              return colors[node.type || ''] || '#6b7280';
            }}
            maskColor="rgba(255, 255, 255, 0.8)"
            style={{ backgroundColor: '#f9fafb' }}
          />
        )}

        <Panel position="top-left" className="canvas-info-panel">
          <div className="node-count">
            {nodes.length} nodes, {edges.length} edges
          </div>
          {selection.nodeIds.length > 0 && (
            <div className="selection-info">{selection.nodeIds.length} selected</div>
          )}
        </Panel>
      </ReactFlow>
    </div>
  );
};

export default ABLCanvas;
