/**
 * ToolPickerDialog – Project Tools Tests
 *
 * @vitest-environment happy-dom
 *
 * Verifies that project tools are inserted using their full DSL signature
 * instead of the legacy name-only snippet.
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockFetchTools = vi.fn();

vi.mock('../../api/tools', () => ({
  fetchTools: (...args: unknown[]) => mockFetchTools(...args),
}));

vi.mock('../../hooks/useImportedSymbols', () => ({
  useImportedSymbols: () => ({
    agents: [],
    tools: [],
    hasDependencies: false,
  }),
}));

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({
    open,
    onClose,
    title,
    description,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    title?: string;
    description?: string;
    children: React.ReactNode;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="dialog" role="dialog">
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
        <button data-testid="dialog-close" onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('../../components/tools/ToolTypeBadge', () => ({
  ToolTypeBadge: ({ type }: { type: string }) => <span data-testid="tool-type-badge">{type}</span>,
}));

import { ToolPickerDialog } from '../../components/abl/ToolPickerDialog';

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  projectId: 'proj-123',
  onInsert: vi.fn(),
};

function renderPicker(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return { ...render(<ToolPickerDialog {...props} />), props };
}

describe('ToolPickerDialog — Project Tools', () => {
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
          dslContent: `check_refund_eligibility(order_id: string) -> {eligible: boolean, reason: string, window_days_remaining: number}
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
    fireEvent.click(screen.getByRole('button', { name: /insert/i }));

    expect(props.onInsert).toHaveBeenCalledWith(
      `  check_refund_eligibility(order_id: string) -> {eligible: boolean, reason: string, window_days_remaining: number}
    description: "Look up refund eligibility for an order"
    type: http`,
    );
    expect(props.onClose).toHaveBeenCalled();
  });
});
