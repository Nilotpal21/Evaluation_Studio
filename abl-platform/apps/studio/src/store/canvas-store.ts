import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { XYPosition, Viewport } from '@xyflow/react';

// =============================================================================
// Store 1: Viewport — changes on EVERY pan/zoom frame (60fps during interaction)
// =============================================================================

export type SemanticZoomLevel = 'compact' | 'summary' | 'full';

interface ViewportStore {
  zoom: number;
  position: XYPosition;
  semanticZoomLevel: SemanticZoomLevel;
  setViewport: (zoom: number, position: XYPosition) => void;
}

export const useCanvasViewportStore = create<ViewportStore>((set) => ({
  zoom: 1,
  position: { x: 0, y: 0 },
  semanticZoomLevel: 'full',
  setViewport: (zoom, position) =>
    set((state) => {
      let level: SemanticZoomLevel;
      const current = state.semanticZoomLevel;
      // Hysteresis: require crossing by 0.03 to prevent flickering at boundaries
      if (current === 'full' && zoom < 0.57) level = 'summary';
      else if (current === 'summary' && zoom >= 0.63) level = 'full';
      else if (current === 'summary' && zoom < 0.27) level = 'compact';
      else if (current === 'compact' && zoom >= 0.33) level = 'summary';
      else level = current;
      return { zoom, position, semanticZoomLevel: level };
    }),
}));

// =============================================================================
// Store 2: Selection — changes on click (low-medium frequency)
// =============================================================================

export type SidePanelContentType = 'edge' | 'node' | 'agent';

export interface SidePanelContent {
  type: SidePanelContentType;
  id: string;
  data: Record<string, unknown>;
}

interface SelectionStore {
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;
  hoveredNodeId: string | null;
  sidePanelContent: SidePanelContent | null;
  selectNode: (id: string) => void;
  deselectAll: () => void;
  selectEdge: (id: string) => void;
  setHovered: (id: string | null) => void;
  openSidePanel: (content: SidePanelContent) => void;
  closeSidePanel: () => void;
}

export const useCanvasSelectionStore = create<SelectionStore>((set) => ({
  selectedNodeIds: new Set<string>(),
  selectedEdgeIds: new Set<string>(),
  hoveredNodeId: null,
  sidePanelContent: null,
  selectNode: (id) =>
    set({
      selectedNodeIds: new Set([id]),
      selectedEdgeIds: new Set(),
    }),
  deselectAll: () =>
    set({
      selectedNodeIds: new Set(),
      selectedEdgeIds: new Set(),
      sidePanelContent: null,
    }),
  selectEdge: (id) =>
    set({
      selectedEdgeIds: new Set([id]),
      selectedNodeIds: new Set(),
    }),
  setHovered: (id) => set({ hoveredNodeId: id }),
  openSidePanel: (content) => set({ sidePanelContent: content }),
  closeSidePanel: () => set({ sidePanelContent: null }),
}));

// =============================================================================
// Store 3: Canvas Data — changes on topology fetch or layout recalculation
// =============================================================================

const MAX_PERSISTED_PROJECTS = 20;

/** Keep only the most recent N entries (by JS object insertion order). */
function trimToRecent<T>(obj: Record<string, T>): Record<string, T> {
  const keys = Object.keys(obj);
  if (keys.length <= MAX_PERSISTED_PROJECTS) return obj;

  const kept = keys.slice(keys.length - MAX_PERSISTED_PROJECTS);
  const result: Record<string, T> = {};
  for (const key of kept) {
    result[key] = obj[key];
  }
  return result;
}

export type CanvasLayer = 'project' | 'agent';
export type TopologyPattern = 'tree' | 'mesh' | 'chain';

interface CanvasDataStore {
  layer: CanvasLayer;
  selectedAgentId: string | null;
  topologyPattern: TopologyPattern;

  projectViewports: Record<string, Viewport>;
  nodePositions: Record<string, Record<string, XYPosition>>;

  setLayer: (layer: CanvasLayer) => void;
  drillIntoAgent: (agentId: string) => void;
  backToProject: () => void;
  persistNodePosition: (projectId: string, nodeId: string, position: XYPosition) => void;
  persistViewport: (projectId: string, viewport: Viewport) => void;
  resetLayout: (projectId: string) => void;
  setTopologyPattern: (pattern: TopologyPattern) => void;
}

export const useCanvasDataStore = create<CanvasDataStore>()(
  persist(
    (set) => ({
      layer: 'project' as CanvasLayer,
      selectedAgentId: null,
      topologyPattern: 'tree' as TopologyPattern,

      projectViewports: {},
      nodePositions: {},

      setLayer: (layer) => set({ layer }),
      drillIntoAgent: (agentId) => set({ layer: 'agent', selectedAgentId: agentId }),
      backToProject: () => set({ layer: 'project', selectedAgentId: null }),

      persistNodePosition: (projectId, nodeId, position) =>
        set((state) => ({
          nodePositions: {
            ...state.nodePositions,
            [projectId]: {
              ...(state.nodePositions[projectId] ?? {}),
              [nodeId]: position,
            },
          },
        })),

      persistViewport: (projectId, viewport) =>
        set((state) => ({
          projectViewports: {
            ...state.projectViewports,
            [projectId]: viewport,
          },
        })),

      resetLayout: (projectId) =>
        set((state) => {
          const { [projectId]: _, ...rest } = state.nodePositions;
          return { nodePositions: rest };
        }),

      setTopologyPattern: (pattern) => set({ topologyPattern: pattern }),
    }),
    {
      name: 'abl-canvas-data',
      partialize: (state) => ({
        projectViewports: trimToRecent(state.projectViewports),
        nodePositions: trimToRecent(state.nodePositions),
      }),
    },
  ),
);

// Selectors
export const selectSemanticZoomLevel = (state: { semanticZoomLevel: SemanticZoomLevel }) =>
  state.semanticZoomLevel;
