/**
 * Eval Pipeline Definition (Manual Only)
 *
 * Defines the eval run pipeline: run conversations (parallel) →
 * judge conversations (parallel) → aggregate results → store.
 *
 * This pipeline is triggered manually via PipelineTrigger.triggerManual()
 * from the Studio eval runs API route.
 *
 * NOTE: The actual orchestration for eval runs uses a custom Restate workflow
 * (EvalRunWorkflow) rather than the generic PipelineRun workflow, because eval
 * runs need custom fan-out logic (persona x scenario x variant matrix) that
 * doesn't map to the generic step-by-step pipeline model. This definition is
 * registered for metadata/discovery purposes.
 */
import type { PipelineDefinition } from '../types.js';

export const EVAL_PIPELINE_ID = 'eval-run-pipeline';

export const evalPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'simulation',
  name: 'Evaluation Run',
  description:
    'Execute persona x scenario x evaluator matrix evaluation with bias mitigation and trajectory scoring',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [], // Shared fields only (model, provider, samplingRate)
  },

  supportedTriggers: [
    {
      id: 'manual',
      type: 'manual',
      strategy: 'eval',
      label: 'Manual',
      description: 'Triggered from Studio or API for evaluation runs',
    },
  ],
  defaultTriggerIds: ['manual'],

  strategies: {
    eval: {
      executionMode: 'batch',
      steps: [
        { id: 'run-conversations', activity: 'run-eval-conversation', parallel: 'true' },
        { id: 'judge-conversations', activity: 'judge-conversation', parallel: 'true' },
        { id: 'aggregate-results', activity: 'aggregate-eval-run' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  // Keep old fields for migration compat
  trigger: { type: 'manual' },
  inputSchema: {
    required: ['tenantId', 'projectId', 'runId', 'evalSetId'],
    properties: {
      tenantId: { type: 'string', description: 'Tenant ID for isolation' },
      projectId: { type: 'string', description: 'Project containing the agents' },
      runId: { type: 'string', description: 'EvalRun document ID in MongoDB' },
      evalSetId: { type: 'string', description: 'EvalSet defining the matrix' },
    },
  },
  steps: [
    {
      id: 'run-conversations',
      name: 'Run Eval Conversations',
      type: 'run-eval-conversation',
      config: {},
      timeout: 600_000,
      retries: 1,
    },
    {
      id: 'judge-conversations',
      name: 'Judge Conversations',
      type: 'judge-conversation',
      config: {},
      timeout: 120_000,
      retries: 2,
    },
    {
      id: 'aggregate-results',
      name: 'Aggregate Results',
      type: 'aggregate-eval-run',
      config: {},
      timeout: 30_000,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-05'),
  updatedAt: new Date('2026-03-05'),
};
