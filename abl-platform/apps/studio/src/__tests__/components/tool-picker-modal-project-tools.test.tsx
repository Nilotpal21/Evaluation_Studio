/**
 * ToolPickerModal - Project Tools Tests
 *
 * @vitest-environment happy-dom
 *
 * Locks the command-palette picker to the same DSL-preserving insertion
 * behavior as the legacy toolbar picker.
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockFetchTools = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('../../api/tools', () => ({
  fetchTools: (...args: unknown[]) => mockFetchTools(...args),
}));

vi.mock('../../hooks/use-features', () => ({
  useFeatures: () => ({ hasCodeTools: true }),
}));

vi.mock('../../components/tools/ToolTypeBadge', () => ({
  ToolTypeBadge: ({ type }: { type: string }) => <span data-testid="tool-type-badge">{type}</span>,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/abl/pickers/BasePickerModal', () => ({
  BasePickerModal: ({
    open,
    items,
    renderPreview,
  }: {
    open: boolean;
    items: Array<unknown>;
    renderPreview: (item: unknown | null) => React.ReactNode;
  }) => {
    if (!open) return null;
    return <div role="dialog">{renderPreview(items[0] ?? null)}</div>;
  },
}));

import { ToolPickerModal } from '../../components/abl/pickers/ToolPickerModal';

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  projectId: 'proj-123',
  onInsert: vi.fn(),
};

function renderPicker(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return { ...render(<ToolPickerModal {...props} />), props };
}

describe('ToolPickerModal - Project Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchTools.mockResolvedValue({ data: [] });
  });

  it('inserts the full tool signature from project tool DSL', async () => {
    mockFetchTools.mockResolvedValue({
      data: [
        {
          id: 'tool-1',
          name: 'check_refund_eligibility',
          slug: 'check-refund-eligibility',
          toolType: 'http',
          description: 'Look up refund eligibility for an order',
          dslContent: `check_refund_eligibility(order_id: string) -> {eligible: boolean, reason: string}
  description: "Look up refund eligibility for an order"
  type: http`,
          sourceHash: 'hash-1',
          variableNamespaceIds: [],
          projectId: 'proj-123',
          createdBy: 'user-1',
          lastEditedBy: null,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
    });

    const { props } = renderPicker();

    await screen.findByRole('dialog');
    await waitFor(() => {
      expect(screen.getByText(/check_refund_eligibility\(order_id: string\)/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'insert_tool' }));

    expect(props.onInsert).toHaveBeenCalledWith(
      `  check_refund_eligibility(order_id: string) -> {eligible: boolean, reason: string}
    description: "Look up refund eligibility for an order"
    type: http`,
    );
    expect(props.onClose).toHaveBeenCalled();
  });
});
