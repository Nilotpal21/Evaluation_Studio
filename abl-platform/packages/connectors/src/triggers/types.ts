/**
 * Trigger Engine Types
 *
 * Interfaces for trigger registration persistence, dedup store,
 * and Restate ingress client. All dependencies are injected for testability.
 */

// ─── Trigger Type Constants (local — avoids circular dep on @abl/shared) ──
/** Trigger types valid for connector registrations */
export const REGISTRATION_TRIGGER_TYPES = ['webhook', 'cron', 'event', 'polling'] as const;
export type RegistrationTriggerType = (typeof REGISTRATION_TRIGGER_TYPES)[number];

/** All trigger types (including studio/agent invocations) */
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];

/** Persisted trigger registration record */
export interface TriggerRegistration {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersionId?: string;
  environment?: string;
  connectorName: string;
  triggerName: string;
  connectionId: string;
  triggerType: RegistrationTriggerType;
  status: 'active' | 'paused' | 'error';
  config: Record<string, unknown>;
  webhookSecret?: string;
  cronExpression?: string;
  pollingIntervalMs?: number;
  consecutiveErrors: number;
  lastFiredAt?: Date;
  lastErrorAt?: Date;
  /** Encrypted JSON string — decrypt with tenant DEK before use. */
  samplePayload?: string;
  samplePayloadExpiresAt?: Date;
}

/** Mongoose-like model interface for TriggerRegistration (testable) */
export interface TriggerRegistrationModel {
  findOne(filter: Record<string, unknown>): Promise<TriggerRegistration | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<TriggerRegistration | null>;
}

/** Redis-like interface for deduplication and secret decryption */
export interface TriggerRedisClient {
  set(
    key: string,
    value: string,
    mode: string,
    duration: number,
    flag: string,
  ): Promise<string | null>;
}

/** Decrypts a stored webhook secret for signature verification */
export type DecryptSecretFn = (encryptedSecret: string, tenantId: string) => Promise<string>;

/** Invokes a Restate workflow execution */
export interface RestateIngressClient {
  startWorkflow(executionId: string, input: WorkflowTriggerInput): Promise<void>;
}

/** Input to start a workflow execution from a trigger */
export interface WorkflowTriggerInput {
  workflowId: string;
  workflowVersionId?: string;
  workflowName?: string;
  tenantId: string;
  projectId: string;
  triggerType: TriggerType;
  triggerPayload: Record<string, unknown>;
  triggerMetadata: Record<string, unknown>;
  /** Workflow step definitions — opaque at the trigger layer, interpreted by Restate handler */
  steps?: unknown[];
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
}

/** BullMQ-like Queue interface for repeatable jobs */
export interface TriggerQueue {
  add(
    name: string,
    data: Record<string, unknown>,
    options?: {
      repeat?: { every?: number; cron?: string };
      jobId?: string;
    },
  ): Promise<void>;
  removeRepeatable(
    name: string,
    options: { every?: number; cron?: string; jobId?: string },
  ): Promise<void>;
}

/** BullMQ-like Worker interface — constructor is handled by the caller */
export interface TriggerJobData {
  registrationId: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  triggerName: string;
  connectionId: string;
  workflowVersionId?: string;
  environment?: string;
}
