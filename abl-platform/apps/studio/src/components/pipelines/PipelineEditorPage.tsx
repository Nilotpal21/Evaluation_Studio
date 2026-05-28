/**
 * PipelineEditorPage
 *
 * Full-page graph editor for custom pipelines.
 * Composes: PipelineEditorToolbar (top), NodePalette (left),
 * PipelineGraphCanvas (center), NodeConfigPanel (right slide-over).
 *
 * Layout:
 * ┌──────────────────────────────────────────────┐
 * │ PipelineEditorToolbar                         │
 * ├──────────┬────────────────────┬──────────────┤
 * │ NodePal  │ PipelineGraphCanvas │ NodeConfig  │
 * │ (240px)  │ (flex-1)            │ (320px)     │
 * │          │                     │ (slide-over)│
 * └──────────┴────────────────────┴──────────────┘
 */

'use client';

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import type { Node, Edge } from '@xyflow/react';
import type {
  PipelineDefinition,
  PipelineNode as BackendPipelineNode,
  NodeTransition,
  NodeTypeDefinition,
  GroupChildNode,
} from '@agent-platform/pipeline-engine';
import { swrFetcher } from '../../lib/swr-config';
import { apiFetch } from '../../lib/api-client';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { usePipelineEditorStore, type SelectedTrigger } from '../../store/pipeline-editor-store';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { useRunsStore } from '../../store/pipeline-runs-store';
import { usePipelineAutoLayout } from './usePipelineAutoLayout';
import { PipelineEditorToolbar } from './PipelineEditorToolbar';
import { NodePalette } from './NodePalette';
import { PipelineGraphCanvas } from './PipelineGraphCanvas';
import { NodeConfigPanel } from './NodeConfigPanel';
import { PipelineTestDrawer } from './PipelineTestDrawer';
import { TemplatePicker } from './TemplatePicker';
import { PIPELINE_NODE_WIDTH, PIPELINE_NODE_HEIGHT } from './PipelineNodeComponent';
import type { PipelineNodeData } from './PipelineNodeComponent';
import { validatePipelineDraft } from './pipeline-draft-validation';
import {
  GROUP_PADDING_X,
  GROUP_PADDING_TOP,
  GROUP_PADDING_BOTTOM,
  CHILD_GAP,
} from './PipelineGroupNode';
import {
  TRIGGER_NODE_ID,
  TRIGGER_EDGE_ID_PREFIX,
  TRIGGER_POSITION_OFFSET_Y,
  buildTriggerSummary,
  type TriggerNodeData,
} from './pipeline-trigger-constants';

// =============================================================================
// Conversion helpers: Backend <-> React Flow
// =============================================================================

/**
 * Convert backend PipelineNode[] to React Flow Node[].
 * node-group nodes are split into a parent group node + child nodes with parentId.
 */
function toReactFlowNodes(pipelineNodes: BackendPipelineNode[]): Node[] {
  const result: Node[] = [];

  for (const pn of pipelineNodes) {
    if (pn.type === 'node-group' && pn.children && pn.children.length > 0) {
      const childCount = pn.children.length;
      const groupWidth = Math.max(
        280,
        GROUP_PADDING_X * 2 + childCount * PIPELINE_NODE_WIDTH + (childCount - 1) * CHILD_GAP,
      );
      const groupHeight = GROUP_PADDING_TOP + PIPELINE_NODE_HEIGHT + GROUP_PADDING_BOTTOM;

      // Group container node
      result.push({
        id: pn.id,
        type: 'pipelineGroupNode',
        position: pn.position ?? { x: 0, y: 0 },
        style: { width: groupWidth, height: groupHeight },
        data: {
          label: pn.label ?? 'Parallel Group',
          timeout: pn.timeout,
          retries: pn.retries,
          onFailure: pn.onFailure,
        },
      });

      // Child nodes positioned horizontally inside the group
      for (let i = 0; i < pn.children.length; i++) {
        const child = pn.children[i];
        result.push({
          id: child.id,
          type: 'pipelineNode',
          parentId: pn.id,
          extent: 'parent' as const,
          position: {
            x: GROUP_PADDING_X + i * (PIPELINE_NODE_WIDTH + CHILD_GAP),
            y: GROUP_PADDING_TOP,
          },
          data: {
            label: child.label ?? child.type,
            activityType: child.type,
            category: 'compute', // enriched later
            config: child.config ?? {},
            timeout: child.timeout,
            retries: child.retries,
            onFailure: child.onFailure,
          } satisfies PipelineNodeData,
        });
      }
    } else if (pn.type === 'node-group') {
      // Empty group node
      result.push({
        id: pn.id,
        type: 'pipelineGroupNode',
        position: pn.position ?? { x: 0, y: 0 },
        style: {
          width: 280,
          height: GROUP_PADDING_TOP + PIPELINE_NODE_HEIGHT + GROUP_PADDING_BOTTOM,
        },
        data: {
          label: pn.label ?? 'Parallel Group',
          timeout: pn.timeout,
          retries: pn.retries,
          onFailure: pn.onFailure,
        },
      });
    } else {
      // Regular node
      result.push({
        id: pn.id,
        type: 'pipelineNode',
        position: pn.position ?? { x: 0, y: 0 },
        data: {
          label: pn.label ?? pn.type,
          activityType: pn.type,
          category: 'compute',
          config: pn.config ?? {},
          timeout: pn.timeout,
          retries: pn.retries,
          onFailure: pn.onFailure,
        } satisfies PipelineNodeData,
      });
    }
  }

  return result;
}

