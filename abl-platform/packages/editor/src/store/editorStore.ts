/**
 * Editor Store - Zustand state management for the visual editor
 */

import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import type {
  DSLNode,
  DSLEdge,
  EditorProject,
  PanelState,
  ViewMode,
  SelectionState,
  CanvasTransform,
  HistoryEntry,
  ValidationResult,
  CodeEditorState,
} from '../types.js';

// Maximum history entries for undo/redo
const MAX_HISTORY = 50;

export interface EditorState {
  // Project
  project: EditorProject | null;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;

  // Canvas
  nodes: DSLNode[];
  edges: DSLEdge[];
  transform: CanvasTransform;

  // Selection
  selection: SelectionState;

  // Panels
  panels: Record<string, PanelState>;

  // View
  viewMode: ViewMode;
  showGrid: boolean;
  showMinimap: boolean;

  // Code Editor
  codeEditor: CodeEditorState;

  // Validation
  validation: ValidationResult;

  // History
  history: HistoryEntry[];
  historyIndex: number;

  // Actions - Project
  createProject: (name: string) => void;
  loadProject: (project: EditorProject) => void;
  saveProject: () => Promise<void>;
  closeProject: () => void;

  // Actions - Documents
  setSupervisor: (doc: unknown) => void;
  addAgent: (agentId: string, doc: unknown) => void;
  updateAgent: (agentId: string, doc: unknown) => void;
  removeAgent: (agentId: string) => void;

  // Actions - Canvas
  setNodes: (nodes: DSLNode[]) => void;
  setEdges: (edges: DSLEdge[]) => void;
  addNode: (node: DSLNode) => void;
  updateNode: (nodeId: string, data: Partial<DSLNode['data']>) => void;
  removeNode: (nodeId: string) => void;
  addEdge: (edge: DSLEdge) => void;
  removeEdge: (edgeId: string) => void;
  setTransform: (transform: CanvasTransform) => void;

  // Actions - Selection
  setSelection: (selection: SelectionState) => void;
  selectNode: (nodeId: string, addToSelection?: boolean) => void;
  selectEdge: (edgeId: string, addToSelection?: boolean) => void;
  clearSelection: () => void;

  // Actions - Panels
  togglePanel: (panelId: string) => void;
  setPanelWidth: (panelId: string, width: number) => void;

  // Actions - View
  setViewMode: (mode: ViewMode) => void;
  toggleGrid: () => void;
  toggleMinimap: () => void;
  fitView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;

  // Actions - Code Editor
  setCodeContent: (content: string) => void;
  setCodeLanguage: (language: CodeEditorState['language']) => void;
  syncCodeToCanvas: () => void;
  syncCanvasToCode: () => void;

  // Actions - Validation
  validate: () => void;
  clearValidation: () => void;

  // Actions - History
  undo: () => void;
  redo: () => void;
  pushHistory: (description: string) => void;
  clearHistory: () => void;
}

const initialPanels: Record<string, PanelState> = {
  properties: { type: 'properties', isOpen: true, width: 300, position: 'right' },
  code: { type: 'code', isOpen: false, width: 400, position: 'right' },
  validation: { type: 'validation', isOpen: false, width: 300, position: 'bottom' },
  outline: { type: 'outline', isOpen: true, width: 250, position: 'left' },
};

