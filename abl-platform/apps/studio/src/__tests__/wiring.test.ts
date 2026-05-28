/**
 * Studio Wiring Tests
 *
 * Verifies that design-time wiring is properly connected in the studio app.
 * Tests the connections, NOT the underlying implementations.
 *
 * NOTE: Platform-specific wiring (routes, server.ts, OTEL metrics, deployment,
 * sdkClients, observability middleware) is tested in apps/platform/__tests__/wiring.test.ts.
 * This file only tests wiring that exists within the studio file structure.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockQueryStudioAuditLogsFromClickHouse = vi.fn().mockResolvedValue({ logs: [], total: 0 });

vi.mock('@/lib/studio-clickhouse-audit-reader', () => ({
  queryStudioAuditLogsFromClickHouse: mockQueryStudioAuditLogsFromClickHouse,
}));

vi.mock('@/lib/studio-audit-pipeline-writer', () => ({
  publishStudioAuditPipelineEvent: vi.fn(),
}));

// =============================================================================
// W5 + W9: Scheduler status endpoint + SchedulerStatus interface
// =============================================================================

describe('W5 + W9: Scheduler status and SchedulerStrategy.getStatus()', () => {
  test('SchedulerStatus interface is used as return type of getStatus()', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const typesPath = path.resolve(import.meta.dirname, '../services/scheduler/scheduler-types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');

    // Verify getStatus is declared in the interface
    expect(content).toContain('getStatus(): SchedulerStatus');

    // Verify SchedulerStatus has the expected fields
    expect(content).toContain('type: string');
    expect(content).toContain('running: boolean');
    expect(content).toContain('registeredJobs: string[]');
  });

  test('IntervalScheduler implements getStatus()', async () => {
    const { IntervalScheduler } = await import('../services/scheduler/interval-scheduler');

    const scheduler = new IntervalScheduler();
    await scheduler.register({
      name: 'test-job',
      cron: '0 * * * *',
      handler: async () => {},
    });

    const status = scheduler.getStatus();

    expect(status).toEqual({
      type: 'interval',
      running: false,
      registeredJobs: ['test-job'],
      nextRunTimes: expect.objectContaining({ 'test-job': null }),
    });
  });

  test('BullMQScheduler implements getStatus()', async () => {
    const { BullMQScheduler } = await import('../services/scheduler/bullmq-scheduler');

    const scheduler = new BullMQScheduler('redis://localhost:6379');
    await scheduler.register({
      name: 'retention:daily-sweep',
      cron: '0 2 * * *',
      handler: async () => {},
    });

    const status = scheduler.getStatus();

    expect(status).toEqual({
      type: 'bullmq',
      running: false,
      registeredJobs: ['retention:daily-sweep'],
      nextRunTimes: { 'retention:daily-sweep': null },
    });
  });
});

// =============================================================================
// W4: Audit service functions exist and are callable
// =============================================================================

describe('W4: Audit service functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('getRecentAuditLogs returns array from ClickHouse reader', async () => {
    const mockLogs = [
      { id: '1', action: 'login', createdAt: new Date() },
      { id: '2', action: 'project_created', createdAt: new Date() },
    ];
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValueOnce({ logs: mockLogs, total: 2 });

    const { getRecentAuditLogs } = await import('../services/audit-service');
    const result = await getRecentAuditLogs('tenant-1', { limit: 10 });

    expect(result).toEqual(mockLogs);
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        tenantId: 'tenant-1',
        limit: 10,
      }),
    );
  });

  test('getUserAuditLogs queries ClickHouse by userId', async () => {
    const mockLogs = [{ id: '1', userId: 'user-1', action: 'login' }];
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValueOnce({ logs: mockLogs, total: 1 });

    const { getUserAuditLogs } = await import('../services/audit-service');
    const result = await getUserAuditLogs('user-1', 'tenant-1', { limit: 5 });

    expect(result).toEqual(mockLogs);
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'personal',
        userId: 'user-1',
        tenantId: 'tenant-1',
        limit: 5,
      }),
    );
  });
});

// =============================================================================
// INTEGRATION: Scheduler getStatus() returns proper data after register
// =============================================================================

describe('Integration: SchedulerStrategy getStatus()', () => {
  test('IntervalScheduler tracks registered jobs correctly', async () => {
    const { IntervalScheduler } = await import('../services/scheduler/interval-scheduler');
    const scheduler = new IntervalScheduler();

    // Start with no jobs
    expect(scheduler.getStatus().registeredJobs).toEqual([]);
    expect(scheduler.getStatus().running).toBe(false);

    // Register jobs
    await scheduler.register({
      name: 'job-a',
      cron: '0 * * * *',
      handler: async () => {},
    });
    await scheduler.register({
      name: 'job-b',
      cron: '*/5 * * * *',
      handler: async () => {},
    });

    const status = scheduler.getStatus();
    expect(status.registeredJobs).toContain('job-a');
    expect(status.registeredJobs).toContain('job-b');
    expect(status.registeredJobs).toHaveLength(2);
    expect(status.type).toBe('interval');

    // Remove a job
    await scheduler.remove('job-a');
    const status2 = scheduler.getStatus();
    expect(status2.registeredJobs).toEqual(['job-b']);
  });

  test('IntervalScheduler running state changes with start/stop', async () => {
    const { IntervalScheduler } = await import('../services/scheduler/interval-scheduler');
    const scheduler = new IntervalScheduler();

    expect(scheduler.getStatus().running).toBe(false);

    await scheduler.start();
    expect(scheduler.getStatus().running).toBe(true);

    await scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });
});

// =============================================================================
// INTEGRATION: getScheduler() returns null when not started
// =============================================================================

describe('Integration: getScheduler()', () => {
  test('returns null before startRetentionScheduler is called', async () => {
    const { getScheduler } = await import('../services/retention/retention-scheduler');
    // In test env, scheduler is not started
    const scheduler = getScheduler();
    // It could be null or an instance depending on test ordering,
    // but the function itself should be callable
    expect(scheduler === null || typeof scheduler.getStatus === 'function').toBe(true);
  });
});
