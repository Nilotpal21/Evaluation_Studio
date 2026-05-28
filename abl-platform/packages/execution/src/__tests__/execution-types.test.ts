import { describe, it, expect } from 'vitest';
import { createExecution } from '../types.js';

describe('createExecution', () => {
  it('creates an Execution with status queued and generated id', () => {
    const exec = createExecution({
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      message: 'hello',
      agentName: 'booking_agent',
    });

    expect(exec.executionId).toMatch(/^exec-/);
    expect(exec.status).toBe('queued');
    expect(exec.sessionId).toBe('sess-1');
    expect(exec.tenantId).toBe('tenant-1');
    expect(exec.message).toBe('hello');
    expect(exec.agentName).toBe('booking_agent');
    expect(exec.queuedAt).toBeGreaterThan(0);
    expect(exec.startedAt).toBeUndefined();
    expect(exec.completedAt).toBeUndefined();
  });

  it('accepts optional parentExecutionId for fan-out children', () => {
    const exec = createExecution({
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      message: 'hello',
      agentName: 'search_agent',
      parentExecutionId: 'exec-parent-123',
    });

    expect(exec.parentExecutionId).toBe('exec-parent-123');
  });

  it('accepts optional attachmentIds', () => {
    const exec = createExecution({
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      message: 'see attached',
      agentName: 'doc_agent',
      attachmentIds: ['att-1', 'att-2'],
    });

    expect(exec.attachmentIds).toEqual(['att-1', 'att-2']);
  });
});
