import {
  renderSessionMessagesForPIIBoundary,
  renderTraceEventsForPIIBoundary,
  renderValueForPIIBoundary,
  type PIIBoundaryContext,
  type PIIBoundaryMessage,
  type PIIBoundaryTraceEvent,
} from '@abl/compiler/platform/security/index.js';

export type PIIReadSurfaceContext = PIIBoundaryContext;
export type SessionMessagePIIResponse = PIIBoundaryMessage;
export type TraceEventPIIResponse = PIIBoundaryTraceEvent;

export function renderValueForClientSurface<T>(
  value: T,
  context?: PIIReadSurfaceContext,
  role?: string,
): T {
  return renderValueForPIIBoundary(value, context, { consumer: 'session_read', role });
}

export function renderSessionMessagesForUserSurface<T extends SessionMessagePIIResponse>(
  messages: T[],
  context?: PIIReadSurfaceContext,
): T[] {
  return renderSessionMessagesForPIIBoundary(messages, context, 'session_read');
}

export function renderTraceEventsForReadSurface<T extends TraceEventPIIResponse>(
  traceEvents: T[],
  context?: PIIReadSurfaceContext,
): T[] {
  return renderTraceEventsForPIIBoundary(traceEvents, context, 'session_read');
}
