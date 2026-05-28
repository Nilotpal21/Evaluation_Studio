/**
 * Usage API Client
 *
 * Fetches usage metrics and analytics data via studio proxy APIs.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface UsageMetrics {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  totalLLMCalls: number;
  estimatedCost: number;
  period: { from: string; to: string };
}

// =============================================================================
// API
// =============================================================================

/** Session shape accepted by computeUsageMetrics (matches SessionListItem) */
interface SessionMetricInput {
  messageCount?: number;
  traceEventCount?: number;
  createdAt?: string;
  tokenCount?: number;
  estimatedCost?: number;
}

/**
 * Compute usage metrics from an already-fetched session list.
 * Avoids a redundant network fetch when the caller already has sessions.
 */
export function computeUsageMetrics(sessions: SessionMetricInput[]): UsageMetrics {
  let totalMessages = 0;
  let totalTraces = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const s of sessions) {
    totalMessages += s.messageCount || 0;
    totalTraces += s.traceEventCount || 0;
    totalTokens += s.tokenCount || 0;
    totalCost += s.estimatedCost || 0;
  }

  // Fallback token estimate when DB token counts are unavailable
  if (totalTokens === 0 && totalMessages > 0) {
    totalTokens = totalMessages * 500;
    totalCost = totalTokens * 0.000005;
  }

  // Fallback cost estimate when tokens are recorded but cost wasn't persisted
  // (sessions before cost accumulation was wired in handler.ts)
  if (totalCost === 0 && totalTokens > 0) {
    totalCost = totalTokens * 0.000005;
  }

  const earliest =
    sessions.length > 0
      ? (sessions[sessions.length - 1] as any).createdAt || new Date().toISOString()
      : new Date().toISOString();

  return {
    totalSessions: sessions.length,
    totalMessages,
    totalTokens,
    totalLLMCalls: totalTraces,
    estimatedCost: totalCost,
    period: {
      from: earliest,
      to: new Date().toISOString(),
    },
  };
}

export async function fetchSessionAnalysis(
  projectId: string,
  sessionId: string,
): Promise<{ success: boolean; analysis: Record<string, unknown> }> {
  const response = await apiFetch(
    `/api/runtime/sessions/${sessionId}?projectId=${encodeURIComponent(projectId)}`,
  );
  const data = await handleResponse<{
    success: boolean;
    session?: { traceEvents?: unknown[]; messages?: unknown[]; state?: unknown };
  }>(response);

  // Build a basic analysis from the session data
  const session = data.session;
  if (!session) {
    return { success: true, analysis: { summary: 'No session data available' } };
  }

  const traceCount = Array.isArray(session.traceEvents) ? session.traceEvents.length : 0;
  const messageCount = Array.isArray(session.messages) ? session.messages.length : 0;

  return {
    success: true,
    analysis: {
      summary: `Session with ${messageCount} messages and ${traceCount} trace events.`,
      metrics: {
        messages: messageCount,
        trace_events: traceCount,
      },
      issues: [],
      recommendations: [],
    },
  };
}
