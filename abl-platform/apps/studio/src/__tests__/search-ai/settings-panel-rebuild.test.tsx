/**
 * SettingsPanel rebuild regression test
 *
 * Verifies that rebuild is available from the currently mounted KB settings
 * panel and refreshes the KB detail state after the rebuild starts.
 */

import type { PropsWithChildren } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KnowledgeBaseDetail } from '../../api/search-ai';

const mockRebuildKnowledgeBase = vi.fn();
const mockDeleteKnowledgeBase = vi.fn();
const mockNavigate = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      'search_ai.settings.title': 'Settings',
      'search_ai.settings_danger.title': 'Danger Zone',
      'search_ai.settings_danger.rebuild_title': 'Rebuild Index',
      'search_ai.settings_danger.rebuild_desc':
        'Re-process all documents and rebuild the search index.',
      'search_ai.settings_danger.rebuild_button': 'Rebuild',
      'search_ai.settings_danger.delete_title': 'Delete Knowledge Base',
      'search_ai.settings_danger.delete_desc':
        'Permanently delete this knowledge base and all associated data.',
      'search_ai.settings_danger.delete_button': 'Delete',
      'search_ai.settings_danger.rebuild_confirm_title': 'Rebuild Index',
      'search_ai.settings_danger.rebuild_confirm_desc':
        'This will rebuild the entire index from scratch. Existing search results may be unavailable during the rebuild.',
      'search_ai.settings_danger.rebuild_confirm_label': 'Rebuild',
      'search_ai.settings_danger.delete_confirm_title': 'Delete Knowledge Base',
      'search_ai.settings_danger.delete_confirm_desc': `Delete "${params?.name ?? ''}"`,
      'search_ai.settings_danger.delete_confirm_label': 'Delete',
      'search_ai.settings_danger.toast_rebuild_started': 'Index rebuild started',
      'search_ai.settings_danger.toast_deleted': 'Knowledge base deleted',
      'search_ai.settings_danger.error_operation_failed': 'Operation failed',
    };
    return messages[`${namespace}.${key}`] ?? `${namespace}.${key}`;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({
    projectId: 'proj-1',
    navigate: mockNavigate,
  }),
}));

vi.mock('../../components/ui/SlidePanel', () => ({
  SlidePanel: ({ open, title, children }: PropsWithChildren<{ open: boolean; title: string }>) =>
    open ? (
      <div data-testid="slide-panel">
        <div>{title}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock('../../components/search-ai/settings/GeneralSection', () => ({
  GeneralSection: () => <div data-testid="general-section" />,
}));

vi.mock('../../components/search-ai/settings/IndexConfigSection', () => ({
  IndexConfigSection: () => <div data-testid="index-config-section" />,
}));

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
    onClose,
    confirmLabel,
  }: PropsWithChildren<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: string;
  }>) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{description}</div>
        <button onClick={onClose}>Cancel</button>
        <button onClick={onConfirm}>{confirmLabel ?? 'Confirm'}</button>
      </div>
    ) : null,
}));

vi.mock('../../api/search-ai', async () => {
  const actual = await vi.importActual<typeof import('../../api/search-ai')>('../../api/search-ai');
  return {
    ...actual,
    rebuildKnowledgeBase: (...args: unknown[]) => mockRebuildKnowledgeBase(...args),
    deleteKnowledgeBase: (...args: unknown[]) => mockDeleteKnowledgeBase(...args),
  };
});

import { SettingsPanel } from '../../components/search-ai/settings/SettingsPanel';

function getButtonByText(label: string) {
  const button = screen.getByText(label).closest('button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function makeKnowledgeBase(overrides: Partial<KnowledgeBaseDetail> = {}): KnowledgeBaseDetail {
  return {
    _id: 'kb-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Support Docs',
    description: 'Customer support documentation',
    status: 'ready',
    searchIndexId: 'idx-1',
    canonicalSchemaId: 'schema-1',
    connectorCount: 2,
    documentCount: 42,
    lastIndexedAt: '2025-01-01T00:00:00.000Z',
    indexError: null,
    isPublic: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    index: null,
    ...overrides,
  };
}

describe('SettingsPanel rebuild flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRebuildKnowledgeBase.mockResolvedValue({ message: 'started', status: 'rebuilding' });
    mockDeleteKnowledgeBase.mockResolvedValue({ deleted: true });
  });

  it('rebuilds from the mounted settings panel and refreshes the KB detail view', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <SettingsPanel
        open
        onClose={vi.fn()}
        knowledgeBase={makeKnowledgeBase()}
        onRefresh={onRefresh}
      />,
    );

    const rebuildButton = getButtonByText('Rebuild');
    expect(rebuildButton).not.toBeDisabled();

    await user.click(rebuildButton);

    const dialog = screen.getByTestId('confirm-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rebuild' }));

    await waitFor(() => {
      expect(mockRebuildKnowledgeBase).toHaveBeenCalledWith('kb-1');
    });
    expect(onRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('Index rebuild started');
  });
});
