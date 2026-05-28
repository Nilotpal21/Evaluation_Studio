/**
 * Import dialog regressions for failed and partial preview responses.
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportPreviewResponse } from '../../api/project-io';

const mockFetchImportPreview = vi.hoisted(() => vi.fn());
const mockApplyImport = vi.hoisted(() => vi.fn());
const mockFetchImportStatus = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

const translations: Record<string, string> = {
  title: 'Import Project',
  drop_or_browse: 'Drop files here or click to browse',
  accepted_formats: 'Accepted formats',
  cancel: 'Cancel',
  back: 'Back',
  preview_failed: 'Failed to preview import',
  preview_invalid: 'Unable to parse import preview. Please check the file format and try again.',
  import_failed: 'Import failed',
  import_mode_title: 'Import mode',
  merge_mode_summary: 'Merge with existing project',
  merge_mode_description: 'Matching records are updated and unrelated project content is kept.',
  replace_mode_label: 'Replace project contents',
  replace_mode_description:
    'Remove project content from imported layers when it is not present in the archive.',
  blocking_issues_description:
    'Resolve these issues before applying the import. Full-project archives are supported without selecting layers in this dialog.',
  apply_import: 'Apply Import',
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  unchanged: 'Unchanged',
  new_agents: 'New Agents',
  modified_agents: 'Modified Agents',
  removed_agents: 'Removed Agents',
  blocking_issues: 'Blocking Issues',
  issues_to_review: 'Issues To Review',
  warnings: 'Warnings',
  badge_new: 'new',
  badge_mod: 'updated',
  badge_del: 'removed',
  locale_files: 'Locale Files',
  no_valid_files: 'No valid files found',
  parse_failed: 'Parse failed',
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => translations[key] ?? key,
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
  },
}));

vi.mock('../../api/project-io', () => ({
  fetchImportPreview: (...args: unknown[]) => mockFetchImportPreview(...args),
  applyImport: (...args: unknown[]) => mockApplyImport(...args),
  fetchImportStatus: (...args: unknown[]) => mockFetchImportStatus(...args),
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    icon,
    loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    loading?: boolean;
  }) => (
    <button type="button" {...props}>
      {icon}
      {loading ? 'loading' : null}
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: ({
    checked,
    onChange,
    label,
    description,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: string;
    description?: string;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
      {description ? <span>{description}</span> : null}
    </label>
  ),
}));

import { ImportDialog } from '../../components/projects/ImportDialog';

function buildPreview(
  overrides: Partial<NonNullable<ImportPreviewResponse['preview']>> = {},
): NonNullable<ImportPreviewResponse['preview']> {
  return {
    valid: false,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {
      core: { added: 0, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
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
    ...overrides,
  };
}

async function uploadAblFile(
  container: HTMLElement,
  content = 'AGENT: Main\nGOAL: Help customers\n',
) {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected file input');
  }

  const user = userEvent.setup();
  const file = new File([content], 'main.abl', { type: 'text/plain' });
  await user.upload(input, file);
}

describe('ImportDialog', () => {
  beforeEach(() => {
    mockFetchImportPreview.mockReset();
    mockApplyImport.mockReset();
    mockFetchImportStatus.mockReset();
    mockToastError.mockReset();
  });

  it('renders preview error details when preview fails before a preview payload exists', async () => {
    mockFetchImportPreview.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'IMPORT_PREVIEW_TIMEOUT',
        message: 'Import preview timed out before validation completed.',
      },
      warnings: [],
    } satisfies Partial<ImportPreviewResponse>);

    const { container } = render(
      <ImportDialog open onClose={vi.fn()} projectId="proj-1" onImported={vi.fn()} />,
    );

    await uploadAblFile(container);

    await waitFor(() => {
      expect(mockFetchImportPreview).toHaveBeenCalledWith(
        'proj-1',
        {
          'main.abl': 'AGENT: Main\nGOAL: Help customers\n',
        },
        { deleteUnmatched: false },
      );
    });

    expect(
      screen.getByText('Import preview timed out before validation completed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('IMPORT_PREVIEW_TIMEOUT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply Import' })).not.toBeInTheDocument();
  });

  it('defaults to merge mode and explains that unrelated project content is kept', async () => {
    mockFetchImportPreview.mockResolvedValueOnce({
      success: true,
      warnings: [],
      previewDigest: 'digest-1',
      preview: buildPreview({
        valid: true,
        agentChanges: {
          added: ['Main'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      }),
    } satisfies ImportPreviewResponse);

    const { container } = render(
      <ImportDialog open onClose={vi.fn()} projectId="proj-1" onImported={vi.fn()} />,
    );

    expect(screen.getByText('Import mode')).toBeInTheDocument();
    expect(screen.getByText('Merge with existing project')).toBeInTheDocument();
    expect(
      screen.getByText('Matching records are updated and unrelated project content is kept.'),
    ).toBeInTheDocument();

    await uploadAblFile(container);

    await waitFor(() => {
      expect(mockFetchImportPreview).toHaveBeenCalledWith(
        'proj-1',
        {
          'main.abl': 'AGENT: Main\nGOAL: Help customers\n',
        },
        { deleteUnmatched: false },
      );
    });
  });

  it('passes replace mode through preview and apply when explicitly selected', async () => {
    mockFetchImportPreview.mockResolvedValueOnce({
      success: true,
      warnings: [],
      previewDigest: 'digest-1',
      preview: buildPreview({
        valid: true,
        agentChanges: {
          added: ['Main'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      }),
    } satisfies ImportPreviewResponse);
    mockApplyImport.mockResolvedValueOnce({
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
      entryAgentName: 'Main',
      warnings: [],
    });

    const { container } = render(
      <ImportDialog open onClose={vi.fn()} projectId="proj-1" onImported={vi.fn()} />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole('checkbox', { name: /Replace project contents/ }));
    await uploadAblFile(container);

    await waitFor(() => {
      expect(mockFetchImportPreview).toHaveBeenCalledWith(
        'proj-1',
        {
          'main.abl': 'AGENT: Main\nGOAL: Help customers\n',
        },
        { deleteUnmatched: true },
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply Import/ })).toBeEnabled();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /Apply Import/ }));

    await waitFor(() => {
      expect(mockApplyImport).toHaveBeenCalledWith(
        'proj-1',
        {
          'main.abl': 'AGENT: Main\nGOAL: Help customers\n',
        },
        {
          deleteUnmatched: true,
          bindingResolutions: {},
          previewDigest: 'digest-1',
          acknowledgedIssueIds: [],
          bindingResolutions: {},
        },
      );
    });
  });

  it('shows a top-level error summary and disables apply for partial preview failures', async () => {
    mockFetchImportPreview.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'IMPORT_PREVIEW_PARTIAL',
        message: 'Preview stopped after blocking validation issues were found.',
      },
      warnings: [],
      preview: buildPreview({
        agentChanges: {
          added: ['Main'],
          modified: [],
          removed: [],
          unchanged: [],
        },
        issues: [
          {
            id: 'issue-1',
            severity: 'error',
            blocking: true,
            category: 'syntax',
            message: 'Expected AGENT header as first non-comment line',
            file: 'agents/main.agent.abl',
            line: 1,
          },
        ],
        hasBlockingIssues: true,
        blockingIssueCount: 1,
        entryAgentResolution: {
          requested: 'Main',
          resolved: null,
          matchedBy: 'missing',
        },
      }),
    } satisfies Partial<ImportPreviewResponse>);

    const { container } = render(
      <ImportDialog open onClose={vi.fn()} projectId="proj-1" onImported={vi.fn()} />,
    );

    await uploadAblFile(container);

    await waitFor(() => {
      expect(
        screen.getByText('Preview stopped after blocking validation issues were found.'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('IMPORT_PREVIEW_PARTIAL')).toBeInTheDocument();
    expect(
      screen.getByText('agents/main.agent.abl:1: Expected AGENT header as first non-comment line'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply Import/ })).toBeDisabled();
  });

  it('surfaces apply-stage error details without dropping the retryable preview', async () => {
    mockFetchImportPreview.mockResolvedValueOnce({
      success: true,
      warnings: [],
      previewDigest: 'digest-1',
      preview: buildPreview({
        valid: true,
        agentChanges: {
          added: ['Main'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      }),
    } satisfies ImportPreviewResponse);

    mockApplyImport.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply.',
        stage: 'apply',
        sanitizedCause: 'Persistence operation failed',
      },
      warnings: ['Snapshot created'],
      operationId: 'import-op-1',
      previewDigest: 'digest-1',
      preview: buildPreview({
        valid: true,
        agentChanges: {
          added: ['Main'],
          modified: [],
          removed: [],
          unchanged: [],
        },
        warnings: ['Snapshot created'],
      }),
    });
    mockFetchImportStatus.mockResolvedValueOnce({
      success: true,
      data: {
        operationId: 'import-op-1',
        status: 'failed',
        layers: {
          core: { status: 'activated' },
          guardrails: { status: 'rolled_back' },
        },
        error: {
          phase: 'apply',
          layer: 'guardrails',
          message: 'Guardrail import failed',
        },
        createdAt: '2026-05-06T10:00:00.000Z',
        updatedAt: '2026-05-06T10:01:00.000Z',
      },
    });

    const { container } = render(
      <ImportDialog open onClose={vi.fn()} projectId="proj-1" onImported={vi.fn()} />,
    );

    await uploadAblFile(container);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply Import/ })).toBeEnabled();
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /Apply Import/ }));

    await waitFor(() => {
      expect(screen.getByText('Import failed during apply.')).toBeInTheDocument();
    });

    expect(screen.getByText('IMPORT_APPLY_FAILED')).toBeInTheDocument();
    expect(screen.getByText('apply')).toBeInTheDocument();
    expect(screen.getByText('Persistence operation failed')).toBeInTheDocument();
    expect(screen.getByText('Operation: import-op-1')).toBeInTheDocument();
    expect(screen.getByText('Status: failed')).toBeInTheDocument();
    expect(screen.getByText('core: activated')).toBeInTheDocument();
    expect(screen.getByText('guardrails: rolled_back')).toBeInTheDocument();
    expect(screen.getByText('Snapshot created')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply Import/ })).toBeEnabled();
    expect(mockToastError).toHaveBeenCalledWith(
      'IMPORT_APPLY_FAILED · apply: Import failed during apply.',
    );
  });
});
