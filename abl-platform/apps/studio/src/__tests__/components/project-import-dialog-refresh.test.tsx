import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ImportDialog } from '../../components/projects/ImportDialog';

const mockFetchImportPreview = vi.fn();
const mockApplyImport = vi.fn();
const mockLoadProjects = vi.fn();
const mockToastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

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
    onChange,
    label,
    description,
  }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: ReactNode;
    description?: ReactNode;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
      {description}
    </label>
  ),
}));

vi.mock('../../api/project-io', () => ({
  fetchImportPreview: (...args: unknown[]) => mockFetchImportPreview(...args),
  applyImport: (...args: unknown[]) => mockApplyImport(...args),
}));

vi.mock('../../api/projects', () => ({
  loadProjects: (...args: unknown[]) => mockLoadProjects(...args),
  fetchProject: (...args: unknown[]) => Promise.resolve(args),
}));

function makeAblFile(content: string, name = 'imported.agent.abl') {
  const file = new File(['placeholder'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'text', {
    configurable: true,
    value: () => Promise.resolve(content),
  });
  return file;
}

describe('ImportDialog project refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchImportPreview.mockResolvedValue({
      success: true,
      previewDigest: 'preview-123',
      warnings: [],
      preview: {
        valid: true,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: {
          core: { added: 1, modified: 0, removed: 0, unchanged: 0 },
        },
        agentChanges: {
          added: ['imported_agent'],
          modified: [],
          removed: [],
          unchanged: [],
        },
        toolChanges: { added: [], modified: [], removed: [] },
        localeChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: {
          valid: true,
          missingDependencies: [],
          warnings: [],
        },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
        blockingIssueCount: 0,
        nonBlockingIssueCount: 0,
        entryAgentResolution: {
          requested: null,
          resolved: null,
          matchedBy: 'none',
        },
        warnings: [],
      },
    });

    mockApplyImport.mockResolvedValue({
      success: true,
      applied: {
        created: 1,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
      },
      entryAgentName: null,
      warnings: [],
    });

    mockLoadProjects.mockResolvedValue(undefined);
  });

  it('reloads project counts after a successful import before closing the dialog', async () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    const { container } = render(
      <ImportDialog open onClose={onClose} projectId="proj-1" onImported={onImported} />,
    );

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [makeAblFile('AGENT: imported_agent')] },
    });

    await waitFor(() => {
      expect(mockFetchImportPreview).toHaveBeenCalledWith(
        'proj-1',
        {
          'imported.agent.abl': 'AGENT: imported_agent',
        },
        {
          deleteUnmatched: false,
        },
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Apply Import' }));

    await waitFor(() => expect(mockApplyImport).toHaveBeenCalled());
    await waitFor(() => expect(mockLoadProjects).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