/**
 * Convert backend PipelineNode[].transitions to React Flow Edge[].
 * Each transition becomes an edge from the source node to the target node.
 */
function toReactFlowEdges(pipelineNodes: BackendPipelineNode[]): Edge[] {
  const edges: Edge[] = [];
  for (const pn of pipelineNodes) {
    for (const tr of pn.transitions ?? []) {
      edges.push({
        id: `e-${pn.id}-${tr.target}`,
        source: pn.id,
        target: tr.target,
        type: 'pipelineEdge',
        data: {
          condition: tr.condition,
          label: tr.label,
        },
      });
    }
  }
  return edges;
}

/**
 * Convert React Flow nodes/edges back to backend PipelineNode[].
 * Nodes with parentId are collected as children of their parent group.
 */
/**
 * Find the graph root: the node with no incoming edges.
 * Falls back to the first node if every node has an incoming edge (cycle).
 */
function findEntryNodeId(nodes: BackendPipelineNode[]): string | undefined {
  if (nodes.length === 0) return undefined;
  const incoming = new Set<string>();
  for (const node of nodes) {
    for (const t of node.transitions) {
      incoming.add(t.target);
    }
  }
  const root = nodes.find((n) => !incoming.has(n.id));
  return root ? root.id : nodes[0].id;
}

/**
 * Create the visual-only trigger React Flow node and its edge to the entry node.
 * The trigger node is never persisted to the backend — it's synthesized on load.
 */
function createTriggerElements(
  entryNodeId: string | undefined,
  entryPosition: { x: number; y: number },
  triggerCount: number,
  triggerSummary: string,
): { triggerNode: Node; triggerEdge: Edge | null } {
  const triggerNode: Node = {
    id: TRIGGER_NODE_ID,
    type: 'pipelineTriggerNode',
    position: {
      x: entryPosition.x,
      y: entryPosition.y + TRIGGER_POSITION_OFFSET_Y,
    },
    data: {
      label: 'Trigger',
      triggerCount,
      triggerSummary,
    } satisfies TriggerNodeData,
  };

  const triggerEdge: Edge | null = entryNodeId
    ? {
        id: `${TRIGGER_EDGE_ID_PREFIX}${entryNodeId}`,
        source: TRIGGER_NODE_ID,
        target: entryNodeId,
        type: 'pipelineEdge',
      }
    : null;

  return { triggerNode, triggerEdge };
}

interface TriggerSummaryDefinition {
  id: string;
  type: string;
}

function toSelectedTriggers(
  supportedTriggers: PipelineDefinition['supportedTriggers'] | undefined,
): SelectedTrigger[] {
  return (supportedTriggers ?? []).map((trigger) => ({
    triggerId: trigger.id,
    schedule: trigger.type === 'schedule' ? trigger.schedule : undefined,
  }));
}

