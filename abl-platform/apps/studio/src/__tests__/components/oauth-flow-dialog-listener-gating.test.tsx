/**
 * OAuthFlowDialog — listener-gating regression coverage.
 *
 * Background: AuthProfileOAuthDialog and OAuthFlowDialog both subscribe to the
 * same `auth-profile-oauth-callback` postMessage type. When both components
 * were mounted simultaneously (auth-profiles page + connections create modal),
 * a single popup callback fanned out to both listeners → two concurrent
 * callback API calls → the first consumed the OAuth state via Redis GETDEL
 * (201), the second received `INVALID_STATE` (400).
 *
 * Fix: each dialog now only registers the message listener while `open=true`.
 * This test asserts that a closed OAuthFlowDialog does NOT trigger an
 * `apiFetch` to the callback endpoint when a postMessage arrives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { OAuthFlowDialog } from '@/components/connections/OAuthFlowDialog';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const baseConnector = {
  name: 'gmail',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
  displayName: 'Gmail',
};

function dispatchCallback(): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'auth-profile-oauth-callback',
        code: 'auth-code-1',
        state: 'state-1',
      },
    }),
  );
}

describe('OAuthFlowDialog — listener gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT POST to the callback endpoint when open=false', async () => {
    render(
      <OAuthFlowDialog
        open={false}
        connector={baseConnector}
        projectId="proj-1"
        authProfileId="profile-1"
        onSuccess={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    dispatchCallback();
    // Give any errant async work a chance to execute.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('removes the listener when transitioning open=true → open=false', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <OAuthFlowDialog
        open={true}
        connector={baseConnector}
        projectId="proj-1"
        authProfileId="profile-1"
        onSuccess={onSuccess}
        onClose={onClose}
      />,
    );

    // Close the dialog — listener should be detached on cleanup.
    rerender(
      <OAuthFlowDialog
        open={false}
        connector={baseConnector}
        projectId="proj-1"
        authProfileId="profile-1"
        onSuccess={onSuccess}
        onClose={onClose}
      />,
    );

    dispatchCallback();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
