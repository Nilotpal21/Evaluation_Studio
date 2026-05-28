/**
 * Spec Generation Store
 *
 * Manages the ephemeral state for the Quick Generate pipeline:
 * topology -> agents -> openapi -> mocks.
 *
 * Supports cascade invalidation: editing an earlier stage clears all
 * downstream results and restarts the pipeline from the next stage.
 *
 * NO persistence — this is a transient, session-scoped store.
 */

import { create } from 'zustand';
import type {
  SpecGenInput,
  SpecGenStage,
  SpecGenStageResults,
  EditHistoryEntry,
  VercelDeployResult,
  TopologyData,
  GeneratedAgent,
  OpenAPISpec,
  MockProjectBundle,
  ArchMessage as ArchMessageType,
  PlanChange,
} from '../types/arch';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Ordered pipeline stages */
const STAGE_ORDER: SpecGenStage[] = ['topology', 'agents', 'openapi', 'mocks'];

/**
 * Maps each stage to its result key in SpecGenStageResults.
 * topology -> 'topology', agents -> 'agents', openapi -> 'openapi', mocks -> 'mockProject'
 */
const STAGE_RESULT_KEY: Record<SpecGenStage, keyof SpecGenStageResults> = {
  topology: 'topology',
  agent_specs: 'agentSpecs',
  agents: 'agents',
  openapi: 'openapi',
  mocks: 'mockProject',
};

// =============================================================================
// TYPES
// =============================================================================

type StageResult = TopologyData | GeneratedAgent[] | OpenAPISpec | MockProjectBundle;

interface SpecGenerationState {
  // State
  input: SpecGenInput | null;
  pipelineStatus: 'idle' | 'running' | 'complete' | 'error';
  currentStage: SpecGenStage | null;
  stageResults: SpecGenStageResults;
  stageErrors: Record<string, string>;
  editingStage: SpecGenStage | null;
  editHistory: EditHistoryEntry[];
  deployResult: VercelDeployResult | null;
  reviewStep: SpecGenStage | null;
  reviewedStages: Set<SpecGenStage>;
  editMessages: Record<SpecGenStage, ArchMessageType[]>;
  editPanelState: 'collapsed' | 'default' | 'expanded' | 'minimized';
  pendingProposal: {
    stage: SpecGenStage;
    data: unknown;
    summary: string;
    changes: PlanChange[];
  } | null;