function mergeTriggerSummaryDefinitions(
  supportedTriggers: PipelineDefinition['supportedTriggers'] | undefined,
  triggerDefs: Array<{ id: string; type: 'kafka' | 'schedule' | 'manual' }> | undefined,
): TriggerSummaryDefinition[] {
  const definitions = new Map<string, TriggerSummaryDefinition>();

  for (const trigger of supportedTriggers ?? []) {
    definitions.set(trigger.id, { id: trigger.id, type: trigger.type });
  }

  for (const trigger of triggerDefs ?? []) {
    definitions.set(trigger.id, { id: trigger.id, type: trigger.type });
  }

  return [...definitions.values()];
}

function toPipelineNodes(nodes: Node[], edges: Edge[]): BackendPipelineNode[] {
  // Group edges by source
  const transitionsBySource = new Map<string, NodeTransition[]>();
  for (const edge of edges) {
    const transitions = transitionsBySource.get(edge.source) ?? [];
    const edgeData = edge.data as Record<string, unknown> | undefined;
    transitions.push({
      target: edge.target,
      condition: edgeData?.condition as string | undefined,
      label: edgeData?.label as string | undefined,
    });
    transitionsBySource.set(edge.source, transitions);
  }

  // Collect child nodes by parentId
  const childrenByParent = new Map<string, GroupChildNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const d = node.data as PipelineNodeData;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push({
      id: node.id,
      type: d.activityType,
      label: d.label,
      config: (d.config as Record<string, unknown>) ?? {},
      timeout: d.timeout,
      retries: d.retries,
      onFailure: d.onFailure,
    });
    childrenByParent.set(node.parentId, siblings);
  }

  // Build top-level nodes only (skip children)
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => {
      const isGroup = node.type === 'pipelineGroupNode';
      const d = node.data as Record<string, unknown>;

      if (isGroup) {
        return {
          id: node.id,
          type: 'node-group',
          label: d.label as string,
          config: {},
          transitions: transitionsBySource.get(node.id) ?? [],
          timeout: d.timeout as number | undefined,
          retries: d.retries as number | undefined,
          onFailure: d.onFailure as 'stop' | 'skip' | 'continue' | undefined,
          position: node.position,
          children: childrenByParent.get(node.id) ?? [],
        };
      }

      const nd = d as unknown as PipelineNodeData;
      return {
        id: node.id,
        type: nd.activityType,
        label: nd.label,
        config: (nd.config as Record<string, unknown>) ?? {},
        transitions: transitionsBySource.get(node.id) ?? [],
        timeout: nd.timeout,
        retries: nd.retries,
        onFailure: nd.onFailure,
        position: node.position,
      };
    });
}

// =============================================================================
// Types
// =============================================================================

interface NodeTypesResponse {
  success: boolean;
  data: NodeTypeDefinition[];
}

/**
 * Map of raw step/node id → user-facing label, used to render server validation
 * errors with the node name the user actually sees on the canvas.
 */
export type NodeLabelLookup = (stepId: string) => string;

/**
 * Server validation errors come back either as strings or as
 * `{ stepId?, field, message }` objects (from validatePipeline / validateGraphPipeline).
 * Render either form safely so the toast doesn't show "[object Object]".
 *
 * Exported (in addition to being used by handleSave) so unit tests can exercise
 * the rendering logic directly.
 */
export function formatApiDetails(details: unknown, lookupLabel?: NodeLabelLookup): string | null {
  if (!Array.isArray(details) || details.length === 0) return null;
  const lines = details.slice(0, 3).map((d) => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const obj = d as Record<string, unknown>;
      const msg = typeof obj.message === 'string' ? obj.message : null;
      const field = typeof obj.field === 'string' ? obj.field : null;
      const stepId = typeof obj.stepId === 'string' ? obj.stepId : null;
      // Prefer the user-facing label over the internal id (e.g. "Read Conversation"
      // instead of "node-1776324747603-2"). Fall back to the id when no label is known.
      const step = stepId ? (lookupLabel?.(stepId) ?? stepId) : null;
      if (msg) return [step, field, msg].filter(Boolean).join(' · ');
      try {
        return JSON.stringify(d);
      } catch {
        return String(d);
      }
    }
    return String(d);
  });
  return lines.join('; ');
}

// =============================================================================
// Component
// =============================================================================