export const useEditorStore = create<EditorState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      // Initial State
      project: null,
      isLoading: false,
      isSaving: false,
      isDirty: false,

      nodes: [],
      edges: [],
      transform: { x: 0, y: 0, zoom: 1 },

      selection: { nodeIds: [], edgeIds: [], type: 'none' },

      panels: initialPanels,

      viewMode: 'graph',
      showGrid: true,
      showMinimap: true,

      codeEditor: {
        content: '',
        language: 'dsl',
        cursorPosition: { line: 1, column: 1 },
        isDirty: false,
      },

      validation: {
        isValid: true,
        errors: [],
        warnings: [],
      },

      history: [],
      historyIndex: -1,

      // Project Actions
      createProject: (name: string) => {
        const project: EditorProject = {
          id: crypto.randomUUID(),
          name,
          supervisor: null,
          agents: new Map(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set({ project, nodes: [], edges: [], isDirty: false });
      },

      loadProject: (project: EditorProject) => {
        set({ project, isLoading: false, isDirty: false });
        // Convert documents to nodes/edges would happen here
      },

      saveProject: async () => {
        set({ isSaving: true });
        // Save logic would go here
        await new Promise((resolve) => setTimeout(resolve, 500));
        set({ isSaving: false, isDirty: false });
      },

      closeProject: () => {
        set({
          project: null,
          nodes: [],
          edges: [],
          isDirty: false,
          history: [],
          historyIndex: -1,
        });
      },

      // Document Actions
      setSupervisor: (doc: unknown) => {
        const { project } = get();
        if (project) {
          set({
            project: { ...project, supervisor: doc, updatedAt: new Date() },
            isDirty: true,
          });
        }
      },

      addAgent: (agentId: string, doc: unknown) => {
        const { project } = get();
        if (project) {
          const agents = new Map(project.agents);
          agents.set(agentId, doc);
          set({
            project: { ...project, agents, updatedAt: new Date() },
            isDirty: true,
          });
        }
      },

      updateAgent: (agentId: string, doc: unknown) => {
        const { project } = get();
        if (project && project.agents.has(agentId)) {
          const agents = new Map(project.agents);
          agents.set(agentId, doc);
          set({
            project: { ...project, agents, updatedAt: new Date() },
            isDirty: true,
          });
        }
      },

      removeAgent: (agentId: string) => {
        const { project } = get();
        if (project) {
          const agents = new Map(project.agents);
          agents.delete(agentId);
          set({
            project: { ...project, agents, updatedAt: new Date() },
            isDirty: true,
          });
        }
      },

      // Canvas Actions
      setNodes: (nodes: DSLNode[]) => {
        set({ nodes, isDirty: true });
      },

      setEdges: (edges: DSLEdge[]) => {
        set({ edges, isDirty: true });
      },

      addNode: (node: DSLNode) => {
        set((state) => ({
          nodes: [...state.nodes, node],
          isDirty: true,
        }));
      },

      updateNode: (nodeId: string, data: Partial<DSLNode['data']>) => {
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
          ),
          isDirty: true,
        }));
      },

      removeNode: (nodeId: string) => {
        set((state) => ({
          nodes: state.nodes.filter((n) => n.id !== nodeId),
          edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          isDirty: true,
        }));
      },

      addEdge: (edge: DSLEdge) => {
        set((state) => ({
          edges: [...state.edges, edge],
          isDirty: true,
        }));
      },

      removeEdge: (edgeId: string) => {
        set((state) => ({
          edges: state.edges.filter((e) => e.id !== edgeId),
          isDirty: true,
        }));
      },

      setTransform: (transform: CanvasTransform) => {
        set({ transform });
      },

      // Selection Actions
      setSelection: (selection: SelectionState) => {
        set({ selection });
      },

      selectNode: (nodeId: string, addToSelection = false) => {
        set((state) => {
          const nodeIds = addToSelection ? [...state.selection.nodeIds, nodeId] : [nodeId];
          return {
            selection: {
              nodeIds,
              edgeIds: addToSelection ? state.selection.edgeIds : [],
              type: nodeIds.length > 1 ? 'multiple' : 'single',
            },
          };
        });
      },

      selectEdge: (edgeId: string, addToSelection = false) => {
        set((state) => {
          const edgeIds = addToSelection ? [...state.selection.edgeIds, edgeId] : [edgeId];
          return {
            selection: {
              nodeIds: addToSelection ? state.selection.nodeIds : [],
              edgeIds,
              type: edgeIds.length > 1 ? 'multiple' : 'single',
            },
          };
        });
      },

      clearSelection: () => {
        set({ selection: { nodeIds: [], edgeIds: [], type: 'none' } });
      },

      // Panel Actions
      togglePanel: (panelId: string) => {
        set((state) => ({
          panels: {
            ...state.panels,
            [panelId]: {
              ...state.panels[panelId],
              isOpen: !state.panels[panelId]?.isOpen,
            },
          },
        }));
      },

      setPanelWidth: (panelId: string, width: number) => {
        set((state) => ({
          panels: {
            ...state.panels,
            [panelId]: { ...state.panels[panelId], width },
          },
        }));
      },

      // View Actions
      setViewMode: (mode: ViewMode) => {
        set({ viewMode: mode });
      },

      toggleGrid: () => {
        set((state) => ({ showGrid: !state.showGrid }));
      },

      toggleMinimap: () => {
        set((state) => ({ showMinimap: !state.showMinimap }));
      },

      fitView: () => {
        // This would be handled by React Flow ref
      },

      zoomIn: () => {
        set((state) => ({
          transform: { ...state.transform, zoom: Math.min(state.transform.zoom * 1.2, 4) },
        }));
      },

      zoomOut: () => {
        set((state) => ({
          transform: { ...state.transform, zoom: Math.max(state.transform.zoom / 1.2, 0.1) },
        }));
      },

      resetZoom: () => {
        set((state) => ({
          transform: { ...state.transform, zoom: 1 },
        }));
      },

      // Code Editor Actions
      setCodeContent: (content: string) => {
        set((state) => ({
          codeEditor: { ...state.codeEditor, content, isDirty: true },
        }));
      },

      setCodeLanguage: (language: CodeEditorState['language']) => {
        set((state) => ({
          codeEditor: { ...state.codeEditor, language },
        }));
      },

      syncCodeToCanvas: () => {
        // Parse code and update canvas - would use @abl/core parser
      },

      syncCanvasToCode: () => {
        // Generate ABL from canvas nodes - would use generator
      },

      // Validation Actions
      validate: () => {
        // Would use @abl/analyzer
        set({
          validation: { isValid: true, errors: [], warnings: [] },
        });
      },

      clearValidation: () => {
        set({
          validation: { isValid: true, errors: [], warnings: [] },
        });
      },

      // History Actions
      undo: () => {
        const { history, historyIndex } = get();
        if (historyIndex > 0) {
          const entry = history[historyIndex - 1];
          set({
            nodes: entry.nodes,
            edges: entry.edges,
            historyIndex: historyIndex - 1,
          });
        }
      },

      redo: () => {
        const { history, historyIndex } = get();
        if (historyIndex < history.length - 1) {
          const entry = history[historyIndex + 1];
          set({
            nodes: entry.nodes,
            edges: entry.edges,
            historyIndex: historyIndex + 1,
          });
        }
      },

      pushHistory: (description: string) => {
        const { nodes, edges, history, historyIndex } = get();
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push({
          nodes: [...nodes],
          edges: [...edges],
          timestamp: new Date(),
          description,
        });

        // Limit history size
        if (newHistory.length > MAX_HISTORY) {
          newHistory.shift();
        }

        set({
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
      },

      clearHistory: () => {
        set({ history: [], historyIndex: -1 });
      },
    })),
    { name: 'abl-editor' },
  ),
);

// Selectors
export const selectProject = (state: EditorState) => state.project;
export const selectNodes = (state: EditorState) => state.nodes;
export const selectEdges = (state: EditorState) => state.edges;
export const selectSelection = (state: EditorState) => state.selection;
export const selectSelectedNodes = (state: EditorState) =>
  state.nodes.filter((n) => state.selection.nodeIds.includes(n.id));
export const selectValidation = (state: EditorState) => state.validation;
export const selectIsDirty = (state: EditorState) => state.isDirty;
export const selectCanUndo = (state: EditorState) => state.historyIndex > 0;
export const selectCanRedo = (state: EditorState) => state.historyIndex < state.history.length - 1;