  // Actions
  startPipeline: (input: SpecGenInput) => void;
  updateStageResult: (stage: SpecGenStage, result: StageResult) => void;
  setStageError: (stage: SpecGenStage, error: string) => void;
  startEditing: (stage: SpecGenStage) => void;
  stopEditing: () => void;
  commitEdit: (stage: SpecGenStage, updatedResult: StageResult) => void;
  setDeployResult: (result: VercelDeployResult) => void;
  advanceReview: () => void;
  goBackToStage: (stage: SpecGenStage) => void;
  setEditPanelState: (state: 'collapsed' | 'default' | 'expanded' | 'minimized') => void;
  addEditMessage: (stage: SpecGenStage, message: ArchMessageType) => void;
  setPendingProposal: (proposal: {
    stage: SpecGenStage;
    data: unknown;
    summary: string;
    changes: PlanChange[];
  }) => void;
  applyProposal: () => void;
  rejectProposal: () => void;
  reset: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

function stageIndex(stage: SpecGenStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function nextStage(stage: SpecGenStage): SpecGenStage | null {
  const idx = stageIndex(stage);
  return idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;
}

function isLastStage(stage: SpecGenStage): boolean {
  return stageIndex(stage) === STAGE_ORDER.length - 1;
}

/**
 * Returns a new SpecGenStageResults with all stages after `stage` set to null.
 * The stage itself is NOT cleared — only stages downstream of it.
 */
function clearDownstreamResults(
  current: SpecGenStageResults,
  stage: SpecGenStage,
): SpecGenStageResults {
  const idx = stageIndex(stage);
  const cleared = { ...current };
  for (let i = idx + 1; i < STAGE_ORDER.length; i++) {
    const key = STAGE_RESULT_KEY[STAGE_ORDER[i]];
    (cleared as Record<string, unknown>)[key] = null;
  }
  return cleared;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const INITIAL_STAGE_RESULTS: SpecGenStageResults = {
  topology: null,
  agentSpecs: null,
  agents: null,
  openapi: null,
  mockProject: null,
};

const INITIAL_STATE = {
  input: null as SpecGenInput | null,
  pipelineStatus: 'idle' as const,
  currentStage: null as SpecGenStage | null,
  stageResults: { ...INITIAL_STAGE_RESULTS },
  stageErrors: {} as Record<string, string>,
  editingStage: null as SpecGenStage | null,
  editHistory: [] as EditHistoryEntry[],
  deployResult: null as VercelDeployResult | null,
  reviewStep: null as SpecGenStage | null,
  reviewedStages: new Set<SpecGenStage>(),
  editMessages: {
    topology: [],
    agent_specs: [],
    agents: [],
    openapi: [],
    mocks: [],
  } as Record<SpecGenStage, ArchMessageType[]>,
  editPanelState: 'collapsed' as const,
  pendingProposal: null as {
    stage: SpecGenStage;
    data: unknown;
    summary: string;
    changes: PlanChange[];
  } | null,
};

// =============================================================================
// STORE
// =============================================================================

export const useSpecGenerationStore = create<SpecGenerationState>((set) => ({
  ...INITIAL_STATE,

  startPipeline: (input) =>
    set({
      input,
      pipelineStatus: 'running',
      currentStage: 'topology',
      stageResults: { ...INITIAL_STAGE_RESULTS },
      stageErrors: {},
      editingStage: null,
      editHistory: [],
      deployResult: null,
      reviewStep: null,
      reviewedStages: new Set<SpecGenStage>(),
      editMessages: { topology: [], agent_specs: [], agents: [], openapi: [], mocks: [] },
      editPanelState: 'collapsed' as const,
      pendingProposal: null,
    }),

  updateStageResult: (stage, result) =>
    set((state) => {
      const key = STAGE_RESULT_KEY[stage];
      const updatedResults = {
        ...state.stageResults,
        [key]: result,
      };

      if (isLastStage(stage)) {
        return {
          stageResults: updatedResults,
          pipelineStatus: 'complete' as const,
          reviewStep: 'topology' as SpecGenStage,
          reviewedStages: new Set<SpecGenStage>(),
        };
      }

      return {
        stageResults: updatedResults,
        currentStage: nextStage(stage),
      };
    }),

  setStageError: (stage, error) =>
    set((state) => ({
      pipelineStatus: 'error' as const,
      stageErrors: { ...state.stageErrors, [stage]: error },
    })),

  startEditing: (stage) => set({ editingStage: stage }),

  stopEditing: () => set({ editingStage: null }),

  commitEdit: (stage, updatedResult) =>
    set((state) => {
      const key = STAGE_RESULT_KEY[stage];

      // Store the updated result
      const updatedResults = {
        ...state.stageResults,
        [key]: updatedResult,
      };

      // Build the edit history entry
      const entry: EditHistoryEntry = {
        stage,
        timestamp: new Date().toISOString(),
        summary: `Edited ${stage} stage`,
      };

      // If this is the last stage, just update and mark complete
      if (isLastStage(stage)) {
        return {
          stageResults: updatedResults,
          editingStage: null,
          editHistory: [...state.editHistory, entry],
          pipelineStatus: 'complete' as const,
        };
      }

      // Clear all downstream stages and restart from the next stage
      const clearedResults = clearDownstreamResults(updatedResults, stage);
      const idx = stageIndex(stage);
      const clearedReviewed = new Set([...state.reviewedStages].filter((s) => stageIndex(s) < idx));
      return {
        stageResults: clearedResults,
        editingStage: null,
        editHistory: [...state.editHistory, entry],
        pipelineStatus: 'running' as const,
        currentStage: nextStage(stage),
        editPanelState: 'minimized' as const,
        reviewedStages: clearedReviewed,
        reviewStep: stage,
      };
    }),

  setDeployResult: (result) => set({ deployResult: result }),

  advanceReview: () =>
    set((state) => {
      if (!state.reviewStep) return {};
      const reviewed = new Set(state.reviewedStages);
      reviewed.add(state.reviewStep);
      const next = nextStage(state.reviewStep);
      return {
        reviewedStages: reviewed,
        reviewStep: next,
      };
    }),

  goBackToStage: (stage) =>
    set((state) => {
      const idx = stageIndex(stage);
      const reviewed = new Set([...state.reviewedStages].filter((s) => stageIndex(s) < idx));
      return {
        reviewStep: stage,
        reviewedStages: reviewed,
      };
    }),

  setEditPanelState: (panelState) => set({ editPanelState: panelState }),

  addEditMessage: (stage, message) =>
    set((state) => ({
      editMessages: {
        ...state.editMessages,
        [stage]: [...state.editMessages[stage], message],
      },
    })),

  setPendingProposal: (proposal) => set({ pendingProposal: proposal }),

  applyProposal: () =>
    set((state) => {
      if (!state.pendingProposal) return {};
      const { stage, data } = state.pendingProposal;
      const key = STAGE_RESULT_KEY[stage];
      const updatedResults = { ...state.stageResults, [key]: data };

      const entry: EditHistoryEntry = {
        stage,
        timestamp: new Date().toISOString(),
        summary: state.pendingProposal.summary,
      };

      if (isLastStage(stage)) {
        return {
          stageResults: updatedResults,
          pendingProposal: null,
          editHistory: [...state.editHistory, entry],
          pipelineStatus: 'complete' as const,
        };
      }

      const clearedResults = clearDownstreamResults(updatedResults, stage);
      const idx = stageIndex(stage);
      const clearedReviewed = new Set([...state.reviewedStages].filter((s) => stageIndex(s) < idx));
      return {
        stageResults: clearedResults,
        pendingProposal: null,
        editHistory: [...state.editHistory, entry],
        pipelineStatus: 'running' as const,
        currentStage: nextStage(stage),
        editPanelState: 'minimized' as const,
        reviewedStages: clearedReviewed,
        reviewStep: stage,
      };
    }),

  rejectProposal: () => set({ pendingProposal: null }),

  reset: () =>
    set({
      ...INITIAL_STATE,
      stageResults: { ...INITIAL_STAGE_RESULTS },
      stageErrors: {},
      editHistory: [],
      reviewStep: null,
      reviewedStages: new Set<SpecGenStage>(),
      editMessages: { topology: [], agent_specs: [], agents: [], openapi: [], mocks: [] },
      editPanelState: 'collapsed' as const,
      pendingProposal: null,
    }),
}));
