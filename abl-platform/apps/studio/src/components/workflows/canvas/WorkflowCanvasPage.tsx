/**
 * WorkflowCanvasPage
 *
 * Main page component for the visual workflow editor.
 * Fetches workflow data, converts to XY Flow format, and
 * composes the canvas with toolbar, sidebar, config panel, etc.
 */

'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { ReactFlowProvider } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../../store/navigation-store';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import type { WorkflowFlowNode, WorkflowFlowEdge } from '../../../store/workflow-canvas-store';
import { computeLoopSize } from '../../../store/workflow-canvas-store';
import type {
  WorkflowNodeSummary,
  WorkflowEdgeSummary,
  WorkflowCanvasDetail,
} from '../../../api/workflows';
import { WorkflowCanvas } from './WorkflowCanvas';
import { AssetsSidebar } from './panels/AssetsSidebar';
import { ConfigPanel } from './panels/ConfigPanel';
import { LoopBodyModal } from './LoopBodyModal';
import { ValidationPanel } from './panels/ValidationPanel';
import { RunDialog } from './panels/RunDialog';
import { TestActionModal } from './config/TestActionModal';
import { WorkflowDebugPanel } from './panels/WorkflowDebugPanel';
import { useWorkflowValidation } from './useWorkflowValidation';
import { useWorkflowSave } from './useWorkflowSave';
import { useAutoSave } from './useAutoSave';
import { useExecutionWebSocket } from './useExecutionWebSocket';
import type { NodeType } from '@agent-platform/shared-kernel/types';
import {
  NODE_COLOR_MAP,
  STUB_NODE_TYPES,
  getOutputHandles,
} from '@agent-platform/shared-kernel/types';

// =============================================================================
// Helpers
// =============================================================================

function resolveXYFlowType(nodeType: string): string {
  if (nodeType === 'start') return 'startNode';
  if (nodeType === 'end') return 'endNode';
  if (nodeType === 'loop') return 'loopNode';
  if (nodeType === 'loop_start') return 'loopStartNode';
  if (nodeType === 'loop_end') return 'loopEndNode';
  return 'workflowNode';
}

function convertApiNodesToFlow(apiNodes: WorkflowNodeSummary[]): WorkflowFlowNode[] {
  const converted = apiNodes.map((n) => {
    const nodeType = n.nodeType as NodeType;
    const node: WorkflowFlowNode = {
      id: n.id,
      type: resolveXYFlowType(nodeType),
      position: n.position,
      data: {
        nodeType,
        label: n.name,
        config: n.config || {},
        color: NODE_COLOR_MAP[nodeType] || '#6b7280',
        isStub: STUB_NODE_TYPES.includes(nodeType),
        outputHandles: getOutputHandles(nodeType, n.config),
      },
    };
    if (n.parentId) {
      node.parentId = n.parentId;
    }
    return node;
  });

  // ReactFlow requires parent nodes to appear before their children
  converted.sort((a, b) => {
    if (!a.parentId && b.parentId) return -1;
    if (a.parentId && !b.parentId) return 1;
    return 0;
  });

  // Set each loop container's width/height to fit its children on load
  let normalised = converted;
  for (const node of normalised.filter((n) => n.data.nodeType === 'loop')) {
    const { width, height } = computeLoopSize(node.id, normalised);
    normalised = normalised.map((n) =>
      n.id === node.id ? { ...n, width, height, style: { ...n.style, width, height } } : n,
    );
  }

  return normalised;
}

function convertApiEdgesToFlow(
  apiEdges: WorkflowEdgeSummary[],
  flowNodes: WorkflowFlowNode[],
): WorkflowFlowEdge[] {
  const loopStartByParentId = new Map(
    flowNodes
      .filter((node) => node.data.nodeType === 'loop_start' && node.parentId)
      .map((node) => [node.parentId as string, node.id]),
  );

  return apiEdges
    .map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      // loop_body_end edges target the loop container directly — do not remap.
      // All other edges to a loop container are remapped to target loop_start.
      target:
        e.targetHandle === 'loop_body_end'
          ? e.target
          : (loopStartByParentId.get(e.target) ?? e.target),
      targetHandle: e.targetHandle ?? null,
      type: 'workflowEdge' as const,
      label: e.label,
    }))
    .filter((edge) => edge.source !== edge.target);
}

// =============================================================================
// Component
// =============================================================================

interface WorkflowCanvasPageProps {
  expandButton?: React.ReactNode;
}

