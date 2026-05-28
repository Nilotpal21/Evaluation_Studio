/**
 * Common test fixtures for agent-transfer tests.
 */
import type { TransferPayload, AgentEvent } from '../../types.js';
import type { TransferSessionData } from '../../session/types.js';
import type { AgentDesktopEventJob, SdkNotificationJob } from '../../events/types.js';
import type { TimeoutJob } from '../../events/session-timeout-scheduler.js';

export function sampleTransferPayload(overrides?: Partial<TransferPayload>): TransferPayload {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    sessionId: 'session-1',
    channel: 'chat',
    ...overrides,
  };
}

export function sampleTransferSessionData(
  overrides?: Partial<TransferSessionData>,
): TransferSessionData {
  const now = Date.now();
  return {
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    providerSessionId: 'conv-123',
    state: 'active',
    metadata: {},
    providerData: {},
    ownerPod: 'pod-1',
    lastHeartbeat: now,
    createdAt: now,
    updatedAt: now,
    ttl: 1800,
    ...overrides,
  };
}

export function sampleAgentDesktopEventJob(
  overrides?: Partial<AgentDesktopEventJob>,
): AgentDesktopEventJob {
  return {
    sessionKey: 'agent_transfer:tenant-1:contact-1:chat',
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    eventType: 'agent_message',
    payload: { text: 'Hello from agent' },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function sampleAgentEvent(overrides?: Partial<AgentEvent>): AgentEvent {
  return {
    type: 'agent:message',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    timestamp: new Date().toISOString(),
    data: { text: 'Hello' },
    ...overrides,
  };
}

export function sampleVoiceTransferPayload(overrides?: Partial<TransferPayload>): TransferPayload {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    sessionId: 'session-1',
    channel: 'voice',
    language: 'en',
    metadata: { callId: 'call-abc-123', ani: '+15551234567', dnis: '+15559876543' },
    ...overrides,
  };
}

export function sampleWebhookEvent(overrides?: Partial<SdkNotificationJob>): SdkNotificationJob {
  return {
    callbackUrl: 'https://hooks.example.com/agent-events',
    payload: {
      eventType: 'agent_message',
      sessionKey: 'agent_transfer:tenant-1:contact-1:chat',
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      data: { text: 'Hello from agent' },
    },
    headers: { 'x-kore-signature': 'sha256=abc123', 'x-kore-timestamp': String(Date.now()) },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function sampleTimeoutJob(overrides?: Partial<TimeoutJob>): TimeoutJob {
  return {
    sessionKey: 'agent_transfer:tenant-1:contact-1:chat',
    scheduledAt: Date.now(),
    ...overrides,
  };
}
