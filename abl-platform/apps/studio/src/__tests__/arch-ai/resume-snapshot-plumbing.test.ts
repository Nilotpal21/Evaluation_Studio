/**
 * Resume snapshot must round-trip:
 *   server response { session, resume }
 *   → fetchCurrentSession returns both
 *   → loadCurrentSession stores both
 *   → hook returns store's resume (not hardcoded null)
 *
 * Pure data-plumbing test; no platform mocks. Uses Zustand store directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { createSession, fetchCurrentSession } from '@/lib/arch-ai/ui/session-api';

const fakeResume = {
  phase: 'INTERVIEW',
  state: 'IDLE',
  canSendMessage: true,
  pending: null,
  nextAction: { type: 'send_message' },
  interruption: { wasInterrupted: false },
  artifacts: {
    topology: {
      exists: false,
      approved: false,
      agentCount: 0,
      edgeCount: 0,
      entryPoint: null,
    },
    files: { count: 0, names: [], mockFileCount: 0, mockFilePaths: [] },
    buildProgress: null,
    pendingMutation: null,
  },
} as const;

describe('resume snapshot plumbing', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
  });

  it('store exposes a resume slot that defaults to null', () => {
    expect(useArchUIStore.getState().resume).toBeNull();
  });

  it('setResume stores the value and setResume(null) clears it', () => {
    useArchUIStore.getState().setResume(fakeResume as never);
    expect(useArchUIStore.getState().resume).toEqual(fakeResume);

    useArchUIStore.getState().setResume(null);
    expect(useArchUIStore.getState().resume).toBeNull();
  });

  it('clear() resets resume to null', () => {
    useArchUIStore.getState().setResume(fakeResume as never);
    useArchUIStore.getState().clear();
    expect(useArchUIStore.getState().resume).toBeNull();
  });

  it('clear() drops the current session and restored messages', () => {
    useArchUIStore.setState({
      session: { id: 'sess-1', state: 'IDLE' } as never,
      messages: [{ id: 'msg-1', role: 'assistant', content: 'hello', timestamp: 'now' }] as never,
    });

    useArchUIStore.getState().clear();

    expect(useArchUIStore.getState().session).toBeNull();
    expect(useArchUIStore.getState().messages).toEqual([]);
  });
});

describe('fetchCurrentSession return shape', () => {
  it('extracts both session and resume from the server payload', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ session: { id: 'sess-1' }, resume: fakeResume }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const result = await fetchCurrentSession('ONBOARDING');
      expect(result.session).toEqual({ id: 'sess-1' });
      expect(result.resume).toEqual(fakeResume);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns { session: null, resume: null } on 404', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    try {
      const result = await fetchCurrentSession('ONBOARDING');
      expect(result).toEqual({ session: null, resume: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes backend-owned thread scope when loading the current onboarding session', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return new Response(JSON.stringify({ session: { id: 'sess-threaded' }, resume: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await fetchCurrentSession('ONBOARDING', undefined, { threadId: 'thread-server-1' });
      const url = new URL(calls[0]!, 'http://x');
      expect(url.pathname).toBe('/api/arch-ai/sessions/current');
      expect(url.searchParams.get('mode')).toBe('ONBOARDING');
      expect(url.searchParams.get('threadId')).toBe('thread-server-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes agent editor DSL scope when loading a project thread', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return new Response(JSON.stringify({ session: { id: 'sess-editor' }, resume: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await fetchCurrentSession('IN_PROJECT', 'proj-123', {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-editor-1',
      });
      const url = new URL(calls[0]!, 'http://x');
      expect(url.pathname).toBe('/api/arch-ai/sessions/current');
      expect(url.searchParams.get('mode')).toBe('IN_PROJECT');
      expect(url.searchParams.get('projectId')).toBe('proj-123');
      expect(url.searchParams.get('surface')).toBe('agent-editor');
      expect(url.searchParams.get('agentName')).toBe('BookingRequestAgent');
      expect(url.searchParams.get('threadId')).toBe('thread-editor-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not invent a client thread id when forcing a new project session', async () => {
    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          session: {
            id: 'sess-editor-new',
            state: 'IDLE',
            metadata: {
              mode: 'IN_PROJECT',
              projectId: 'proj-123',
              surface: 'agent-editor',
              agentName: 'BookingRequestAgent',
              threadId: 'thread-server-generated',
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    try {
      const session = await createSession({
        mode: 'IN_PROJECT',
        projectId: 'proj-123',
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        force: true,
      });
      expect(postedBody).toEqual({
        mode: 'IN_PROJECT',
        projectId: 'proj-123',
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        force: true,
      });
      expect(session.metadata.threadId).toBe('thread-server-generated');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('createSession hydrates the session when the server returns sessionId only', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(url, 'http://x').pathname}`);
      if (url.endsWith('/api/arch-ai/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sessionId: 'sess-42' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/arch-ai/sessions/sess-42')) {
        return new Response(JSON.stringify({ session: { id: 'sess-42', state: 'IDLE' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in test: ${init?.method ?? 'GET'} ${url}`);
    }) as typeof fetch;

    try {
      const session = await createSession({ mode: 'ONBOARDING' });
      expect(session).toEqual({ id: 'sess-42', state: 'IDLE' });
      expect(calls).toEqual(['POST /api/arch-ai/sessions', 'GET /api/arch-ai/sessions/sess-42']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
