import { describe, it, expect } from 'vitest';
import { MockSandboxRunner } from '../../platform/constructs/executors/mock-sandbox-runner.js';
import { MOCK_RESPONSES } from '../fixtures/mock-tool-responses.js';

const defaults = {
  limits: { timeoutMs: 5000, memoryMb: 128 },
};

describe('MockSandboxRunner', () => {
  // ─── Dynamic Mock ──────────────────────────────────────────────────────

  describe('dynamic mock (mockResponse)', () => {
    it('returns mockResponse directly when present in params', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'calculate_risk',
        runtime: 'javascript',
        codeContent: 'return { risk: "low" };',
        params: { income: 50000, mockResponse: { risk: 'high', custom: true } },
        ...defaults,
      });
      expect(result).toEqual({ risk: 'high', custom: true });
    });

    it('returns null mockResponse when explicitly set to null', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'test_tool',
        runtime: 'javascript',
        codeContent: 'return { ok: true };',
        params: { mockResponse: null },
        ...defaults,
      });
      expect(result).toBeNull();
    });

    it('returns string mockResponse', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'test_tool',
        runtime: 'javascript',
        codeContent: 'return { ok: true };',
        params: { mockResponse: 'custom string result' },
        ...defaults,
      });
      expect(result).toBe('custom string result');
    });
  });

  // ─── JavaScript Execution ──────────────────────────────────────────────

  describe('JavaScript code execution', () => {
    it('executes seeded return-object code', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'custom_risk_calc',
        runtime: 'javascript',
        codeContent: '// Mock: custom_risk_calc\nreturn { risk: "low", score: 42 };',
        params: { income: 50000, credit_score: 750 },
        ...defaults,
      });
      expect(result).toEqual({ risk: 'low', score: 42 });
    });

    it('passes params as $-prefixed args', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'echo_params',
        runtime: 'javascript',
        codeContent: 'return { income: $income, score: $credit_score };',
        params: { income: 50000, credit_score: 750 },
        ...defaults,
      });
      expect(result).toEqual({ income: 50000, score: 750 });
    });

    it('handles empty params', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'no_params',
        runtime: 'javascript',
        codeContent: 'return { status: "ok" };',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ status: 'ok' });
    });

    it('handles null params', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'null_params',
        runtime: 'javascript',
        codeContent: 'return { status: "ok" };',
        params: null,
        ...defaults,
      });
      expect(result).toEqual({ status: 'ok' });
    });

    it('handles code that returns an array', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'list_items',
        runtime: 'javascript',
        codeContent: 'return [1, 2, 3];',
        params: {},
        ...defaults,
      });
      expect(result).toEqual([1, 2, 3]);
    });

    it('throws on syntax errors in code', async () => {
      const runner = new MockSandboxRunner();
      await expect(
        runner.run({
          functionName: 'bad_code',
          runtime: 'javascript',
          codeContent: 'return {{{invalid',
          params: {},
          ...defaults,
        }),
      ).rejects.toThrow('Mock JS execution failed');
    });
  });

  // ─── Python Fallback ───────────────────────────────────────────────────

  describe('Python code execution', () => {
    it('extracts JSON from return statement', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'py_tool',
        runtime: 'python',
        codeContent: 'def py_tool():\n    return {"status": "ok", "count": 5}',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ status: 'ok', count: 5 });
    });

    it('handles Python-style booleans and None', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'py_bool',
        runtime: 'python',
        codeContent: "return {'active': True, 'deleted': False, 'value': None}",
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ active: true, deleted: false, value: null });
    });

    it('returns generic success when return value cannot be parsed', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'py_complex',
        runtime: 'python',
        codeContent: 'result = compute()\nreturn result',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ success: true, message: 'py_complex executed (mock)' });
    });

    it('returns generic success for empty code', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'py_empty',
        runtime: 'python',
        codeContent: '',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ success: true, message: 'py_empty executed (mock)' });
    });
  });

  // ─── Empty Code ────────────────────────────────────────────────────────

  describe('empty code handling', () => {
    it('returns generic success for empty JS code', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'empty_js',
        runtime: 'javascript',
        codeContent: '',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ success: true, message: 'mock executed (empty code)' });
    });

    it('returns generic success for whitespace-only JS code', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'ws_js',
        runtime: 'javascript',
        codeContent: '   \n  \t  ',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ success: true, message: 'mock executed (empty code)' });
    });
  });

  // ─── Static Registry ─────────────────────────────────────────────────

  describe('static registry lookup', () => {
    it('returns registry response for known tool name', async () => {
      const runner = new MockSandboxRunner(undefined, MOCK_RESPONSES);
      const result = await runner.run({
        functionName: 'get_balance',
        runtime: 'javascript',
        codeContent: 'return { wrong: true };',
        params: {},
        ...defaults,
      });
      expect(result).toEqual(MOCK_RESPONSES.get_balance);
    });

    it('static registry takes priority over code_content', async () => {
      const runner = new MockSandboxRunner(undefined, MOCK_RESPONSES);
      const result = await runner.run({
        functionName: 'calculate_risk',
        runtime: 'javascript',
        codeContent: 'return { wrong: true };',
        params: { income: 50000 },
        ...defaults,
      });
      // Should return registry response, not { wrong: true }
      expect(result).toEqual(MOCK_RESPONSES.calculate_risk);
      expect(result).not.toEqual({ wrong: true });
    });

    it('dynamic mockResponse still takes priority over static registry', async () => {
      const runner = new MockSandboxRunner(undefined, MOCK_RESPONSES);
      const result = await runner.run({
        functionName: 'get_balance',
        runtime: 'javascript',
        codeContent: 'return { wrong: true };',
        params: { mockResponse: { custom: 'override' } },
        ...defaults,
      });
      expect(result).toEqual({ custom: 'override' });
    });

    it('falls through to code eval for unknown tool name', async () => {
      const runner = new MockSandboxRunner(undefined, MOCK_RESPONSES);
      const result = await runner.run({
        functionName: 'completely_unknown_tool',
        runtime: 'javascript',
        codeContent: 'return { from_code: true };',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ from_code: true });
    });

    it('works with Python runtime for known tool name', async () => {
      const runner = new MockSandboxRunner(undefined, MOCK_RESPONSES);
      const result = await runner.run({
        functionName: 'search_hotels',
        runtime: 'python',
        codeContent: 'return {"wrong": True}',
        params: {},
        ...defaults,
      });
      expect(result).toEqual(MOCK_RESPONSES.search_hotels);
    });
  });

  // ─── Timeout ─────────────────────────────────────────────────────────

  describe('timeout mechanism', () => {
    it('rejects when execution exceeds timeout', async () => {
      const runner = new MockSandboxRunner();
      await expect(
        runner.run({
          functionName: 'slow_tool',
          runtime: 'javascript',
          codeContent: 'await new Promise(r => setTimeout(r, 5000)); return { ok: true };',
          params: {},
          limits: { timeoutMs: 50, memoryMb: 128 },
        }),
      ).rejects.toThrow('timed out');
    });

    it('succeeds when execution completes before timeout', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'fast_tool',
        runtime: 'javascript',
        codeContent: 'return { ok: true };',
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      });
      expect(result).toEqual({ ok: true });
    });
  });

  // ─── Session Context ───────────────────────────────────────────────────

  describe('session context', () => {
    it('works with session context provided', async () => {
      const runner = new MockSandboxRunner({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        userId: 'user-1',
      });
      const result = await runner.run({
        functionName: 'ctx_tool',
        runtime: 'javascript',
        codeContent: 'return { ok: true };',
        params: {},
        ...defaults,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  // ─── Globals Injection ──────────────────────────────────────────────────

  describe('globals injection', () => {
    it('injects params as a global object', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'use_params',
        runtime: 'javascript',
        codeContent: 'return { q: params.query };',
        params: { query: 'test' },
        ...defaults,
        globals: {},
      });
      expect(result).toEqual({ q: 'test' });
    });

    it('injects env global from globals', async () => {
      const runner = new MockSandboxRunner();
      const mockEnv = {
        get: (key: string) => (key === 'MY_URL' ? 'https://example.com' : undefined),
      };
      const result = await runner.run({
        functionName: 'use_env',
        runtime: 'javascript',
        codeContent: 'return { url: env.get("MY_URL") };',
        params: {},
        ...defaults,
        globals: { env: mockEnv },
      });
      expect(result).toEqual({ url: 'https://example.com' });
    });

    it('injects memory global from globals', async () => {
      const runner = new MockSandboxRunner();
      const mockMemory = {
        get_content: async () => ({ data: { content: { foo: 'bar' } } }),
        set_content: async () => {},
      };
      const result = await runner.run({
        functionName: 'use_memory',
        runtime: 'javascript',
        codeContent:
          'const m = await memory.get_content("key"); return { val: m.data.content.foo };',
        params: {},
        ...defaults,
        globals: { memory: mockMemory },
      });
      expect(result).toEqual({ val: 'bar' });
    });

    it('supports async code with await', async () => {
      const runner = new MockSandboxRunner();
      const result = await runner.run({
        functionName: 'async_tool',
        runtime: 'javascript',
        codeContent: 'const val = await Promise.resolve(42); return { answer: val };',
        params: {},
        ...defaults,
        globals: {},
      });
      expect(result).toEqual({ answer: 42 });
    });
  });
});
