/**
 * Pipeline Runs — Client-side type definitions
 *
 * Mirror the shapes returned by the API routes. We avoid importing
 * server-side Mongoose schemas directly in client components.
 *
 * RunSummary mirrors the shape from pipeline-service.ts#listProjectRuns.
 */

export interface RunStep {
  id: string;
  name: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  pipelineKind: 'builtin' | 'custom';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
    triggerId: string;
    executionMode: 'batch' | 'realtime';
  };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: { message: string };
}

export interface IPipelineRunRecord {
  _id: string;
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  projectId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
    triggerId: string;
    executionMode: 'batch' | 'realtime';
  };
  input: Record<string, unknown>;
  triggerInput?: Record<string, unknown>;
  triggerInputTruncated?: boolean;
  steps: RunStep[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: {
    stepId: string;
    message: string;
  };
}
