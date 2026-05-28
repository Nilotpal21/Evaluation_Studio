/**
 * ElevenLabs Stream Timeout Tests
 *
 * Tests for Fix 3:
 * - Fetch timeout triggers after configured ms (mock stalled fetch)
 * - Chunk read timeout triggers for stalled stream body
 * - External signal abort cancels fetch
 * - Normal streaming completes without hitting timeouts
 * - Error is AppError with correct error code
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsService } from '../services/voice/elevenlabs-service.js';
import { AppError } from '@agent-platform/shared/errors';

// =============================================================================
// HELPERS
// =============================================================================

function createService(): ElevenLabsService {
  return new ElevenLabsService({
    apiKey: 'test-api-key',
    voiceId: 'test-voice',
    modelId: 'test-model',
  });
}

/** Helper to collect all chunks from an async generator */
async function collectChunks(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Mock fetch that never resolves but respects abort signal */
function createStalledFetch() {
  return (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal) {
        if (init.signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ElevenLabs Stream Timeout', () => {
  let service: ElevenLabsService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = createService();
  });

  afterEach(() => {
    // Clear any pending timers from Promise.race patterns before restoring real timers
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('completes normally when upstream responds within timeout', async () => {
    const mockData = new Uint8Array([1, 2, 3]);
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: mockData })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    } as any);

    const gen = service.synthesizeStream('hello');
    const collectPromise = collectChunks(gen);
    await vi.advanceTimersByTimeAsync(0);
    const chunks = await collectPromise;

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(mockData);
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  it('sends configured ElevenLabs voice settings in stream requests', async () => {
    const configuredService = ElevenLabsService.fromCredentials('test-api-key', {
      voiceId: 'configured-voice',
      model: 'eleven_multilingual_v2',
      stability: '0.35',
      similarityBoost: 0.82,
      style: '0.2',
      useSpeakerBoost: 'false',
      speed: '0.9',
    });
    const mockReader = {
      read: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    } as any);

    const gen = configuredService.synthesizeStream('hello', {
      style: 0.45,
      useSpeakerBoost: true,
    });
    const collectPromise = collectChunks(gen);
    await vi.advanceTimersByTimeAsync(0);
    await collectPromise;

    const [, requestInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body));

    expect(body).toMatchObject({
      text: 'hello',
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.82,
        style: 0.45,
        use_speaker_boost: true,
        speed: 0.9,
      },
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/text-to-speech/configured-voice/stream');
  });

  it('throws AppError when fetch times out (15s)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(createStalledFetch());

    const gen = service.synthesizeStream('hello');
    let caught: unknown;
    const collectPromise = collectChunks(gen).catch((err) => {
      caught = err;
    });

    // Advance past the 15s fetch timeout
    await vi.advanceTimersByTimeAsync(16_000);
    await collectPromise;

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('ElevenLabs fetch timed out');
  });

  it('throws AppError when stream chunk read times out (10s)', async () => {
    const mockReader = {
      read: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      releaseLock: vi.fn(),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    } as any);

    const gen = service.synthesizeStream('hello');
    let caught: unknown;
    const collectPromise = collectChunks(gen).catch((err) => {
      caught = err;
    });

    // Advance past fetch (resolves immediately) and past the 10s chunk timeout
    await vi.advanceTimersByTimeAsync(11_000);
    await collectPromise;

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('ElevenLabs stream chunk timed out');
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  it('cancels fetch when external signal is aborted', async () => {
    const externalController = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation(createStalledFetch());

    const gen = service.synthesizeStream('hello', {
      signal: externalController.signal,
    });
    let caught: unknown;
    const collectPromise = collectChunks(gen).catch((err) => {
      caught = err;
    });

    // Abort externally (immediately)
    externalController.abort();
    await vi.advanceTimersByTimeAsync(0);
    await collectPromise;

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('ElevenLabs fetch timed out');
  });

  it('propagates non-abort fetch errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'));

    const gen = service.synthesizeStream('hello');
    // Attach .catch() immediately to prevent unhandled rejection during timer advancement
    let caught: unknown;
    const collectPromise = collectChunks(gen).catch((err) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(0);
    await collectPromise;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Network failure');
    // Should NOT be an AppError — raw errors pass through
    expect(caught).not.toBeInstanceOf(AppError);
  });

  it('handles HTTP error responses correctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    } as any);

    const gen = service.synthesizeStream('hello');
    // Attach .catch() immediately to prevent unhandled rejection during timer advancement
    let caught: unknown;
    const collectPromise = collectChunks(gen).catch((err) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(0);
    await collectPromise;

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toContain('ElevenLabs API error: 429');
  });
});
