/**
 * ConnectionExpandPanel Component Tests
 *
 * Tests for the inline expand panel showing connection details,
 * status, and action buttons (test/edit/disconnect).
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// lucide-react and framer-motion are mocked globally in setup.tsx

// API mocks
const mockTestConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockUpdateConnection = vi.fn();

vi.mock('../api/connections', () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
}));

// sanitize-error mock — returns fallback string
vi.mock('../lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// UI component mocks
vi.mock('../components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    variant,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: string;
    [key: string]: unknown;
  }) =>
    React.createElement(
      'button',
      {
        onClick,
        disabled: disabled || loading,
        'data-loading': loading ? 'true' : undefined,
        'data-variant': variant,
        ...rest,
      },
      children,
    ),
}));

vi.mock('../components/ui/Input', () => ({
  Input: ({
    label,
    value,
    onChange,
    ...rest
  }: {
    label?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    [key: string]: unknown;
  }) =>
    React.createElement('div', null, [
      label ? React.createElement('label', { key: 'label' }, label) : null,
      React.createElement('input', {
        key: 'input',
        value,
        onChange,
        'aria-label': label,
        ...rest,
      }),
    ]),
}));

vi.mock('../components/ui/Badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { ConnectionExpandPanel } from '../components/connections/ConnectionExpandPanel';
import type { ConnectionSummary } from '../api/connections';

// =============================================================================
// TEST DATA
// =============================================================================

const defaultConnection: ConnectionSummary = {
  id: 'conn-1',
  connectorName: 'slack',
  displayName: 'My Slack Connection',
  scope: 'tenant',
  authProfileId: 'ap-1',
  status: 'active',
  createdAt: '2026-01-15T10:00:00Z',
  updatedAt: '2026-03-20T14:30:00Z',
};

const defaultProps = {
  connection: defaultConnection,
  projectId: 'proj-1',
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
};

// =============================================================================
// TESTS
// =============================================================================

describe('ConnectionExpandPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 1. View mode renders info
  // ---------------------------------------------------------------------------
  it('renders status badge and created date in view mode', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    // Status badge
    expect(screen.getByText('active')).toBeDefined();

    // Formatted created date: Jan 15, 2026
    expect(screen.getByText('Jan 15, 2026')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. View mode shows action buttons
  // ---------------------------------------------------------------------------
  it('shows Test Connection, Edit, and Disconnect buttons in view mode', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    expect(screen.getByText('Test Connection')).toBeDefined();
    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3. Test Connection - success
  // ---------------------------------------------------------------------------
  it('shows "Connected" after successful test, then reverts to idle after 2s', async () => {
    mockTestConnection.mockResolvedValue({ success: true });

    render(<ConnectionExpandPanel {...defaultProps} />);

    fireEvent.click(screen.getByText('Test Connection'));

    await vi.waitFor(() => {
      expect(screen.getByText('Connected')).toBeDefined();
    });

    expect(mockTestConnection).toHaveBeenCalledWith('proj-1', 'conn-1');

    // Advance timers to trigger the 2s reset
    vi.advanceTimersByTime(2000);

    await vi.waitFor(() => {
      expect(screen.getByText('Test Connection')).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Test Connection - error
  // ---------------------------------------------------------------------------
  it('shows "Failed" and error text after test connection error, reverts after 3s', async () => {
    mockTestConnection.mockRejectedValue(new Error('Network error'));

    render(<ConnectionExpandPanel {...defaultProps} />);

    fireEvent.click(screen.getByText('Test Connection'));

    await vi.waitFor(() => {
      expect(screen.getByText('Failed')).toBeDefined();
    });

    // The sanitizeError mock returns the fallback string
    expect(screen.getByText('Connection test failed')).toBeDefined();

    // Advance timers to trigger the 3s reset
    vi.advanceTimersByTime(3000);

    await vi.waitFor(() => {
      expect(screen.getByText('Test Connection')).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Edit mode
  // ---------------------------------------------------------------------------
  it('shows name input with current displayName plus Save and Cancel buttons in edit mode', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    fireEvent.click(screen.getByText('Edit'));

    // Input with label "Connection name"
    expect(screen.getByText('Connection name')).toBeDefined();

    // Input value should be the current displayName
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('My Slack Connection');

    // Save and Cancel buttons
    expect(screen.getByText('Save')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 6. Edit - save calls updateConnection
  // ---------------------------------------------------------------------------
  it('calls updateConnection with new name and onUpdated on save', async () => {
    mockUpdateConnection.mockResolvedValue({ success: true });

    render(<ConnectionExpandPanel {...defaultProps} />);

    // Enter edit mode
    fireEvent.click(screen.getByText('Edit'));

    // Change the name
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed Connection' } });

    // Click Save
    fireEvent.click(screen.getByText('Save'));

    await vi.waitFor(() => {
      expect(mockUpdateConnection).toHaveBeenCalledWith('proj-1', 'conn-1', {
        displayName: 'Renamed Connection',
      });
    });

    expect(defaultProps.onUpdated).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 7. Edit - cancel returns to view
  // ---------------------------------------------------------------------------
  it('returns to view mode with original name when edit is cancelled', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    // Enter edit mode
    fireEvent.click(screen.getByText('Edit'));

    // Change the name
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Changed Name' } });

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Should be back in view mode with action buttons
    expect(screen.getByText('Test Connection')).toBeDefined();
    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 8. Disconnect flow
  // ---------------------------------------------------------------------------
  it('shows confirmation text with connection name and Disconnect/Cancel buttons', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    fireEvent.click(screen.getByText('Disconnect'));

    expect(
      screen.getByText('Disconnect My Slack Connection? This cannot be undone.'),
    ).toBeDefined();

    // Disconnect (danger) and Cancel buttons in confirm mode
    const disconnectBtn = screen.getByText('Disconnect');
    expect(disconnectBtn).toBeDefined();
    expect(disconnectBtn.getAttribute('data-variant')).toBe('danger');

    expect(screen.getByText('Cancel')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 9. Disconnect - confirm calls deleteConnection
  // ---------------------------------------------------------------------------
  it('calls deleteConnection and onDeleted when disconnect is confirmed', async () => {
    mockDeleteConnection.mockResolvedValue({ success: true });

    render(<ConnectionExpandPanel {...defaultProps} />);

    // Enter confirm-disconnect mode
    fireEvent.click(screen.getByText('Disconnect'));

    // Click the danger Disconnect button
    const disconnectBtn = screen.getByText('Disconnect');
    fireEvent.click(disconnectBtn);

    await vi.waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith('proj-1', 'conn-1');
    });

    expect(defaultProps.onDeleted).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 10. Disconnect - cancel returns to view
  // ---------------------------------------------------------------------------
  it('returns to view mode when disconnect cancel is clicked', () => {
    render(<ConnectionExpandPanel {...defaultProps} />);

    // Enter confirm-disconnect mode
    fireEvent.click(screen.getByText('Disconnect'));

    // Verify we are in confirm mode
    expect(
      screen.getByText('Disconnect My Slack Connection? This cannot be undone.'),
    ).toBeDefined();

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Should be back in view mode
    expect(screen.getByText('Test Connection')).toBeDefined();
    expect(screen.getByText('Edit')).toBeDefined();
  });
});
