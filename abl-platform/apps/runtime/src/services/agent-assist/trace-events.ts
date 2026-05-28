/**
 * Typed trace-event emitter helpers for the agent_assist domain.
 *
 * All 8 event kinds registered in the trace-event-registry are wrapped here
 * so call sites get type-safe payloads and a single import.
 *
 * Emitting is best-effort — failures are logged but never propagated to the
 * caller, matching the existing runtime tracing convention.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentAssistTraceEventType } from '@agent-platform/shared-kernel';

const log = createLogger('agent-assist:trace-events');

// ─── Payload shapes ─────────────────────────────────────────────────────

export interface AgentAssistTraceContext {
  tenantId: string;
  projectId: string;
  sessionId?: string;
  appId: string;
  environment: string;
}

export interface ReceivedPayload extends AgentAssistTraceContext {
  messageId: string;
  isAsync: boolean;
  streaming: boolean;
}

export interface BindingResolvedPayload extends AgentAssistTraceContext {
  bindingId?: string;
  bindingStatus: string;
}

export interface DelegatedPayload extends AgentAssistTraceContext {
  sessionId: string;
  runId: string;
  deploymentId?: string;
}

export interface TranslatedResponsePayload extends AgentAssistTraceContext {
  sessionId: string;
  runId: string;
  responseLength: number;
  mode: 'sync' | 'stream' | 'async';
}

export interface ErrorPayload extends AgentAssistTraceContext {
  errorCode: string;
  errorMessage: string;
}

export interface CallbackScheduledPayload extends AgentAssistTraceContext {
  runId: string;
  callbackUrl: string;
}

export interface CallbackDeliveredPayload extends AgentAssistTraceContext {
  runId: string;
  callbackUrl: string;
  durationMs: number;
}

export interface CallbackFailedPayload extends AgentAssistTraceContext {
  runId: string;
  callbackUrl: string;
  reason: string;
}

// ─── Emitter port (DI-friendly) ────────────────────────────────────────

export type TraceEventEmitterFn = (
  type: AgentAssistTraceEventType,
  payload: Record<string, unknown>,
) => void;

/**
 * Default no-op emitter used when no TraceStore is available.
 * Call `setAgentAssistTraceEmitter` to wire the real one.
 */
let _emitter: TraceEventEmitterFn = () => {
  /* no-op */
};

export function setAgentAssistTraceEmitter(fn: TraceEventEmitterFn): void {
  _emitter = fn;
}

function emit(type: AgentAssistTraceEventType, payload: Record<string, unknown>): void {
  try {
    _emitter(type, payload);
  } catch (err) {
    log.warn('Failed to emit agent_assist trace event', {
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Typed emission helpers ────────────────────────────────────────────

export function emitReceived(p: ReceivedPayload): void {
  emit('agent_assist.received', p as unknown as Record<string, unknown>);
}

export function emitBindingResolved(p: BindingResolvedPayload): void {
  emit('agent_assist.binding_resolved', p as unknown as Record<string, unknown>);
}

export function emitDelegated(p: DelegatedPayload): void {
  emit('agent_assist.delegated', p as unknown as Record<string, unknown>);
}

export function emitTranslatedResponse(p: TranslatedResponsePayload): void {
  emit('agent_assist.translated_response', p as unknown as Record<string, unknown>);
}

export function emitError(p: ErrorPayload): void {
  emit('agent_assist.error', p as unknown as Record<string, unknown>);
}

export function emitCallbackScheduled(p: CallbackScheduledPayload): void {
  emit('agent_assist.callback_scheduled', p as unknown as Record<string, unknown>);
}

export function emitCallbackDelivered(p: CallbackDeliveredPayload): void {
  emit('agent_assist.callback_delivered', p as unknown as Record<string, unknown>);
}

export function emitCallbackFailed(p: CallbackFailedPayload): void {
  emit('agent_assist.callback_failed', p as unknown as Record<string, unknown>);
}
