import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateWorkflowConfig,
  WorkflowConfigForm,
} from '../../components/tools/WorkflowConfigForm';
import type { WorkflowConfig } from '../../components/tools/shared-types';

const PROJECT_ID = 'project-workflow-config-form';
const WORKFLOW_ID = 'workflow-config-form-1';

const mockListWorkflows = vi.fn();
const mockListWorkflowTriggers = vi.fn();
const mockListVersions = vi.fn();
const mockGetVersion = vi.fn();

vi.mock('../../store/project-store', () => ({
  useProjectStore: () => ({
    currentProject: { id: PROJECT_ID },
  }),
}));

vi.mock('../../api/workflows', () => ({
  listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
  listWorkflowTriggers: (...args: unknown[]) => mockListWorkflowTriggers(...args),
  listVersions: (...args: unknown[]) => mockListVersions(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  getExecution: vi.fn(),
  cancelExecution: vi.fn(),
}));

function WorkflowConfigFormHarness({
  initialConfig,
  persistAutoSelectedVersion,
}: {
  initialConfig?: WorkflowConfig;
  persistAutoSelectedVersion: boolean;
}) {
  const [config, setConfig] = useState<WorkflowConfig>(
    initialConfig ?? {
      workflowId: WORKFLOW_ID,
      triggerId: '',
      mode: 'sync',
    },
  );

  return (
    <>
      <WorkflowConfigForm
        config={config}
        onChange={setConfig}
        persistAutoSelectedVersion={persistAutoSelectedVersion}
      />
      <pre data-testid="workflow-config-state">{JSON.stringify(config)}</pre>
    </>
  );
}

function readRenderedConfig(): WorkflowConfig {
  const raw = screen.getByTestId('workflow-config-state').textContent ?? '{}';
  return JSON.parse(raw) as WorkflowConfig;
}

describe('WorkflowConfigForm version persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockListWorkflows.mockResolvedValue([
      {
        id: WORKFLOW_ID,
        name: 'Workflow Config Form',
        status: 'active',
        stepCount: 2,
        createdAt: '2026-04-18T00:00:00.000Z',
      },
    ]);

    mockListWorkflowTriggers.mockImplementation(async (_projectId: string, workflowId?: string) => {
      if (!workflowId) {
        return [
          {
            id: 'trigger-global-webhook',
            workflowId: WORKFLOW_ID,
            triggerType: 'webhook',
            status: 'active',
            config: {},
          },
        ];
      }

      return [
        {
          id: 'trigger-v020',
          workflowId: WORKFLOW_ID,
          triggerType: 'webhook',
          status: 'active',
          workflowVersionId: 'version-020',
          config: {},
        },
      ];
    });

    mockListVersions.mockResolvedValue([
      {
        id: 'version-020',
        workflowId: WORKFLOW_ID,
        version: 'v0.2.0',
        state: 'active',
        createdAt: '2026-04-18T00:00:00.000Z',
      },
      {
        id: 'version-010',
        workflowId: WORKFLOW_ID,
        version: 'v0.1.0',
        state: 'active',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      {
        id: 'version-draft',
        workflowId: WORKFLOW_ID,
        version: 'draft',
        state: 'active',
        createdAt: '2026-04-18T00:00:00.000Z',
      },
    ]);

    mockGetVersion.mockImplementation(
      async (_projectId: string, _workflowId: string, version: string) => ({
        id:
          version === 'draft'
            ? 'version-draft'
            : version === 'v0.1.0'
              ? 'version-010'
              : 'version-020',
        workflowId: WORKFLOW_ID,
        version,
        state: 'active',
        createdAt: '2026-04-18T00:00:00.000Z',
        definition: {
          nodes: [],
          edges: [],
        },
      }),
    );
  });

  it('persists the auto-selected version in create flows', async () => {
    render(<WorkflowConfigFormHarness persistAutoSelectedVersion />);

    await waitFor(() => {
      expect(readRenderedConfig().workflowVersion).toBe('v0.2.0');
    });

    expect(mockGetVersion).toHaveBeenCalledWith(PROJECT_ID, WORKFLOW_ID, 'v0.2.0');
  });

  it('keeps edit-style auto-resolve bindings unpinned while still previewing the current version', async () => {
    render(<WorkflowConfigFormHarness persistAutoSelectedVersion={false} />);

    await waitFor(() => {
      expect(mockGetVersion).toHaveBeenCalledWith(PROJECT_ID, WORKFLOW_ID, 'v0.2.0');
    });

    expect(readRenderedConfig().workflowVersion).toBeUndefined();
  });

  it('preserves config-backed workflow timeout placeholders', async () => {
    render(
      <WorkflowConfigFormHarness
        initialConfig={{
          workflowId: WORKFLOW_ID,
          triggerId: 'trigger-v020',
          mode: 'sync',
        }}
        persistAutoSelectedVersion={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('30000 or {{config.WORKFLOW_TIMEOUT_MS}}')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('30000 or {{config.WORKFLOW_TIMEOUT_MS}}'), {
      target: { value: '{{config.WORKFLOW_TIMEOUT_MS}}' },
    });

    expect(readRenderedConfig().timeoutMs).toBe('{{config.WORKFLOW_TIMEOUT_MS}}');
  });

  it('accepts config-backed workflow timeout placeholders during validation', () => {
    expect(
      validateWorkflowConfig({
        workflowId: WORKFLOW_ID,
        triggerId: 'trigger-v020',
        mode: 'sync',
        timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
      }),
    ).toEqual({});
  });
});
