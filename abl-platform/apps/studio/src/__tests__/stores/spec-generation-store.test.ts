/**
 * Spec Generation Store Tests
 *
 * Comprehensive tests for the spec-generation-store: pipeline lifecycle,
 * stage progression, cascade edits, deploy result, and reset.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useSpecGenerationStore } from '../../store/spec-generation-store';
import type {
  SpecGenInput,
  TopologyData,
  GeneratedAgent,
  OpenAPISpec,
  MockProjectBundle,
  VercelDeployResult,
} from '../../types/arch';

// =============================================================================
// FIXTURES
// =============================================================================

const SAMPLE_INPUT: SpecGenInput = {
  domain: 'healthcare',
  problemStatement: 'Patient scheduling and billing',
  details: 'Multi-agent system for hospital operations',
};

const SAMPLE_TOPOLOGY: TopologyData = {
  nodes: [
    {
      id: 'supervisor',
      name: 'Main Supervisor',
      type: 'supervisor',
      isEntry: true,
      executionMode: 'reasoning',
      tools: [],
      gatherFields: [],
      flowStepCount: 0,
      constraintCount: 0,
      healthStatus: 'healthy',
    },
    {
      id: 'scheduling',
      name: 'Scheduling Agent',
      type: 'agent',
      isEntry: false,
      executionMode: 'scripted',
      tools: ['check_availability', 'book_appointment'],
      gatherFields: ['date', 'time', 'doctor'],
      flowStepCount: 3,
      constraintCount: 1,
      healthStatus: 'healthy',
    },
  ],
  edges: [{ from: 'supervisor', to: 'scheduling', type: 'routing' }],
};

const SAMPLE_AGENTS: GeneratedAgent[] = [
  {
    id: 'scheduling',
    name: 'Scheduling Agent',
    executionMode: 'scripted',
    ablContent: 'agent scheduling_agent { ... }',
    tools: ['check_availability', 'book_appointment'],
    gatherFields: ['date', 'time', 'doctor'],
    flowStepCount: 3,
  },
];

const SAMPLE_OPENAPI: OpenAPISpec = {
  openapi: '3.1.0',
  info: { title: 'Healthcare API', version: '1.0.0' },
  paths: {
    '/appointments': {
      get: {
        operationId: 'listAppointments',
        summary: 'List appointments',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const SAMPLE_MOCK_PROJECT: MockProjectBundle = {
  projectName: 'healthcare-mock',
  files: [
    { path: 'package.json', content: '{}' },
    { path: 'index.ts', content: 'export default {}' },
  ],
};

const SAMPLE_DEPLOY_RESULT: VercelDeployResult = {
  url: 'https://healthcare-mock.vercel.app',
  projectName: 'healthcare-mock',
  deployedAt: '2026-02-17T10:00:00Z',
};

// =============================================================================
// TESTS
// =============================================================================

describe('Spec Generation Store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useSpecGenerationStore.getState().reset();
  });

  // ===========================================================================
  // 1. INITIAL STATE
  // ===========================================================================

  describe('Initial state', () => {
    test('is idle with null results', () => {
      const state = useSpecGenerationStore.getState();

      expect(state.input).toBeNull();
      expect(state.pipelineStatus).toBe('idle');
      expect(state.currentStage).toBeNull();
      expect(state.stageResults.topology).toBeNull();
      expect(state.stageResults.agents).toBeNull();
      expect(state.stageResults.openapi).toBeNull();
      expect(state.stageResults.mockProject).toBeNull();
      expect(state.stageErrors).toEqual({});
      expect(state.editingStage).toBeNull();
      expect(state.editHistory).toEqual([]);
      expect(state.deployResult).toBeNull();
    });
  });

  // ===========================================================================
  // 2. startPipeline
  // ===========================================================================

  describe('startPipeline', () => {
    test('sets running state and stores input', () => {
      useSpecGenerationStore.getState().startPipeline(SAMPLE_INPUT);

      const state = useSpecGenerationStore.getState();
      expect(state.input).toEqual(SAMPLE_INPUT);
      expect(state.pipelineStatus).toBe('running');
      expect(state.currentStage).toBe('topology');
    });

    test('clears previous results and errors', () => {
      // Set some state first
      const store = useSpecGenerationStore.getState();
      store.startPipeline(SAMPLE_INPUT);
      store.updateStageResult('topology', SAMPLE_TOPOLOGY);
      store.setStageError('agents', 'some error');

      // Start fresh pipeline
      useSpecGenerationStore.getState().startPipeline({
        domain: 'banking',
        problemStatement: 'Account management',
      });

      const state = useSpecGenerationStore.getState();
      expect(state.stageResults.topology).toBeNull();
      expect(state.stageResults.agents).toBeNull();
      expect(state.stageResults.openapi).toBeNull();
      expect(state.stageResults.mockProject).toBeNull();
      expect(state.stageErrors).toEqual({});
      expect(state.editHistory).toEqual([]);
      expect(state.deployResult).toBeNull();
      expect(state.editingStage).toBeNull();
    });
  });

  // ===========================================================================
  // 3. updateStageResult — stores result and advances stage
  // ===========================================================================

  describe('updateStageResult', () => {
    beforeEach(() => {
      useSpecGenerationStore.getState().startPipeline(SAMPLE_INPUT);
    });

    test('stores topology result and advances to agents', () => {
      useSpecGenerationStore.getState().updateStageResult('topology', SAMPLE_TOPOLOGY);

      const state = useSpecGenerationStore.getState();
      expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
      expect(state.currentStage).toBe('agents');
    });

    test('stores agents result and advances to openapi', () => {
      useSpecGenerationStore.getState().updateStageResult('topology', SAMPLE_TOPOLOGY);
      useSpecGenerationStore.getState().updateStageResult('agents', SAMPLE_AGENTS);

      const state = useSpecGenerationStore.getState();
      expect(state.stageResults.agents).toEqual(SAMPLE_AGENTS);
      expect(state.currentStage).toBe('openapi');
    });

    test('stores openapi result and advances to mocks', () => {
      useSpecGenerationStore.getState().updateStageResult('topology', SAMPLE_TOPOLOGY);
      useSpecGenerationStore.getState().updateStageResult('agents', SAMPLE_AGENTS);
      useSpecGenerationStore.getState().updateStageResult('openapi', SAMPLE_OPENAPI);

      const state = useSpecGenerationStore.getState();
      expect(state.stageResults.openapi).toEqual(SAMPLE_OPENAPI);
      expect(state.currentStage).toBe('mocks');
    });

    test('on final stage (mocks) sets pipeline to complete', () => {
      useSpecGenerationStore.getState().updateStageResult('topology', SAMPLE_TOPOLOGY);
      useSpecGenerationStore.getState().updateStageResult('agents', SAMPLE_AGENTS);
      useSpecGenerationStore.getState().updateStageResult('openapi', SAMPLE_OPENAPI);
      useSpecGenerationStore.getState().updateStageResult('mocks', SAMPLE_MOCK_PROJECT);

      const state = useSpecGenerationStore.getState();
      expect(state.stageResults.mockProject).toEqual(SAMPLE_MOCK_PROJECT);
      expect(state.pipelineStatus).toBe('complete');
    });
  });

  // ===========================================================================
  // 4. setStageError
  // ===========================================================================

  describe('setStageError', () => {
    test('marks error status and stores error message', () => {
      useSpecGenerationStore.getState().startPipeline(SAMPLE_INPUT);
      useSpecGenerationStore.getState().setStageError('topology', 'LLM generation failed');

      const state = useSpecGenerationStore.getState();
      expect(state.pipelineStatus).toBe('error');
      expect(state.stageErrors['topology']).toBe('LLM generation failed');
    });

    test('preserves existing errors when adding new ones', () => {
      useSpecGenerationStore.getState().startPipeline(SAMPLE_INPUT);
      useSpecGenerationStore.getState().setStageError('topology', 'error 1');
      useSpecGenerationStore.getState().setStageError('agents', 'error 2');

      const state = useSpecGenerationStore.getState();
      expect(state.stageErrors['topology']).toBe('error 1');
      expect(state.stageErrors['agents']).toBe('error 2');
    });
  });

  // ===========================================================================
  // 5. startEditing / stopEditing
  // ===========================================================================

  describe('startEditing', () => {
    test('sets editingStage', () => {
      useSpecGenerationStore.getState().startEditing('topology');

      const state = useSpecGenerationStore.getState();
      expect(state.editingStage).toBe('topology');
    });
  });

  describe('stopEditing', () => {
    test('clears editingStage', () => {
      useSpecGenerationStore.getState().startEditing('agents');

      expect(useSpecGenerationStore.getState().editingStage).toBe('agents');

      useSpecGenerationStore.getState().stopEditing();

      expect(useSpecGenerationStore.getState().editingStage).toBeNull();
    });
  });

  // ===========================================================================
  // 6. commitEdit — cascade logic
  // ===========================================================================

  describe('commitEdit', () => {
    beforeEach(() => {
      // Run through full pipeline first
      const store = useSpecGenerationStore.getState();
      store.startPipeline(SAMPLE_INPUT);
      store.updateStageResult('topology', SAMPLE_TOPOLOGY);
      store.updateStageResult('agents', SAMPLE_AGENTS);
      store.updateStageResult('openapi', SAMPLE_OPENAPI);
      store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
    });

    test('updates result and clears all downstream stages', () => {
      const updatedTopology: TopologyData = {
        ...SAMPLE_TOPOLOGY,
        nodes: [
          ...SAMPLE_TOPOLOGY.nodes,
          {
            id: 'billing',
            name: 'Billing Agent',
            type: 'agent',
            isEntry: false,
            executionMode: 'reasoning',
            tools: ['process_payment'],
            gatherFields: ['amount'],
            flowStepCount: 2,
            constraintCount: 0,
            healthStatus: 'healthy',
          },
        ],
      };

      useSpecGenerationStore.getState().startEditing('topology');
      useSpecGenerationStore.getState().commitEdit('topology', updatedTopology);

      const state = useSpecGenerationStore.getState();
      // Updated result stored
      expect(state.stageResults.topology).toEqual(updatedTopology);
      // Downstream cleared
      expect(state.stageResults.agents).toBeNull();
      expect(state.stageResults.openapi).toBeNull();
      expect(state.stageResults.mockProject).toBeNull();
      // Pipeline re-running from next stage
      expect(state.pipelineStatus).toBe('running');
      expect(state.currentStage).toBe('agents');
      // Editing cleared
      expect(state.editingStage).toBeNull();
    });

    test('clears downstream when editing agents (clears openapi + mocks)', () => {
      const updatedAgents: GeneratedAgent[] = [
        ...SAMPLE_AGENTS,
        {
          id: 'billing',
          name: 'Billing Agent',
          executionMode: 'reasoning',
          ablContent: 'agent billing_agent { ... }',
          tools: ['process_payment'],
          gatherFields: ['amount'],
          flowStepCount: 2,
        },
      ];

      useSpecGenerationStore.getState().startEditing('agents');
      useSpecGenerationStore.getState().commitEdit('agents', updatedAgents);

      const state = useSpecGenerationStore.getState();
      // Updated result stored
      expect(state.stageResults.agents).toEqual(updatedAgents);
      // Upstream preserved
      expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
      // Downstream cleared
      expect(state.stageResults.openapi).toBeNull();
      expect(state.stageResults.mockProject).toBeNull();
      // Pipeline re-running from next stage
      expect(state.pipelineStatus).toBe('running');
      expect(state.currentStage).toBe('openapi');
    });

    test('clears downstream when editing openapi (clears mocks)', () => {
      const updatedOpenapi: OpenAPISpec = {
        ...SAMPLE_OPENAPI,
        paths: {
          ...SAMPLE_OPENAPI.paths,
          '/billing': {
            post: {
              operationId: 'createInvoice',
              summary: 'Create an invoice',
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };

      useSpecGenerationStore.getState().startEditing('openapi');
      useSpecGenerationStore.getState().commitEdit('openapi', updatedOpenapi);

      const state = useSpecGenerationStore.getState();
      // Updated result stored
      expect(state.stageResults.openapi).toEqual(updatedOpenapi);
      // Upstream preserved
      expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
      expect(state.stageResults.agents).toEqual(SAMPLE_AGENTS);
      // Downstream cleared
      expect(state.stageResults.mockProject).toBeNull();
      // Pipeline re-running from next stage
      expect(state.pipelineStatus).toBe('running');
      expect(state.currentStage).toBe('mocks');
    });

    test('on mocks (last stage) does not clear anything downstream', () => {
      const updatedMocks: MockProjectBundle = {
        projectName: 'healthcare-mock-v2',
        files: [{ path: 'package.json', content: '{ "name": "v2" }' }],
      };

      useSpecGenerationStore.getState().startEditing('mocks');
      useSpecGenerationStore.getState().commitEdit('mocks', updatedMocks);

      const state = useSpecGenerationStore.getState();
      // Updated result stored
      expect(state.stageResults.mockProject).toEqual(updatedMocks);
      // All upstream preserved
      expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
      expect(state.stageResults.agents).toEqual(SAMPLE_AGENTS);
      expect(state.stageResults.openapi).toEqual(SAMPLE_OPENAPI);
      // Pipeline is complete (last stage was edited, nothing downstream)
      expect(state.pipelineStatus).toBe('complete');
      // Editing cleared
      expect(state.editingStage).toBeNull();
    });

    test('adds entry to edit history', () => {
      useSpecGenerationStore.getState().startEditing('topology');
      useSpecGenerationStore.getState().commitEdit('topology', SAMPLE_TOPOLOGY);

      const state = useSpecGenerationStore.getState();
      expect(state.editHistory).toHaveLength(1);
      expect(state.editHistory[0].stage).toBe('topology');
      expect(state.editHistory[0].summary).toBeDefined();
      expect(state.editHistory[0].timestamp).toBeDefined();
    });

    test('accumulates multiple edit history entries', () => {
      // Edit topology
      useSpecGenerationStore.getState().commitEdit('topology', SAMPLE_TOPOLOGY);
      // Re-complete pipeline
      useSpecGenerationStore.getState().updateStageResult('agents', SAMPLE_AGENTS);
      useSpecGenerationStore.getState().updateStageResult('openapi', SAMPLE_OPENAPI);
      useSpecGenerationStore.getState().updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
      // Edit agents
      useSpecGenerationStore.getState().commitEdit('agents', SAMPLE_AGENTS);

      const state = useSpecGenerationStore.getState();
      expect(state.editHistory).toHaveLength(2);
      expect(state.editHistory[0].stage).toBe('topology');
      expect(state.editHistory[1].stage).toBe('agents');
    });
  });

  // ===========================================================================
  // 7. setDeployResult
  // ===========================================================================

  describe('setDeployResult', () => {
    test('stores deploy result', () => {
      useSpecGenerationStore.getState().setDeployResult(SAMPLE_DEPLOY_RESULT);

      const state = useSpecGenerationStore.getState();
      expect(state.deployResult).toEqual(SAMPLE_DEPLOY_RESULT);
      expect(state.deployResult!.url).toBe('https://healthcare-mock.vercel.app');
      expect(state.deployResult!.projectName).toBe('healthcare-mock');
    });
  });

  // ===========================================================================
  // 8. reset
  // ===========================================================================

  describe('reset', () => {
    test('clears everything to initial state', () => {
      // Build up some state
      const store = useSpecGenerationStore.getState();
      store.startPipeline(SAMPLE_INPUT);
      store.updateStageResult('topology', SAMPLE_TOPOLOGY);
      store.updateStageResult('agents', SAMPLE_AGENTS);
      store.updateStageResult('openapi', SAMPLE_OPENAPI);
      store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
      store.setDeployResult(SAMPLE_DEPLOY_RESULT);
      store.startEditing('topology');

      // Reset
      useSpecGenerationStore.getState().reset();

      const state = useSpecGenerationStore.getState();
      expect(state.input).toBeNull();
      expect(state.pipelineStatus).toBe('idle');
      expect(state.currentStage).toBeNull();
      expect(state.stageResults.topology).toBeNull();
      expect(state.stageResults.agents).toBeNull();
      expect(state.stageResults.openapi).toBeNull();
      expect(state.stageResults.mockProject).toBeNull();
      expect(state.stageErrors).toEqual({});
      expect(state.editingStage).toBeNull();
      expect(state.editHistory).toEqual([]);
      expect(state.deployResult).toBeNull();
    });
  });

  // ===========================================================================
  // 9. REVIEW STEP TRACKING
  // ===========================================================================

  describe('Review step tracking', () => {
    beforeEach(() => {
      // Complete full pipeline
      const store = useSpecGenerationStore.getState();
      store.startPipeline(SAMPLE_INPUT);
      store.updateStageResult('topology', SAMPLE_TOPOLOGY);
      store.updateStageResult('agents', SAMPLE_AGENTS);
      store.updateStageResult('openapi', SAMPLE_OPENAPI);
      store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
    });

    test('pipeline completion sets reviewStep to topology', () => {
      const state = useSpecGenerationStore.getState();
      expect(state.reviewStep).toBe('topology');
      expect(state.reviewedStages).toEqual(new Set());
    });

    test('advanceReview marks current step reviewed and advances', () => {
      useSpecGenerationStore.getState().advanceReview();
      const state = useSpecGenerationStore.getState();
      expect(state.reviewedStages).toContain('topology');
      expect(state.reviewStep).toBe('agents');
    });

    test('advanceReview through all stages ends at null', () => {
      const store = useSpecGenerationStore.getState();
      store.advanceReview(); // topology -> agents
      store.advanceReview(); // agents -> openapi
      store.advanceReview(); // openapi -> mocks
      store.advanceReview(); // mocks -> null (all reviewed)

      const state = useSpecGenerationStore.getState();
      expect(state.reviewStep).toBeNull();
      expect(state.reviewedStages).toEqual(new Set(['topology', 'agents', 'openapi', 'mocks']));
    });

    test('goBackToStage un-reviews from that stage forward', () => {
      const store = useSpecGenerationStore.getState();
      store.advanceReview(); // reviewed: topology
      store.advanceReview(); // reviewed: topology, agents
      store.advanceReview(); // reviewed: topology, agents, openapi

      store.goBackToStage('agents');

      const state = useSpecGenerationStore.getState();
      expect(state.reviewStep).toBe('agents');
      // topology still reviewed, agents/openapi/mocks un-reviewed
      expect(state.reviewedStages).toEqual(new Set(['topology']));
    });
  });

  // ===========================================================================
  // 10. EDIT PANEL STATE
  // ===========================================================================

  describe('Edit panel state', () => {
    test('initial editPanelState is collapsed', () => {
      const state = useSpecGenerationStore.getState();
      expect(state.editPanelState).toBe('collapsed');
    });

    test('setEditPanelState updates the state', () => {
      useSpecGenerationStore.getState().setEditPanelState('expanded');
      expect(useSpecGenerationStore.getState().editPanelState).toBe('expanded');

      useSpecGenerationStore.getState().setEditPanelState('minimized');
      expect(useSpecGenerationStore.getState().editPanelState).toBe('minimized');
    });
  });

  // ===========================================================================
  // 11. EDIT MESSAGES PER STAGE
  // ===========================================================================

  describe('Edit messages per stage', () => {
    test('initial editMessages is empty for all stages', () => {
      const state = useSpecGenerationStore.getState();
      expect(state.editMessages.topology).toEqual([]);
      expect(state.editMessages.agents).toEqual([]);
      expect(state.editMessages.openapi).toEqual([]);
      expect(state.editMessages.mocks).toEqual([]);
    });

    test('addEditMessage appends to correct stage thread', () => {
      const msg = {
        id: '1',
        role: 'user' as const,
        content: 'Add billing agent',
        timestamp: new Date().toISOString(),
      };
      useSpecGenerationStore.getState().addEditMessage('topology', msg);

      const state = useSpecGenerationStore.getState();
      expect(state.editMessages.topology).toHaveLength(1);
      expect(state.editMessages.topology[0].content).toBe('Add billing agent');
      // Other stages unaffected
      expect(state.editMessages.agents).toEqual([]);
    });
  });

  // ===========================================================================
  // 12. PENDING PROPOSAL
  // ===========================================================================

  describe('Pending proposal', () => {
    beforeEach(() => {
      const store = useSpecGenerationStore.getState();
      store.startPipeline(SAMPLE_INPUT);
      store.updateStageResult('topology', SAMPLE_TOPOLOGY);
      store.updateStageResult('agents', SAMPLE_AGENTS);
      store.updateStageResult('openapi', SAMPLE_OPENAPI);
      store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
    });

    test('setPendingProposal stores proposal', () => {
      useSpecGenerationStore.getState().setPendingProposal({
        stage: 'topology',
        data: { nodes: [], edges: [] },
        summary: '+1 agent',
        changes: [{ type: 'add', description: 'Billing agent' }],
      });

      const state = useSpecGenerationStore.getState();
      expect(state.pendingProposal).not.toBeNull();
      expect(state.pendingProposal?.stage).toBe('topology');
    });

    test('applyProposal commits data and triggers cascade', () => {
      useSpecGenerationStore.getState().setPendingProposal({
        stage: 'topology',
        data: SAMPLE_TOPOLOGY,
        summary: 'Updated topology',
        changes: [],
      });

      useSpecGenerationStore.getState().applyProposal();

      const state = useSpecGenerationStore.getState();
      expect(state.pendingProposal).toBeNull();
      expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
      // Downstream cleared (cascade triggered)
      expect(state.stageResults.agents).toBeNull();
      expect(state.pipelineStatus).toBe('running');
    });

    test('rejectProposal clears proposal but keeps chat open', () => {
      useSpecGenerationStore.getState().setPendingProposal({
        stage: 'agents',
        data: SAMPLE_AGENTS,
        summary: 'Updated agents',
        changes: [],
      });

      useSpecGenerationStore.getState().rejectProposal();

      const state = useSpecGenerationStore.getState();
      expect(state.pendingProposal).toBeNull();
      // editPanelState not changed (chat stays open)
    });

    test('applyProposal on last stage does not cascade', () => {
      useSpecGenerationStore.getState().setPendingProposal({
        stage: 'mocks',
        data: SAMPLE_MOCK_PROJECT,
        summary: 'Updated mocks',
        changes: [],
      });

      useSpecGenerationStore.getState().applyProposal();

      const state = useSpecGenerationStore.getState();
      expect(state.pendingProposal).toBeNull();
      expect(state.stageResults.mockProject).toEqual(SAMPLE_MOCK_PROJECT);
      expect(state.pipelineStatus).toBe('complete');
    });
  });
});
