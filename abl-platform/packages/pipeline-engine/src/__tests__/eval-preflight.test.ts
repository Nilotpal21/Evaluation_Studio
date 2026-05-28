import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runEvalPreflight,
  withTimeout,
  computeOverallStatus,
  isPreflightWarningStatus,
} from '../pipeline/services/eval/eval-preflight.js';
import type { PreflightCheck } from '../pipeline/services/eval/eval-preflight.js';

// Save original env and restore after each test
const originalEnv = { ...process.env };

beforeEach(() => {
  // Set baseline valid env for most tests
  process.env['ENCRYPTION_MASTER_KEY'] =
    '761c4d78624f1b2be00917d14d721d1a581298f5fb2cf857675acc25a0e226e1';
  process.env['JWT_SECRET'] = 'test-jwt-secret';
  process.env['EVAL_SERVICE_USER_ID'] = 'test-user';
  process.env['RUNTIME_URL'] = 'http://localhost:99999'; // non-routable
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Eval Preflight — encryption_master_key', () => {
  test('passes with valid 64-hex-char key', async () => {
    const result = await runEvalPreflight('_system_');
    const check = result.checks.find((c) => c.name === 'encryption_master_key');
    expect(check).toBeDefined();
    expect(check!.status).toBe('pass');
    expect(check!.message).toContain('AES-256-GCM round-trip OK');
  });

  test('fails when ENCRYPTION_MASTER_KEY is missing', async () => {
    delete process.env['ENCRYPTION_MASTER_KEY'];
    const result = await runEvalPreflight('_system_');
    const check = result.checks.find((c) => c.name === 'encryption_master_key');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('not set');
  });

  test('fails when ENCRYPTION_MASTER_KEY is wrong length', async () => {
    process.env['ENCRYPTION_MASTER_KEY'] = 'abc123';
    const result = await runEvalPreflight('_system_');
    const check = result.checks.find((c) => c.name === 'encryption_master_key');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('must be 64 hex chars');
  });
});

describe('Eval Preflight — required_env_vars', () => {
  test('passes when all required vars set', async () => {
    const result = await runEvalPreflight('_system_');
    const check = result.checks.find((c) => c.name === 'required_env_vars');
    expect(check!.status).not.toBe('fail');
  });

  test('fails when JWT_SECRET is missing', async () => {
    delete process.env['JWT_SECRET'];
    const result = await runEvalPreflight('_system_');
    const check = result.checks.find((c) => c.name === 'required_env_vars');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('JWT_SECRET');
  });
});

