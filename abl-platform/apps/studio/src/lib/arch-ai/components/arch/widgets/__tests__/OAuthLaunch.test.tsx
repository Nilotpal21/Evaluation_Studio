import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OAuthLaunch, type OAuthLaunchInput } from '../OAuthLaunch';
import { useBatchOAuth } from '@/hooks/useBatchOAuth';

// External hook mock — UI-level test boundary. The hook wraps real
// browser popup machinery; widget-rendering tests must not exercise it.
vi.mock('@/hooks/useBatchOAuth', () => ({
  useBatchOAuth: vi.fn(),
}));

const baseInput: OAuthLaunchInput = {
  widgetType: 'OAuthLaunch',
  authProfileId: 'ap_1',
  authProfileRef: 'authprofile:ap_1',
  connectorName: 'slack',
  connectionMode: 'per_user',
  scopes: ['chat:write'],
  providerLabel: 'Slack',
  requirementKey: 'slack-oauth-1',
};

interface HookCallbacks {
  onAuthorizing: (key: string) => void;
  onConnected: (key: string) => void;
  onFailed: (key: string, error: string) => void;
}

function installHookCapture(): { callbacks: HookCallbacks; startOAuth: ReturnType<typeof vi.fn> } {
  const captured: { current: HookCallbacks | null } = { current: null };
  const startOAuth = vi.fn();
  vi.mocked(useBatchOAuth).mockImplementation((options) => {
    captured.current = {
      onAuthorizing: options.onAuthorizing,
      onConnected: options.onConnected,
      onFailed: options.onFailed,
    };
    return {
      startOAuth,
      connectAll: vi.fn(),
      isConnecting: false,
    };
  });
  return {
    get callbacks() {
      if (!captured.current) throw new Error('hook callbacks not captured yet');
      return captured.current;
    },
    startOAuth,
  } as unknown as { callbacks: HookCallbacks; startOAuth: ReturnType<typeof vi.fn> };
}

describe('OAuthLaunch widget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the connect button labeled with the provider name', () => {
    installHookCapture();
    render(<OAuthLaunch input={baseInput} onSubmit={vi.fn()} projectId="proj_1" />);
    expect(screen.getByRole('button', { name: /connect to slack/i })).toBeTruthy();
    expect(document.querySelector('[data-widget="OAuthLaunch"]')).toBeTruthy();
  });

  it('starts OAuth on click and forwards a connected answer', async () => {
    const onSubmit = vi.fn();
    const handle = installHookCapture();

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} projectId="proj_1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect to slack/i }));

    await waitFor(() => expect(handle.startOAuth).toHaveBeenCalledWith('slack-oauth-1'));

    act(() => {
      handle.callbacks.onAuthorizing('slack-oauth-1');
      handle.callbacks.onConnected('slack-oauth-1');
    });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' })),
    );
  });

  it('forwards canceled status when popup is dismissed', async () => {
    const onSubmit = vi.fn();
    const handle = installHookCapture();

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} projectId="proj_1" />);
    fireEvent.click(screen.getByRole('button'));

    act(() => {
      handle.callbacks.onFailed(
        'slack-oauth-1',
        'Authorization window was closed before completion',
      );
    });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'canceled' })),
    );
  });

  it('forwards failed status with the error message on real failure', async () => {
    const onSubmit = vi.fn();
    const handle = installHookCapture();

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} projectId="proj_1" />);
    fireEvent.click(screen.getByRole('button'));

    act(() => {
      handle.callbacks.onFailed('slack-oauth-1', 'token exchange returned 500');
    });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'token exchange returned 500',
        }),
      ),
    );
  });

  it('only submits once even if callbacks fire repeatedly', async () => {
    const onSubmit = vi.fn();
    const handle = installHookCapture();

    render(<OAuthLaunch input={baseInput} onSubmit={onSubmit} projectId="proj_1" />);
    fireEvent.click(screen.getByRole('button'));

    act(() => {
      handle.callbacks.onConnected('slack-oauth-1');
      handle.callbacks.onConnected('slack-oauth-1');
      handle.callbacks.onFailed('slack-oauth-1', 'late failure');
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' }));
  });
});
