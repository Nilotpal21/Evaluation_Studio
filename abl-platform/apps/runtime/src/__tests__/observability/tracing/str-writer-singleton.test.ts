import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SpatialTraceRow,
  STREntry,
  FlushContext,
} from '@agent-platform/shared-observability/sti';

// ---------------------------------------------------------------------------
// Mock: @abl/compiler/platform (createLogger)
// ---------------------------------------------------------------------------
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock: @agent-platform/database/clickhouse (dynamic import in production code)
// ---------------------------------------------------------------------------
const mockInsert = vi.fn();

class MockBufferedClickHouseWriter {
  insert = mockInsert;
}

const mockGetClickHouseClient = vi.fn(() => ({}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: mockGetClickHouseClient,
  BufferedClickHouseWriter: MockBufferedClickHouseWriter,
}));

// ---------------------------------------------------------------------------
// Note: STRWriter internally imports getVersionVector from its own
// ./version-vector.js. In test env without GIT_SHA/DEPLOY_ID env vars,
// the defaults are codeVersion='unknown', irSchemaVersion=1, deployId='local'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are registered
// ---------------------------------------------------------------------------
import {
  getSTRWriter,
  initializeSTRWriter,
  _resetSTRWriter,
} from '../../../services/tracing/str-writer-singleton.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<STREntry> = {}): STREntry {
  return {
    path: 'agent.llm.call',
    timestamp: Date.now(),
    durationUs: 15000,
    outcome: 'success',
    depth: 1,
    ...overrides,
  };
}

function makeFlushContext(overrides: Partial<FlushContext> = {}): FlushContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    traceId: 'trace-aaa',
    sessionId: 'sess-1',
    agentName: 'test-agent',
    configHash: 'hash-abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('STRWriter Singleton', () => {
  beforeEach(() => {
    _resetSTRWriter();
    mockInsert.mockClear();
    mockGetClickHouseClient.mockClear();
  });

  // -----------------------------------------------------------------------
  // Singleton lifecycle
  // -----------------------------------------------------------------------

  describe('getSTRWriter', () => {
    it('returns null before initialization', () => {
      expect(getSTRWriter()).toBeNull();
    });

    it('returns STRWriter instance after initializeSTRWriter()', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter();
      expect(writer).not.toBeNull();
    });

    it('returns null when ClickHouse is not ready', async () => {
      await initializeSTRWriter({ clickhouseReady: false });
      expect(getSTRWriter()).toBeNull();
    });
  });

  describe('initializeSTRWriter', () => {
    it('is idempotent — second call is a no-op', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const first = getSTRWriter();

      await initializeSTRWriter({ clickhouseReady: true });
      const second = getSTRWriter();

      expect(first).toBe(second);
      // Only one ClickHouse client fetch
      expect(mockGetClickHouseClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('_resetSTRWriter', () => {
    it('resets singleton to null', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      expect(getSTRWriter()).not.toBeNull();

      _resetSTRWriter();
      expect(getSTRWriter()).toBeNull();
    });

    it('allows re-initialization after reset', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      _resetSTRWriter();
      await initializeSTRWriter({ clickhouseReady: true });
      expect(getSTRWriter()).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // ClickHouseSTRRowWriter insert behavior
  // -----------------------------------------------------------------------

  describe('ClickHouseSTRRowWriter via STRWriter.flush', () => {
    it('delegates insert calls to the buffered writer', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const entries: STREntry[] = [makeEntry()];
      writer.flush(entries, makeFlushContext());

      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it('insert catches errors and never throws', async () => {
      mockInsert.mockImplementation(() => {
        throw new Error('ClickHouse unavailable');
      });

      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      // Should not throw — error is caught inside ClickHouseSTRRowWriter
      expect(() => {
        writer.flush([makeEntry()], makeFlushContext());
      }).not.toThrow();
    });

    it('produces no insert calls for empty entries', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      writer.flush([], makeFlushContext());

      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('produces correct number of insert calls for multiple entries', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const entries: STREntry[] = [
        makeEntry({ path: 'agent.llm.call', depth: 1 }),
        makeEntry({ path: 'agent.tool.execute', depth: 2 }),
        makeEntry({ path: 'agent.llm.call', depth: 1, outcome: 'error' }),
      ];

      writer.flush(entries, makeFlushContext());

      expect(mockInsert).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------------
  // Row field mapping
  // -----------------------------------------------------------------------

  describe('row field mapping (spatial_trace_records schema)', () => {
    it('maps STREntry + FlushContext to the correct SpatialTraceRow shape', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const entry = makeEntry({
        path: 'agent.llm.call',
        timestamp: 1700000000000,
        durationUs: 25000,
        outcome: 'success',
        depth: 2,
      });

      const context = makeFlushContext({
        tenantId: 'tenant-x',
        projectId: 'project-y',
        traceId: 'trace-z',
        sessionId: 'sess-42',
        agentName: 'my-agent',
        configHash: 'cfg-hash',
      });

      writer.flush([entry], context);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      const row: SpatialTraceRow = mockInsert.mock.calls[0][0];

      // Context fields
      expect(row.tenant_id).toBe('tenant-x');
      expect(row.project_id).toBe('project-y');
      expect(row.trace_id).toBe('trace-z');
      expect(row.session_id).toBe('sess-42');
      expect(row.agent_name).toBe('my-agent');
      expect(row.config_hash).toBe('cfg-hash');

      // STI path
      expect(row.sti_path).toBe('agent.llm.call');

      // Duration: 25000us = 25ms
      expect(row.duration_ms).toBe(25);

      // Error flag
      expect(row.has_error).toBe(0);

      // Timestamps are ISO strings
      expect(row.started_at).toBe(new Date(1700000000000).toISOString());
      expect(row.ended_at).toBe(new Date(1700000000000 + 25).toISOString());

      // Version vector fields (defaults when env vars are not set)
      expect(row.deployment_id).toBe(process.env.DEPLOY_ID || 'local');

      // Attributes JSON contains depth, outcome, code_version, ir_schema_version
      const attrs = JSON.parse(row.attributes);
      expect(attrs.depth).toBe(2);
      expect(attrs.outcome).toBe('success');
      expect(attrs.code_version).toBe(
        process.env.GIT_SHA || process.env.npm_package_version || 'unknown',
      );
      expect(attrs.ir_schema_version).toBe(1);
    });

    it('maps has_error = 1 for error outcome', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      writer.flush([makeEntry({ outcome: 'error' })], makeFlushContext());

      const row: SpatialTraceRow = mockInsert.mock.calls[0][0];
      expect(row.has_error).toBe(1);
    });

    it('defaults optional context fields to empty strings', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const minimalContext: FlushContext = {
        tenantId: 'tid',
        projectId: 'pid',
        traceId: 'trid',
      };

      writer.flush([makeEntry()], minimalContext);

      const row: SpatialTraceRow = mockInsert.mock.calls[0][0];
      expect(row.session_id).toBe('');
      expect(row.agent_name).toBe('');
      expect(row.config_hash).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // Flush callbacks
  // -----------------------------------------------------------------------

  describe('flush callbacks', () => {
    it('calls onSuccess when flush succeeds', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const onSuccess = vi.fn();
      const onFailure = vi.fn();

      writer.flush([makeEntry()], makeFlushContext(), { onSuccess, onFailure });

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('calls onSuccess for empty entries (no-op flush)', async () => {
      await initializeSTRWriter({ clickhouseReady: true });
      const writer = getSTRWriter()!;

      const onSuccess = vi.fn();
      const onFailure = vi.fn();

      writer.flush([], makeFlushContext(), { onSuccess, onFailure });

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
    });
  });
});
