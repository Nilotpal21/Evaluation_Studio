/**
 * Pipeline Editor Store
 *
 * Zustand store for managing pipeline configuration state.
 * Follows the existing editor-store.ts pattern for complex editor state.
 */

import { create } from 'zustand';
import type {
  PipelineDefinition,
  PipelineFlow,
  PipelineStage,
  ValidationResult,
  ValidationError,
  EmbeddingProviderInfo,
  PublishResult,
} from '../api/pipelines';
import {
  fetchPipeline,
  createPipeline,
  updatePipeline,
  publishPipeline,
  validatePipeline,
  fetchEmbeddingProviders,
  updateEmbeddingConfig,
  triggerReindex,
} from '../api/pipelines';

// =============================================================================
// TYPES
// =============================================================================

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface PipelineStore {
  // State
  draft: PipelineDefinition | null;
  published: PipelineDefinition | null;
  selectedFlowId: string | null;
  selectedStageId: string | null;
  isDirty: boolean;
  isLoading: boolean;
  saveStatus: SaveStatus;
  error: string | null;
  validationErrors: ValidationError[];
  validationResult: ValidationResult | null;

  // Context
  projectId: string | null;
  knowledgeBaseId: string | null;

  // Panel state
  stageConfigOpen: boolean;
  ruleBuilderOpen: boolean;
  testSelectionOpen: boolean;

  // V2 canvas state
  expandedStageId: string | null;
  activePanelType:
    | 'config'
    | 'script'
    | 'embedding-fields'
    | 'embedding-config'
    | 'version'
    | 'router'
    | null;
  activePanelNodeId: string | null;
  highlightedFlowId: string | null;
  highlightedFlowTimerId: ReturnType<typeof setTimeout> | null;
  isDefaultView: boolean;
  detailPanelCollapsed: boolean;

  /** Shows a persistent banner after deploy with 0 docs (no reindex needed) */
  deploySuccessMessage: string | null;

  // Actions - Loading
  loadPipeline: (projectId: string, kbId: string) => Promise<void>;
  createPipeline: (projectId: string, kbId: string) => Promise<void>;
  reset: () => void;

  // Actions - Draft editing
  updateDraft: (updates: Partial<PipelineDefinition>) => void;
  updateFlow: (flowId: string, updates: Partial<PipelineFlow>) => void;
  addFlow: (flow: PipelineFlow) => void;
  removeFlow: (flowId: string) => void;
  reorderFlows: (flowIds: string[]) => void;
  addStage: (flowId: string, stage: PipelineStage) => void;
  updateStage: (flowId: string, stageId: string, updates: Partial<PipelineStage>) => void;
  removeStage: (flowId: string, stageId: string) => void;
  moveStage: (flowId: string, stageId: string, direction: 'up' | 'down') => void;

  // Actions - Selection
  selectFlow: (flowId: string | null) => void;
  selectStage: (stageId: string | null) => void;

  // Actions - Panels
  openStageConfig: (stageId: string) => void;
  closeStageConfig: () => void;
  openRuleBuilder: () => void;
  closeRuleBuilder: () => void;
  openTestSelection: () => void;
  closeTestSelection: () => void;

  // V2 canvas actions
  setDefaultView: (isDefault: boolean) => void;
  expandStage: (stageId: string | null) => void;
  openPanel: (
    type: 'config' | 'script' | 'embedding-fields' | 'embedding-config' | 'version' | 'router',
    nodeId: string,
  ) => void;
  closePanel: () => void;
  highlightFlow: (flowId: string) => void;
  clearHighlight: () => void;
  toggleDetailPanel: () => void;
  setDetailPanelCollapsed: (collapsed: boolean) => void;

  // Actions - Save/Publish
  saveDraft: () => Promise<void>;
  publish: () => Promise<void>;
  validate: () => Promise<ValidationResult | null>;

  // Embedding configuration
  embeddingProviders: EmbeddingProviderInfo[] | null;
  embeddingDialogOpen: boolean;
  embeddingDialogLoading: boolean;
  embeddingDialogError: string | null;
  openEmbeddingDialog: () => Promise<void>;
  closeEmbeddingDialog: () => void;
  changeEmbeddingConfig: (config: {
    provider: string;
    model: string;
    dimensions: number;
    providerConfig?: Record<string, unknown>;
  }) => Promise<void>;

  // Reindex
  reindexPending: PublishResult['reindex'] | null;
  reindexAnalyzed: boolean;
  reindexLoading: boolean;
  reindexError: string | null;
  reindexBatchId: string | null;
  confirmReindex: () => Promise<void>;
  dismissReindex: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialState = {
  draft: null,
  published: null,
  selectedFlowId: null,
  selectedStageId: null,
  isDirty: false,
  isLoading: false,
  saveStatus: 'idle' as SaveStatus,
  error: null,
  validationErrors: [],
  validationResult: null,
  projectId: null,
  knowledgeBaseId: null,
  stageConfigOpen: false,
  ruleBuilderOpen: false,
  testSelectionOpen: false,
  expandedStageId: null,
  activePanelType: null,
  activePanelNodeId: null,
  highlightedFlowId: null,
  highlightedFlowTimerId: null,
  isDefaultView: false,
  detailPanelCollapsed: true,
  deploySuccessMessage: null,
  embeddingProviders: null,
  embeddingDialogOpen: false,
  embeddingDialogLoading: false,
  embeddingDialogError: null,
  reindexPending: null,
  reindexAnalyzed: false,
  reindexLoading: false,
  reindexError: null,
  reindexBatchId: null,
};

// =============================================================================
// PIPELINE NORMALIZATION — upgrade legacy enrichment to V2 stages
// =============================================================================

/**
 * When loading a pipeline from the backend, the old `enrichment` stage should
 * be expanded into two visible V2 stages: `content-intelligence` and
 * `visual-analysis`. The original `enrichment` stage is preserved (backend
 * still expects it) but the two new stages are inserted alongside it so users
 * see and configure them in the canvas.
 */
/** Canonical stage-type order — matches STAGE_ORDER in stage-insertion-rules.ts */
const STAGE_TYPE_RANK: Record<string, number> = {
  extraction: 0,
  chunking: 1,
  'content-intelligence': 2,
  'visual-analysis': 3,
  enrichment: 4,
};
const UTILITY_RANK = 99;

/**
 * Sort stages by canonical type order, reassigning integer `order` values.
 * Utility stages (api-webhook, llm-stage, etc.) keep their relative position but
 * are placed after all ordered types.
 */
function reorderByStageType(stages: PipelineStage[]): PipelineStage[] {
  const sorted = [...stages].sort((a, b) => {
    const rankA = STAGE_TYPE_RANK[a.type] ?? UTILITY_RANK;
    const rankB = STAGE_TYPE_RANK[b.type] ?? UTILITY_RANK;
    if (rankA !== rankB) return rankA - rankB;
    return (a.order ?? 0) - (b.order ?? 0);
  });
  return sorted.map((s, i) => (s.order === i ? s : { ...s, order: i }));
}

function normalizePipelineFlows(pipeline: PipelineDefinition): PipelineDefinition {
  const updatedFlows = pipeline.flows.map((flow) => {
    // Migrate tree-builder → recursive-character (tree-builder is not fully wired)
    const migratedStages = flow.stages.map((s) =>
      s.type === 'chunking' && s.provider === 'tree-builder'
        ? {
            ...s,
            provider: 'recursive-character',
            name: /tree.?build/i.test(s.name) ? 'Recursive Chunking' : s.name,
          }
        : s,
    );

    const hasCI = migratedStages.some((s) => s.type === 'content-intelligence');
    const hasVA = migratedStages.some((s) => s.type === 'visual-analysis');

    // Already has the new stages — just ensure correct ordering
    if (hasCI && hasVA) {
      const reordered = reorderByStageType(migratedStages);
      const orderChanged = reordered.some((s, i) => s !== migratedStages[i]);
      if (!orderChanged && migratedStages === flow.stages) return flow;
      return { ...flow, stages: reordered };
    }

    const enrichmentIdx = migratedStages.findIndex((s) => s.type === 'enrichment');
    if (enrichmentIdx < 0 && hasCI) return { ...flow, stages: migratedStages };

    // Compute insertion point — right after chunking, or right after enrichment
    const chunkingIdx = migratedStages.findIndex((s) => s.type === 'chunking');
    const insertAfterIdx =
      chunkingIdx >= 0
        ? chunkingIdx
        : enrichmentIdx >= 0
          ? enrichmentIdx
          : migratedStages.length - 1;

    // Compute order values based on surrounding stages
    const prevOrder = migratedStages[insertAfterIdx]?.order ?? insertAfterIdx;
    const nextStage = migratedStages[insertAfterIdx + 1];
    const nextOrder = nextStage?.order ?? prevOrder + 3;
    const gap = (nextOrder - prevOrder) / 3;

    const newStages: PipelineStage[] = [...migratedStages];

    if (!hasCI) {
      newStages.splice(insertAfterIdx + 1, 0, {
        id: `ci-${flow.id}`,
        name: 'Content Intelligence',
        type: 'content-intelligence',
        provider: 'content-intelligence',
        providerConfig: {
          generateSummary: true,
          generateQuestions: true,
          documentSummary: true,
          documentQuestions: true,
          questionsPerChunk: 3,
          summaryMaxTokens: 300,
          modelTier: 'fast',
        },
        order: prevOrder + gap,
      });
    }

    if (!hasVA) {
      // Insert after CI (which we may have just inserted)
      const ciIdx = newStages.findIndex((s) => s.type === 'content-intelligence');
      const vaInsertIdx = ciIdx >= 0 ? ciIdx + 1 : insertAfterIdx + 1;
      newStages.splice(vaInsertIdx, 0, {
        id: `va-${flow.id}`,
        name: 'Visual Analysis',
        type: 'visual-analysis',
        provider: 'visual-analysis',
        providerConfig: {
          analyzeImages: true,
          analyzeScreenshots: true,
          summarizeTables: true,
          analyzeCharts: true,
          enhanceTableContinuations: true,
          modelTier: 'balanced',
        },
        order: prevOrder + gap * 2,
      });
    }

    return { ...flow, stages: reorderByStageType(newStages) };
  });

  return { ...pipeline, flows: updatedFlows };
}

// =============================================================================
// STORE
// =============================================================================

export const usePipelineStore = create<PipelineStore>((set, get) => ({
  ...initialState,

  // ─── Loading ──────────────────────────────────────────────────────────

  loadPipeline: async (projectId: string, kbId: string) => {
    set({ isLoading: true, error: null, projectId, knowledgeBaseId: kbId });
    try {
      const pipeline = await fetchPipeline(projectId, kbId);
      const normalized = pipeline ? normalizePipelineFlows(pipeline) : null;
      set({
        draft: normalized,
        published: pipeline?.status === 'active' ? pipeline : null,
        isLoading: false,
        selectedFlowId: null,
        isDefaultView: !!(pipeline as any)?.isDefault,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load pipeline',
      });
    }
  },

  createPipeline: async (projectId: string, kbId: string) => {
    set({ isLoading: true, error: null });
    try {
      const pipeline = await createPipeline(projectId, kbId);
      const normalized = normalizePipelineFlows(pipeline);
      set({
        draft: normalized,
        published: pipeline.status === 'active' ? pipeline : null,
        isLoading: false,
        selectedFlowId: null,
        isDefaultView: !!(pipeline as any)?.isDefault,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create pipeline',
      });
    }
  },

  reset: () => {
    set(initialState);
  },

  // ─── Draft Editing ────────────────────────────────────────────────────

  updateDraft: (updates) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: { ...draft, ...updates },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  updateFlow: (flowId, updates) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: {
        ...draft,
        flows: draft.flows.map((f) => (f.id === flowId ? { ...f, ...updates } : f)),
      },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  addFlow: (flow) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: { ...draft, flows: [...draft.flows, flow] },
      isDirty: true,
      saveStatus: 'idle',
      selectedFlowId: flow.id,
    });
  },

  removeFlow: (flowId) => {
    const { draft, selectedFlowId } = get();
    if (!draft) return;
    const flow = draft.flows.find((f) => f.id === flowId);
    if (flow?.isDefault) return; // Cannot delete default flow
    const newFlows = draft.flows.filter((f) => f.id !== flowId);
    set({
      draft: { ...draft, flows: newFlows },
      isDirty: true,
      saveStatus: 'idle',
      selectedFlowId: selectedFlowId === flowId ? (newFlows[0]?.id ?? null) : selectedFlowId,
    });
  },

  reorderFlows: (flowIds) => {
    const { draft } = get();
    if (!draft) return;
    const flowMap = new Map(draft.flows.map((f) => [f.id, f]));
    const reordered = flowIds
      .map((id) => flowMap.get(id))
      .filter((f): f is PipelineFlow => f !== undefined);
    set({
      draft: { ...draft, flows: reordered },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  addStage: (flowId, stage) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: {
        ...draft,
        flows: draft.flows.map((f) =>
          f.id === flowId ? { ...f, stages: [...f.stages, stage] } : f,
        ),
      },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  updateStage: (flowId, stageId, updates) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: {
        ...draft,
        flows: draft.flows.map((f) =>
          f.id === flowId
            ? {
                ...f,
                stages: f.stages.map((s) => (s.id === stageId ? { ...s, ...updates } : s)),
              }
            : f,
        ),
      },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  removeStage: (flowId, stageId) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: {
        ...draft,
        flows: draft.flows.map((f) =>
          f.id === flowId ? { ...f, stages: f.stages.filter((s) => s.id !== stageId) } : f,
        ),
      },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  moveStage: (flowId, stageId, direction) => {
    const { draft } = get();
    if (!draft) return;
    set({
      draft: {
        ...draft,
        flows: draft.flows.map((f) => {
          if (f.id !== flowId) return f;
          const sorted = [...f.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const idx = sorted.findIndex((s) => s.id === stageId);
          if (idx < 0) return f;
          if (direction === 'up' && idx === 0) return f;
          if (direction === 'down' && idx === sorted.length - 1) return f;
          const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
          // Swap order values
          const reordered = sorted.map((s, i) => {
            if (i === idx) return { ...s, order: swapIdx };
            if (i === swapIdx) return { ...s, order: idx };
            return { ...s, order: i };
          });
          return { ...f, stages: reordered };
        }),
      },
      isDirty: true,
      saveStatus: 'idle',
    });
  },

  // ─── Selection ────────────────────────────────────────────────────────

  selectFlow: (flowId) => {
    set({
      selectedFlowId: flowId,
      selectedStageId: null,
      detailPanelCollapsed: flowId === null ? true : false,
    });
  },

  selectStage: (stageId) => {
    set({ selectedStageId: stageId });
  },

  // ─── Panels ───────────────────────────────────────────────────────────

  openStageConfig: (stageId) => {
    set({ stageConfigOpen: true, selectedStageId: stageId });
  },

  closeStageConfig: () => {
    set({ stageConfigOpen: false, selectedStageId: null });
  },

  openRuleBuilder: () => {
    set({ ruleBuilderOpen: true });
  },

  closeRuleBuilder: () => {
    set({ ruleBuilderOpen: false });
  },

  openTestSelection: () => {
    set({ testSelectionOpen: true });
  },

  closeTestSelection: () => {
    set({ testSelectionOpen: false });
  },

  // ─── V2 Canvas ──────────────────────────────────────────────────────────

  setDefaultView: (isDefault) => {
    set({ isDefaultView: isDefault });
  },

  expandStage: (stageId) => {
    set({
      expandedStageId: stageId,
      detailPanelCollapsed: stageId === null ? get().detailPanelCollapsed : false,
    });
  },

  openPanel: (type, nodeId) => {
    // Overlay panels (config, script, embedding-fields) are fixed-position drawers —
    // collapse the detail panel so they don't stack. Inline panels expand it.
    const isOverlay = type === 'config' || type === 'script' || type === 'embedding-fields';
    set({
      activePanelType: type,
      activePanelNodeId: nodeId,
      detailPanelCollapsed: isOverlay ? true : false,
    });
  },

  closePanel: () => {
    set({ activePanelType: null, activePanelNodeId: null, detailPanelCollapsed: true });
  },

  highlightFlow: (flowId) => {
    const { highlightedFlowTimerId } = get();
    if (highlightedFlowTimerId !== null) {
      clearTimeout(highlightedFlowTimerId);
    }
    const timerId = setTimeout(() => {
      set({ highlightedFlowId: null, highlightedFlowTimerId: null });
    }, 2000);
    set({ highlightedFlowId: flowId, highlightedFlowTimerId: timerId });
  },

  clearHighlight: () => {
    const { highlightedFlowTimerId } = get();
    if (highlightedFlowTimerId !== null) {
      clearTimeout(highlightedFlowTimerId);
    }
    set({ highlightedFlowId: null, highlightedFlowTimerId: null });
  },

  toggleDetailPanel: () => {
    set((state) => ({ detailPanelCollapsed: !state.detailPanelCollapsed }));
  },

  setDetailPanelCollapsed: (collapsed: boolean) => {
    set({ detailPanelCollapsed: collapsed });
  },

  // ─── Save / Publish ───────────────────────────────────────────────────

  saveDraft: async () => {
    const { draft, projectId, knowledgeBaseId } = get();
    if (!draft || !projectId || !knowledgeBaseId) return;

    set({ saveStatus: 'saving' });
    try {
      const result = await updatePipeline(projectId, knowledgeBaseId, draft._id, draft);
      set({
        draft: result.pipeline,
        validationResult: result.validation,
        validationErrors: result.validation.errors,
        isDirty: false,
        saveStatus: 'saved',
      });
    } catch (error) {
      set({
        saveStatus: 'error',
        error: error instanceof Error ? error.message : 'Failed to save pipeline',
      });
    }
  },

  publish: async () => {
    const { draft, projectId, knowledgeBaseId } = get();
    if (!draft || !projectId || !knowledgeBaseId) return;

    set({ saveStatus: 'saving', error: null, validationErrors: [] });
    try {
      const result = await publishPipeline(projectId, knowledgeBaseId, draft._id);
      const needsReindex = result.reindex?.hasChanges === true;
      const noDocsMessage = !needsReindex
        ? 'Pipeline deployed successfully. Changes will apply to all future document uploads.'
        : null;

      set({
        draft: result.pipeline,
        published: result.pipeline,
        isDirty: false,
        saveStatus: 'saved',
        validationErrors: [],
        validationResult: null,
        reindexAnalyzed: result.reindex !== null,
        reindexPending: needsReindex ? result.reindex : null,
        reindexError: null,
        reindexBatchId: null,
        deploySuccessMessage: noDocsMessage,
      });
    } catch (error: unknown) {
      // Extract validation errors if this is a publish-validation failure
      const appError = error as { code?: string; messages?: string[]; message?: string };
      const isValidationError = appError.code === 'PIPELINE_VALIDATION_FAILED';
      const errorMessages = appError.messages ?? [];

      // Map error messages into ValidationError objects for UI display
      const validationErrors: ValidationError[] = isValidationError
        ? errorMessages.map((msg) => ({
            code: 'PUBLISH_VALIDATION',
            message: msg,
            severity: 'error' as const,
          }))
        : [];

      set({
        saveStatus: 'error',
        error: appError.message ?? 'Failed to publish pipeline',
        validationErrors: validationErrors.length > 0 ? validationErrors : get().validationErrors,
      });
    }
  },

  validate: async () => {
    const { draft, projectId, knowledgeBaseId } = get();
    if (!draft || !projectId || !knowledgeBaseId) return null;

    try {
      const result = await validatePipeline(projectId, knowledgeBaseId, draft);
      set({
        validationResult: result,
        validationErrors: result.errors,
      });
      return result;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to validate pipeline',
      });
      return null;
    }
  },

  // ─── Embedding Configuration ──────────────────────────────────────────

  openEmbeddingDialog: async () => {
    const { projectId } = get();
    if (!projectId) return;

    set({ embeddingDialogOpen: true, embeddingDialogLoading: true, embeddingDialogError: null });

    try {
      const providers = await fetchEmbeddingProviders(projectId);
      set({ embeddingProviders: providers, embeddingDialogLoading: false });
    } catch (error) {
      set({
        embeddingDialogLoading: false,
        embeddingDialogError:
          error instanceof Error ? error.message : 'Failed to load embedding providers',
      });
    }
  },

  closeEmbeddingDialog: () => {
    set({ embeddingDialogOpen: false, embeddingDialogError: null });
  },

  changeEmbeddingConfig: async (config) => {
    const { draft, projectId, knowledgeBaseId } = get();
    if (!draft || !projectId || !knowledgeBaseId) return;

    set({ embeddingDialogLoading: true, embeddingDialogError: null });

    try {
      const result = await updateEmbeddingConfig(projectId, knowledgeBaseId, draft._id, {
        ...config,
        confirm: true,
      });

      // Update local draft with new embedding config
      set({
        draft: {
          ...draft,
          activeEmbeddingConfig: result.data.newConfig,
        },
        embeddingDialogOpen: false,
        embeddingDialogLoading: false,
      });
    } catch (error) {
      set({
        embeddingDialogLoading: false,
        embeddingDialogError:
          error instanceof Error ? error.message : 'Failed to update embedding configuration',
      });
    }
  },

  // ─── Reindex ────────────────────────────────────────────────────────────

  confirmReindex: async () => {
    const { draft, projectId, knowledgeBaseId } = get();
    if (!draft || !projectId || !knowledgeBaseId) return;

    set({ reindexLoading: true, reindexError: null });

    try {
      const result = await triggerReindex(projectId, knowledgeBaseId, draft._id);
      set({ reindexPending: null, reindexLoading: false, reindexBatchId: result.batchId });
    } catch (error) {
      set({
        reindexLoading: false,
        reindexError: error instanceof Error ? error.message : 'Failed to trigger reindex',
      });
    }
  },

  dismissReindex: () => {
    set({
      reindexPending: null,
      reindexError: null,
      reindexLoading: false,
      reindexAnalyzed: false,
    });
  },
}));
