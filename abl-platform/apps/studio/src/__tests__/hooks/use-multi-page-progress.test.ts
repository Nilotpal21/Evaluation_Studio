/**
 * Tests for useMultiPageProgress hook
 *
 * Verifies WebSocket event handling for V4 multi-page intelligence crawl
 * progress updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock auth store
// ---------------------------------------------------------------------------

vi.mock('@/store/auth-store', () => ({
  useAuthStore: vi.fn(() => ({ accessToken: 'test-token' })),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSHandler = ((event: { data: string }) => void) | (() => void) | null;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  send(_data: string) {
    // no-op
  }

  /** Test helper: simulate receiving a server message */
  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

let mockWsInstance: MockWebSocket | null = null;

// Replace global WebSocket
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockWsInstance = null;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstance = this;
    }
  };
  // Need OPEN constant on the class itself for readyState checks
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  mockWsInstance = null;
});

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { useMultiPageProgress } from '../../hooks/useMultiPageProgress';
import type { MultiPageProgressState } from '../../hooks/useMultiPageProgress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render hook and wait for WS to open */
async function renderAndConnect(jobId: string | null = 'job-123') {
  const { result } = renderHook(() => useMultiPageProgress(jobId));

  if (jobId) {
    // Wait for the setTimeout in MockWebSocket constructor to fire onopen
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  return { result, ws: mockWsInstance };
}

function sendEvent(ws: MockWebSocket | null, event: Record<string, unknown>) {
  act(() => {
    ws?.simulateMessage(event);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMultiPageProgress', () => {
  it('initializes with default state when jobId is null', async () => {
    const { result } = renderHook(() => useMultiPageProgress(null));

    expect(result.current.connected).toBe(false);
    expect(result.current.discovering).toBe(false);
    expect(result.current.totalPages).toBe(0);
    expect(result.current.reusablePages).toBe(0);
    expect(result.current.maxLlmCalls).toBe(0);
    expect(result.current.pages).toEqual({});
    expect(result.current.currentUrl).toBeNull();
    expect(result.current.currentPhase).toBeNull();
    expect(result.current.currentIteration).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.isComplete).toBe(false);
    expect(result.current.isFailed).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('connects to WebSocket with type=crawler', async () => {
    await renderAndConnect('job-abc');
    expect(mockWsInstance).not.toBeNull();
    expect(mockWsInstance?.url).toContain('jobId=job-abc');
    expect(mockWsInstance?.url).toContain('type=crawler');
  });

  it('sets connected=true after WebSocket opens', async () => {
    const { result } = await renderAndConnect();
    expect(result.current.connected).toBe(true);
  });

  it('processes intelligence_crawl_discovering event', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_crawl_discovering',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:00Z',
    });

    expect(result.current.discovering).toBe(true);
  });

  it('processes intelligence_crawl_started event', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_crawl_started',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:00Z',
      data: { totalPages: 5, reusablePages: 2, maxLlmCalls: 10 },
    });

    expect(result.current.totalPages).toBe(5);
    expect(result.current.reusablePages).toBe(2);
    expect(result.current.maxLlmCalls).toBe(10);
    expect(result.current.discovering).toBe(false);
  });

  it('processes intelligence_page_started event — adds page to Record', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_page_started',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:01Z',
      data: { url: 'https://example.com/page1', handlerReused: false },
    });

    const page = result.current.pages['https://example.com/page1'];
    expect(page).toBeDefined();
    expect(page.status).toBe('analyzing');
    expect(page.handlerReused).toBe(false);
    expect(page.url).toBe('https://example.com/page1');
    expect(result.current.currentUrl).toBe('https://example.com/page1');
  });

  it('processes intelligence_page_phase event', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_page_phase',
      jobId: 'job-123',
      data: { phase: 'understand', iteration: 2 },
    });

    expect(result.current.currentPhase).toBe('understand');
    expect(result.current.currentIteration).toBe(2);
  });

  it('processes intelligence_page_complete event — updates page status + handlerReused', async () => {
    const { result, ws } = await renderAndConnect();

    // First, add the page
    sendEvent(ws, {
      type: 'intelligence_page_started',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:01Z',
      data: { url: 'https://example.com/page1', handlerReused: false },
    });

    // Then complete it
    sendEvent(ws, {
      type: 'intelligence_page_complete',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:05Z',
      data: {
        url: 'https://example.com/page1',
        handlerReused: true,
        llmCalls: 3,
        title: 'Example Page',
        quality: 'high',
        completedAt: '2026-03-22T00:00:05Z',
      },
    });

    const page = result.current.pages['https://example.com/page1'];
    expect(page.status).toBe('reused');
    expect(page.handlerReused).toBe(true);
    expect(page.llmCalls).toBe(3);
    expect(page.title).toBe('Example Page');
    expect(page.quality).toBe('high');
  });

  it('processes intelligence_page_failed event', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_page_started',
      jobId: 'job-123',
      data: { url: 'https://example.com/bad', handlerReused: false },
    });

    sendEvent(ws, {
      type: 'intelligence_page_failed',
      jobId: 'job-123',
      timestamp: '2026-03-22T00:00:10Z',
      data: { url: 'https://example.com/bad', error: 'Extraction timeout' },
    });

    const page = result.current.pages['https://example.com/bad'];
    expect(page.status).toBe('failed');
    expect(page.error).toBe('Extraction timeout');
  });

  it('processes intelligence_page_saved event', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_page_started',
      jobId: 'job-123',
      data: { url: 'https://example.com/saved', handlerReused: false },
    });

    sendEvent(ws, {
      type: 'intelligence_page_saved',
      jobId: 'job-123',
      data: { url: 'https://example.com/saved' },
    });

    const page = result.current.pages['https://example.com/saved'];
    expect(page.status).toBe('saved');
  });

  it('processes intelligence_crawl_complete event — sets isComplete and summary', async () => {
    const { result, ws } = await renderAndConnect();

    const summary = {
      totalPages: 5,
      completed: 4,
      failed: 1,
      reused: 2,
      llmCallsTotal: 12,
      tokensTotal: 5000,
    };

    sendEvent(ws, {
      type: 'intelligence_crawl_complete',
      jobId: 'job-123',
      data: { summary },
    });

    expect(result.current.isComplete).toBe(true);
    expect(result.current.summary).toEqual(summary);
  });

  it('processes intelligence_crawl_failed event — sets isFailed and error', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'intelligence_crawl_failed',
      jobId: 'job-123',
      data: { error: 'Max LLM calls exceeded' },
    });

    expect(result.current.isFailed).toBe(true);
    expect(result.current.error).toBe('Max LLM calls exceeded');
  });

  it('ignores unrelated event types', async () => {
    const { result, ws } = await renderAndConnect();

    sendEvent(ws, {
      type: 'job_started',
      jobId: 'job-123',
      data: {},
    });

    // State should remain at defaults
    expect(result.current.totalPages).toBe(0);
    expect(result.current.isComplete).toBe(false);
  });
});
