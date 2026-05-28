/**
 * Workflow Canvas Store
 *
 * Zustand store for the visual workflow canvas (node-based editor).
 * Manages XY Flow nodes/edges, selection, validation, and serialization
 * back to the API's WorkflowNode/WorkflowEdge shapes.
 */

import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
} from '@xyflow/react';
import type { WorkflowNode, WorkflowEdge, NodeType } from '@agent-platform/shared-kernel/types';
import {
  generateNodeName,
  getOutputHandles,
  STUB_NODE_TYPES,
  NODE_COLOR_MAP,
} from '@agent-platform/shared-kernel/types';
import type { ExecutionEdges } from '../components/workflows/canvas/edges/computeExecutionEdges';
import { isValidWorkflowConnection, wouldCreateCycle } from './workflow-canvas-helpers';
import { toast } from 'sonner';

/** Keep in sync with @abl/workflow-engine/constants MAX_PARALLEL_BRANCHES */
export const MAX_FAN_OUT = 10;

// =============================================================================
// TYPES
// =============================================================================

/** Node data attached to XY Flow nodes */
export interface WorkflowNodeData {
  nodeType: NodeType;
  label: string;
  config: Record<string, unknown>;
  color: string;
  isStub: boolean;
  outputHandles: string[];
  [key: string]: unknown;
}

export type WorkflowFlowNode = Node<WorkflowNodeData>;
export type WorkflowFlowEdge = Edge;

/** Validation result */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

/**
 * Node overlay status — mirrors the NodeExecutionStatus enum in
 * packages/shared/src/types/workflow-schemas.ts. Keep in sync.
 */
export type NodeOverlayStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'rejected'
  | 'waiting_approval'
  | 'waiting_human_task'
  | 'waiting_callback'
  | 'waiting_delay';

// =============================================================================
// LOOP OVERLAY TYPES
// =============================================================================

export interface LoopBodyStep {
  stepId: string;
  status: string;
}

export interface LoopIterationEntry {
  currentIndex: number;
  currentItem: unknown;
  steps: Record<string, LoopBodyStep>;
}

export interface EdgeBatchBadge {
  count: number;
  hasFailed: boolean;
}

export type IterationPathStateMap = Record<
  string,
  Record<string, Record<string, 'running' | 'completed'>>
