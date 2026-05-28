/**
 * @arch-v2-ui
 * @arch-v2-ui-cleanup-promote
 *
 * Minimal fetch helpers for the v2 UI layer. No retry logic, no state —
 * the store owns state. Errors propagate; caller (hook) handles them.
 */

import { useAuthStore } from '@/store/auth-store';
import type { ArchSession } from './types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';

interface MessageBody {
  sessionId: string;
  type: 'message' | 'tool_answer' | 'gate_response' | 'proposal_response' | 'continue' | 'create';
  [key: string]: unknown;
}

export interface InProjectSessionScopeOptions {
  surface?: 'project' | 'agent-editor';
  agentName?: string;
  threadId?: string;
}

function authHeaders(): HeadersInit {
  const { accessToken, tenantId } = useAuthStore.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return headers;
}

export async function postMessage(body: MessageBody): Promise<Response> {
  return fetch('/api/arch-ai/message', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

export async function fetchCurrentSession(
  mode: 'ONBOARDING' | 'IN_PROJECT',
  projectId?: string,
  options?: InProjectSessionScopeOptions,
): Promise<{ session: ArchSession | null; resume: ResumeSnapshot | null }> {
  const qs = new URLSearchParams({ mode });
  if (projectId) qs.set('projectId', projectId);
  if (mode === 'IN_PROJECT' && options?.surface) qs.set('surface', options.surface);
  if (mode === 'IN_PROJECT' && options?.agentName) qs.set('agentName', options.agentName);
  if (options?.threadId) qs.set('threadId', options.threadId);
  const res = await fetch(`/api/arch-ai/sessions/current?${qs.toString()}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return { session: null, resume: null };
  if (!res.ok) throw new Error(`fetchCurrentSession: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    session?: ArchSession | null;
    resume?: ResumeSnapshot | null;
  };
  return { session: data.session ?? null, resume: data.resume ?? null };
}

export async function createSession(params: {
  mode: 'ONBOARDING' | 'IN_PROJECT';
  projectId?: string;
  surface?: 'project' | 'agent-editor';
  agentName?: string;
  threadId?: string;
  force?: boolean;
}): Promise<ArchSession> {
  const res = await fetch('/api/arch-ai/sessions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`createSession: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { session?: ArchSession; sessionId?: string };
  if (data.session) {
    return data.session;
  }
  if (typeof data.sessionId === 'string' && data.sessionId.length > 0) {
    const sessionRes = await fetch(`/api/arch-ai/sessions/${encodeURIComponent(data.sessionId)}`, {
      headers: authHeaders(),
    });
    if (!sessionRes.ok) {
      throw new Error(`createSession: ${sessionRes.status} ${sessionRes.statusText}`);
    }
    const sessionData = (await sessionRes.json()) as { session?: ArchSession };
    if (sessionData.session) {
      return sessionData.session;
    }
  }
  throw new Error('createSession: server did not return a session');
}

export async function archiveSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/arch-ai/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`archiveSession: ${res.status} ${res.statusText}`);
}

export async function cancelTurn(sessionId: string): Promise<void> {
  // Best-effort cancel — the engine also checks the flag at the next tool boundary.
  // We intentionally ignore network errors here since a failed cancel is non-fatal;
  // the turn will still terminate at the next tool boundary check.
  //
  // Uses the v4 endpoint (arch-ai) which calls SessionService.setCancelRequested()
  // to set cancelRequested: true on the session document. The TurnEngine polls this
  // flag between tool iterations and emits turn_ended(reason:'canceled') on detection.
  try {
    await fetch(`/api/arch-ai/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
    });
  } catch (err: unknown) {
    // Non-fatal: log for diagnostics but do not propagate.
    // In a browser context console.warn is acceptable for client-side code.
    console.warn(
      '[session-api] cancelTurn failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
