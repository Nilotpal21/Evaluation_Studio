import { describe, expect, it } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['session:read'],
  },
  authToken: 'token-1',
};

describe('analytics_ops', () => {
  it('returns FORBIDDEN when permission missing', async () => {
    const noPerm: ToolPermissionContext = {
      ...TOOL_CONTEXT,
      user: { ...TOOL_CONTEXT.user, permissions: [] },
    };

    const { executeAnalyticsOps } = await import('@/lib/arch-ai/tools/analytics-ops');
    const result = await executeAnalyticsOps({ action: 'metrics', timeRange: '24h' }, noPerm);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
  });
});
