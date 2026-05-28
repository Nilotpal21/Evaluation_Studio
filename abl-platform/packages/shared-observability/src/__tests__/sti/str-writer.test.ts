import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STRWriter, type SpatialTraceRow, type RowWriter } from '../../sti/str-writer.js';
import type { STREntry } from '../../sti/str-buffer.js';
import { resetVersionVector } from '../../sti/version-vector.js';

function makeEntry(overrides: Partial<STREntry> = {}): STREntry {
  return {
    path: 'runtime/executor/llm-call',
    timestamp: 1700000000000,
    durationUs: 50000, // 50ms
    outcome: 'success',
    depth: 0,
    ...overrides,
  };
}

function makeContext() {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    traceId: 'trace-abc',
    sessionId: 'session-1',
    agentName: 'greeter',
    configHash: 'hash-xyz',
  };
}

describe('STRWriter', () => {
  let mockWriter: RowWriter & { rows: SpatialTraceRow[] };

  beforeEach(() => {
    resetVersionVector();
    process.env.GIT_SHA = 'test-sha';
    process.env.DEPLOY_ID = 'test-deploy';
    mockWriter = {
      rows: [],
      insert(row: SpatialTraceRow) {
        mockWriter.rows.push(row);
      },
    };
  });

  it('converts STR entries to ClickHouse rows', () => {
    const writer = new STRWriter(mockWriter);
    const entries = [makeEntry()];
    const ctx = makeContext();

    writer.flush(entries, ctx);

    expect(mockWriter.rows).toHaveLength(1);
    const row = mockWriter.rows[0];
    expect(row.tenant_id).toBe('tenant-1');
    expect(row.project_id).toBe('project-1');
    expect(row.trace_id).toBe('trace-abc');
    expect(row.sti_path).toBe('runtime/executor/llm-call');
    expect(row.session_id).toBe('session-1');
    expect(row.agent_name).toBe('greeter');
    expect(row.deployment_id).toBe('test-deploy');
    expect(row.config_hash).toBe('hash-xyz');
    expect(row.duration_ms).toBe(50);
    expect(row.has_error).toBe(0);
  });

  it('sets has_error=1 for error outcomes', () => {
    const writer = new STRWriter(mockWriter);
    writer.flush([makeEntry({ outcome: 'error' })], makeContext());

    expect(mockWriter.rows[0].has_error).toBe(1);
  });

  it('stamps version vector in attributes', () => {
    const writer = new STRWriter(mockWriter);
    writer.flush([makeEntry()], makeContext());

    const attrs = JSON.parse(mockWriter.rows[0].attributes);
    expect(attrs.code_version).toBe('test-sha');
    expect(attrs.ir_schema_version).toBe(1);
    expect(attrs.depth).toBe(0);
    expect(attrs.outcome).toBe('success');
  });

  it('calls onSuccess callback on successful flush', () => {
    const writer = new STRWriter(mockWriter);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    writer.flush([makeEntry()], makeContext(), { onSuccess, onFailure });

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('calls onFailure callback when writer.insert throws', () => {
    const failWriter: RowWriter = {
      insert() {
        throw new Error('ClickHouse unavailable');
      },
    };
    const writer = new STRWriter(failWriter);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    writer.flush([makeEntry()], makeContext(), { onSuccess, onFailure });

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('handles empty entries array', () => {
    const writer = new STRWriter(mockWriter);
    const onSuccess = vi.fn();

    writer.flush([], makeContext(), { onSuccess, onFailure: vi.fn() });

    expect(mockWriter.rows).toHaveLength(0);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('handles missing optional context fields', () => {
    const writer = new STRWriter(mockWriter);
    writer.flush([makeEntry()], {
      tenantId: 't',
      projectId: 'p',
      traceId: 'tr',
    });

    const row = mockWriter.rows[0];
    expect(row.session_id).toBe('');
    expect(row.agent_name).toBe('');
    expect(row.config_hash).toBe('');
  });
});
