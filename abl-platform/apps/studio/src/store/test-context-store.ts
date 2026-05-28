/**
 * Test Context Store
 *
 * Manages test context state for agent debugging.
 * Scenarios are persisted to localStorage; editing state is ephemeral.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TestContextPayload, ToolMockConfig, TestScenario } from '../types/test-context';

// =============================================================================
// TYPES
// =============================================================================

interface TestContextState {
  // Editing state (ephemeral — not persisted)
  gatherValues: Record<string, unknown>;
  sessionVariables: Record<string, unknown>;
  callerContext: {
    userId?: string;
    channel?: string;
    customAttributes?: Record<string, unknown>;
  };
  toolMocks: ToolMockConfig[];
  skipOnStart: boolean;
  startAtStep: string;

  // Scenarios (persisted to localStorage)
  scenarios: TestScenario[];
  activeScenarioId: string | null;

  // Actions — gather values
  updateGatherValue: (key: string, value: unknown) => void;
  removeGatherValue: (key: string) => void;

  // Actions — session variables
  updateSessionVariable: (key: string, value: unknown) => void;
  removeSessionVariable: (key: string) => void;

  // Actions — caller context
  updateCallerContext: (updates: Partial<TestContextState['callerContext']>) => void;

  // Actions — tool mocks
  addToolMock: (mock: ToolMockConfig) => void;
  updateToolMock: (index: number, mock: ToolMockConfig) => void;
  removeToolMock: (index: number) => void;

  // Actions — options
  setSkipOnStart: (skip: boolean) => void;
  setStartAtStep: (step: string) => void;

  // Actions — scenarios
  saveScenario: (name: string, description: string, agentPath: string, projectId?: string) => void;
  loadScenario: (id: string) => void;
  deleteScenario: (id: string) => void;

  // Actions — utility
  clearContext: () => void;
  getContextPayload: () => TestContextPayload;
  hasContext: () => boolean;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const EMPTY_CONTEXT = {
  gatherValues: {} as Record<string, unknown>,
  sessionVariables: {} as Record<string, unknown>,
  callerContext: {} as TestContextState['callerContext'],
  toolMocks: [] as ToolMockConfig[],
  skipOnStart: false,
  startAtStep: '',
};

// =============================================================================
// STORE
// =============================================================================

export const useTestContextStore = create<TestContextState>()(
  persist(
    (set, get) => ({
      ...EMPTY_CONTEXT,
      scenarios: [],
      activeScenarioId: null,

      // Gather values
      updateGatherValue: (key, value) =>
        set((state) => ({
          gatherValues: { ...state.gatherValues, [key]: value },
        })),
      removeGatherValue: (key) =>
        set((state) => {
          const { [key]: _, ...rest } = state.gatherValues;
          return { gatherValues: rest };
        }),

      // Session variables
      updateSessionVariable: (key, value) =>
        set((state) => ({
          sessionVariables: { ...state.sessionVariables, [key]: value },
        })),
      removeSessionVariable: (key) =>
        set((state) => {
          const { [key]: _, ...rest } = state.sessionVariables;
          return { sessionVariables: rest };
        }),

      // Caller context
      updateCallerContext: (updates) =>
        set((state) => ({
          callerContext: { ...state.callerContext, ...updates },
        })),

      // Tool mocks
      addToolMock: (mock) =>
        set((state) => ({
          toolMocks: [...state.toolMocks, mock],
        })),
      updateToolMock: (index, mock) =>
        set((state) => ({
          toolMocks: state.toolMocks.map((m, i) => (i === index ? mock : m)),
        })),
      removeToolMock: (index) =>
        set((state) => ({
          toolMocks: state.toolMocks.filter((_, i) => i !== index),
        })),

      // Options
      setSkipOnStart: (skip) => set({ skipOnStart: skip }),
      setStartAtStep: (step) => set({ startAtStep: step }),

      // Scenarios
      saveScenario: (name, description, agentPath, projectId) => {
        const state = get();
        const id = `scenario_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const scenario: TestScenario = {
          id,
          name,
          description,
          agentPath,
          projectId,
          context: state.getContextPayload(),
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          scenarios: [...s.scenarios, scenario],
          activeScenarioId: id,
        }));
      },

      loadScenario: (id) => {
        const scenario = get().scenarios.find((s) => s.id === id);
        if (!scenario) return;
        const ctx = scenario.context;
        set({
          gatherValues: ctx.gatherValues || {},
          sessionVariables: ctx.sessionVariables || {},
          callerContext: ctx.callerContext || {},
          toolMocks: ctx.toolMocks || [],
          skipOnStart: ctx.skipOnStart || false,
          startAtStep: ctx.startAtStep || '',
          activeScenarioId: id,
        });
      },

      deleteScenario: (id) =>
        set((state) => ({
          scenarios: state.scenarios.filter((s) => s.id !== id),
          activeScenarioId: state.activeScenarioId === id ? null : state.activeScenarioId,
        })),

      // Utility
      clearContext: () => set({ ...EMPTY_CONTEXT, activeScenarioId: null }),

      getContextPayload: (): TestContextPayload => {
        const state = get();
        const payload: TestContextPayload = {};

        if (Object.keys(state.gatherValues).length > 0) {
          payload.gatherValues = state.gatherValues;
        }
        if (Object.keys(state.sessionVariables).length > 0) {
          payload.sessionVariables = state.sessionVariables;
        }
        if (
          state.callerContext.userId ||
          state.callerContext.channel ||
          state.callerContext.customAttributes
        ) {
          payload.callerContext = state.callerContext;
        }
        if (state.toolMocks.length > 0) {
          payload.toolMocks = state.toolMocks;
        }
        if (state.skipOnStart) {
          payload.skipOnStart = true;
        }
        if (state.startAtStep) {
          payload.startAtStep = state.startAtStep;
        }

        return payload;
      },

      hasContext: (): boolean => {
        const state = get();
        return (
          Object.keys(state.gatherValues).length > 0 ||
          Object.keys(state.sessionVariables).length > 0 ||
          !!(
            state.callerContext.userId ||
            state.callerContext.channel ||
            state.callerContext.customAttributes
          ) ||
          state.toolMocks.length > 0 ||
          state.skipOnStart ||
          !!state.startAtStep
        );
      },
    }),
    {
      name: 'test-context-store',
      // Only persist scenarios — editing state is ephemeral
      partialize: (state) => ({
        scenarios: state.scenarios,
      }),
    },
  ),
);
