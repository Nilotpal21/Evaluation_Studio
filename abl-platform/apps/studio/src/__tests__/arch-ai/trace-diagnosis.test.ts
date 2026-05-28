import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeTraceDiagnosis } from '@/lib/arch-ai/tools/trace-diagnosis';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => '',
}));

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  user: {
    permissions: ['session:read'],
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
};

describe('trace diagnosis tool', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('builds environment breakdowns from session inventory when grouping by environment', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        success: true,
        total: 3,
        sessions: [
          {
            id: 'sess-prod-1',
            agentName: 'Billing_Agent',
            status: 'completed',
            createdAt: '2026-04-20T10:00:00.000Z',
            lastActivityAt: '2026-04-20T10:05:00.000Z',
            errorCount: 1,
            tokenCount: 120,
            estimatedCost: 0.12,
            durationMs: 5000,
            messageCount: 5,
            traceEventCount: 20,
            environment: 'production',
          },
          {
            id: 'sess-stage-1',
            agentName: 'Billing_Agent',
            status: 'completed',
            createdAt: '2026-04-20T09:00:00.000Z',
            lastActivityAt: '2026-04-20T09:04:00.000Z',
            errorCount: 0,
            tokenCount: 80,
            estimatedCost: 0.08,
            durationMs: 4000,
            messageCount: 4,
            traceEventCount: 15,
            environment: 'staging',
          },
          {
            id: 'sess-prod-2',
            agentName: 'Billing_Agent',
            status: 'active',
            createdAt: '2026-04-20T08:00:00.000Z',
            lastActivityAt: '2026-04-20T08:10:00.000Z',
            errorCount: 0,
            tokenCount: 60,
            estimatedCost: 0.06,
            durationMs: 6000,
            messageCount: 3,
            traceEventCount: 12,
            environment: 'production',
          },
        ],
      }),
    );

    const result = await executeTraceDiagnosis(
      {
        action: 'aggregate',
        from: '2026-04-20T00:00:00.000Z',
        to: '2026-04-21T00:00:00.000Z',
        groupByEnvironment: true,
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      action: 'aggregate',
      source: 'session_list_fallback',
      matchedSessions: 3,
      scannedSessions: 3,
      truncated: false,
      sessionSummary: {
        sessionCount: 3,
        activeCount: 1,
        totalErrors: 1,
      },
    });
    const payload = result.data as {
      filtersApplied: { groupByEnvironment: boolean };
      environmentBreakdown: Array<{
        environment: string;
        summary: { sessionCount: number; totalErrors: number };
      }> | null;
    };
    expect(payload.filtersApplied.groupByEnvironment).toBe(true);
    expect(payload.environmentBreakdown).toEqual([
      {
        environment: 'production',
        summary: expect.objectContaining({
          sessionCount: 2,
          totalErrors: 1,
        }),
        sessions: expect.any(Array),
      },
      {
        environment: 'staging',
        summary: expect.objectContaining({
          sessionCount: 1,
          totalErrors: 0,
        }),
        sessions: expect.any(Array),
      },
    ]);
  });

  it('compares two environments via separate session-list queries', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          total: 2,
          sessions: [
            {
              id: 'prod-1',
              agentName: 'Billing_Agent',
              status: 'completed',
              createdAt: '2026-04-20T10:00:00.000Z',
              lastActivityAt: '2026-04-20T10:05:00.000Z',
              errorCount: 2,
              tokenCount: 150,
              estimatedCost: 0.15,
              durationMs: 7000,
              messageCount: 6,
              traceEventCount: 24,
              environment: 'production',
            },
            {
              id: 'prod-2',
              agentName: 'Billing_Agent',
              status: 'active',
              createdAt: '2026-04-20T09:00:00.000Z',
              lastActivityAt: '2026-04-20T09:03:00.000Z',
              errorCount: 0,
              tokenCount: 90,
              estimatedCost: 0.09,
              durationMs: 3000,
              messageCount: 4,
              traceEventCount: 14,
              environment: 'production',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          total: 1,
          sessions: [
            {
              id: 'stage-1',
              agentName: 'Billing_Agent',
              status: 'completed',
              createdAt: '2026-04-20T08:00:00.000Z',
              lastActivityAt: '2026-04-20T08:02:00.000Z',
              errorCount: 1,
              tokenCount: 70,
              estimatedCost: 0.07,
              durationMs: 2000,
              messageCount: 3,
              traceEventCount: 10,
              environment: 'staging',
            },
          ],
        }),
      );

    const result = await executeTraceDiagnosis(
      {
        action: 'compare',
        environment: 'prod',
        compareWithEnvironment: 'stage',
        agentName: 'Billing_Agent',
        from: '2026-04-20T00:00:00.000Z',
        to: '2026-04-21T00:00:00.000Z',
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('environment=production');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('environment=staging');
    expect(result.data).toMatchObject({
      action: 'compare',
      compareType: 'environment',
      source: 'session_list_fallback',
      environmentComparison: {
        primaryEnvironment: 'production',
        secondaryEnvironment: 'staging',
        primary: {
          summary: {
            sessionCount: 2,
            totalErrors: 2,
          },
        },
        secondary: {
          summary: {
            sessionCount: 1,
            totalErrors: 1,
          },
        },
        delta: {
          sessionCount: 1,
          totalErrors: 1,
        },
      },
    });
  });

  it('compares two time windows via separate session-list queries', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          total: 2,
          sessions: [
            {
              id: 'today-1',
              agentName: 'Billing_Agent',
              status: 'completed',
              createdAt: '2026-04-21T10:00:00.000Z',
              lastActivityAt: '2026-04-21T10:05:00.000Z',
              errorCount: 0,
              tokenCount: 100,
              estimatedCost: 0.1,
              durationMs: 4000,
              messageCount: 4,
              traceEventCount: 12,
              environment: 'production',
            },
            {
              id: 'today-2',
              agentName: 'Billing_Agent',
              status: 'completed',
              createdAt: '2026-04-21T11:00:00.000Z',
              lastActivityAt: '2026-04-21T11:04:00.000Z',
              errorCount: 1,
              tokenCount: 120,
              estimatedCost: 0.12,
              durationMs: 5000,
              messageCount: 5,
              traceEventCount: 15,
              environment: 'production',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          total: 1,
          sessions: [
            {
              id: 'yesterday-1',
              agentName: 'Billing_Agent',
              status: 'completed',
              createdAt: '2026-04-20T10:00:00.000Z',
              lastActivityAt: '2026-04-20T10:05:00.000Z',
              errorCount: 2,
              tokenCount: 80,
              estimatedCost: 0.08,
              durationMs: 6000,
              messageCount: 4,
              traceEventCount: 14,
              environment: 'production',
            },
          ],
        }),
      );

    const result = await executeTraceDiagnosis(
      {
        action: 'compare',
        agentName: 'Billing_Agent',
        environment: 'production',
        from: '2026-04-21T00:00:00.000Z',
        to: '2026-04-22T00:00:00.000Z',
        compareFrom: '2026-04-20T00:00:00.000Z',
        compareTo: '2026-04-21T00:00:00.000Z',
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(`http://runtime${fetchMock.mock.calls[0]?.[0] as string}`);
    const secondUrl = new URL(`http://runtime${fetchMock.mock.calls[1]?.[0] as string}`);
    expect(firstUrl.searchParams.get('from')).toBe('2026-04-21T00:00:00.000Z');
    expect(secondUrl.searchParams.get('from')).toBe('2026-04-20T00:00:00.000Z');
    expect(result.data).toMatchObject({
      action: 'compare',
      compareType: 'time_range',
      source: 'session_list_fallback',
      timeRangeComparison: {
        primary: {
          summary: {
            sessionCount: 2,
            totalErrors: 1,
          },
        },
        secondary: {
          summary: {
            sessionCount: 1,
            totalErrors: 2,
          },
        },
        delta: {
          sessionCount: 1,
          totalErrors: -1,
        },
      },
    });
  });
});
