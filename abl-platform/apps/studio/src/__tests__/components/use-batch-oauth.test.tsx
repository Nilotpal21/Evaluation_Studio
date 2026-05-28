import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBatchOAuth } from '../../hooks/useBatchOAuth';
import type { ConsentConnector } from '../../store/batch-consent-store';

const mockInitiateOAuth = vi.fn();
const mockHandleOAuthProfileCallback = vi.fn();

vi.mock('../../api/auth-profiles', () => ({
  initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
  handleOAuthProfileCallback: (...args: unknown[]) => mockHandleOAuthProfileCallback(...args),
  // ABLP-1123: workspace-surface stubs for mock-export-drift guard
  deleteAuthProfile: vi.fn(),
  deleteWorkspaceAuthProfile: vi.fn(),
  revokeWorkspaceAuthProfile: vi.fn(),
  fetchIntegrationProviders: vi.fn(),
  fetchWorkspaceIntegrationProviders: vi.fn(),
  fetchWorkspaceAuthProfiles: vi.fn(),
  // ABLP-1123 lifecycle UI: list-page disable toggle imports the update calls
  // and AuthProfileImpactModal transitively imports the consumer fetchers.
  updateAuthProfile: vi.fn(),
  updateWorkspaceAuthProfile: vi.fn(),
  fetchAuthProfileConsumers: vi.fn(),
  fetchWorkspaceAuthProfileConsumers: vi.fn(),
}));

function makeConnector(overrides: Partial<ConsentConnector> = {}): ConsentConnector {
  const authProfileRef = overrides.authProfileRef ?? 'google-creds';
  return {
    connector: 'google',
    requirementKey: overrides.requirementKey ?? authProfileRef,
    authProfileRef,
    connectionMode: 'per_user',
    status: 'pending',
    ...overrides,
  };
}

function createPopup(): Window {
  const popup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
  };
  return popup as unknown as Window;
}

describe('useBatchOAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('ignores callback messages with the wrong OAuth state', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'expected-state',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-1' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [makeConnector()],
      }),
    );

    act(() => {
      result.current.startOAuth('google-creds');
    });

    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledOnce());

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'wrong-code',
            state: 'unexpected-state',
          },
        }),
      );
    });

    expect(mockHandleOAuthProfileCallback).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'good-code',
            state: 'expected-state',
          },
        }),
      );
    });

    await waitFor(() =>
      expect(mockHandleOAuthProfileCallback).toHaveBeenCalledWith('proj-1', {
        code: 'good-code',
        state: 'expected-state',
      }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('google-creds'));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('rejects a second connector while another OAuth popup is active', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'state-1',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-1' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [
          makeConnector(),
          makeConnector({
            connector: 'salesforce',
            authProfileRef: 'salesforce-creds',
          }),
        ],
      }),
    );

    act(() => {
      result.current.startOAuth('google-creds');
    });

    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.startOAuth('salesforce-creds');
    });

    expect(onFailed).toHaveBeenCalledWith(
      'salesforce-creds',
      expect.stringContaining('Another authorization is already in progress'),
    );
    expect(mockInitiateOAuth).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'done-code',
            state: 'state-1',
          },
        }),
      );
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('google-creds'));
  });

  it('connectAll retries skipped connectors', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'skipped-state',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-2' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [makeConnector({ status: 'skipped' })],
      }),
    );

    act(() => {
      void result.current.connectAll();
    });

    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledOnce());
    expect(onAuthorizing).toHaveBeenCalledWith('google-creds');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'retry-code',
            state: 'skipped-state',
          },
        }),
      );
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('google-creds'));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('prefers a resolved auth profile id when initiating OAuth', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'profile-id-state',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-4' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [
          makeConnector({
            authProfileId: 'profile-123',
            environment: 'staging',
          }),
        ],
      }),
    );

    act(() => {
      result.current.startOAuth('google-creds');
    });

    await waitFor(() =>
      expect(mockInitiateOAuth).toHaveBeenCalledWith('proj-1', {
        connectorName: 'google',
        authProfileId: 'profile-123',
        isUserConsent: true,
      }),
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'done-code',
            state: 'profile-id-state',
          },
        }),
      );
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('google-creds'));
  });

  it('passes connector environment when initiating OAuth by auth profile reference', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'env-state',
      },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-3' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [makeConnector({ environment: 'staging' })],
      }),
    );

    act(() => {
      result.current.startOAuth('google-creds');
    });

    await waitFor(() =>
      expect(mockInitiateOAuth).toHaveBeenCalledWith('proj-1', {
        connectorName: 'google',
        authProfileRef: 'google-creds',
        environment: 'staging',
        isUserConsent: true,
      }),
    );
  });

  it('disambiguates same authProfileRef entries by environment during connectAll', async () => {
    const popupA = createPopup();
    const popupB = createPopup();
    vi.spyOn(window, 'open').mockReturnValueOnce(popupA).mockReturnValueOnce(popupB);
    mockInitiateOAuth
      .mockResolvedValueOnce({
        data: {
          authUrl: 'https://oauth.example.com/authorize-a',
          state: 'state-a',
        },
      })
      .mockResolvedValueOnce({
        data: {
          authUrl: 'https://oauth.example.com/authorize-b',
          state: 'state-b',
        },
      });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'token-profile-4' },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [
          makeConnector({
            requirementKey: 'shared-creds:staging',
            connector: 'salesforce',
            authProfileRef: 'shared-creds',
            environment: 'staging',
          }),
          makeConnector({
            requirementKey: 'shared-creds:production',
            connector: 'hubspot',
            authProfileRef: 'shared-creds',
            environment: 'production',
          }),
        ],
      }),
    );

    act(() => {
      void result.current.connectAll();
    });

    await waitFor(() =>
      expect(mockInitiateOAuth).toHaveBeenNthCalledWith(1, 'proj-1', {
        connectorName: 'salesforce',
        authProfileRef: 'shared-creds',
        environment: 'staging',
        isUserConsent: true,
      }),
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popupA as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'code-a',
            state: 'state-a',
          },
        }),
      );
    });

    await waitFor(() =>
      expect(mockInitiateOAuth).toHaveBeenNthCalledWith(2, 'proj-1', {
        connectorName: 'hubspot',
        authProfileRef: 'shared-creds',
        environment: 'production',
        isUserConsent: true,
      }),
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popupB as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'code-b',
            state: 'state-b',
          },
        }),
      );
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('skips second token exchange when callback page already exchanged', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authUrl: 'https://oauth.example.com/authorize',
        state: 'already-exchanged-state',
      },
    });

    const onAuthorizing = vi.fn();
    const onConnected = vi.fn();
    const onFailed = vi.fn();

    const { result } = renderHook(() =>
      useBatchOAuth({
        projectId: 'proj-1',
        onAuthorizing,
        onConnected,
        onFailed,
        connectors: [makeConnector()],
      }),
    );

    act(() => {
      result.current.startOAuth('google-creds');
    });

    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledOnce());

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as MessageEventSource,
          data: {
            type: 'auth-profile-oauth-callback',
            state: 'already-exchanged-state',
            exchanged: true,
            callbackResult: { id: 'token-profile-9' },
          },
        }),
      );
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('google-creds'));
    expect(mockHandleOAuthProfileCallback).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
