import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ExportDialog } from '../../components/projects/ExportDialog';

const mockFetchExportPreview = vi.fn();
const mockFetchExport = vi.fn();
const mockFetchExportV2 = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastWarning = vi.fn();
const mockToastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../api/project-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/project-io')>();
  return {
    ...actual,
    fetchExportPreview: (...args: unknown[]) => mockFetchExportPreview(...args),
    fetchExport: (...args: unknown[]) => mockFetchExport(...args),
    fetchExportV2: (...args: unknown[]) => mockFetchExportV2(...args),
  };
});

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ open, title, children }: { open: boolean; title?: string; children: ReactNode }) =>
    open ? (
      <div>
        {title ? <h1>{title}</h1> : null}
        {children}
      </div>
    ) : null,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled || loading}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    label?: ReactNode;
    onChange?: () => void;
  }) => (
    <label>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onChange?.()} />
      {label}
    </label>
  ),
}));

describe('ExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchExportPreview.mockResolvedValue({
      project: { name: 'Support Ops', slug: 'support-ops' },
      agents: [{ name: 'support_agent', hasDslContent: true }],
      tools: [{ name: 'search_docs', toolType: 'mcp' }],
      profiles: ['vip_support'],
      dependencies: {
        edges: [],
        validation: { valid: true, missing: [], circular: [] },
      },
      layers: [
        { name: 'core', defaultMode: 'always', entityCount: 2 },
        { name: 'connections', defaultMode: 'always', entityCount: 1 },
      ],
      defaultLayers: ['core', 'connections'],
      provisioning: {
        requiredEnvVars: ['OPENAI_API_KEY'],
        requiredConnectors: ['salesforce'],
        requiredMcpServers: ['docs-mcp'],
      },
    });
    mockFetchExport.mockResolvedValue({
      success: true,
      manifest: {},
      lockfile: {},
      files: {},
      warnings: [],
    });
    mockFetchExportV2.mockResolvedValue({
      success: true,
      manifest: {},
      lockfile: {},
      files: {},
      warnings: [],
    });
  });

  it('renders provisioning requirements from the export preview', async () => {
    render(<ExportDialog open onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(mockFetchExportPreview).toHaveBeenCalledWith('proj-1');
    });

    expect(await screen.findByText('Provisioning Requirements')).toBeInTheDocument();
    expect(screen.getByText('Environment Variables')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('Connectors')).toBeInTheDocument();
    expect(screen.getByText('salesforce')).toBeInTheDocument();
    expect(screen.getByText('MCP Servers')).toBeInTheDocument();
    expect(screen.getByText('docs-mcp')).toBeInTheDocument();
  });

  it('renders actionable runtime-config diagnostics when preview loading is blocked', async () => {
    mockFetchExportPreview.mockRejectedValueOnce(
      Object.assign(new Error('Export blocked'), {
        cause: {
          issues: [
            {
              kind: 'runtime_config',
              diagnostics: [
                {
                  severity: 'error',
                  message: 'Runtime filler prompt reference is archived',
                },
              ],
            },
          ],
        },
      }),
    );

    render(<ExportDialog open onClose={vi.fn()} projectId="proj-1" />);

    expect(
      await screen.findByText('Runtime filler prompt reference is archived'),
    ).toBeInTheDocument();
  });

  it('uses actionable diagnostics in the export failure toast', async () => {
    mockFetchExportV2.mockRejectedValueOnce(
      Object.assign(new Error('Export blocked'), {
        cause: {
          issues: [
            {
              kind: 'runtime_config',
              diagnostics: [
                {
                  severity: 'error',
                  message: 'Runtime filler prompt reference is archived',
                },
              ],
            },
          ],
        },
      }),
    );

    render(<ExportDialog open onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => {
      expect(mockFetchExportPreview).toHaveBeenCalledWith('proj-1');
    });

    const buttons = await screen.findAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Runtime filler prompt reference is archived');
    });
  });
});
