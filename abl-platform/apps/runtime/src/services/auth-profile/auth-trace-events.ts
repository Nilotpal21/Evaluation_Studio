import crypto from 'crypto';
import type { AuthRequirement, TraceEventWithId } from '../../types/index.js';
import {
  AUTH_PREFLIGHT_REQUIRED_CODE,
  AUTH_PREFLIGHT_SATISFIED_CODE,
  type AuthContractCode,
} from './auth-contract.js';

export const AUTH_GATE_DECISION_KIND = 'auth_gate' as const;

export type AuthLifecycleDecision =
  | 'preflight_required'
  | 'gate_updated'
  | 'gate_satisfied'
  | 'message_queued';

interface RequirementSummary {
  connector: string;
  authProfileRef: string;
  connectionMode: 'per_user' | 'shared';
  requirementKey?: string;
  profileId?: string;
  environment?: string | null;
}

interface AuthLifecycleTraceBase {
  sessionId: string;
  traceId?: string;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp?: Date;
}

interface AuthGateRequirementTrace extends AuthLifecycleTraceBase {
  decision: 'preflight_required' | 'gate_updated';
  pending: AuthRequirement[];
  satisfied: AuthRequirement[];
}

interface AuthGateSatisfiedTrace extends AuthLifecycleTraceBase {
  decision: 'gate_satisfied';
  queuedMessageCount: number;
}

interface AuthMessageQueuedTrace extends AuthLifecycleTraceBase {
  decision: 'message_queued';
  reason: string;
  attachmentCount?: number;
  textLength?: number;
}

export type AuthLifecycleTraceParams =
  | AuthGateRequirementTrace
  | AuthGateSatisfiedTrace
  | AuthMessageQueuedTrace;

function summarizeRequirements(requirements: AuthRequirement[]): RequirementSummary[] {
  return requirements.map((requirement) => ({
    connector: requirement.connector,
    authProfileRef: requirement.authProfileRef,
    connectionMode: requirement.connectionMode,
    ...(requirement.requirementKey ? { requirementKey: requirement.requirementKey } : {}),
    ...(requirement.profileId ? { profileId: requirement.profileId } : {}),
    ...(requirement.environment !== undefined ? { environment: requirement.environment } : {}),
  }));
}

function resolveAuthLifecycleCode(decision: AuthLifecycleDecision): AuthContractCode {
  switch (decision) {
    case 'gate_satisfied':
      return AUTH_PREFLIGHT_SATISFIED_CODE;
    case 'preflight_required':
    case 'gate_updated':
    case 'message_queued':
      return AUTH_PREFLIGHT_REQUIRED_CODE;
  }
}

function resolveAuthLifecycleMessage(params: AuthLifecycleTraceParams): string {
  switch (params.decision) {
    case 'preflight_required':
      return `Authentication preflight required for ${params.pending.length} connector(s).`;
    case 'gate_updated':
      return `Authentication preflight updated: ${params.pending.length} pending, ${params.satisfied.length} satisfied.`;
    case 'gate_satisfied':
      return `Authentication preflight satisfied; replaying ${params.queuedMessageCount} queued message(s).`;
    case 'message_queued':
      return 'Message queued until authentication preflight is satisfied.';
  }
}

export function buildAuthLifecycleTraceEvent(params: AuthLifecycleTraceParams): TraceEventWithId {
  const timestamp = params.timestamp ?? new Date();
  const code = resolveAuthLifecycleCode(params.decision);
  const message = resolveAuthLifecycleMessage(params);

  const data: Record<string, unknown> = {
    source: 'auth_contract',
    category: 'auth',
    code,
    decisionKind: AUTH_GATE_DECISION_KIND,
    decision: params.decision,
    message,
  };

  switch (params.decision) {
    case 'preflight_required':
    case 'gate_updated':
      data.pendingCount = params.pending.length;
      data.satisfiedCount = params.satisfied.length;
      data.pendingRequirements = summarizeRequirements(params.pending);
      data.satisfiedRequirements = summarizeRequirements(params.satisfied);
      break;
    case 'gate_satisfied':
      data.queuedMessageCount = params.queuedMessageCount;
      break;
    case 'message_queued':
      data.reason = params.reason;
      if (params.attachmentCount !== undefined) {
        data.attachmentCount = params.attachmentCount;
      }
      if (params.textLength !== undefined) {
        data.textLength = params.textLength;
      }
      break;
  }

  return {
    id: crypto.randomUUID(),
    sessionId: params.sessionId,
    type: 'decision',
    timestamp,
    data,
    ...(params.traceId ? { traceId: params.traceId } : {}),
    ...(params.agentName ? { agentName: params.agentName } : {}),
    ...(params.spanId ? { spanId: params.spanId } : {}),
    ...(params.parentSpanId ? { parentSpanId: params.parentSpanId } : {}),
  };
}