export function PipelineEditorPage() {
  const subPage = useNavigationStore((s) => s.subPage);
  const routeProjectId = useNavigationStore((s) => s.projectId);
  const projectId = useProjectStore((s) => s.currentProjectId) ?? routeProjectId;
  const navigate = useNavigationStore((s) => s.navigate);
  const setPipelineListTab = usePipelineListStore((s) => s.setActiveTab);
  const openRun = useRunsStore((s) => s.openRun);

  const pipelineId = subPage;
  const isBlankDraftRoute =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('template') === 'blank';
  const shouldShowTemplatePicker = pipelineId === 'new' && !isBlankDraftRoute;

  // ── Store actions ──
  const setPipeline = usePipelineEditorStore((s) => s.setPipeline);
  const reset = usePipelineEditorStore((s) => s.reset);
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const edges = usePipelineEditorStore((s) => s.edges);
  const pipelineName = usePipelineEditorStore((s) => s.pipelineName);
  const pipelineStatus = usePipelineEditorStore((s) => s.pipelineStatus);
  const isDirty = usePipelineEditorStore((s) => s.isDirty);
  const isPaletteOpen = usePipelineEditorStore((s) => s.isPaletteOpen);
  const togglePalette = usePipelineEditorStore((s) => s.togglePalette);
  const isConfigPanelOpen = usePipelineEditorStore((s) => s.isConfigPanelOpen);
  const markSaved = usePipelineEditorStore((s) => s.markSaved);
  const setValidationResult = usePipelineEditorStore((s) => s.setValidationResult);
  const setPipelineStatus = usePipelineEditorStore((s) => s.setPipelineStatus);
  const selectedTriggers = usePipelineEditorStore((s) => s.selectedTriggers);

  // ── Auto-layout hook ──
  const { autoLayout } = usePipelineAutoLayout();

  // ── Refs for preventing duplicate hydration ──
  const hydratedIdRef = useRef<string | null>(null);
  const [isTestOpen, setIsTestOpen] = useState(false);

  // ── Fetch pipeline data ──
  const {
    data: pipelineData,
    error: pipelineError,
    mutate: mutatePipeline,
  } = useSWR<PipelineDefinition>(
    pipelineId && pipelineId !== 'new' ? `/api/pipelines/${pipelineId}` : null,
    swrFetcher,
  );

  // ── Fetch node types ──
  const { data: nodeTypesData } = useSWR<NodeTypesResponse>('/api/pipelines/nodes', swrFetcher);

  // ── Fetch trigger definitions (for save conversion) ──
  interface TriggerDefResponse {
    success: boolean;
    data: Array<{
      id: string;
      type: 'kafka' | 'schedule' | 'manual';
      kafkaTopic?: string;
      category: string;
      label: string;
      description: string;
      inputSchema?: {
        required: string[];
        properties: Record<string, { type: string; description?: string }>;
      };
    }>;
  }
  const { data: triggerDefsData } = useSWR<TriggerDefResponse>(
    '/api/pipelines/triggers',
    swrFetcher,
  );

  // Build node type map
  const nodeTypeMap = useMemo<Map<string, NodeTypeDefinition>>(() => {
    const map = new Map<string, NodeTypeDefinition>();
    if (nodeTypesData?.data) {
      for (const nt of nodeTypesData.data) {
        map.set(nt.type, nt);
      }
    }
    return map;
  }, [nodeTypesData]);

  const testTriggers = useMemo(() => {
    const defaultTriggerIds = pipelineData?.defaultTriggerIds ?? [];
    const hasActiveDefaults = defaultTriggerIds.length > 0;
    const activeSet = new Set(defaultTriggerIds);

    return (pipelineData?.supportedTriggers ?? []).map((trigger) => ({
      ...trigger,
      ...(hasActiveDefaults ? { active: activeSet.has(trigger.id) } : {}),
    }));
  }, [pipelineData]);

  // ── Handle "new" pipeline: initialize empty local state ──
  useEffect(() => {
    if (pipelineId !== 'new') return;
    if (!isBlankDraftRoute) return;
    if (hydratedIdRef.current === 'new') return;
    hydratedIdRef.current = 'new';
    const { triggerNode } = createTriggerElements(undefined, { x: 0, y: 0 }, 0, 'Not configured');
    setPipeline('new', 'Untitled Pipeline', 'draft', [triggerNode], [], []);
  }, [isBlankDraftRoute, pipelineId, setPipeline]);

  // ── Hydrate store when pipeline data loads ──
  useEffect(() => {
    if (!pipelineData || !pipelineData._id) return;
    if (hydratedIdRef.current === pipelineData._id) return;
    hydratedIdRef.current = pipelineData._id;

    const backendNodes = pipelineData.nodes ?? [];
    const hydratedTriggers = toSelectedTriggers(pipelineData.supportedTriggers);
    const triggerSummaryDefinitions = mergeTriggerSummaryDefinitions(
      pipelineData.supportedTriggers,
      triggerDefsData?.data,
    );
    const triggerSummary = buildTriggerSummary(hydratedTriggers, triggerSummaryDefinitions);
    let rfNodes = toReactFlowNodes(backendNodes);
    const rfEdges = toReactFlowEdges(backendNodes);

    // Enrich node categories from node type map (skip group container nodes)
    if (nodeTypeMap.size > 0) {
      rfNodes = rfNodes.map((node) => {
        const d = node.data as Record<string, unknown>;
        const activityType = d.activityType as string | undefined;
        if (!activityType) return node; // skip group nodes
        const typeDef = nodeTypeMap.get(activityType);
        if (typeDef) {
          return {
            ...node,
            data: { ...d, category: typeDef.category },
          };
        }
        return node;
      });
    }

    // Auto-layout if nodes have no positions
    const needsLayout =
      rfNodes.length > 0 && rfNodes.every((n) => n.position.x === 0 && n.position.y === 0);

    if (needsLayout) {
      autoLayout(rfNodes, rfEdges).then((layoutedNodes) => {
        const computedEntryId =
          pipelineData.entryNodeId ?? findEntryNodeId(pipelineData.nodes ?? []);
        const entryNode = layoutedNodes.find((n) => n.id === computedEntryId);
        const entryPos = entryNode?.position ?? { x: 0, y: 0 };
        const { triggerNode, triggerEdge } = createTriggerElements(
          computedEntryId,
          entryPos,
          hydratedTriggers.length,
          triggerSummary,
        );
        setPipeline(
          pipelineData._id,
          pipelineData.name,
          pipelineData.status,
          [triggerNode, ...layoutedNodes],
          triggerEdge ? [triggerEdge, ...rfEdges] : rfEdges,
          hydratedTriggers,
        );
      });
    } else {
      const computedEntryId = pipelineData.entryNodeId ?? findEntryNodeId(pipelineData.nodes ?? []);
      const entryNode = rfNodes.find((n) => n.id === computedEntryId);
      const entryPos = entryNode?.position ?? { x: 0, y: 0 };
      const { triggerNode, triggerEdge } = createTriggerElements(
        computedEntryId,
        entryPos,
        hydratedTriggers.length,
        triggerSummary,
      );
      setPipeline(
        pipelineData._id,
        pipelineData.name,
        pipelineData.status,
        [triggerNode, ...rfNodes],
        triggerEdge ? [triggerEdge, ...rfEdges] : rfEdges,
        hydratedTriggers,
      );
    }
  }, [pipelineData, nodeTypeMap, setPipeline, autoLayout, triggerDefsData]);

  // ── On mount: if ?selectedNodeId param is present, focus that node ──
  // Used by "Open in editor" buttons in the run-detail view (ABLP-564 Phase 4).
  const selectNode = usePipelineEditorStore((s) => s.selectNode);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const nodeId = params.get('selectedNodeId');
    if (!nodeId) return;
    const maxAttempts = 50;
    let attempts = 0;
    // Wait until the pipeline has been hydrated before selecting
    const interval = setInterval(() => {
      attempts += 1;
      const state = usePipelineEditorStore.getState();
      const exists = state.nodes.some((n) => n.id === nodeId);
      if (exists) {
        clearInterval(interval);
        state.selectNode(nodeId);
        // Remove the param from the URL without a full navigation
        const url = new URL(window.location.href);
        url.searchParams.delete('selectedNodeId');
        window.history.replaceState(null, '', url.toString());
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        console.warn('[PipelineEditorPage] selectedNodeId was not found after hydration wait', {
          nodeId,
        });
      }
    }, 100);
    return () => clearInterval(interval);
  }, [selectNode]);

  // ── Sync trigger node data when selectedTriggers changes ──
  useEffect(() => {
    const state = usePipelineEditorStore.getState();
    const triggerNode = state.nodes.find((node) => node.id === TRIGGER_NODE_ID);
    if (!triggerNode) return;
    const latestSelectedTriggers = state.selectedTriggers;

    const triggerSummaryDefinitions = mergeTriggerSummaryDefinitions(
      pipelineData?.supportedTriggers,
      triggerDefsData?.data,
    );
    const summary = buildTriggerSummary(latestSelectedTriggers, triggerSummaryDefinitions);
    const currentData = triggerNode.data as Partial<TriggerNodeData> | undefined;

    if (
      currentData?.triggerCount === latestSelectedTriggers.length &&
      currentData?.triggerSummary === summary
    ) {
      return;
    }

    state.updateNodeData(TRIGGER_NODE_ID, {
      triggerCount: latestSelectedTriggers.length,
      triggerSummary: summary,
    });
  }, [pipelineData?.supportedTriggers, selectedTriggers, triggerDefsData]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      // Reset the hydration guard so re-mounting (including React StrictMode
      // remount) will re-hydrate from the SWR data instead of showing an
      // empty canvas.
      hydratedIdRef.current = null;
      reset();
    };
  }, [reset]);

  // ── Save handler ──
  // Build an id→label lookup from the current canvas nodes so server validation
  // errors render with the node name the user sees, not the internal id.
  const buildLabelLookup = useCallback((): NodeLabelLookup => {
    const latest = usePipelineEditorStore.getState();
    const labelById = new Map<string, string>();
    for (const n of latest.nodes) {
      const data = (n.data ?? {}) as Record<string, unknown>;
      const label =
        (typeof data.label === 'string' && data.label) ||
        (typeof data.activityType === 'string' && data.activityType) ||
        '';
      if (label) labelById.set(n.id, label);
    }
    return (stepId: string) => labelById.get(stepId) ?? stepId;
  }, []);

  const handleSave = useCallback(async () => {
    if (!pipelineId) return;

    const latestState = usePipelineEditorStore.getState();
    const triggerSelections = latestState.selectedTriggers;

    const realNodes = latestState.nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
    const realEdges = latestState.edges.filter(
      (e) => e.source !== TRIGGER_NODE_ID && e.target !== TRIGGER_NODE_ID,
    );
    const draftValidation = validatePipelineDraft(latestState.nodes, latestState.edges);
    setValidationResult(draftValidation);
    if (!draftValidation.valid) {
      toast.error(
        `Fix ${draftValidation.issues.filter((issue) => issue.severity === 'error').length} validation error(s) before saving`,
      );
      return;
    }

    const backendNodes = toPipelineNodes(realNodes, realEdges);

    const triggerEdge = latestState.edges.find((e) => e.source === TRIGGER_NODE_ID);
    const entryNodeId = triggerEdge?.target ?? findEntryNodeId(backendNodes);

    try {
      if (pipelineId === 'new') {
        const res = await apiFetch('/api/pipelines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            name: latestState.pipelineName,
            nodes: backendNodes,
            entryNodeId,
            triggerSelections,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Save failed' }));
          const detail = formatApiDetails(body.details, buildLabelLookup());
          toast.error(body.error ?? 'Failed to save pipeline', {
            description: detail ?? undefined,
          });
          return;
        }
        const created = await res.json();
        markSaved();
        toast.success('Pipeline created');
        navigate(`/projects/${projectId}/pipelines/${created._id}`);
      } else {
        const res = await apiFetch(`/api/pipelines/${pipelineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: latestState.pipelineName,
            nodes: backendNodes,
            entryNodeId,
            triggerSelections,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Save failed' }));
          const detail = formatApiDetails(body.details, buildLabelLookup());
          toast.error(body.error ?? 'Failed to save pipeline', {
            description: detail ?? undefined,
          });
          return;
        }
        markSaved();
        mutatePipeline();
        toast.success('Pipeline saved');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${message}`);
    }
  }, [
    pipelineId,
    projectId,
    markSaved,
    mutatePipeline,
    navigate,
    setValidationResult,
    buildLabelLookup,
  ]);

  // ── Validate handler ──
  const handleValidate = useCallback(() => {
    const result = validatePipelineDraft(nodes, edges);
    setValidationResult(result);

    if (result.valid) {
      toast.success('Validation passed');
    } else {
      const errors = result.issues.filter((i) => i.severity === 'error');
      toast.error(`Validation found ${errors.length} error(s)`, {
        description: errors
          .slice(0, 3)
          .map((e) => e.message)
          .join('; '),
      });
    }
  }, [nodes, edges, setValidationResult]);

  // ── Live authoring validation ──
  useEffect(() => {
    setValidationResult(validatePipelineDraft(nodes, edges));
  }, [edges, nodes, setValidationResult]);

  const [isToggling, setIsToggling] = useState(false);

  // ── Activate handler ──
  const handleActivate = useCallback(async () => {
    if (!pipelineId || pipelineId === 'new' || isToggling) return;

    setIsToggling(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/pipelines/${pipelineId}/activate`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Activation failed' }));
        toast.error(body.error ?? 'Failed to activate pipeline');
        return;
      }

      setPipelineStatus('active');
      mutatePipeline();
      toast.success('Pipeline activated');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Activation failed: ${message}`);
    } finally {
      setIsToggling(false);
    }
  }, [pipelineId, projectId, isToggling, setPipelineStatus, mutatePipeline]);

  // ── Deactivate handler ──
  const handleDeactivate = useCallback(async () => {
    if (!pipelineId || pipelineId === 'new' || isToggling) return;

    setIsToggling(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/pipelines/${pipelineId}/deactivate`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Deactivation failed' }));
        toast.error(body.error ?? 'Failed to deactivate pipeline');
        return;
      }

      setPipelineStatus('draft');
      mutatePipeline();
      toast.success('Pipeline deactivated');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Deactivation failed: ${message}`);
    } finally {
      setIsToggling(false);
    }
  }, [pipelineId, projectId, isToggling, setPipelineStatus, mutatePipeline]);

  // ── Back handler ──
  const handleBack = useCallback(() => {
    if (projectId) {
      navigate(`/projects/${projectId}/pipelines`);
    }
  }, [projectId, navigate]);

  // ── Keyboard shortcut: Cmd+S to save ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // ── Loading / Error states ──
  if (pipelineError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-error">Failed to load pipeline</div>
      </div>
    );
  }

  if (!pipelineData && pipelineId !== 'new') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          Loading pipeline...
        </div>
      </div>
    );
  }

  if (shouldShowTemplatePicker && projectId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <TemplatePicker
          open
          onClose={() => navigate(`/projects/${projectId}/pipelines`)}
          projectId={projectId}
          onNavigate={navigate}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Top toolbar */}
      <PipelineEditorToolbar
        onBack={handleBack}
        onSave={handleSave}
        onTest={() => setIsTestOpen(true)}
        onValidate={handleValidate}
        onActivate={handleActivate}
        onDeactivate={handleDeactivate}
        isToggling={isToggling}
        testDisabled={
          pipelineId === 'new' ||
          !projectId ||
          pipelineStatus !== 'active' ||
          isDirty ||
          testTriggers.length === 0
        }
      />

      {/* Three-panel body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel: Node palette */}
        <NodePalette isOpen={isPaletteOpen} onToggle={togglePalette} />

        {/* Center: React Flow canvas */}
        <PipelineGraphCanvas className="flex-1 h-full" />

        {/* Right panel: Node config (slide-over) */}
        {isConfigPanelOpen && <NodeConfigPanel nodeTypes={nodeTypeMap} projectId={projectId} />}
      </div>

      {projectId && pipelineId && pipelineId !== 'new' && (
        <PipelineTestDrawer
          open={isTestOpen}
          onClose={() => setIsTestOpen(false)}
          projectId={projectId}
          pipelineId={pipelineId}
          triggers={testTriggers}
          onRunCreated={(runId) => {
            setPipelineListTab('runs');
            openRun(runId);
            navigate(`/projects/${projectId}/pipelines`);
          }}
        />
      )}
    </div>
  );
}
