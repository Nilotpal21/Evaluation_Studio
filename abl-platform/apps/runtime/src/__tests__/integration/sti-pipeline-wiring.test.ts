/**
 * E2E: STI Pipeline Wiring
 *
 * Tests the full STI pipeline end-to-end:
 * tracePath wraps a function → STRBuffer records entry → flush drains buffer
 * → STRWriter converts to rows → RowWriter.insert() called with correct SpatialTraceRow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock createLogger used by STRWriter (now in shared-observability)
vi.mock('@agent-platform/shared-observability/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock getCurrentTraceId from observability
const mockGetCurrentTraceId = vi.fn<() => string | undefined>();
vi.mock('@agent-platform/shared-observability/context', () => ({
  getCurrentTraceId: (...args: unknown[]) => mockGetCurrentTraceId(...(args as [])),
  runWithObservabilityContext: vi.fn(),
  getObservabilityContext: vi.fn(),
  getCurrentSpanId: vi.fn(),
}));

import {
  STRBuffer,
  STRWriter,
  tracePath,
  setSharedSTRBuffer,
  getSharedSTRBuffer,
  resetVersionVector,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RESET_MS,
  type RowWriter,
  type FlushContext,
  type SpatialTraceRow,
} from '@agent-platform/shared-observability/sti';

describe('STI Pipeline Wiring E2E', () => {
  let buffer: STRBuffer;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      STI_ENABLED: process.env.STI_ENABLED,
      GIT_SHA: process.env.GIT_SHA,
      DEPLOY_ID: process.env.DEPLOY_ID,
    };

    // Clean singleton state
    resetVersionVector();
    setSharedSTRBuffer(undefined);

    // Default: STI enabled
    process.env.STI_ENABLED = 'true';
    process.env.GIT_SHA = 'abc123';
    process.env.DEPLOY_ID = 'deploy-42';

    buffer = new STRBuffer();
    setSharedSTRBuffer(buffer);

    mockGetCurrentTraceId.mockReset();
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    resetVersionVector();
    setSharedSTRBuffer(undefined);
  });

  describe('full pipeline flow', () => {
    it('tracePath → buffer → flush → STRWriter → RowWriter.insert()', async () => {
      const traceId = 'trace-full-pipeline-001';
      mockGetCurrentTraceId.mockReturnValue(traceId);

      // Wrap a simple async function
      const innerFn = vi.fn(async (x: number) => x * 2);
      const traced = tracePath('agent.execute', innerFn);

      // Invoke the traced function
      const result = await traced(21);
      expect(result).toBe(42);
      expect(innerFn).toHaveBeenCalledWith(21);

      // Buffer should have captured the entry
      expect(buffer.size).toBe(1);

      // Flush entries from buffer
      const entries = buffer.flush(traceId);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('agent.execute');
      expect(entries[0].outcome).toBe('success');
      expect(entries[0].durationUs).toBeGreaterThan(0);

      // Feed entries through STRWriter with mock RowWriter
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);
      const context: FlushContext = {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        traceId,
        sessionId: 'session-1',
        agentName: 'test-agent',
        configHash: 'hash-abc',
      };

      writer.flush(entries, context);

      // Verify RowWriter.insert() was called with correct SpatialTraceRow
      expect(mockRowWriter.insert).toHaveBeenCalledOnce();
      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;

      expect(row.tenant_id).toBe('tenant-1');
      expect(row.project_id).toBe('project-1');
      expect(row.trace_id).toBe(traceId);
      expect(row.sti_path).toBe('agent.execute');
      expect(row.session_id).toBe('session-1');
      expect(row.agent_name).toBe('test-agent');
      expect(row.config_hash).toBe('hash-abc');
      expect(row.deployment_id).toBe('deploy-42');
      expect(row.has_error).toBe(0);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row.started_at).toBeTruthy();
      expect(row.ended_at).toBeTruthy();

      // Verify version vector fields in attributes
      const attrs = JSON.parse(row.attributes);
      expect(attrs.code_version).toBe('abc123');
      expect(attrs.outcome).toBe('success');
      expect(attrs.depth).toBe(0);
    });
  });

  describe('kill switch disabled', () => {
    it('returns raw function when STI_ENABLED is not set', async () => {
      delete process.env.STI_ENABLED;

      const innerFn = vi.fn(async () => 'result');
      const traced = tracePath('agent.execute', innerFn);

      // tracePath should return the original function unchanged
      expect(traced).toBe(innerFn);

      mockGetCurrentTraceId.mockReturnValue('trace-disabled');
      await traced();

      // Buffer should be empty — no recording happened
      expect(buffer.size).toBe(0);
    });

    it('returns raw function when STI_ENABLED is false', async () => {
      process.env.STI_ENABLED = 'false';

      const innerFn = vi.fn(async () => 'result');
      const traced = tracePath('agent.execute', innerFn);

      expect(traced).toBe(innerFn);
    });
  });

  describe('circuit breaker integration', () => {
    it('opens after repeated failures, closes after timeout', () => {
      vi.useFakeTimers();
      try {
        const traceId = 'trace-circuit-breaker';
        mockGetCurrentTraceId.mockReturnValue(traceId);

        // Report consecutive flush failures to open the circuit
        for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
          buffer.reportFlushFailure();
        }

        // Circuit should be open — recordEntry returns noop handle
        expect(buffer.isCircuitOpen()).toBe(true);
        const handle = buffer.recordEntry('trace-new', 'agent.blocked', 0);
        handle.markSuccess();
        // No entry recorded — trace not in buffer
        expect(buffer.flush('trace-new')).toHaveLength(0);

        // Advance time past the reset window
        vi.advanceTimersByTime(CIRCUIT_RESET_MS + 1);

        // Circuit should be closed — writes accepted again
        expect(buffer.isCircuitOpen()).toBe(false);
        const handle2 = buffer.recordEntry('trace-recovered', 'agent.recovered', 0);
        handle2.markSuccess();
        const entries = buffer.flush('trace-recovered');
        expect(entries).toHaveLength(1);
        expect(entries[0].path).toBe('agent.recovered');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('config hash in flush context', () => {
    it('passes configHash through to SpatialTraceRow.config_hash', () => {
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);

      const entry = buffer.recordEntry('trace-config', 'agent.execute', 0);
      entry.markSuccess();
      entry.recordDuration(5000);
      const entries = buffer.flush('trace-config');

      const context: FlushContext = {
        tenantId: 't1',
        projectId: 'p1',
        traceId: 'trace-config',
        configHash: 'sha256-deadbeef',
      };

      writer.flush(entries, context);

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      expect(row.config_hash).toBe('sha256-deadbeef');
    });

    it('defaults config_hash to empty string when not provided', () => {
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);

      const entry = buffer.recordEntry('trace-no-hash', 'agent.execute', 0);
      entry.markSuccess();
      entry.recordDuration(1000);
      const entries = buffer.flush('trace-no-hash');

      const context: FlushContext = {
        tenantId: 't1',
        projectId: 'p1',
        traceId: 'trace-no-hash',
      };

      writer.flush(entries, context);

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      expect(row.config_hash).toBe('');
    });
  });

  describe('version vector stamping', () => {
    it('stamps deployment_id and code_version from env vars', () => {
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);

      const entry = buffer.recordEntry('trace-version', 'agent.execute', 0);
      entry.markSuccess();
      entry.recordDuration(2000);
      const entries = buffer.flush('trace-version');

      writer.flush(entries, {
        tenantId: 't1',
        projectId: 'p1',
        traceId: 'trace-version',
      });

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      expect(row.deployment_id).toBe('deploy-42');

      const attrs = JSON.parse(row.attributes);
      expect(attrs.code_version).toBe('abc123');
      expect(attrs.ir_schema_version).toBe(1);
    });
  });

  describe('error path', () => {
    it('tracePath-wrapped function throws → entry marked as error → row has has_error=1', async () => {
      const traceId = 'trace-error-path';
      mockGetCurrentTraceId.mockReturnValue(traceId);

      const error = new Error('boom');
      const failingFn = vi.fn(async () => {
        throw error;
      });
      const traced = tracePath('agent.execute', failingFn);

      // The traced function should re-throw the original error
      await expect(traced()).rejects.toThrow('boom');

      // Flush and verify the entry is marked as error
      const entries = buffer.flush(traceId);
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('error');

      // Write through STRWriter and verify has_error
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);

      writer.flush(entries, {
        tenantId: 't1',
        projectId: 'p1',
        traceId,
      });

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      expect(row.has_error).toBe(1);

      const attrs = JSON.parse(row.attributes);
      expect(attrs.outcome).toBe('error');
    });
  });

  describe('duration measurement', () => {
    it('records durationUs > 0 after function execution', async () => {
      const traceId = 'trace-duration';
      mockGetCurrentTraceId.mockReturnValue(traceId);

      const slowFn = async () => {
        // Small delay to ensure measurable duration
        const start = Date.now();
        while (Date.now() - start < 5) {
          // busy wait ~5ms
        }
        return 'done';
      };
      const traced = tracePath('agent.slow', slowFn);

      await traced();

      const entries = buffer.flush(traceId);
      expect(entries).toHaveLength(1);
      // durationUs should be > 0 (at least a few thousand microseconds for ~5ms)
      expect(entries[0].durationUs).toBeGreaterThan(0);
    });

    it('duration propagates to row as duration_ms', async () => {
      const traceId = 'trace-duration-ms';
      mockGetCurrentTraceId.mockReturnValue(traceId);

      const fn = async () => {
        const start = Date.now();
        while (Date.now() - start < 2) {
          // busy wait ~2ms
        }
      };
      const traced = tracePath('agent.timed', fn);
      await traced();

      const entries = buffer.flush(traceId);
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);

      writer.flush(entries, {
        tenantId: 't1',
        projectId: 'p1',
        traceId,
      });

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      // duration_ms = Math.round(durationUs / 1000), should be >= 0
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('flush callbacks for circuit breaker feedback', () => {
    it('calls onSuccess when flush succeeds', () => {
      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);
      const onSuccess = vi.fn();
      const onFailure = vi.fn();

      const entry = buffer.recordEntry('trace-cb-ok', 'agent.execute', 0);
      entry.markSuccess();
      entry.recordDuration(100);
      const entries = buffer.flush('trace-cb-ok');

      writer.flush(
        entries,
        { tenantId: 't1', projectId: 'p1', traceId: 'trace-cb-ok' },
        { onSuccess, onFailure },
      );

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('calls onFailure when RowWriter.insert throws', () => {
      const mockRowWriter: RowWriter = {
        insert: vi.fn(() => {
          throw new Error('ClickHouse down');
        }),
      };
      const writer = new STRWriter(mockRowWriter);
      const onSuccess = vi.fn();
      const onFailure = vi.fn();

      const entry = buffer.recordEntry('trace-cb-fail', 'agent.execute', 0);
      entry.markSuccess();
      entry.recordDuration(100);
      const entries = buffer.flush('trace-cb-fail');

      writer.flush(
        entries,
        { tenantId: 't1', projectId: 'p1', traceId: 'trace-cb-fail' },
        { onSuccess, onFailure },
      );

      expect(onFailure).toHaveBeenCalledOnce();
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('no traceId available', () => {
    it('falls back to raw function when getCurrentTraceId returns undefined', async () => {
      mockGetCurrentTraceId.mockReturnValue(undefined);

      const innerFn = vi.fn(async () => 'fallback');
      const traced = tracePath('agent.execute', innerFn);

      const result = await traced();
      expect(result).toBe('fallback');
      // No entry should be recorded
      expect(buffer.size).toBe(0);
    });
  });

  describe('depth parameter', () => {
    it('passes depth through to entry and row attributes', async () => {
      const traceId = 'trace-depth';
      mockGetCurrentTraceId.mockReturnValue(traceId);

      const fn = vi.fn(async () => 'ok');
      const traced = tracePath('agent.tool.inner', fn, 3);

      await traced();

      const entries = buffer.flush(traceId);
      expect(entries[0].depth).toBe(3);

      const mockRowWriter: RowWriter = { insert: vi.fn() };
      const writer = new STRWriter(mockRowWriter);
      writer.flush(entries, {
        tenantId: 't1',
        projectId: 'p1',
        traceId,
      });

      const row = (mockRowWriter.insert as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SpatialTraceRow;
      const attrs = JSON.parse(row.attributes);
      expect(attrs.depth).toBe(3);
    });
  });
});
