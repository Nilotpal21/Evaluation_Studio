/**
 * Pipeline Editor Store
 *
 * Manages state for the custom pipeline graph editor:
 *   - Nodes and edges (React Flow graph data)
 *   - Selection state (node/edge)
 *   - Panel toggles (palette, config)
 *   - Pipeline metadata (name, description)
 *   - Dirty tracking and validation results
 */

import { create } from 'zustand';
import type { Node, Edge } from '@xyflow/react';
import { normalizeNodeReferenceName } from '@agent-platform/pipeline-engine/node-references';
import { TRIGGER_NODE_ID } from '../components/pipelines/pipeline-trigger-constants';

// =============================================================================
// Types
// =============================================================================

export interface ValidationIssue {
  nodeId?: string;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface SelectedTrigger {
  /** Trigger definition ID from the registry */
  triggerId: string;
  /** Cron expression (only for schedule triggers) */
  schedule?: string;
}

interface PipelineEditorState {
  // ── Pipeline metadata ──
  pipelineId: string | null;
  pipelineName: string;
  pipelineDescription: string;
  pipelineStatus: 'draft' | 'active' | 'archived';

  // ── Triggers ──
  selectedTriggers: SelectedTrigger[];

  // ── Graph data ──
  nodes: Node[];
  edges: Edge[];

  // ── Selection ──
  selectedNodeId: string | null;
  selectedEdgeId: string | null;

  // ── Panel visibility ──
  isPaletteOpen: boolean;
  isConfigPanelOpen: boolean;

  // ── State tracking ──
  isDirty: boolean;
  lastSavedAt: Date | null;
  validationResult: ValidationResult | null;

  // ── Pipeline metadata actions ──
  setPipeline: (
    id: string,
    name: string,
    status: 'draft' | 'active' | 'archived',
    nodes: Node[],
    edges: Edge[],
    selectedTriggers: SelectedTrigger[],
  ) => void;
  setPipelineName: (name: string) => void;
  setPipelineDescription: (description: string) => void;
  setPipelineStatus: (status: 'draft' | 'active' | 'archived') => void;

  // ── Trigger actions ──
  setSelectedTriggers: (triggers: SelectedTrigger[]) => void;
  toggleTrigger: (triggerId: string) => void;
  updateTriggerSchedule: (triggerId: string, schedule: string) => void;

  // ── Graph data actions ──
  replaceNodes: (nodes: Node[]) => void;
  replaceEdges: (edges: Edge[]) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
  addChildNode: (parentId: string, node: Node) => void;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  renameNode: (nodeId: string, label: string) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
  updateNodeConfig: (nodeId: string, key: string, value: unknown) => void;

  // ── Selection actions ──
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  clearSelection: () => void;

  // ── Panel actions ──
  togglePalette: () => void;
  toggleConfigPanel: () => void;
  setPaletteOpen: (open: boolean) => void;
  setConfigPanelOpen: (open: boolean) => void;

  // ── State tracking actions ──
  setValidationResult: (result: ValidationResult | null) => void;
  markSaved: () => void;
  markDirty: () => void;

  // ── Reset ──
  reset: () => void;
}

// =============================================================================
// Initial state
// =============================================================================

const initialState = {
  pipelineId: null,
  pipelineName: '',
  pipelineDescription: '',
  pipelineStatus: 'draft' as const,
  selectedTriggers: [] as SelectedTrigger[],
  nodes: [] as Node[],
  edges: [] as Edge[],
  selectedNodeId: null,
  selectedEdgeId: null,
  isPaletteOpen: true,
  isConfigPanelOpen: false,
  isDirty: false,
  lastSavedAt: null,
  validationResult: null,
};

function rewriteStepReference(value: unknown, oldReference: string, newReference: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(`steps.${oldReference}.output`, `steps.${newReference}.output`);
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteStepReference(item, oldReference, newReference));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        rewriteStepReference(nested, oldReference, newReference),
      ]),
    );
  }

  return value;
}

// =============================================================================
// Store
// =============================================================================