>;

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface WorkflowCanvasStore {
  // Canvas state
  workflowId: string | null;
  /** Eagerly set by WorkflowDetailPage on mount — used for execution-state gating across all tabs.
   *  Separate from workflowId so the canvas hydration guard (canvasWorkflowId === workflowId) is
   *  not triggered before setWorkflow has actually loaded nodes into the store. */
  pageWorkflowId: string | null;
  workflowName: string;
  workflowDescription: string;
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  selectedNodeId: string | null;
  /** Node id whose Test Action modal is currently open, or null when closed. */
  testActionNodeId: string | null;

  // Validation
  validationIssues: ValidationIssue[];

  // UI state
  configPanelOpen: boolean;
  validationPanelOpen: boolean;
  runDialogOpen: boolean;
  deployPanelOpen: boolean;
  isDirty: boolean;
  isSaving: boolean;
  changeVersion: number;

  // Execution state
  currentExecutionId: string | null;
  /** Tracks the latest execution status so the toolbar can distinguish running vs terminal */
  executionStatus: string | null;
  debugPanelOpen: boolean;
  /** True while a cancel-execution API call is in-flight */
  isCancelling: boolean;
  /** AbortController for the in-flight executeWorkflow fetch — null when idle */
  executeAbortController: AbortController | null;

  // Execution overlay
  executionOverlay: Record<string, NodeOverlayStatus> | null;
  /** Pre-computed edge highlight sets — traversed (green) and active (particles) */
  executionEdges: ExecutionEdges | null;
  /** Full execution.context from the last run — contains trigger, vars, steps */
  executionContext: Record<string, unknown> | null;

  // Loop iteration overlay — per-loop iteration history and interactive selection
  /** Iterations stored per loop canvas node ID, keyed by loopNodeId */
  loopIterationData: Record<string, LoopIterationEntry[]> | null;
  /** Currently displayed iteration index per loop (for dropdown and reframe) */
  selectedLoopIteration: Record<string, number>;
  /** Parallel batch live-count badges: edgeId → { count, hasFailed } */
  edgeBatchCounts: Record<string, EdgeBatchBadge> | null;
  /** Outer-only (non-body) execution overlay — used as baseline for interactive reframe */
  baseExecutionOverlay: Record<string, NodeOverlayStatus> | null;
  /** Outer-only (non-body) execution edges — used as baseline for interactive reframe */
  baseExecutionEdges: ExecutionEdges | null;
  /** Backend-provided per-iteration body edge pathState keyed by loopNodeId → iterIndex → edgeId */
  iterationEdgePathState: Record<
    string,
    Record<string, Record<string, 'running' | 'completed'>>
  > | null;

  // Env vars
  envVars: Record<string, string>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;

  // Actions
  setWorkflow: (
    id: string,
    name: string,
    description: string,
    nodes: WorkflowFlowNode[],
    edges: WorkflowFlowEdge[],
    envVars?: Record<string, string>,
    inputSchema?: Record<string, unknown> | null,
    outputSchema?: Record<string, unknown> | null,
  ) => void;
  onNodesChange: OnNodesChange<WorkflowFlowNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  canvasExpanded: boolean;
  expandedLoopId: string | null;
  setExpandedLoopId: (id: string | null) => void;
  addNode: (
    nodeType: NodeType,
    position?: { x: number; y: number },
    sourceInfo?: { nodeId: string; handleId: string },
  ) => string;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  updateNodeName: (nodeId: string, name: string) => void;
  removeNode: (nodeId: string) => void;
  /** Replace node positions in bulk. Used by auto-layout. Nodes not in the input are left untouched. */
  arrangeNodes: (positioned: WorkflowFlowNode[]) => void;
  removeEdge: (edgeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  openTestActionModal: (nodeId: string) => void;
  closeTestActionModal: () => void;
  setCanvasExpanded: (expanded: boolean) => void;
  setValidationIssues: (issues: ValidationIssue[]) => void;
  setConfigPanelOpen: (open: boolean) => void;
  setValidationPanelOpen: (open: boolean) => void;
  setRunDialogOpen: (open: boolean) => void;
  setDeployPanelOpen: (open: boolean) => void;
  setCurrentExecutionId: (id: string | null) => void;
  setExecutionStatus: (status: string | null) => void;
  setDebugPanelOpen: (open: boolean) => void;
  setIsCancelling: (cancelling: boolean) => void;
  setExecuteAbortController: (controller: AbortController | null) => void;
  setIsSaving: (saving: boolean) => void;
  markSaved: () => void;
  markSavedIfUnchanged: (version: number) => void;
  setExecutionOverlay: (overlay: Record<string, string> | null) => void;
  setExecutionEdges: (edges: ExecutionEdges | null) => void;
  /**
   * Set the outer-only baseline overlay and edges (no loop body nodes),
   * and sync executionOverlay/executionEdges to the merged result of
   * base + all currently selected loop iterations.
   */
  setBaseExecution: (overlay: Record<string, string>, edges: ExecutionEdges) => void;
  /** Store per-loop iteration data (for dropdown). Does not reframe overlay. */
  setLoopData: (loopNodeId: string, iterations: LoopIterationEntry[]) => void;
  /**
   * Reframe executionOverlay and executionEdges to show the selected iteration's
   * execution path for the given loop node. Builds from baseExecutionOverlay +
   * all selected iterations for all loops.
   */
  setSelectedLoopIteration: (loopNodeId: string, iterationIndex: number) => void;
  /** Merge backend-provided per-iteration body edge pathState. */
  mergeIterationEdgePathState: (
    incoming: Record<string, Record<string, Record<string, 'running' | 'completed'>>>,
  ) => void;
  setEdgeBatchCounts: (counts: Record<string, EdgeBatchBadge> | null) => void;
  setNodeZIndex: (nodeId: string, zIndex: number) => void;
  setExecutionContext: (context: Record<string, unknown> | null) => void;
  setEnvVars: (envVars: Record<string, string>) => void;
  /**
   * Eagerly pins pageWorkflowId without loading canvas data.
   * Resets execution state if the ID changes so stale execution from a
   * previous workflow doesn't bleed into the new one's Run/Stop button logic.
   */
  setWorkflowId: (id: string | null) => void;
  /**
   * Persist the latest edge pathState into wf_exec:<targetWorkflowId>.
   * Called by useExecutionWebSocket on every WS step delta that carries path data.
   * Accepts explicit workflowId + executionId from the hook's refs so that writes
   * target the correct storage key even if the Zustand store has already switched
   * to a different workflow (race window between setWorkflow and effect cleanup).
   */
  setPersistedPathState: (
    targetWorkflowId: string,
    targetExecutionId: string,
    pathState: Record<string, 'running' | 'completed'> | null,
    iterationPathState: IterationPathStateMap | null,
  ) => void;
  /**
   * Read pathState from the active wf_exec:<workflowId> entry, but only when
   * the stored currentExecutionId matches the store's currentExecutionId.
   * Returns null if there is no matching persisted state (new execution, no prior
   * WS session, or id mismatch).
   */
  readStoredPathState: () => {
    pathState: Record<string, 'running' | 'completed'> | null;
    iterationPathState: IterationPathStateMap | null;
  } | null;
  toggleOnFailure: (nodeId: string, enabled: boolean) => void;
  updateOnFailureTarget: (nodeId: string, targetNodeId: string) => void;
  updateOnSuccessTarget: (nodeId: string, targetNodeId: string) => void;

  // Serialization helpers
  toWorkflowNodes: () => WorkflowNode[];
  toWorkflowEdges: () => WorkflowEdge[];
}

// =============================================================================
// HELPERS
// =============================================================================

function resolveNodeType(nodeType: NodeType): string {
  if (nodeType === 'start') return 'startNode';
  if (nodeType === 'end') return 'endNode';
  if (nodeType === 'loop') return 'loopNode';
  if (nodeType === 'loop_start') return 'loopStartNode';
  if (nodeType === 'loop_end') return 'loopEndNode';
  return 'workflowNode';
}

// Loop container sizing constants. Child positions are relative to the container's top-left.
const LOOP_HEADER_H = 36;
const LOOP_TOP_PAD = 60; // min Y for children (36px header + 24px gap)
const LOOP_BODY_PAD = 40; // padding on left, right, and bottom
const LOOP_HANDLE_AREA = 130; // width reserved on the right for on_complete/on_failure handles
const LOOP_NODE_W = 200; // WorkflowNodeComponent fixed width
const LOOP_NODE_H = 80; // generous height estimate for regular nodes
const LOOP_START_SIZE = 40; // loop body entry port diameter
const LOOP_END_SIZE = 40; // loop body exit port diameter
// Right output rectangle: two w-8 (32px) py-3 (24px each) halves stacked.
// translate-x-1/2 (+16px) shifts it right, so visual left edge = loopWidth - 16.
const LOOP_RIGHT_RECT_INSET = 16; // = w-8 / 2
export const LOOP_RIGHT_RECT_W = 32; // w-8
export const LOOP_RIGHT_RECT_H = 48; // 2 × py-3 halves (24px each)
const LOOP_MIN_W = 400;
const LOOP_MIN_H = 180;

/** Initial position for the loop_start child. */
export const LOOP_START_INIT_POS = { x: 0, y: LOOP_TOP_PAD };

export function getLoopStartPosition(loopHeight: number): { x: number; y: number } {
  return {
    x: -LOOP_START_SIZE / 2,
    y: LOOP_HEADER_H + Math.max(0, (loopHeight - LOOP_HEADER_H - LOOP_START_SIZE) / 2),
  };
}

export function getLoopEndPosition(
  loopWidth: number,
  loopHeight: number,
): { x: number; y: number } {
  // Place the card exactly behind the right output rectangle.
  // Rectangle left edge = loopWidth - LOOP_RIGHT_RECT_INSET.
  // Rectangle is vertically centred in the full container height.
  return {
    x: loopWidth - LOOP_RIGHT_RECT_INSET,
    y: (loopHeight - LOOP_RIGHT_RECT_H) / 2,
  };
}

/** Compute the container width/height that fits all children with padding on every side. */
export function computeLoopSize(
  loopId: string,
  nodes: WorkflowFlowNode[],
): { width: number; height: number } {
  const children = nodes.filter(
    (n) =>
      n.parentId === loopId && n.data.nodeType !== 'loop_start' && n.data.nodeType !== 'loop_end',
  );
  if (children.length === 0) return { width: LOOP_MIN_W, height: LOOP_MIN_H };

  let maxRight = 0;
  let maxBottom = 0;
  for (const child of children) {
    const w = LOOP_NODE_W;
    const h = LOOP_NODE_H;
    maxRight = Math.max(maxRight, child.position.x + w);
    maxBottom = Math.max(maxBottom, child.position.y + h);
  }

  return {
    width: Math.max(LOOP_MIN_W, maxRight + LOOP_BODY_PAD + LOOP_HANDLE_AREA),
    height: Math.max(LOOP_MIN_H, maxBottom + LOOP_BODY_PAD),
  };
}

function normalizeLoopGeometry(nodes: WorkflowFlowNode[]): WorkflowFlowNode[] {
  const sizeByLoopId = new Map<string, { width: number; height: number }>();

  for (const loopNode of nodes.filter((node) => node.data.nodeType === 'loop')) {
    sizeByLoopId.set(loopNode.id, computeLoopSize(loopNode.id, nodes));
  }

  return nodes.map((node) => {
    if (node.data.nodeType === 'loop') {
      const size = sizeByLoopId.get(node.id);
      if (!size) return node;

      return {
        ...node,
        width: size.width,
        height: size.height,
        style: { ...node.style, width: size.width, height: size.height, overflow: 'visible' },
      };
    }

    if (node.data.nodeType === 'loop_start' && node.parentId) {
      const parentSize = sizeByLoopId.get(node.parentId);
      if (!parentSize) return node;

      return {
        ...node,
        position: getLoopStartPosition(parentSize.height),
        draggable: false,
        selectable: false,
        deletable: false,
      };
    }

    if (node.data.nodeType === 'loop_end' && node.parentId) {
      const parentSize = sizeByLoopId.get(node.parentId);
      if (!parentSize) return node;

      return {
        ...node,
        position: getLoopEndPosition(parentSize.width, parentSize.height),
        draggable: false,
        selectable: false,
        deletable: false,
        style: { ...node.style, pointerEvents: 'none', background: 'transparent' },
      };
    }

    return node;
  });
}

// No custom overlap logic — XY Flow handles node dragging and layout natively.

// =============================================================================
// SESSION STORAGE — per-workflow execution persistence
// =============================================================================

interface PersistedExec {
  currentExecutionId: string | null;
  executionStatus: string | null;
  debugPanelOpen: boolean;
  pathState: Record<string, 'running' | 'completed'> | null;
  iterationPathState: IterationPathStateMap | null;
}

function execKey(workflowId: string) {
  return `wf_exec:${workflowId}`;
}

function readExec(workflowId: string): PersistedExec | null {
  try {
    const raw = sessionStorage.getItem(execKey(workflowId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as PersistedExec;
    // Never restore a non-terminal status — if the engine is still running, the
    // WS/polling will deliver the real status. Restoring 'running' would show a
    // stale Stop button on every tab switch even after the execution completed.
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
    return {
      ...stored,
      executionStatus:
        stored.executionStatus && TERMINAL.has(stored.executionStatus)
          ? stored.executionStatus
          : null,
    };
  } catch {
    return null;
  }
}

function writeExec(workflowId: string, exec: PersistedExec): void {
  try {
    if (exec.currentExecutionId) {
      sessionStorage.setItem(execKey(workflowId), JSON.stringify(exec));
    } else {
      sessionStorage.removeItem(execKey(workflowId));
    }
  } catch {
    // ignore quota errors
  }
}

// =============================================================================
// LOOP OVERLAY HELPERS
// =============================================================================

const LOOP_DONE = new Set(['completed', 'rejected', 'failed', 'skipped', 'cancelled']);
const LOOP_ACTIVE = new Set([
  'running',
  'waiting_approval',
  'waiting_human_task',
  'waiting_delay',
  'waiting_callback',
]);

/**
 * Mutates `overlay`, `traversed`, `active` to add the body node statuses and
 * edge highlights for the given loop iteration. Called by setSelectedLoopIteration
 * and setBaseExecution to build the merged final state.
 */
function applyIterationToState(
  loopNodeId: string,
  iteration: LoopIterationEntry,
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  overlay: Record<string, NodeOverlayStatus>,
  traversed: Set<string>,
  active: Set<string>,
  backendIterEdges?: Record<string, 'running' | 'completed'>,
): void {
  // loop_end is excluded from bodyNodeIds — it has no execution data and acts
  // as a visual terminal; edges to it are always "traversed when taken".
  const bodyNodeIds = new Set(
    nodes
      .filter(
        (n) =>
          n.parentId === loopNodeId &&
          n.data.nodeType !== 'loop_start' &&
          n.data.nodeType !== 'loop_end',
      )
      .map((n) => n.id),
  );
  const loopEndNodeIds = new Set(
    nodes
      .filter((n) => n.parentId === loopNodeId && n.data.nodeType === 'loop_end')
      .map((n) => n.id),
  );

  const stepStatusMap = new Map<string, string>();
  for (const stepData of Object.values(iteration.steps)) {
    if (stepData.stepId) stepStatusMap.set(stepData.stepId, stepData.status || 'pending');
  }

  // Overlay body nodes (always from iteration step data)
  for (const [stepId, status] of stepStatusMap) {
    if (bodyNodeIds.has(stepId)) overlay[stepId] = status as NodeOverlayStatus;
  }

  // Edges body → loop_end (or legacy body → loop container) are never in the
  // backend pathState — stripped during canvas-to-steps. Apply before early-return.
  for (const edge of edges) {
    const isTerminalTarget = edge.target === loopNodeId || loopEndNodeIds.has(edge.target);
    if (!isTerminalTarget || !bodyNodeIds.has(edge.source)) continue;
    const sourceStatus = stepStatusMap.get(edge.source);
    if (sourceStatus && LOOP_DONE.has(sourceStatus)) traversed.add(edge.id);
  }

  // Edge highlights — use backend data when available (handles conditions correctly)
  if (backendIterEdges) {
    for (const [edgeId, status] of Object.entries(backendIterEdges)) {
      if (status === 'running') active.add(edgeId);
      else traversed.add(edgeId);
    }
    return;
  }

  // Fallback: client-side inference
  const loopStartId = nodes.find(
    (n) => n.parentId === loopNodeId && n.data.nodeType === 'loop_start',
  )?.id;
  const hasAnySteps = stepStatusMap.size > 0;

  for (const edge of edges) {
    const sourceIsBody = bodyNodeIds.has(edge.source);
    const sourceIsLoopStart = edge.source === loopStartId;
    const targetIsBody = bodyNodeIds.has(edge.target);
    const targetIsLoopEnd = edge.target === loopNodeId || loopEndNodeIds.has(edge.target);
    if (!((sourceIsBody || sourceIsLoopStart) && (targetIsBody || targetIsLoopEnd))) continue;

    if (sourceIsLoopStart) {
      if (!hasAnySteps) continue;
      const targetStatus = stepStatusMap.get(edge.target);
      if (targetStatus && LOOP_ACTIVE.has(targetStatus)) {
        active.add(edge.id);
      } else {
        traversed.add(edge.id);
      }
      continue;
    }

    const sourceStatus = stepStatusMap.get(edge.source);
    if (!sourceStatus || !LOOP_DONE.has(sourceStatus)) continue;

    const handle = edge.sourceHandle;
    let taken = false;
    if (handle === 'on_success' || !handle) {
      taken = sourceStatus === 'completed' || sourceStatus === 'skipped';
    } else if (handle === 'on_failure') {
      taken = sourceStatus === 'failed';
    } else if (handle === 'on_reject') {
      taken = sourceStatus === 'rejected';
    } else if (handle === 'on_approve') {
      taken = sourceStatus === 'completed';
    } else {
      taken = sourceStatus === 'completed' || sourceStatus === 'skipped';
    }
    if (!taken) continue;

    // loop_body_end edges target the loop container — always traversed when taken
    if (targetIsLoopEnd) {
      traversed.add(edge.id);
      continue;
    }

    const targetStatus = stepStatusMap.get(edge.target);
    if (targetStatus && LOOP_ACTIVE.has(targetStatus)) {
      active.add(edge.id);
    } else if (targetStatus && LOOP_DONE.has(targetStatus)) {
      traversed.add(edge.id);
    }
  }
}

// =============================================================================
// STORE
// =============================================================================

export const useWorkflowCanvasStore = create<WorkflowCanvasStore>((set, get) => ({
  // Initial state
  workflowId: null,
  pageWorkflowId: null,
  workflowName: '',
  workflowDescription: '',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  testActionNodeId: null,
  validationIssues: [],
  configPanelOpen: false,
  validationPanelOpen: false,
  runDialogOpen: false,
  deployPanelOpen: false,
  canvasExpanded: false,
  expandedLoopId: null,
  isDirty: false,
  isSaving: false,
  changeVersion: 0,
  currentExecutionId: null,
  executionStatus: null,
  debugPanelOpen: false,
  isCancelling: false,
  executeAbortController: null,
  executionOverlay: null,
  executionEdges: null,
  loopIterationData: null,
  selectedLoopIteration: {},
  edgeBatchCounts: null,
  baseExecutionOverlay: null,
  baseExecutionEdges: null,
  iterationEdgePathState: null,
  executionContext: null,
  envVars: {},
  inputSchema: null,
  outputSchema: null,

  // ── Actions ──────────────────────────────────────────────────────────

  setWorkflow: (id, name, description, nodes, edges, envVars, inputSchema, outputSchema) =>
    set((state) => {
      const isSameWorkflow = state.workflowId === id;

      // NOTE: we intentionally do NOT write state.currentExecutionId to the previous
      // workflow's sessionStorage here. By the time setWorkflow(newId) fires, setWorkflowId(newId)
      // has already run (WorkflowDetailPage.useEffect mount), which means state.currentExecutionId
      // has already been updated to the new workflow's execution — writing it to the old workflow's
      // key corrupts that entry. The correct save is handled by setWorkflowId(null) cleanup, which
      // runs before setWorkflowId(newId) and preserves the old execution accurately.
      const stored = !isSameWorkflow ? readExec(id) : null;

      return {
        workflowId: id,
        // Pin pageWorkflowId here too so the canvas hydration guard
        // (canvasWorkflowId === workflowId) flips on the same render that
        // setWorkflow loads nodes — without this the Flow tab briefly
        // shows the loader after SWR returns from cache.
        pageWorkflowId: id,
        workflowName: name,
        workflowDescription: description,
        nodes: normalizeLoopGeometry(nodes),
        edges,
        envVars: envVars ?? {},
        inputSchema: inputSchema ?? null,
        outputSchema: outputSchema ?? null,
        isDirty: false,
        changeVersion: 0,
        selectedNodeId: null,
        validationIssues: [],
        executionOverlay: null,
        executionEdges: null,
        loopIterationData: null,
        selectedLoopIteration: {},
        edgeBatchCounts: null,
        baseExecutionOverlay: null,
        baseExecutionEdges: null,
        iterationEdgePathState: null,
        // Same workflow (tab nav): preserve in-memory execution state unchanged.
        // Different workflow: restore from sessionStorage or clear, and reset
        // PR-introduced transient fields (cancel-in-flight + abort controller).
        ...(isSameWorkflow
          ? {}
          : {
              currentExecutionId: stored?.currentExecutionId ?? null,
              executionStatus: stored?.executionStatus ?? null,
              debugPanelOpen: stored?.debugPanelOpen ?? false,
              isCancelling: false,
              executeAbortController: null,
              executionContext: null,
            }),
      };
    }),

  onNodesChange: (changes) =>
    set((state) => {
      // Only mark dirty on user-authored changes. React Flow also emits
      // `dimensions` events on mount (DOM measurement) and `select` events on
      // click — neither is a real edit. For drags, mark dirty only at drag
      // end (`dragging === false`) to avoid spamming auto-save per frame.
      const meaningful = changes.some(
        (c) =>
          c.type === 'add' ||
          c.type === 'remove' ||
          c.type === 'replace' ||
          (c.type === 'position' && c.dragging === false),
      );

      let newNodes = applyNodeChanges(changes, state.nodes);

      // On every child drag frame: resize the container so every side has exactly
      // LOOP_BODY_PAD (LOOP_TOP_PAD at the top) of padding around all children.
      // When a child moves toward the left/top, shift the container in that direction
      // and compensate all children so their absolute positions are unchanged.
      const affectedLoopIds = new Set<string>();
      for (const c of changes) {
        if (c.type === 'position') {
          const node = newNodes.find((n) => n.id === c.id);
          if (node?.parentId) affectedLoopIds.add(node.parentId);
        }
      }
      for (const loopId of affectedLoopIds) {
        const children = newNodes.filter((n) => n.parentId === loopId);
        if (children.length === 0) continue;
        const bodyChildren = children.filter((child) => child.data.nodeType !== 'loop_start');
        if (bodyChildren.length === 0) continue;

        let minX = Infinity,
          minY = Infinity,
          maxRight = 0,
          maxBottom = 0;
        for (const child of bodyChildren) {
          const w = LOOP_NODE_W;
          const h = LOOP_NODE_H;
          minX = Math.min(minX, child.position.x);
          minY = Math.min(minY, child.position.y);
          maxRight = Math.max(maxRight, child.position.x + w);
          maxBottom = Math.max(maxBottom, child.position.y + h);
        }

        // Shift amount to place the leftmost/topmost child exactly at the padding boundary
        const shiftX = LOOP_BODY_PAD - minX;
        const shiftY = LOOP_TOP_PAD - minY;

        // Move container in the opposite direction and compensate children so that
        // all absolute positions remain unchanged (pure visual repositioning).
        if (shiftX !== 0 || shiftY !== 0) {
          newNodes = newNodes.map((n) => {
            if (n.id === loopId)
              return {
                ...n,
                position: { x: n.position.x - shiftX, y: n.position.y - shiftY },
              };
            if (n.parentId === loopId && n.data.nodeType !== 'loop_start')
              return {
                ...n,
                position: { x: n.position.x + shiftX, y: n.position.y + shiftY },
              };
            return n;
          });
        }

        const newWidth = Math.max(LOOP_MIN_W, maxRight + shiftX + LOOP_BODY_PAD + LOOP_HANDLE_AREA);
        const newHeight = Math.max(LOOP_MIN_H, maxBottom + shiftY + LOOP_BODY_PAD);

        // Set both width/height and style so ReactFlow's internal measured value is overridden
        newNodes = newNodes.map((n) =>
          n.id === loopId
            ? {
                ...n,
                width: newWidth,
                height: newHeight,
                style: { ...n.style, width: newWidth, height: newHeight },
              }
            : n,
        );
      }

      return {
        nodes: normalizeLoopGeometry(newNodes),
        ...(meaningful ? { isDirty: true, changeVersion: state.changeVersion + 1 } : {}),
      };
    }),

  onEdgesChange: (changes) =>
    set((state) => {
      const meaningful = changes.some(
        (c) => c.type === 'add' || c.type === 'remove' || c.type === 'replace',
      );
      return {
        edges: applyEdgeChanges(changes, state.edges),
        ...(meaningful ? { isDirty: true, changeVersion: state.changeVersion + 1 } : {}),
      };
    }),

  onConnect: (connection: Connection) =>
    set((state) => {
      if (!connection.source || !connection.target) return state;

      // Prevent exact duplicate connections (same source, handle, AND target)
      const alreadyConnected = state.edges.some(
        (e) =>
          e.source === connection.source &&
          e.sourceHandle === connection.sourceHandle &&
          e.target === connection.target,
      );
      if (alreadyConnected) return state;

      // Enforce fan-out cap — at most MAX_FAN_OUT outgoing edges from the same handle
      const fanOutCount = state.edges.filter(
        (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle,
      ).length;
      if (fanOutCount >= MAX_FAN_OUT) return state;

      // Block invalid connections — scope violations, loop-container targets, cycles.
      // `isValidConnection` on ReactFlow already gives visual feedback during drag;
      // this is the programmatic backstop that enforces the same rules on drop.
      if (!isValidWorkflowConnection(state.edges, state.nodes, connection)) {
        toast.error('Cannot connect: this would create an invalid or cyclic connection.');
        return state;
      }

      return {
        edges: addEdge(connection, state.edges),
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      };
    }),

  arrangeNodes: (positioned) =>
    set((state) => {
      const positionById = new Map(positioned.map((n) => [n.id, n.position]));
      let arrangedNodes = state.nodes.map((n) => {
        const next = positionById.get(n.id);
        return next ? { ...n, position: next } : n;
      });
      arrangedNodes = normalizeLoopGeometry(arrangedNodes);

      return {
        nodes: arrangedNodes,
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      };
    }),

  addNode: (nodeType, position, sourceInfo) => {
    const state = get();
    const existingNames = state.nodes.map((n) => n.data.label);
    const label = generateNodeName(nodeType, existingNames);
    const defaultPos = position ?? { x: 300, y: 200 };

    // Default config per node type
    let defaultConfig: Record<string, unknown> = {};
    if (nodeType === 'condition') {
      defaultConfig = { conditions: [{ id: 'if', label: 'If', expression: '' }] };
    } else if (nodeType === 'delay') {
      defaultConfig = { duration: 5, unit: 'seconds' };
    } else if (nodeType === 'loop') {
      defaultConfig = {
        mode: 'sequential',
        source: '',
        itemAlias: 'currentItem',
        outputField: 'results',
        onError: 'continue',
        maxIterations: 1000,
      };
    }

    // ── Loop node: also auto-create its loop_start and loop_end children ───
    if (nodeType === 'loop') {
      const loopId = crypto.randomUUID();
      const startId = crypto.randomUUID();
      const endId = crypto.randomUUID();
      const startLabel = generateNodeName('loop_start', [...existingNames, label]);
      const endLabel = generateNodeName('loop_end', [...existingNames, label, startLabel]);

      const loopStartNode: WorkflowFlowNode = {
        id: startId,
        type: 'loopStartNode',
        position: LOOP_START_INIT_POS,
        draggable: false,
        selectable: false,
        deletable: false,
        data: {
          nodeType: 'loop_start',
          label: startLabel,
          config: {},
          color: NODE_COLOR_MAP['loop_start'],
          isStub: false,
          outputHandles: getOutputHandles('loop_start'),
        },
        parentId: loopId,
      };

      const loopEndNodeData: WorkflowFlowNode = {
        id: endId,
        type: 'loopEndNode',
        position: {
          x: LOOP_MIN_W - LOOP_RIGHT_RECT_INSET,
          y: (LOOP_MIN_H - LOOP_RIGHT_RECT_H) / 2,
        },
        draggable: false,
        selectable: false,
        deletable: false,
        style: { pointerEvents: 'none', background: 'transparent' },
        data: {
          nodeType: 'loop_end',
          label: endLabel,
          config: {},
          color: NODE_COLOR_MAP['loop_end'],
          isStub: false,
          outputHandles: getOutputHandles('loop_end'),
        },
        parentId: loopId,
      };

      const loopNode: WorkflowFlowNode = {
        id: loopId,
        type: 'loopNode',
        position: defaultPos,
        style: { width: LOOP_MIN_W, height: LOOP_MIN_H, overflow: 'visible' },
        data: {
          nodeType: 'loop',
          label,
          config: defaultConfig,
          color: NODE_COLOR_MAP['loop'],
          isStub: false,
          outputHandles: getOutputHandles('loop', defaultConfig),
        },
      };
      const normalizedLoopNodes = normalizeLoopGeometry([loopNode, loopStartNode, loopEndNodeData]);
      const normalizedLoopNode = normalizedLoopNodes.filter((node) => node.id === loopId)[0]!;
      const normalizedLoopStartNode = normalizedLoopNodes.filter((node) => node.id === startId)[0]!;
      const normalizedLoopEndNode = normalizedLoopNodes.filter((node) => node.id === endId)[0]!;

      const newEdges = [...state.edges];
      if (sourceInfo) {
        newEdges.push({
          id: `e-${sourceInfo.nodeId}-${startId}`,
          source: sourceInfo.nodeId,
          sourceHandle: sourceInfo.handleId,
          target: startId,
          type: 'workflowEdge',
        });
      }

      set({
        nodes: [...state.nodes, normalizedLoopNode, normalizedLoopStartNode, normalizedLoopEndNode],
        edges: newEdges,
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      });
      return loopId;
    }

    // ── Detect loop body context ──────────────────────────────────────────
    let parentLoopId: string | undefined;
    let resolvedPosition = defaultPos;

    if (sourceInfo) {
      const sourceNode = state.nodes.find((n) => n.id === sourceInfo.nodeId);
      const isLoopBodyContext =
        sourceNode?.data.nodeType === 'loop_start' || sourceNode?.parentId !== undefined;

      if (isLoopBodyContext) {
        if (nodeType === 'start' || nodeType === 'end') {
          return '';
        }
        parentLoopId =
          sourceNode?.data.nodeType === 'loop_start'
            ? (sourceNode.parentId as string)
            : (sourceNode?.parentId as string);

        // Position is passed from HandlePlusMenu (sourceNode.position + 250),
        // which is already relative to the loop container since loop_start and
        // body nodes use parent-relative coordinates.
        resolvedPosition = position ?? {
          x: (sourceNode?.position.x ?? 20) + 260,
          y: sourceNode?.position.y ?? 100,
        };
      }
    }

    const newNode: WorkflowFlowNode = {
      id: crypto.randomUUID(),
      type: resolveNodeType(nodeType),
      position: resolvedPosition,
      data: {
        nodeType,
        label,
        config: defaultConfig,
        color: NODE_COLOR_MAP[nodeType],
        isStub: STUB_NODE_TYPES.includes(nodeType),
        outputHandles: getOutputHandles(nodeType, defaultConfig),
      },
    };

    if (parentLoopId) {
      newNode.parentId = parentLoopId;
    }

    const newEdges = [...state.edges];
    if (sourceInfo) {
      newEdges.push({
        id: `e-${sourceInfo.nodeId}-${newNode.id}`,
        source: sourceInfo.nodeId,
        sourceHandle: sourceInfo.handleId,
        target: newNode.id,
        type: 'workflowEdge',
      });
    }

    // Resize the loop container to fit the new child
    let updatedNodes = [...state.nodes, newNode];
    if (parentLoopId) {
      updatedNodes = normalizeLoopGeometry(updatedNodes);
    }

    set({
      nodes: updatedNodes,
      edges: newEdges,
      isDirty: true,
      changeVersion: state.changeVersion + 1,
    });

    return newNode.id;
  },

  updateNodeConfig: (nodeId, config) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                config,
                outputHandles: getOutputHandles(node.data.nodeType, config),
              },
            }
          : node,
      ),
      isDirty: true,
      changeVersion: state.changeVersion + 1,
    })),

  updateNodeName: (nodeId, name) =>
    set((state) => {
      // Enforce unique names — reject if another node already has this name
      const isDuplicate = state.nodes.some((n) => n.id !== nodeId && n.data.label === name);
      if (isDuplicate) return state;
      return {
        nodes: state.nodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, label: name } } : node,
        ),
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      };
    }),

  removeNode: (nodeId) =>
    set((state) => {
      const nodeToRemove = state.nodes.find((n) => n.id === nodeId);

      // loop_start / loop_end cannot be deleted directly — removed with parent loop
      if (
        nodeToRemove?.data.nodeType === 'loop_start' ||
        nodeToRemove?.data.nodeType === 'loop_end'
      )
        return state;

      const parentLoopId = nodeToRemove?.parentId;

      // When removing a loop container, cascade-delete all its children
      const idsToRemove = new Set([nodeId]);
      if (nodeToRemove?.data.nodeType === 'loop') {
        for (const n of state.nodes) {
          if (n.parentId === nodeId) idsToRemove.add(n.id);
        }
      }

      let filteredNodes = state.nodes.filter((n) => !idsToRemove.has(n.id));

      // Resize loop container to remaining children after deletion
      if (parentLoopId) {
        const { width, height } = computeLoopSize(parentLoopId, filteredNodes);
        filteredNodes = filteredNodes.map((n) =>
          n.id === parentLoopId ? { ...n, width, height, style: { ...n.style, width, height } } : n,
        );
      }

      return {
        nodes: filteredNodes,
        edges: state.edges.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)),
        selectedNodeId:
          state.selectedNodeId && idsToRemove.has(state.selectedNodeId)
            ? null
            : state.selectedNodeId,
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      };
    }),

  removeEdge: (edgeId) =>
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
      isDirty: true,
      changeVersion: state.changeVersion + 1,
    })),

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      // When deselecting, clear XY Flow's selected flag so the ring disappears
      nodes:
        nodeId === null
          ? state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n))
          : state.nodes,
    })),

  openTestActionModal: (nodeId) => set({ testActionNodeId: nodeId }),
  closeTestActionModal: () => set({ testActionNodeId: null }),

  setValidationIssues: (issues) => set({ validationIssues: issues }),

  setConfigPanelOpen: (open) => set({ configPanelOpen: open }),
  setValidationPanelOpen: (open) => set({ validationPanelOpen: open }),
  setRunDialogOpen: (open) => set({ runDialogOpen: open }),
  setDeployPanelOpen: (open) => set({ deployPanelOpen: open }),
  setCanvasExpanded: (expanded) => set({ canvasExpanded: expanded }),
  setExpandedLoopId: (id) => set({ expandedLoopId: id }),
  setCurrentExecutionId: (id) =>
    set((state) => {
      if (state.workflowId) {
        // Always clear pathState when switching executions. writeExec removes the key
        // entirely when id is null, so a single key wf_exec:<workflowId> covers both.
        writeExec(state.workflowId, {
          currentExecutionId: id,
          executionStatus: id === null ? null : state.executionStatus,
          debugPanelOpen: state.debugPanelOpen,
          pathState: null,
          iterationPathState: null,
        });
      }
      return {
        currentExecutionId: id,
        executionOverlay: null,
        executionEdges: null,
        loopIterationData: null,
        selectedLoopIteration: {},
        edgeBatchCounts: null,
        baseExecutionOverlay: null,
        baseExecutionEdges: null,
        iterationEdgePathState: null,
        ...(id === null ? { executionStatus: null } : {}),
      };
    }),
  setExecutionStatus: (status) =>
    set((state) => {
      const isTerminal =
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'rejected';
      if (isTerminal && state.workflowId && state.currentExecutionId) {
        const stored = readExec(state.workflowId);
        writeExec(state.workflowId, {
          currentExecutionId: state.currentExecutionId,
          executionStatus: status,
          debugPanelOpen: state.debugPanelOpen,
          pathState: stored?.pathState ?? null,
          iterationPathState: stored?.iterationPathState ?? null,
        });
      }
      return { executionStatus: status };
    }),
  setDebugPanelOpen: (open) =>
    set((state) => {
      if (state.workflowId) {
        const priorStored = readExec(state.workflowId);
        const isTerminalStatus =
          state.executionStatus === 'completed' ||
          state.executionStatus === 'failed' ||
          state.executionStatus === 'cancelled' ||
          state.executionStatus === 'rejected';
        writeExec(state.workflowId, {
          currentExecutionId: state.currentExecutionId,
          executionStatus: isTerminalStatus ? state.executionStatus : null,
          debugPanelOpen: open,
          pathState: priorStored?.pathState ?? null,
          iterationPathState: priorStored?.iterationPathState ?? null,
        });
      }
      return {
        debugPanelOpen: open,
        ...(open
          ? {}
          : {
              executionOverlay: null,
              executionEdges: null,
              loopIterationData: null,
              selectedLoopIteration: {},
              edgeBatchCounts: null,
              baseExecutionOverlay: null,
              baseExecutionEdges: null,
            }),
      };
    }),

  setIsCancelling: (cancelling) => set({ isCancelling: cancelling }),
  setExecuteAbortController: (controller) => set({ executeAbortController: controller }),

  setIsSaving: (saving) => set({ isSaving: saving }),

  markSaved: () => set({ isDirty: false, isSaving: false }),
  markSavedIfUnchanged: (version) =>
    set((state) =>
      state.changeVersion === version ? { isDirty: false, isSaving: false } : { isSaving: false },
    ),

  setExecutionOverlay: (overlay) =>
    set({
      executionOverlay: overlay as Record<string, NodeOverlayStatus> | null,
    }),

  setExecutionEdges: (edges) => set({ executionEdges: edges }),
  setExecutionContext: (context) => set({ executionContext: context }),

  setBaseExecution: (overlay, edges) =>
    set((state) => {
      const base = overlay as Record<string, NodeOverlayStatus>;
      const finalOverlay: Record<string, NodeOverlayStatus> = { ...base };
      const finalTraversed = new Set<string>(edges.traversed);
      const finalActive = new Set<string>(edges.active);

      for (const [loopId, iterIdx] of Object.entries(state.selectedLoopIteration)) {
        const iters = state.loopIterationData?.[loopId];
        if (!iters || iterIdx < 0 || iterIdx >= iters.length) continue;
        const backendIterEdges =
          state.iterationEdgePathState?.[loopId]?.[String(iterIdx)] ?? undefined;
        applyIterationToState(
          loopId,
          iters[iterIdx],
          state.nodes,
          state.edges,
          finalOverlay,
          finalTraversed,
          finalActive,
          backendIterEdges,
        );
      }

      return {
        baseExecutionOverlay: base,
        baseExecutionEdges: edges,
        executionOverlay: finalOverlay,
        executionEdges: { traversed: finalTraversed, active: finalActive },
      };
    }),

  setLoopData: (loopNodeId, iterations) =>
    set((state) => ({
      loopIterationData: { ...(state.loopIterationData ?? {}), [loopNodeId]: iterations },
    })),

  setSelectedLoopIteration: (loopNodeId, iterationIndex) =>
    set((state) => {
      const newSelected = { ...state.selectedLoopIteration, [loopNodeId]: iterationIndex };
      const allLoopData = state.loopIterationData ?? {};

      const finalOverlay: Record<string, NodeOverlayStatus> = {
        ...(state.baseExecutionOverlay ?? {}),
      };
      const finalTraversed = new Set<string>(state.baseExecutionEdges?.traversed ?? []);
      const finalActive = new Set<string>(state.baseExecutionEdges?.active ?? []);

      for (const [loopId, iterIdx] of Object.entries(newSelected)) {
        const iters = allLoopData[loopId];
        if (!iters || iterIdx < 0 || iterIdx >= iters.length) continue;
        const backendIterEdges =
          state.iterationEdgePathState?.[loopId]?.[String(iterIdx)] ?? undefined;
        applyIterationToState(
          loopId,
          iters[iterIdx],
          state.nodes,
          state.edges,
          finalOverlay,
          finalTraversed,
          finalActive,
          backendIterEdges,
        );
      }

      return {
        selectedLoopIteration: newSelected,
        executionOverlay: finalOverlay,
        executionEdges: { traversed: finalTraversed, active: finalActive },
      };
    }),

  mergeIterationEdgePathState: (incoming) =>
    set((state) => {
      const merged: Record<string, Record<string, Record<string, 'running' | 'completed'>>> = {
        ...(state.iterationEdgePathState ?? {}),
      };
      for (const [loopId, iterMap] of Object.entries(incoming)) {
        merged[loopId] = { ...(merged[loopId] ?? {}), ...iterMap };
      }
      return { iterationEdgePathState: merged };
    }),

  setEdgeBatchCounts: (counts) =>
    set((state) => ({
      edgeBatchCounts: counts,
      // Embed badge data into each edge's `data` field so ReactFlow re-renders
      // edge components via its own prop mechanism. Zustand subscriptions inside
      // ReactFlow edge components don't reliably trigger re-renders in v12 when
      // the store update originates outside ReactFlow's rendering cycle (same root
      // cause as the node data staleness fixed in LoopNodeComponent).
      edges: state.edges.map((e) => {
        const badge = counts?.[e.id] ?? null;
        const currentBadge = (e.data as Record<string, unknown> | undefined)?.batchBadge ?? null;
        if (badge === currentBadge) return e;
        return {
          ...e,
          data: { ...(e.data as Record<string, unknown> | undefined), batchBadge: badge },
        };
      }),
    })),

  setNodeZIndex: (nodeId, zIndex) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, zIndex } : n)),
    })),

  setPersistedPathState: (targetWorkflowId, targetExecutionId, pathState, iterationPathState) => {
    if (!targetWorkflowId || !targetExecutionId || targetExecutionId === '__starting__') return;
    // Read debugPanelOpen from the STORED entry for this workflow (not from get()) so
    // that navigating to another workflow doesn't corrupt the source workflow's flag.
    const stored = readExec(targetWorkflowId);
    writeExec(targetWorkflowId, {
      currentExecutionId: targetExecutionId,
      executionStatus: stored?.executionStatus ?? null,
      debugPanelOpen: stored?.debugPanelOpen ?? false,
      pathState,
      iterationPathState,
    });
  },

  readStoredPathState: () => {
    const { workflowId, currentExecutionId } = get();
    if (!workflowId || !currentExecutionId) return null;
    const stored = readExec(workflowId);
    if (!stored || stored.currentExecutionId !== currentExecutionId) return null;
    return {
      pathState: stored.pathState ?? null,
      iterationPathState: stored.iterationPathState ?? null,
    };
  },

  setEnvVars: (envVars) =>
    set((state) => ({ envVars, isDirty: true, changeVersion: state.changeVersion + 1 })),

  setWorkflowId: (id) =>
    set((state) => {
      if (state.pageWorkflowId === id) return {};
      // Mirror setWorkflow's persist/restore so the header Run/Stop button
      // reflects the persisted execution on non-Flow tabs (Overview, Versions,
      // etc.) without waiting for the Flow tab to remount setWorkflow.
      if (state.pageWorkflowId && state.currentExecutionId) {
        const priorStored = readExec(state.pageWorkflowId);
        const isTerminalStatus =
          state.executionStatus === 'completed' ||
          state.executionStatus === 'failed' ||
          state.executionStatus === 'cancelled' ||
          state.executionStatus === 'rejected';
        writeExec(state.pageWorkflowId, {
          currentExecutionId: state.currentExecutionId,
          executionStatus: isTerminalStatus ? state.executionStatus : null,
          debugPanelOpen: state.debugPanelOpen,
          pathState: priorStored?.pathState ?? null,
          iterationPathState: priorStored?.iterationPathState ?? null,
        });
      }
      const stored = id ? readExec(id) : null;
      return {
        pageWorkflowId: id,
        currentExecutionId: stored?.currentExecutionId ?? null,
        executionStatus: stored?.executionStatus ?? null,
        debugPanelOpen: stored?.debugPanelOpen ?? false,
      };
    }),

  toggleOnFailure: (nodeId, enabled) =>
    set((state) => {
      const updatedNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const newConfig = { ...node.data.config, onFailureEnabled: enabled };
        return {
          ...node,
          data: {
            ...node.data,
            config: newConfig,
            outputHandles: getOutputHandles(node.data.nodeType, newConfig),
          },
        };
      });

      // When disabling, remove any existing on_failure edges from this node
      let updatedEdges = state.edges;
      if (!enabled) {
        updatedEdges = state.edges.filter(
          (e) => !(e.source === nodeId && e.sourceHandle === 'on_failure'),
        );
      }

      return {
        nodes: updatedNodes,
        edges: updatedEdges,
        isDirty: true,
        changeVersion: state.changeVersion + 1,
      };
    }),

  updateOnFailureTarget: (nodeId, targetNodeId) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === nodeId);
    const targetNode = state.nodes.find((n) => n.id === targetNodeId);
    if (sourceNode?.parentId !== targetNode?.parentId) return;
    const nodeTypeOf = {
      get: (id: string) => state.nodes.find((n) => n.id === id)?.data.nodeType,
    };
    if (wouldCreateCycle(state.edges, nodeId, targetNodeId, nodeTypeOf)) {
      toast.error('Cannot connect: this would create an infinite loop in the workflow.');
      return;
    }
    const edgesWithoutOldFailure = state.edges.filter(
      (e) => !(e.source === nodeId && e.sourceHandle === 'on_failure'),
    );
    const newEdge: WorkflowFlowEdge = {
      id: `e-${nodeId}-failure-${targetNodeId}`,
      source: nodeId,
      sourceHandle: 'on_failure',
      target: targetNodeId,
      type: 'workflowEdge',
    };
    set({
      edges: [...edgesWithoutOldFailure, newEdge],
      isDirty: true,
      changeVersion: state.changeVersion + 1,
    });
  },

  updateOnSuccessTarget: (nodeId, targetNodeId) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === nodeId);
    const targetNode = state.nodes.find((n) => n.id === targetNodeId);
    if (sourceNode?.parentId !== targetNode?.parentId) return;
    const nodeTypeOf = {
      get: (id: string) => state.nodes.find((n) => n.id === id)?.data.nodeType,
    };
    if (wouldCreateCycle(state.edges, nodeId, targetNodeId, nodeTypeOf)) {
      toast.error('Cannot connect: this would create an infinite loop in the workflow.');
      return;
    }
    const edgesWithoutOldSuccess = state.edges.filter(
      (e) => !(e.source === nodeId && e.sourceHandle === 'on_success'),
    );
    const newEdge: WorkflowFlowEdge = {
      id: `e-${nodeId}-success-${targetNodeId}`,
      source: nodeId,
      sourceHandle: 'on_success',
      target: targetNodeId,
      type: 'workflowEdge',
    };
    set({
      edges: [...edgesWithoutOldSuccess, newEdge],
      isDirty: true,
      changeVersion: state.changeVersion + 1,
    });
  },

  // ── Serialization ────────────────────────────────────────────────────

  toWorkflowNodes: (): WorkflowNode[] => {
    const { nodes } = get();
    return nodes.map((n) => {
      const node: WorkflowNode = {
        id: n.id,
        nodeType: n.data.nodeType,
        name: n.data.label,
        position: { x: n.position.x, y: n.position.y },
        config: n.data.config,
      };
      if (n.parentId) node.parentId = n.parentId;
      return node;
    });
  },

  toWorkflowEdges: (): WorkflowEdge[] => {
    const { edges, nodes } = get();
    const parentLoopByLoopStartId = new Map(
      nodes
        .filter((node) => node.data.nodeType === 'loop_start' && node.parentId)
        .map((node) => [node.id, node.parentId as string]),
    );

    return edges
      .map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? 'on_success',
        // loop_body_end targets the loop container directly — keep as-is.
        // All other edges to loop_start are remapped to the parent loop container for storage.
        target:
          e.targetHandle === 'loop_body_end'
            ? e.target
            : (parentLoopByLoopStartId.get(e.target) ?? e.target),
        targetHandle: e.targetHandle ?? undefined,
        label: typeof e.label === 'string' ? e.label : undefined,
      }))
      .filter((edge) => edge.source !== edge.target);
  },
}));

// Expose store for E2E testing
if (typeof window !== 'undefined') {
  (window as any).__zustandStores = (window as any).__zustandStores || {};
  (window as any).__zustandStores.workflowCanvas = useWorkflowCanvasStore;
}
