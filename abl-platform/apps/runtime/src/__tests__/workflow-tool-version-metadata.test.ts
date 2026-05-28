import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@abl/compiler';
import { resolveWorkflowToolVersionMetadata } from '../services/workflow/workflow-tool-version-metadata.js';

const mockWorkflowFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Workflow: {
    find: (...args: unknown[]) => mockWorkflowFind(...args),
  },
}));

function makeWorkflowTool(
  name: string,
  workflowBinding: NonNullable<ToolDefinition['workflow_binding']>,
): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'workflow',
    workflow_binding: workflowBinding,
  };
}

describe('resolveWorkflowToolVersionMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves explicit workflowVersionId pins', async () => {
    const tools = [
      makeWorkflowTool('run_workflow', {
        workflowId: 'wf-1',
        workflowVersionId: 'wfv-1',
        triggerId: 'tr-1',
        mode: 'async',
        paramMapping: {},
      }),
    ];

    const resolved = await resolveWorkflowToolVersionMetadata({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tools,
      workflowVersionManifest: { Orders: 'v2.0.0' },
    });

    expect(resolved.run_workflow).toEqual({
      workflowId: 'wf-1',
      workflowVersionId: 'wfv-1',
    });
    expect(mockWorkflowFind).not.toHaveBeenCalled();
  });

  it('preserves explicit workflowVersion semver pins', async () => {
    const tools = [
      makeWorkflowTool('run_workflow', {
        workflowId: 'wf-1',
        workflowVersion: 'v1.4.0',
        triggerId: 'tr-1',
        mode: 'async',
        paramMapping: {},
      }),
    ];

    const resolved = await resolveWorkflowToolVersionMetadata({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tools,
      workflowVersionManifest: { Orders: 'v2.0.0' },
    });

    expect(resolved.run_workflow).toEqual({
      workflowId: 'wf-1',
      workflowVersion: 'v1.4.0',
    });
    expect(mockWorkflowFind).not.toHaveBeenCalled();
  });

  it('maps deployment workflowVersionManifest entries onto unpinned workflow tools', async () => {
    mockWorkflowFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([
            {
              _id: 'wf-2',
              name: 'Orders',
            },
          ]),
      }),
    });

    const tools = [
      makeWorkflowTool('run_orders', {
        workflowId: 'wf-2',
        triggerId: 'tr-2',
        mode: 'sync',
        paramMapping: {},
      }),
    ];

    const resolved = await resolveWorkflowToolVersionMetadata({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tools,
      workflowVersionManifest: { Orders: 'v2.0.0' },
    });

    expect(mockWorkflowFind).toHaveBeenCalledWith({
      _id: { $in: ['wf-2'] },
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(resolved.run_orders).toEqual({
      workflowId: 'wf-2',
      workflowVersion: 'v2.0.0',
    });
  });

  it('does not pin unlisted workflows from the deployment manifest', async () => {
    mockWorkflowFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([
            {
              _id: 'wf-3',
              name: 'Returns',
            },
          ]),
      }),
    });

    const tools = [
      makeWorkflowTool('run_returns', {
        workflowId: 'wf-3',
        triggerId: 'tr-3',
        mode: 'async',
        paramMapping: {},
      }),
    ];

    const resolved = await resolveWorkflowToolVersionMetadata({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tools,
      workflowVersionManifest: { Orders: 'v2.0.0' },
    });

    expect(resolved.run_returns).toBeUndefined();
  });
});
