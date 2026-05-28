/**
 * Workflow Execution Payload Builder
 *
 * Single constructor for the Restate `startWorkflow` payload shared by every
 * fire path (webhook, cron, polling, Studio execute). The builder is the
 * canonical answer to "what keys must every workflow execution carry?" —
 * callers that skip `nameToIdMap` or `outputMappings` have caused
 * silent-empty-output bugs (a cron trigger for a canvas workflow would fire
 * but end-node output mappings and name-based step references were dropped).
 *
 * Keys that are `undefined`/`null` are omitted so the wire shape matches the
 * existing contract (tests assert presence/absence of version fields).
 */
import type {
  OutputMapping,
  OutputMappingsByEndNodeId,
  StartInputVariable,
  EdgeDescriptor,
} from '../handlers/canvas-to-steps.js';

export type WorkflowTriggerType = 'webhook' | 'cron' | 'event' | 'studio' | 'agent' | 'workflow';

/**
 * Index signature `[key: string]: unknown` is deliberate — `RestateClient.
 * startWorkflow` accepts `Record<string, unknown>` and TypeScript requires an
 * explicit index signature for the typed payload to be assignable to that
 * wider shape without a cast at every callsite.
 */
export interface WorkflowExecutionPayload {
  [key: string]: unknown;
  workflowId: string;
  workflowName: string;
  tenantId: string;
  projectId: string;
  triggerType: WorkflowTriggerType;
  triggerPayload: Record<string, unknown>;
  triggerMetadata: Record<string, unknown>;
  steps: unknown[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  outputMappingsByEndNodeId: OutputMappingsByEndNodeId;
  /**
   * Input variables declared on the canvas start node. Always present — the
   * builder defaults to `[]` when callers omit it. The handler validates the
   * trigger payload against these declarations at workflow start.
   */
  startInputVariables: StartInputVariable[];
  /** Present only when the resolved version is non-null. */
  workflowVersion?: string;
  /** Present only when the resolved version id is non-null. */
  workflowVersionId?: string;
  /** Present only when a deployment drove the resolution. */
  deploymentId?: string;
  /** Pre-computed in-degree map from canvas-to-steps; absent = sequential fallback. */
  inDegreeMap?: Record<string, number>;
  /** Edge descriptor map for backend-authoritative pathState computation. */
  edgeMap?: Record<string, EdgeDescriptor[]>;
  /** Webhook-only: request/response mode. */
  webhookMode?: 'sync' | 'async';
  /** Webhook-only: response delivery (poll vs push). */
  webhookDelivery?: 'poll' | 'push';
}

export interface BuildExecutionPayloadInput {
  workflowId: string;
  workflowName: string;
  tenantId: string;
  projectId: string;
  triggerType: WorkflowTriggerType;
  triggerPayload: Record<string, unknown>;
  triggerMetadata: Record<string, unknown>;
  steps: unknown[];
  /** Defaults to `{}` when omitted — never forwarded as `undefined`. */
  nameToIdMap?: Record<string, string>;
  /** Defaults to `[]` when omitted — never forwarded as `undefined`. */
  outputMappings?: OutputMapping[];
  outputMappingsByEndNodeId?: OutputMappingsByEndNodeId;
  /** Defaults to `[]` when omitted — never forwarded as `undefined`. */
  startInputVariables?: StartInputVariable[];
  /** Pre-computed in-degree map from canvas-to-steps; absent = sequential fallback. */
  inDegreeMap?: Record<string, number>;
  /** Edge descriptor map for backend-authoritative pathState computation. */
  edgeMap?: Record<string, EdgeDescriptor[]>;
  workflowVersion?: string | null;
  workflowVersionId?: string | null;
  deploymentId?: string | null;
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
}

/**
 * Build the Restate `startWorkflow` input payload with canonical field
 * defaults. Always returns `nameToIdMap` and `outputMappings` as concrete
 * (possibly empty) values so callers cannot accidentally drop them — the
 * cron scheduler's working-copy branch previously omitted both, and canvas
 * workflows fired via cron produced empty outputs as a result.
 */
export function buildWorkflowExecutionPayload(
  input: BuildExecutionPayloadInput,
): WorkflowExecutionPayload {
  const payload: WorkflowExecutionPayload = {
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    triggerType: input.triggerType,
    triggerPayload: input.triggerPayload,
    triggerMetadata: input.triggerMetadata,
    steps: input.steps,
    nameToIdMap: input.nameToIdMap ?? {},
    outputMappings: input.outputMappings ?? [],
    outputMappingsByEndNodeId: input.outputMappingsByEndNodeId ?? {},
    startInputVariables: input.startInputVariables ?? [],
  };
  if (input.inDegreeMap && Object.keys(input.inDegreeMap).length > 0) {
    payload.inDegreeMap = input.inDegreeMap;
  }
  if (input.edgeMap && Object.keys(input.edgeMap).length > 0) {
    payload.edgeMap = input.edgeMap;
  }
  if (input.workflowVersion != null) payload.workflowVersion = input.workflowVersion;
  if (input.workflowVersionId != null) payload.workflowVersionId = input.workflowVersionId;
  if (input.deploymentId != null) payload.deploymentId = input.deploymentId;
  if (input.webhookMode) payload.webhookMode = input.webhookMode;
  if (input.webhookDelivery) payload.webhookDelivery = input.webhookDelivery;
  return payload;
}