describe('Eval Preflight — overall status', () => {
  test('overall is fail when any check fails', async () => {
    delete process.env['ENCRYPTION_MASTER_KEY'];
    const result = await runEvalPreflight('_system_');
    expect(result.overall).toBe('fail');
  });

  test('system-level preflight skips tenant-specific checks', async () => {
    const result = await runEvalPreflight('_system_');
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).not.toContain('llm_credentials');
    expect(checkNames).not.toContain('provider_key_match');
    expect(checkNames).not.toContain('runtime_auth');
  });

  test('result includes timestamp', async () => {
    const result = await runEvalPreflight('_system_');
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
  });

  test('each check has durationMs >= 0', async () => {
    const result = await runEvalPreflight('_system_');
    for (const check of result.checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Eval Preflight — evaluator model diagnostics', () => {
  afterEach(() => {
    vi.doUnmock('../pipeline/services/llm-client-factory.js');
    vi.resetModules();
  });

  test('surfaces typed LLM resolution failures for evaluator models', async () => {
    const evaluatorFailure = {
      code: 'INFERENCE_DISABLED',
      userMessage:
        'Configured LLM model exists but inference is disabled. Enable inference for the model before running evals.',
    };

    vi.doMock('../pipeline/services/llm-client-factory.js', () => ({
      resolvePipelineLLM: vi.fn(
        (
          _tenantId: string,
          _projectId?: string,
          pipelineModelId?: string,
        ): Promise<{
          provider: string;
          modelId: string;
          apiKey: string;
          source: 'tenant';
        }> => {
          if (pipelineModelId) {
            return Promise.reject(evaluatorFailure);
          }

          return Promise.resolve({
            provider: 'openai',
            modelId: 'gpt-4o-mini',
            apiKey: 'sk-test',
            source: 'tenant',
          });
        },
      ),
      isPipelineLLMResolutionError: (error: unknown) =>
        Boolean(error && typeof error === 'object' && 'code' in error && 'userMessage' in error),
    }));

    const { runEvalPreflight: runWithMockedResolver } =
      await import('../pipeline/services/eval/eval-preflight.js');

    const result = await runWithMockedResolver('tenant-1066', 'project-1066', {
      evaluatorModels: ['disabled-model'],
    });
    const evaluatorCheck = result.checks.find((c) => c.name === 'evaluator_model_1');

    expect(evaluatorCheck).toBeDefined();
    expect(evaluatorCheck!.status).toBe('fail');
    expect(evaluatorCheck!.code).toBe('INFERENCE_DISABLED');
    expect(evaluatorCheck!.message).toContain('inference is disabled');
    expect(evaluatorCheck!.message).not.toContain('tenant-1066');
  });
});

// ── withTimeout ──────────────────────────────────────────────────────

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('resolves with the operation result when it completes before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 5_000, 'should not fire');
    expect(result).toBe('ok');
  });

  test('rejects with the timeout message when the operation never settles', async () => {
    const op = new Promise<string>(() => {
      // intentionally never resolves
    });
    const race = withTimeout(op, 5_000, 'operation timed out');
    vi.advanceTimersByTime(5_000);
    await expect(race).rejects.toThrow('operation timed out');
  });

  test('rejects with the operation error when the operation fails before the deadline', async () => {
    const op = Promise.reject(new Error('network error'));
    await expect(withTimeout(op, 5_000, 'should not fire')).rejects.toThrow('network error');
  });

  test('clears the timer so it does not fire after the operation resolves', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(Promise.resolve(42), 5_000, 'should not fire');
    expect(clearSpy).toHaveBeenCalled();
    // Advance past the deadline — timer must not fire an unhandled rejection
    vi.advanceTimersByTime(10_000);
    clearSpy.mockRestore();
  });

  test('clears the timer when the operation rejects before the deadline', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 5_000, 'should not fire'),
    ).rejects.toThrow('boom');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  test('does not fire before the deadline', async () => {
    const op = new Promise<string>(() => {});
    const race = withTimeout(op, 1_000, 'timed out');
    vi.advanceTimersByTime(999);
    const winner = await Promise.race([race, Promise.resolve('still-pending')]);
    expect(winner).toBe('still-pending');

    vi.advanceTimersByTime(1);
    // Catch the rejection before asserting so there is no window of an
    // unhandled rejection between advanceTimersByTime and the expect call.
    const settled = await race.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(settled.ok).toBe(false);
    expect((settled as { ok: false; e: unknown }).e).toBeInstanceOf(Error);
    expect(((settled as { ok: false; e: unknown }).e as Error).message).toBe('timed out');
  });
});

// ── computeOverallStatus ─────────────────────────────────────────────

describe('computeOverallStatus', () => {
  function check(status: PreflightCheck['status']): PreflightCheck {
    return { name: 'x', status, message: '', durationMs: 0 };
  }

  test('returns pass when all checks pass', () => {
    expect(computeOverallStatus([check('pass'), check('pass')])).toBe('pass');
  });

  test('returns pass for an empty check list', () => {
    expect(computeOverallStatus([])).toBe('pass');
  });

  test('returns warn when at least one check warns and none fail', () => {
    expect(computeOverallStatus([check('pass'), check('warn')])).toBe('warn');
  });

  test('returns warn when a check was not run and none fail', () => {
    expect(computeOverallStatus([check('pass'), check('not_checked')])).toBe('warn');
  });

  test('returns fail when at least one check fails', () => {
    expect(computeOverallStatus([check('pass'), check('warn'), check('fail')])).toBe('fail');
  });

  test('fail takes precedence over warn', () => {
    expect(computeOverallStatus([check('warn'), check('fail'), check('pass')])).toBe('fail');
  });

  test('identifies statuses that contribute to warn overall status', () => {
    expect(isPreflightWarningStatus('warn')).toBe(true);
    expect(isPreflightWarningStatus('not_checked')).toBe(true);
    expect(isPreflightWarningStatus('pass')).toBe(false);
    expect(isPreflightWarningStatus('fail')).toBe(false);
  });
});
