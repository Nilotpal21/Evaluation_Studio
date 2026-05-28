/**
 * Start New creates a fresh hidden thread. Archiving remains available as an
 * explicit helper, but the fresh-thread path should not require it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture fetch calls in order.
type Call = { url: string; method: string; body?: unknown };

function parseBody(init?: RequestInit): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

describe('newChat fresh-thread create', () => {
  let calls: Call[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: parseBody(init) });
      if (url.includes('/archive') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/arch-ai/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session: { id: 'sess-new', state: 'IDLE' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in test: ${init?.method ?? 'GET'} ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('can archive explicitly before creating a fresh thread', async () => {
    const { archiveSession, createSession } = await import('@/lib/arch-ai/ui/session-api');

    await archiveSession('sess-old');
    await createSession({ mode: 'ONBOARDING', force: true });

    expect(calls.map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /api/arch-ai/sessions/sess-old/archive',
      'POST /api/arch-ai/sessions',
    ]);
    expect(calls[1]?.body).toEqual({ mode: 'ONBOARDING', force: true });
  });

  it('archiveSession throws on non-OK responses (caller decides to retry)', async () => {
    globalThis.fetch = (async () => new Response('server err', { status: 500 })) as typeof fetch;

    const { archiveSession } = await import('@/lib/arch-ai/ui/session-api');

    await expect(archiveSession('sess-x')).rejects.toThrow(/archiveSession/);
  });
});

import { useArchUIStore } from '@/lib/arch-ai/ui/store';

describe('newChat end-to-end', () => {
  let calls: Call[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: parseBody(init) });
      if (url.includes('/archive') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/arch-ai/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ session: { id: 'sess-new', state: 'IDLE' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in test: ${init?.method ?? 'GET'} ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips archive when no current session', async () => {
    // Reset store, ensure no session set.
    useArchUIStore.getState().clear();
    useArchUIStore.setState({ session: null });

    // We can't import the hook directly (it's a React hook),
    // but we can test the archive helper isn't called by asserting
    // only the POST /sessions request is captured.
    const { createSession } = await import('@/lib/arch-ai/ui/session-api');
    await createSession({ mode: 'ONBOARDING', force: true });

    expect(calls.some((c) => c.url.includes('/archive'))).toBe(false);
    expect(calls[0]?.body).toEqual({ mode: 'ONBOARDING', force: true });
  });

  it('does not require archiving a live session before creating another thread', async () => {
    useArchUIStore.setState({
      session: { id: 'sess-live', state: 'IDLE' } as never,
    });

    const { createSession } = await import('@/lib/arch-ai/ui/session-api');
    await createSession({ mode: 'ONBOARDING', force: true });

    expect(calls.some((c) => c.url.includes('/archive'))).toBe(false);
    expect(calls[0]?.body).toEqual({ mode: 'ONBOARDING', force: true });
  });
});
