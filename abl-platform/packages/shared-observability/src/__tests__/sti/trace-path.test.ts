import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { STRBuffer } from '../../sti/str-buffer.js';

vi.mock('../../context.js', () => ({
  getCurrentTraceId: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let tracePathMod: typeof import('../../sti/trace-path.js');
let getCurrentTraceIdMock: ReturnType<typeof vi.fn>;

describe('tracePath', () => {
  let buffer: STRBuffer;

  beforeEach(async () => {
    buffer = new STRBuffer();
    const ctx = await import('../../context.js');
    getCurrentTraceIdMock = ctx.getCurrentTraceId as ReturnType<typeof vi.fn>;
    tracePathMod = await import('../../sti/trace-path.js');
    tracePathMod.setSharedSTRBuffer(buffer);
  });

  afterEach(() => {
    buffer.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('when STI_ENABLED is false (default)', () => {
    it('returns the original function unchanged', () => {
      const fn = async (x: number) => x * 2;
      const wrapped = tracePathMod.tracePath('test/path', fn);
      expect(wrapped).toBe(fn);
    });
  });

  describe('when STI_ENABLED is true', () => {
    beforeEach(() => {
      vi.stubEnv('STI_ENABLED', 'true');
    });

    it('records success and duration for a successful call', async () => {
      getCurrentTraceIdMock.mockReturnValue('test-trace-id');

      const fn = async (x: number) => x * 2;
      const wrapped = tracePathMod.tracePath('llm/chat/invoke', fn);
      const result = await wrapped(21);

      expect(result).toBe(42);

      const entries = buffer.flush('test-trace-id');
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('llm/chat/invoke');
      expect(entries[0].outcome).toBe('success');
      expect(entries[0].durationUs).toBeGreaterThan(0);
    });

    it('records error outcome when wrapped function throws', async () => {
      getCurrentTraceIdMock.mockReturnValue('test-trace-id');

      const err = new Error('boom');
      const fn = async () => {
        throw err;
      };
      const wrapped = tracePathMod.tracePath('tool/execute', fn);

      await expect(wrapped()).rejects.toThrow('boom');

      const entries = buffer.flush('test-trace-id');
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('error');
    });

    it('passes through when no traceId is available', async () => {
      getCurrentTraceIdMock.mockReturnValue(undefined);

      const fn = async () => 'ok';
      const wrapped = tracePathMod.tracePath('test/path', fn);
      const result = await wrapped();

      expect(result).toBe('ok');
      expect(buffer.size).toBe(0);
    });

    it('preserves this context', async () => {
      getCurrentTraceIdMock.mockReturnValue('test-trace-id');

      const obj = {
        value: 99,
        async getDouble() {
          return this.value * 2;
        },
      };

      obj.getDouble = tracePathMod.tracePath('test/this', obj.getDouble);
      const result = await obj.getDouble();
      expect(result).toBe(198);
    });

    it('accepts a depth parameter', async () => {
      getCurrentTraceIdMock.mockReturnValue('test-trace-id');

      const fn = async () => 'ok';
      const wrapped = tracePathMod.tracePath('nested/path', fn, 3);
      await wrapped();

      const entries = buffer.flush('test-trace-id');
      expect(entries[0].depth).toBe(3);
    });

    it('does not propagate wrapper errors to the caller', async () => {
      getCurrentTraceIdMock.mockImplementation(() => {
        throw new Error('ALS broken');
      });

      const fn = async () => 'safe';
      const wrapped = tracePathMod.tracePath('test/safety', fn);
      const result = await wrapped();

      expect(result).toBe('safe');
    });

    it('does not call the wrapped function twice when it throws', async () => {
      getCurrentTraceIdMock.mockReturnValue('test-trace-id');

      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new Error('single-call');
      };
      const wrapped = tracePathMod.tracePath('test/no-double', fn);

      await expect(wrapped()).rejects.toThrow('single-call');
      expect(callCount).toBe(1);
    });
  });
});