export function WorkflowCanvasPage({ expandButton }: WorkflowCanvasPageProps = {}) {
  const t = useTranslations('workflows.canvas');
  const projectId = useNavigationStore((s) => s.projectId);
  const workflowId = useNavigationStore((s) => s.subPage);
  const setWorkflow = useWorkflowCanvasStore((s) => s.setWorkflow);
  const canvasWorkflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const configPanelOpen = useWorkflowCanvasStore((s) => s.configPanelOpen);
  const selectedNodeId = useWorkflowCanvasStore((s) => s.selectedNodeId);
  const validationPanelOpen = useWorkflowCanvasStore((s) => s.validationPanelOpen);
  const runDialogOpen = useWorkflowCanvasStore((s) => s.runDialogOpen);
  const debugPanelOpen = useWorkflowCanvasStore((s) => s.debugPanelOpen);
  const currentExecutionId = useWorkflowCanvasStore((s) => s.currentExecutionId);
  // Hooks
  useWorkflowValidation();
  const { save } = useWorkflowSave();
  useAutoSave(save);
  const execution = useExecutionWebSocket(debugPanelOpen ? currentExecutionId : null);

  // Use the same SWR key as useWorkflowDetail so the request is deduplicated
  // (parent WorkflowDetailPage already fetches this).
  const swrKey =
    projectId && workflowId
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`
      : null;
  const { data: swrData, error: swrError, isLoading: loading } = useSWR(swrKey);

  // Extract canvas-relevant fields from the SWR response (shape: { success, data })
  const canvasData = (swrData as { data?: WorkflowCanvasDetail } | undefined)?.data ?? null;
  const error = swrError ? (swrError instanceof Error ? swrError.message : String(swrError)) : null;

  // Sync SWR data into the canvas store on first load.
  // Guard against two scenarios:
  //   1. SWR re-runs (canvasData reference changes) after user edits — skip if already synced.
  //   2. Remount (e.g. fullscreen toggle) with stale SWR cache — skip if store already holds
  //      this workflow's live edits, otherwise the remount would overwrite unsaved nodes.
  const syncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canvasData) return;
    // Store already has this workflow's live state — don't overwrite with potentially stale SWR cache
    if (canvasWorkflowId === canvasData.id) return;
    // Already synced in this instance's lifetime
    if (syncedRef.current === canvasData.id) return;
    syncedRef.current = canvasData.id;

    // Add default Start node if canvas is empty (new workflow)
    const apiNodes =
      canvasData.nodes && canvasData.nodes.length > 0
        ? canvasData.nodes
        : [
            {
              id: 'start-node',
              nodeType: 'start' as const,
              name: 'Start',
              position: { x: 200, y: 250 },
              config: { inputVariables: [] },
            },
          ];
    const flowNodes = convertApiNodesToFlow(apiNodes);
    const flowEdges = convertApiEdgesToFlow(canvasData.edges || [], flowNodes);
    setWorkflow(
      canvasData.id,
      canvasData.name,
      canvasData.description || '',
      flowNodes,
      flowEdges,
      canvasData.envVars ?? {},
      canvasData.inputSchema,
      canvasData.outputSchema,
    );
  }, [canvasData, setWorkflow, canvasWorkflowId]);

  // Hold the canvas until the store is hydrated for this workflow (setWorkflow has run).
  // SWR may return loading=false immediately from cache, but setWorkflow runs in a useEffect
  // (after render) — mounting ReactFlow before nodes are in the store causes fitView to fire
  // on an empty canvas, leaving existing nodes off-screen.
  const isHydrated = canvasWorkflowId === workflowId;

  if (loading || !isHydrated) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="workflow-canvas-page">
        <div className="text-sm text-muted-foreground animate-pulse">{t('loading_workflow')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="workflow-canvas-page">
        <div className="text-sm text-error">Failed to load workflow: {error}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="workflow-canvas-page">
      <ReactFlowProvider>
        {/* Main area */}
        <div className="flex flex-1 min-h-0">
          {/* Assets sidebar */}
          <AssetsSidebar />

          {/* Canvas */}
          <div className="flex-1 min-w-0 relative">
            <WorkflowCanvas />
            {/* Expand to fullscreen button — inside canvas area so it doesn't overlap config panel */}
            {expandButton && <div className="absolute top-3 right-3 z-10">{expandButton}</div>}
            {/* Validation panel overlay */}
            {validationPanelOpen && <ValidationPanel />}
            {/* Loop body expansion — absolute within canvas so it stays inside ReactFlow bounds */}
            <LoopBodyModal />
          </div>

          {/* Right panel: debug or config */}
          {debugPanelOpen && currentExecutionId ? (
            <WorkflowDebugPanel execution={execution} mode="canvas" />
          ) : configPanelOpen && selectedNodeId ? (
            <ConfigPanel />
          ) : null}
        </div>

        {/* Run dialog */}
        {runDialogOpen && <RunDialog />}

        {/* Test-action modal — opened from on-node hover button or side panel */}
        <TestActionModalHost />
      </ReactFlowProvider>
    </div>
  );
}

/**
 * Lightweight host that subscribes to the canvas store and mounts the modal
 * when a target node id is set. Lives at page level so both the side-panel
 * button and the on-canvas hover button can open the same modal.
 */
function TestActionModalHost() {
  const testActionNodeId = useWorkflowCanvasStore((s) => s.testActionNodeId);
  const closeTestActionModal = useWorkflowCanvasStore((s) => s.closeTestActionModal);
  return (
    <TestActionModal
      open={testActionNodeId !== null}
      nodeId={testActionNodeId}
      onClose={closeTestActionModal}
    />
  );
}
