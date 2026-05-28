/**
 * RevokeUserTokensConfirm (FR-23, FR-24) — Unit Tests
 *
 * Tests blast-radius modal preview rendering, per-user toggle, confirm/cancel
 * button disabled states, error handling, and success flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RevokeUserTokensConfirm } from '@/components/auth-profiles/RevokeUserTokensConfirm';
import type { BlastRadiusPayload } from '@/api/auth-profiles';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRevokePreview = vi.fn();
const mockRevokeUserTokens = vi.fn();

vi.mock('@/api/auth-profiles', () => ({
  getRevokePreview: (...args: unknown[]) => mockGetRevokePreview(...args),
  revokeUserTokens: (...args: unknown[]) => mockRevokeUserTokens(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreview(overrides: Partial<BlastRadiusPayload> = {}): { data: BlastRadiusPayload } {
  return {
    data: {
      type: 'tokens',
      affectedConsumers: {
        tools: 0,
        integrationNodes: 0,
        mcpServers: 0,
        a2aServers: 0,
        connectorConnections: 0,
        channelConnections: 0,
        serviceNodes: 0,
        gitIntegrations: 0,
        triggerRegistrations: 0,
      },
      affectedUsers: 5,
      activeSessions: 12,
      cascadeDeletesTokens: 3,
      ...overrides,
    },
  };
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onRevoked: vi.fn(),
  projectId: 'proj-1',
  profileId: 'prof-1',
  profileName: 'Test OAuth App',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RevokeUserTokensConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRevokePreview.mockResolvedValue(makePreview());
    mockRevokeUserTokens.mockResolvedValue({ success: true });
  });

  // =========================================================================
  // Preview loading and display
  // =========================================================================

  describe('Preview display', () => {
    it('loads and displays blast-radius preview on open', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      // Should call preview API
      expect(mockGetRevokePreview).toHaveBeenCalledWith('proj-1', 'prof-1', 'tokens', undefined);

      // Wait for preview to render
      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      expect(screen.getByText('12')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows loading indicator while preview is being fetched', () => {
      // Make the preview hang
      mockGetRevokePreview.mockReturnValue(new Promise(() => {}));

      render(<RevokeUserTokensConfirm {...defaultProps} />);

      expect(screen.getByText('Loading impact preview...')).toBeInTheDocument();
    });

    it('shows error state when preview fails', async () => {
      mockGetRevokePreview.mockRejectedValue(new Error('Network error'));

      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load impact preview')).toBeInTheDocument();
      });
    });

    it('does not show cascade deletes when count is 0', async () => {
      mockGetRevokePreview.mockResolvedValue(makePreview({ cascadeDeletesTokens: 0 }));

      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      // The cascade tokens label should not appear
      expect(screen.queryByText('Tokens to be deleted')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Per-user toggle
  // =========================================================================

  describe('Per-user toggle', () => {
    it('shows per-user toggle that is off by default', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('shows user ID input when per-user toggle is enabled', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      // Enable per-user mode
      fireEvent.click(screen.getByRole('switch'));

      expect(screen.getByPlaceholderText('Enter user ID to revoke tokens for')).toBeInTheDocument();
    });

    it('re-fetches preview with userId when per-user toggle is on and userId entered', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      mockGetRevokePreview.mockClear();
      mockGetRevokePreview.mockResolvedValue(makePreview({ affectedUsers: 1, activeSessions: 3 }));

      // Enable per-user mode
      fireEvent.click(screen.getByRole('switch'));

      // Enter user ID to revoke tokens for
      fireEvent.change(screen.getByPlaceholderText('Enter user ID to revoke tokens for'), {
        target: { value: 'user-42' },
      });

      await waitFor(() => {
        expect(mockGetRevokePreview).toHaveBeenCalledWith('proj-1', 'prof-1', 'tokens', 'user-42');
      });
    });

    it('disables confirm button when per-user mode is on but userId is empty', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      // Enable per-user mode (no user ID entered)
      fireEvent.click(screen.getByRole('switch'));

      const confirmButton = screen.getByRole('button', {
        name: 'Revoke Tokens',
      });
      expect(confirmButton).toBeDisabled();
    });
  });

  // =========================================================================
  // Confirm / Cancel actions
  // =========================================================================

  describe('Confirm and cancel', () => {
    it('disables confirm button while preview is loading', () => {
      mockGetRevokePreview.mockReturnValue(new Promise(() => {}));

      render(<RevokeUserTokensConfirm {...defaultProps} />);

      const confirmButton = screen.getByRole('button', {
        name: 'Revoke Tokens',
      });
      expect(confirmButton).toBeDisabled();
    });

    it('disables confirm button when preview has error', async () => {
      mockGetRevokePreview.mockRejectedValue(new Error('fail'));

      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load impact preview')).toBeInTheDocument();
      });

      const confirmButton = screen.getByRole('button', {
        name: 'Revoke Tokens',
      });
      expect(confirmButton).toBeDisabled();
    });

    it('calls revokeUserTokens on confirm and triggers onRevoked', async () => {
      const onRevoked = vi.fn();

      render(<RevokeUserTokensConfirm {...defaultProps} onRevoked={onRevoked} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Revoke Tokens' }));

      await waitFor(() => {
        expect(mockRevokeUserTokens).toHaveBeenCalledWith('proj-1', 'prof-1', undefined);
      });

      await waitFor(() => {
        expect(onRevoked).toHaveBeenCalledTimes(1);
      });
    });

    it('passes userId to revokeUserTokens when per-user mode is active', async () => {
      render(<RevokeUserTokensConfirm {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      // Enable per-user, enter user ID
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.change(screen.getByPlaceholderText('Enter user ID to revoke tokens for'), {
        target: { value: 'user-99' },
      });

      // Wait for the re-fetch caused by the userId change
      await waitFor(() => {
        expect(mockGetRevokePreview).toHaveBeenCalledWith('proj-1', 'prof-1', 'tokens', 'user-99');
      });

      fireEvent.click(screen.getByRole('button', { name: 'Revoke Tokens' }));

      await waitFor(() => {
        expect(mockRevokeUserTokens).toHaveBeenCalledWith('proj-1', 'prof-1', 'user-99');
      });
    });

    it('calls onClose when cancel is clicked', async () => {
      const onClose = vi.fn();

      render(<RevokeUserTokensConfirm {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Closed state
  // =========================================================================

  describe('Closed dialog', () => {
    it('does not load preview when dialog is closed', () => {
      render(<RevokeUserTokensConfirm {...defaultProps} open={false} />);

      expect(mockGetRevokePreview).not.toHaveBeenCalled();
    });
  });
});