export const usePipelineEditorStore = create<PipelineEditorState>((set) => ({
  ...initialState,

  // ── Pipeline metadata actions ──

  setPipeline: (id, name, status, nodes, edges, selectedTriggers) =>
    set({
      pipelineId: id,
      pipelineName: name,
      pipelineStatus: status,
      selectedTriggers,
      nodes,
      edges,
      isDirty: false,
      lastSavedAt: null,
      validationResult: null,
    }),

  setPipelineName: (name) => set({ pipelineName: name, isDirty: true }),

  setPipelineDescription: (description) => set({ pipelineDescription: description, isDirty: true }),

  setPipelineStatus: (status) => set({ pipelineStatus: status }),

  // ── Trigger actions ──

  setSelectedTriggers: (triggers) => set({ selectedTriggers: triggers, isDirty: true }),

  toggleTrigger: (triggerId) =>
    set((state) => {
      const exists = state.selectedTriggers.some((t) => t.triggerId === triggerId);
      return {
        selectedTriggers: exists
          ? state.selectedTriggers.filter((t) => t.triggerId !== triggerId)
          : [...state.selectedTriggers, { triggerId }],
        isDirty: true,
      };
    }),

  updateTriggerSchedule: (triggerId, schedule) =>
    set((state) => ({
      selectedTriggers: state.selectedTriggers.map((t) =>
        t.triggerId === triggerId ? { ...t, schedule } : t,
      ),
      isDirty: true,
    })),

  // ── Graph data actions ──

  replaceNodes: (nodes) => set({ nodes }),

  replaceEdges: (edges) => set({ edges }),

  setNodes: (nodes) => set({ nodes, isDirty: true }),

  setEdges: (edges) => set({ edges, isDirty: true }),

  addNode: (node) =>
    set((state) => ({
      nodes: [...state.nodes, node],
      isDirty: true,
    })),

  addChildNode: (parentId, node) =>
    set((state) => {
      // Layout constants (duplicated to avoid circular imports)
      const CHILD_WIDTH = 220;
      const CHILD_HEIGHT = 100;
      const PAD_X = 20;
      const PAD_TOP = 56;
      const PAD_BOTTOM = 20;
      const GAP = 20;

      const siblings = state.nodes.filter((n) => n.parentId === parentId);
      const childNode: Node = {
        ...node,
        parentId,
        extent: 'parent' as const,
        position: {
          x: PAD_X + siblings.length * (CHILD_WIDTH + GAP),
          y: PAD_TOP,
        },
      };

      const newChildCount = siblings.length + 1;
      const newGroupWidth = Math.max(
        280,
        PAD_X * 2 + newChildCount * CHILD_WIDTH + (newChildCount - 1) * GAP,
      );
      const newGroupHeight = PAD_TOP + CHILD_HEIGHT + PAD_BOTTOM;

      return {
        nodes: [
          ...state.nodes.map((n) =>
            n.id === parentId
              ? { ...n, style: { ...n.style, width: newGroupWidth, height: newGroupHeight } }
              : n,
          ),
          childNode,
        ],
        isDirty: true,
      };
    }),

  removeNode: (nodeId) =>
    set((state) => {
      if (nodeId === TRIGGER_NODE_ID) return state;
      const targetNode = state.nodes.find((n) => n.id === nodeId);
      if (!targetNode) return state;

      // Layout constants
      const CHILD_WIDTH = 220;
      const CHILD_HEIGHT = 100;
      const PAD_X = 20;
      const PAD_TOP = 56;
      const PAD_BOTTOM = 20;
      const GAP = 20;

      // Removing a top-level or group node: cascade delete children
      if (!targetNode.parentId) {
        const childIds = new Set(state.nodes.filter((n) => n.parentId === nodeId).map((n) => n.id));
        const removeIds = new Set([nodeId, ...childIds]);
        return {
          nodes: state.nodes.filter((n) => !removeIds.has(n.id)),
          edges: state.edges.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target)),
          selectedNodeId: removeIds.has(state.selectedNodeId ?? '') ? null : state.selectedNodeId,
          isConfigPanelOpen: removeIds.has(state.selectedNodeId ?? '')
            ? false
            : state.isConfigPanelOpen,
          isDirty: true,
        };
      }

      // Removing a child node: reposition siblings and resize parent
      const parentId = targetNode.parentId;
      const remainingSiblings = state.nodes.filter(
        (n) => n.parentId === parentId && n.id !== nodeId,
      );
      const repositioned = new Map<string, { x: number; y: number }>();
      remainingSiblings.forEach((sib, i) => {
        repositioned.set(sib.id, {
          x: PAD_X + i * (CHILD_WIDTH + GAP),
          y: PAD_TOP,
        });
      });

      const newGroupWidth = Math.max(
        280,
        PAD_X * 2 +
          remainingSiblings.length * CHILD_WIDTH +
          Math.max(0, remainingSiblings.length - 1) * GAP,
      );
      const newGroupHeight = PAD_TOP + CHILD_HEIGHT + PAD_BOTTOM;

      return {
        nodes: state.nodes
          .filter((n) => n.id !== nodeId)
          .map((n) => {
            if (n.id === parentId) {
              return { ...n, style: { ...n.style, width: newGroupWidth, height: newGroupHeight } };
            }
            const newPos = repositioned.get(n.id);
            if (newPos) return { ...n, position: newPos };
            return n;
          }),
        edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
        isConfigPanelOpen: state.selectedNodeId === nodeId ? false : state.isConfigPanelOpen,
        isDirty: true,
      };
    }),

  removeEdge: (edgeId) =>
    set((state) => {
      const edge = state.edges.find((e) => e.id === edgeId);
      if (!edge) return state;
      return {
        edges: state.edges.filter((e) => e.id !== edgeId),
        selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
        isConfigPanelOpen: state.selectedEdgeId === edgeId ? false : state.isConfigPanelOpen,
        isDirty: true,
      };
    }),

  renameNode: (nodeId, label) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId);
      const targetData = target?.data as Record<string, unknown> | undefined;
      const oldReference = normalizeNodeReferenceName(
        String(targetData?.label ?? target?.id ?? ''),
      );
      const newReference = normalizeNodeReferenceName(label);
      const shouldRewrite = oldReference !== newReference;

      return {
        nodes: state.nodes.map((node) => {
          const nextData = node.id === nodeId ? { ...node.data, label } : { ...(node.data ?? {}) };
          if (!shouldRewrite || node.id === nodeId) {
            return node.id === nodeId ? { ...node, data: nextData } : node;
          }

          const config = (nextData as Record<string, unknown>).config;
          if (!config || typeof config !== 'object') return node;

          return {
            ...node,
            data: {
              ...nextData,
              config: rewriteStepReference(config, oldReference, newReference),
            },
          };
        }),
        isDirty: true,
      };
    }),

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
      isDirty: true,
    })),

  updateNodeConfig: (nodeId, key, value) =>
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const existingConfig = (n.data as Record<string, unknown>).config as
          | Record<string, unknown>
          | undefined;
        return {
          ...n,
          data: { ...n.data, config: { ...existingConfig, [key]: value } },
        };
      }),
      isDirty: true,
    })),

  // ── Selection actions ──

  selectNode: (nodeId) =>
    set({
      selectedNodeId: nodeId,
      selectedEdgeId: null,
      isConfigPanelOpen: nodeId !== null,
    }),

  selectEdge: (edgeId) =>
    set({
      selectedEdgeId: edgeId,
      selectedNodeId: null,
      isConfigPanelOpen: edgeId !== null,
    }),

  clearSelection: () =>
    set({
      selectedNodeId: null,
      selectedEdgeId: null,
      isConfigPanelOpen: false,
    }),

  // ── Panel actions ──

  togglePalette: () => set((state) => ({ isPaletteOpen: !state.isPaletteOpen })),

  toggleConfigPanel: () => set((state) => ({ isConfigPanelOpen: !state.isConfigPanelOpen })),

  setPaletteOpen: (open) => set({ isPaletteOpen: open }),

  setConfigPanelOpen: (open) => set({ isConfigPanelOpen: open }),

  // ── State tracking actions ──

  setValidationResult: (result) => set({ validationResult: result }),

  markSaved: () => set({ isDirty: false, lastSavedAt: new Date() }),

  markDirty: () => set({ isDirty: true }),

  // ── Reset ──

  reset: () => set({ ...initialState }),
}));
