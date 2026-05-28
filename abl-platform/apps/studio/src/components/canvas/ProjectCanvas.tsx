'use client';

import React, { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  useReactFlow,
  useOnViewportChange,
  applyNodeChanges,
  applyEdgeChanges,
  useUpdateNodeInternals,
} from '@xyflow/react';
import type {
  NodeTypes,
  EdgeTypes,
  NodeChange,
  EdgeChange,
  Viewport,
  Node,
  Edge,
  Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { clsx } from 'clsx';
import { toast } from 'sonner';

import { AgentNode, EscalationTargetNode } from './nodes';
import { RelationshipEdge } from './edges/RelationshipEdge';
import type { RelationshipType } from './edges/RelationshipEdge';
import { EdgeMarkerDefs } from './edges/EdgeMarkerDefs';
import { CanvasControls } from './CanvasControls';
import { CanvasLegend } from './CanvasLegend';
import { AgentDetailPanel } from './AgentDetailPanel';
import { AgentEditorSlider } from '../agent-editor';
import { ConnectionTypePicker } from './ConnectionTypePicker';
import type { ConnectionFormData } from './ConnectionTypePicker';
import { useAutoLayout } from './hooks/useAutoLayout';
import {
  topologyToReactFlowNodes,
  detectTopologyPattern,
  getLayoutConfigForPattern,
  findAvailablePosition,
} from './transform';

import {
  useCanvasViewportStore,
  useCanvasSelectionStore,
  useCanvasDataStore,
} from '../../store/canvas-store';
import {
  removeHandoff,
  removeDelegate,
  addHandoff,
  addDelegate,
  parseRelationships,
} from '../../lib/agent-canvas/dsl-updater';
import { saveDslWorkingCopy } from '../../api/runtime-agents';
import { PROJECT_NODE_DIMENSIONS } from './types';
import type { TopologyData } from '../../types/arch';
import type { RuntimeAgent } from '../../api/runtime-agents';

const projectNodeTypes: NodeTypes = {
  'agent-node': AgentNode,
  'escalation-target': EscalationTargetNode,
};

const projectEdgeTypes: EdgeTypes = {
  relationship: RelationshipEdge,
};

interface ProjectCanvasProps {
  topology: TopologyData;
  projectId: string;
  agents?: RuntimeAgent[];
  className?: string;
  onAgentClick?: (agentId: string) => void;
  onSaved?: () => void;
  onConnect?: (sourceAgent: string, targetAgent: string, data: ConnectionFormData) => void;
  /** Name of a newly created agent to focus on and open in slider */
  focusNewAgent?: string | null;
  /** Callback to clear the focusNewAgent after it has been handled */
  onFocusHandled?: () => void;
}

export function ProjectCanvas(props: ProjectCanvasProps) {
  return (
    <ReactFlowProvider>
      <ProjectCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ProjectCanvasInner({
  topology,
  projectId,
  agents: agentsProp,
  className,
  onAgentClick,
  onSaved,
  onConnect,
  focusNewAgent,
  onFocusHandled,
}: ProjectCanvasProps) {
  const {
    setCenter,
    fitView,
    zoomTo,
    getViewport: getRfViewport,
    setViewport: setRfViewport,
  } = useReactFlow();
  const [showLegend, setShowLegend] = useState(true);
  const [pendingConnection, setPendingConnection] = useState<{
    source: string;
    target: string;
    editMode?: {
      type: 'handoff' | 'delegate';
      when?: string;
      summary?: string;
      pass?: string;
      history?: import('@abl/core').HandoffHistoryConfig;
      return?: boolean;
      purpose?: string;
    };
  } | null>(null);

  const setViewport = useCanvasViewportStore((s) => s.setViewport);
  const semanticZoomLevel = useCanvasViewportStore((s) => s.semanticZoomLevel);
  const updateNodeInternals = useUpdateNodeInternals();
  const {
    selectNode,
    selectEdge,
    deselectAll,
    setHovered,
    openSidePanel,
    closeSidePanel,
    sidePanelContent,
  } = useCanvasSelectionStore();
  const { persistNodePosition, persistViewport, nodePositions, resetLayout, setTopologyPattern } =
    useCanvasDataStore();

  const pattern = useMemo(() => detectTopologyPattern(topology.nodes, topology.edges), [topology]);

  useEffect(() => {
    setTopologyPattern(pattern);
  }, [pattern, setTopologyPattern]);

  const layoutConfig = useMemo(() => getLayoutConfigForPattern(pattern), [pattern]);

  const { nodes: rfNodes, edges: rfEdges } = useMemo(
    () => topologyToReactFlowNodes(topology),
    [topology],
  );

  const persistedPositions = nodePositions[projectId];

  const { layoutedNodes, layoutedEdges, isComputing, layoutReady, recompute } = useAutoLayout(
    rfNodes,
    rfEdges,
    layoutConfig,
    persistedPositions,
  );

  // =========================================================================
  // LOCAL NODE STATE — React Flow controls these during drag
  // Seeded from ELK layout output; updated in real-time via onNodesChange
  // =========================================================================
  const [nodes, setNodes] = useState<Node[]>([]);
  const layoutVersionRef = useRef(0);

  useEffect(() => {
    if (layoutedNodes.length > 0) {
      layoutVersionRef.current++;
      setNodes(layoutedNodes);
    }
  }, [layoutedNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // =========================================================================
  // LOCAL EDGE STATE — needed for React Flow selection tracking
  // =========================================================================
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    setEdges(layoutedEdges);
  }, [layoutedEdges]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  // Fit view once after first layout completes
  const hasFittedRef = useRef(false);
  const hashRestoredRef = useRef(false);

  useEffect(() => {
    if (layoutReady && !hasFittedRef.current && layoutedNodes.length > 0) {
      hasFittedRef.current = true;
      // Persist all ELK-computed positions so subsequent topology refreshes
      // (from edge add/edit/delete) reuse positions instead of re-laying out
      for (const node of layoutedNodes) {
        if (node.position && (node.position.x !== 0 || node.position.y !== 0)) {
          persistNodePosition(projectId, node.id, node.position);
        }
      }
      requestAnimationFrame(() => {
        fitView({ padding: 0.15, maxZoom: 1.2, duration: 400 });
      });
    }
  }, [layoutReady, layoutedNodes, fitView, projectId, persistNodePosition]);

  // Recalculate edge paths when semantic zoom level changes (node dimensions change)
  const prevZoomLevelRef = useRef(semanticZoomLevel);
  useEffect(() => {
    if (prevZoomLevelRef.current !== semanticZoomLevel && nodes.length > 0) {
      prevZoomLevelRef.current = semanticZoomLevel;
      // Small delay to let CSS transitions start before recalculating edges
      requestAnimationFrame(() => {
        for (const node of nodes) {
          updateNodeInternals(node.id);
        }
      });
    }
  }, [semanticZoomLevel, nodes, updateNodeInternals]);

  // =========================================================================
  // FOCUS NEW AGENT — position, pan, and open slider for newly created agent
  // =========================================================================
  const focusHandledRef = useRef<string | null>(null);
  const focusRetryRef = useRef(0);
  const [focusRetryTick, setFocusRetryTick] = useState(0);

  useEffect(() => {
    if (!focusNewAgent || !layoutReady || focusHandledRef.current === focusNewAgent) {
      return;
    }

    // Find the node matching the new agent name
    const targetNode = nodes.find(
      (n) => (n.data as Record<string, unknown>).name === focusNewAgent,
    );

    if (!targetNode) {
      // Node not in topology yet — SWR may still be refetching
      const attempt = focusRetryRef.current;
      if (attempt < 3) {
        focusRetryRef.current = attempt + 1;
        const timer = setTimeout(() => {
          setFocusRetryTick((t) => t + 1);
        }, 600);
        return () => clearTimeout(timer);
      }
      // Give up after 3 retries
      onFocusHandled?.();
      return;
    }
    focusRetryRef.current = 0;
    focusHandledRef.current = focusNewAgent;

    // If the node is at (0,0) it may not have been positioned yet — compute a smart position
    if (targetNode.position.x === 0 && targetNode.position.y === 0) {
      const otherNodes = nodes.filter((n) => n.id !== targetNode.id);
      const newPos = findAvailablePosition(otherNodes);
      targetNode.position = newPos;
      persistNodePosition(projectId, targetNode.id, newPos);
      setNodes((prev) =>
        prev.map((n) => (n.id === targetNode.id ? { ...n, position: newPos } : n)),
      );
    }

    // Smooth pan to the new node
    const dims = PROJECT_NODE_DIMENSIONS['agent-node'];
    requestAnimationFrame(() => {
      setCenter(targetNode.position.x + dims.width / 2, targetNode.position.y + dims.height / 2, {
        zoom: 0.85,
        duration: 800,
      });
    });

    // Open the slider editor for the new agent
    selectNode(targetNode.id);
    openSidePanel({
      type: 'node',
      id: targetNode.id,
      data: targetNode.data as Record<string, unknown>,
    });

    onFocusHandled?.();
  }, [
    focusNewAgent,
    layoutReady,
    nodes,
    setCenter,
    selectNode,
    openSidePanel,
    persistNodePosition,
    projectId,
    onFocusHandled,
    setNodes,
    focusRetryTick,
  ]);

  // =========================================================================
  // KEYBOARD SHORTCUTS
  // =========================================================================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingConnection) {
          setPendingConnection(null);
          return;
        }
        deselectAll();
      }
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        fitView({ padding: 0.15, maxZoom: 1.2, duration: 400 });
      }

      // Guard: don't hijack typing in inputs
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;
      if (isInput) return;

      if (e.key === 'f') {
        fitView({ padding: 0.15, duration: 400 });
      }
      if (e.key === '1') {
        zoomTo(1.0, { duration: 300 });
      }
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        e.preventDefault();
        const vp = getRfViewport();
        const PAN_DELTA = 50;
        const dx = e.key === 'ArrowLeft' ? PAN_DELTA : e.key === 'ArrowRight' ? -PAN_DELTA : 0;
        const dy = e.key === 'ArrowUp' ? PAN_DELTA : e.key === 'ArrowDown' ? -PAN_DELTA : 0;
        setRfViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 200 });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deselectAll, fitView, zoomTo, getRfViewport, setRfViewport, pendingConnection]);

  // =========================================================================
  // EVENT HANDLERS
  // =========================================================================

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      selectNode(node.id);
      if (node.type === 'agent-node') {
        openSidePanel({
          type: 'node',
          id: node.id,
          data: node.data as Record<string, unknown>,
        });
      }
    },
    [selectNode, openSidePanel],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const dims =
        PROJECT_NODE_DIMENSIONS[
          (node.type as keyof typeof PROJECT_NODE_DIMENSIONS) ?? 'agent-node'
        ] ?? PROJECT_NODE_DIMENSIONS['agent-node'];
      setCenter(node.position.x + dims.width / 2, node.position.y + dims.height / 2, {
        zoom: 1.0,
        duration: 400,
      });

      // Attention pulse after centering animation completes
      setTimeout(() => {
        const domNode = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
        if (domNode) {
          domNode.classList.add('canvas-node-attention');
          domNode.addEventListener(
            'animationend',
            () => {
              domNode.classList.remove('canvas-node-attention');
            },
            { once: true },
          );
        }
      }, 400);
    },
    [setCenter],
  );

  const handleNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => setHovered(node.id),
    [setHovered],
  );

  const handleNodeMouseLeave = useCallback(() => setHovered(null), [setHovered]);

  const handleNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      persistNodePosition(projectId, node.id, node.position);
    },
    [projectId, persistNodePosition],
  );

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      selectEdge(edge.id);

      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);

      openSidePanel({
        type: 'edge',
        id: edge.id,
        data: {
          ...(edge.data ?? {}),
          source: edge.source,
          target: edge.target,
          sourceName: (sourceNode?.data as Record<string, unknown>)?.name ?? edge.source,
          targetName: (targetNode?.data as Record<string, unknown>)?.name ?? edge.target,
        },
      });
    },
    [selectEdge, openSidePanel, nodes],
  );

  const handlePaneClick = useCallback(() => deselectAll(), [deselectAll]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      const sourceName = (sourceNode?.data as Record<string, unknown>)?.name as string;
      const targetName = (targetNode?.data as Record<string, unknown>)?.name as string;
      if (!sourceName || !targetName) return;
      setPendingConnection({ source: sourceName, target: targetName });
    },
    [nodes],
  );

  const handleConnectionTypeSelect = useCallback(
    (data: ConnectionFormData) => {
      if (pendingConnection && onConnect) {
        onConnect(pendingConnection.source, pendingConnection.target, data);
      }
      setPendingConnection(null);
    },
    [pendingConnection, onConnect],
  );

  const handleConnectionCancel = useCallback(() => {
    setPendingConnection(null);
  }, []);

  const handleResetLayout = useCallback(() => {
    hasFittedRef.current = false;
    resetLayout(projectId);
    recompute();
  }, [projectId, resetLayout, recompute]);

  // =========================================================================
  // URL HASH STATE — #agent/{name} for deep-linking
  // =========================================================================

  // Restore: auto-open agent detail from URL hash on initial layout
  useEffect(() => {
    if (!layoutReady || hashRestoredRef.current || nodes.length === 0) return;
    hashRestoredRef.current = true;

    const hash = window.location.hash;
    if (!hash.startsWith('#agent/')) return;

    const agentName = decodeURIComponent(hash.slice('#agent/'.length));
    const node = nodes.find((n) => (n.data as Record<string, unknown>)?.name === agentName);
    if (node) {
      selectNode(node.id);
      openSidePanel({
        type: 'node',
        id: node.id,
        data: node.data as Record<string, unknown>,
      });
    }
  }, [layoutReady, nodes, selectNode, openSidePanel]);

  // Sync: update URL hash when agent detail panel opens/closes
  useEffect(() => {
    if (!hashRestoredRef.current) return;

    if (sidePanelContent?.type === 'node') {
      const name = sidePanelContent.data.name as string;
      if (name) {
        window.history.replaceState(null, '', `#agent/${encodeURIComponent(name)}`);
      }
    } else if (window.location.hash.startsWith('#agent/')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [sidePanelContent]);

  // =========================================================================
  // EDGE DELETION via custom event from RelationshipEdge
  // =========================================================================

  useEffect(() => {
    const handleEdgeDelete = async (e: Event) => {
      const { source, target, relationshipType } = (e as CustomEvent).detail as {
        edgeId: string;
        source: string;
        target: string;
        relationshipType: RelationshipType;
      };

      if (!agentsProp) return;
      const agent = agentsProp.find((a) => a.name === source);
      if (!agent?.dslContent) {
        toast.error(`Agent "${source}" has no ABL definition`);
        return;
      }

      const rels = parseRelationships(agent.dslContent);
      if (!rels) {
        toast.error('Failed to parse agent definition');
        return;
      }

      const tgtLower = target.toLowerCase();
      let updatedDsl: string | null = null;
      if (relationshipType === 'handoff') {
        const idx = rels.handoffs.findIndex((h) => h.to.toLowerCase() === tgtLower);
        if (idx >= 0) updatedDsl = removeHandoff(agent.dslContent, idx);
      } else if (relationshipType === 'delegate') {
        const idx = rels.delegates.findIndex((d) => d.agent.toLowerCase() === tgtLower);
        if (idx >= 0) updatedDsl = removeDelegate(agent.dslContent, idx);
      }

      if (!updatedDsl) {
        toast.error('Relationship not found');
        return;
      }

      try {
        await saveDslWorkingCopy(projectId, source, updatedDsl);
        toast.success('Relationship deleted');
        deselectAll();
        onSaved?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        toast.error(message);
      }
    };

    window.addEventListener('canvas-edge-delete', handleEdgeDelete);
    return () => window.removeEventListener('canvas-edge-delete', handleEdgeDelete);
  }, [agentsProp, projectId, deselectAll, onSaved]);

  // =========================================================================
  // EDGE EDIT — open config form pre-populated with edge values
  // =========================================================================

  useEffect(() => {
    const handleEdgeEdit = (e: Event) => {
      const { source, target, relationshipType } = (e as CustomEvent).detail as {
        edgeId: string;
        source: string;
        target: string;
        relationshipType: 'handoff' | 'delegate';
      };

      if (!agentsProp) return;
      const agent = agentsProp.find((a) => a.name === source);
      if (!agent?.dslContent) return;

      const rels = parseRelationships(agent.dslContent);
      if (!rels) return;

      let editData: NonNullable<typeof pendingConnection>['editMode'];
      const targetLower = target.toLowerCase();
      if (relationshipType === 'handoff') {
        const h = rels.handoffs.find((h) => h.to.toLowerCase() === targetLower);
        editData = {
          type: 'handoff',
          when: h?.when ?? '',
          summary: h?.context?.summary ?? '',
          return: h?.return !== false,
        };
      } else {
        const d = rels.delegates.find((d) => d.agent.toLowerCase() === targetLower);
        editData = {
          type: 'delegate',
          when: d?.when ?? '',
          purpose: d?.purpose ?? '',
        };
      }

      deselectAll();
      setPendingConnection({ source, target, editMode: editData });
    };

    window.addEventListener('canvas-edge-edit', handleEdgeEdit);
    return () => window.removeEventListener('canvas-edge-edit', handleEdgeEdit);
  }, [agentsProp, deselectAll]);

  // =========================================================================
  // EDGE CHANGE TYPE — remove old type, create new type
  // =========================================================================

  useEffect(() => {
    const handleEdgeChangeType = async (e: Event) => {
      const { source, target, oldType, newType } = (e as CustomEvent).detail as {
        edgeId: string;
        source: string;
        target: string;
        oldType: string;
        newType: string;
      };

      if (!agentsProp) return;
      const agent = agentsProp.find((a) => a.name === source);
      if (!agent?.dslContent) {
        toast.error(`Agent "${source}" has no ABL definition`);
        return;
      }

      const rels = parseRelationships(agent.dslContent);
      if (!rels) {
        toast.error('Failed to parse agent definition');
        return;
      }

      let dsl = agent.dslContent;
      let when = '';
      const ctTgtLower = target.toLowerCase();

      // Remove old relationship and capture its When condition
      if (oldType === 'handoff') {
        const idx = rels.handoffs.findIndex((h) => h.to.toLowerCase() === ctTgtLower);
        if (idx >= 0) {
          when = rels.handoffs[idx].when ?? '';
          const removed = removeHandoff(dsl, idx);
          if (!removed) {
            toast.error('Failed to remove old relationship');
            return;
          }
          dsl = removed;
        }
      } else if (oldType === 'delegate') {
        const idx = rels.delegates.findIndex((d) => d.agent.toLowerCase() === ctTgtLower);
        if (idx >= 0) {
          when = rels.delegates[idx].when ?? '';
          const removed = removeDelegate(dsl, idx);
          if (!removed) {
            toast.error('Failed to remove old relationship');
            return;
          }
          dsl = removed;
        }
      }

      // Create new relationship of the other type
      if (newType === 'handoff') {
        const added = addHandoff(dsl, target, { when });
        if (!added) {
          toast.error('Failed to create new relationship');
          return;
        }
        dsl = added;
      } else if (newType === 'delegate') {
        const added = addDelegate(dsl, target, { when, purpose: when || `Delegate to ${target}` });
        if (!added) {
          toast.error('Failed to create new relationship');
          return;
        }
        dsl = added;
      }

      try {
        await saveDslWorkingCopy(projectId, source, dsl);
        toast.success(`Changed to ${newType}`);
        deselectAll();
        onSaved?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Change failed';
        toast.error(message);
      }
    };

    window.addEventListener('canvas-edge-change-type', handleEdgeChangeType);
    return () => window.removeEventListener('canvas-edge-change-type', handleEdgeChangeType);
  }, [agentsProp, projectId, deselectAll, onSaved]);

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <div className={clsx('relative w-full h-full bg-background-subtle p-6', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        connectionLineStyle={{
          stroke: 'hsl(var(--color-brand-primary))',
          strokeWidth: 2,
          strokeDasharray: '5 5',
        }}
        connectionLineType={ConnectionLineType.SmoothStep}
        nodeTypes={projectNodeTypes}
        edgeTypes={projectEdgeTypes}
        minZoom={0.1}
        maxZoom={2}
        snapToGrid
        snapGrid={[20, 20]}
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeDragStop={handleNodeDragStop}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        deleteKeyCode={null}
        selectionKeyCode={null}
        onlyRenderVisibleElements={topology.nodes.length > 15}
        className="canvas-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeStrokeWidth={2}
          maskColor="rgba(128, 128, 128, 0.15)"
          nodeColor={(node: Node) => {
            const d = node.data as Record<string, unknown>;
            if (d?.agentType === 'supervisor') return 'hsl(var(--minimap-supervisor))';
            if (d?.isEntry) return 'hsl(var(--minimap-entry))';
            return 'hsl(var(--minimap-node))';
          }}
          nodeStrokeColor={(node: Node) => {
            const d = node.data as Record<string, unknown>;
            if (d?.agentType === 'supervisor') return 'hsl(var(--minimap-supervisor-stroke))';
            return 'hsl(var(--minimap-node-stroke))';
          }}
          nodeBorderRadius={6}
          className="canvas-minimap"
          style={{ width: 180, height: 110 }}
        />
        <EdgeMarkerDefs />
        <ViewportTracker
          onViewportChange={(v) => setViewport(v.zoom, { x: v.x, y: v.y })}
          projectId={projectId}
          persistViewport={persistViewport}
        />
        <CanvasControls
          onResetLayout={handleResetLayout}
          showLegend={showLegend}
          onToggleLegend={() => setShowLegend((s) => !s)}
        />
      </ReactFlow>

      {showLegend && <CanvasLegend />}

      {isComputing && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-30 pointer-events-none">
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            Computing layout…
          </div>
        </div>
      )}

      {/* OLD: AgentDetailPanel — kept for revert if needed
      {agentsProp && agentsProp.length > 0 && (
        <AgentDetailPanel
          projectId={projectId}
          agents={agentsProp}
          topologyEdges={edges}
          onSaved={onSaved ?? (() => {})}
        />
      )}
      */}

      {/* NEW: Unified AgentEditorSlider */}
      <AgentEditorSlider
        projectId={projectId}
        agentName={
          sidePanelContent?.type === 'node'
            ? ((sidePanelContent.data.name as string) ?? null)
            : null
        }
        agents={agentsProp?.map((a) => ({ name: a.name }))}
        onClose={closeSidePanel}
        onSaved={onSaved}
      />

      <ConnectionTypePicker
        pendingConnection={pendingConnection}
        onSelect={handleConnectionTypeSelect}
        onCancel={handleConnectionCancel}
      />
    </div>
  );
}

function ViewportTracker({
  onViewportChange,
  projectId,
  persistViewport,
}: {
  onViewportChange: (v: Viewport) => void;
  projectId: string;
  persistViewport: (projectId: string, viewport: Viewport) => void;
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [projectId]);

  useOnViewportChange({
    onChange: (viewport) => {
      onViewportChange(viewport);
    },
    onEnd: (viewport) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        persistViewport(projectId, viewport);
      }, 500);
    },
  });

  return null;
}
