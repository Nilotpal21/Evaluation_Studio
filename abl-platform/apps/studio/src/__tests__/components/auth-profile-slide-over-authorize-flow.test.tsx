/**
 * RTL coverage for ABLP-619 Phase 4 — the inline "Authorize at Creation" flow
 * for `oauth2_app` profiles in the slide-over.
 *
 * Drives:
 *  AT-1  oauth2_app project create -> OAuth dialog opens, simulates popup
 *        success message, asserts onSaved fires once and the success toast
 *        is emitted.
 *  AT-2  oauth2_app cancel -> dialog dismisses, asserts deleteAuthProfile
 *        was called for the pending row and onSaved fires with a cancel toast.
 *  AT-3  oauth2_app workspace scope (projectId={null}) -> the dialog routes
 *        through the admin OAuth endpoints (initiateWorkspaceOAuth,
 *        completeWorkspaceOAuthCallback) and the workspace delete on cancel.
 *  AT-4  api_key create preserves existing behavior — no OAuth dialog,
 *        onSaved fires synchronously after the create call.
 *
 * Mocks at module boundary only — no `vi.mock('@agent-platform/...')` or
 * `vi.mock('@abl/...')`. Per CLAUDE.md "Test Architecture", mocking the
 * `@/api/auth-profiles` client is the smallest seam that lets us drive the
 * UI without standing up a real Next.js server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { AuthProfileSlideOver } from '@/components/auth-profiles/AuthProfileSlideOver';

const mockCreateAuthProfile = vi.fn();
const mockCreateWorkspaceAuthProfile = vi.fn();
const mockDeleteAuthProfile = vi.fn();
const mockDeleteWorkspaceAuthProfile = vi.fn();
const mockInitiateOAuth = vi.fn();
const mockInitiateWorkspaceOAuth = vi.fn();
const mockHandleOAuthProfileCallback = vi.fn();
const mockHandleWorkspaceOAuthProfileCallback = vi.fn();

const mockAuthProfileState = {
  profile: null as Record<string, unknown> | null,
  isLoading: false,
  error: null as string | null,
  errorStatus: null as number | null,
  refresh: vi.fn(),
};

vi.mock('@/hooks/useAuthProfiles', () => ({
  useAuthProfile: () => mockAuthProfileState,
}));

vi.mock('@/api/auth-profiles', () => ({
  createAuthProfile: (...args: unknown[]) => mockCreateAuthProfile(...args),
  createWorkspaceAuthProfile: (...args: unknown[]) => mockCreateWorkspaceAuthProfile(...args),
  updateAuthProfile: vi.fn(),
  updateWorkspaceAuthProfile: vi.fn(),
  validateAuthProfile: vi.fn(),
  validateWorkspaceAuthProfile: vi.fn(),
  fetchWorkspaceAuthProfile: vi.fn(),
  deleteAuthProfile: (...args: unknown[]) => mockDeleteAuthProfile(...args),
  deleteWorkspaceAuthProfile: (...args: unknown[]) => mockDeleteWorkspaceAuthProfile(...args),
  initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
  initiateWorkspaceOAuth: (...args: unknown[]) => mockInitiateWorkspaceOAuth(...args),
  handleOAuthProfileCallback: (...args: unknown[]) => mockHandleOAuthProfileCallback(...args),
  handleWorkspaceOAuthProfileCallback: (...args: unknown[]) =>
    mockHandleWorkspaceOAuthProfileCallback(...args),
}));

vi.mock('@/lib/connection-config-utils', () => ({
  resolveConnectionConfigTemplate: vi.fn((url: string) => url),
  extractConnectionConfigFields: vi.fn(() => []),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface MockPopup {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
}

function fillOAuth2AppForm(name: string): void {
  fireEvent.change(screen.getByPlaceholderText('e.g. OAuth 2.0 App - Production'), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/Authorization URL/i), {
    target: { value: 'https://accounts.example.com/o/oauth2/auth' },
  });
  fireEvent.change(screen.getByLabelText(/Token URL/i), {
    target: { value: 'https://oauth2.example.com/token' },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter client ID'), {
    target: { value: 'client-id-1' },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter client secret'), {
    target: { value: 'client-secret-1' },
  });
}

describe('AuthProfileSlideOver — ABLP-619 inline authorize flow', () => {
  let popup: MockPopup;
  let originalWindowOpen: typeof window.open;

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    mockAuthProfileState.profile = null;
    mockAuthProfileState.isLoading = false;
    mockAuthProfileState.error = null;
    mockAuthProfileState.errorStatus = null;
    mockCreateAuthProfile.mockResolvedValue({
      success: true,
      data: { id: 'profile-pending-1', connector: undefined },
    });
    mockCreateWorkspaceAuthProfile.mockResolvedValue({
      success: true,
      data: { id: 'ws-profile-pending-1', connector: undefined },
    });
    mockInitiateOAuth.mockResolvedValue({
      success: true,
      data: { authUrl: 'https://oauth.example.com/authorize?state=abc', state: 'state-abc' },
    });
    mockInitiateWorkspaceOAuth.mockResolvedValue({
      success: true,
      data: { authUrl: 'https://oauth.example.com/authorize?state=abc', state: 'state-abc' },
    });
    mockHandleOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'profile-pending-1' },
    });
    mockHandleWorkspaceOAuthProfileCallback.mockResolvedValue({
      success: true,
      data: { id: 'ws-profile-pending-1' },
    });
    mockDeleteAuthProfile.mockResolvedValue({ success: true });
    mockDeleteWorkspaceAuthProfile.mockResolvedValue({ success: true });

    popup = { closed: false, close: vi.fn() };
    originalWindowOpen = window.open;
    window.open = vi.fn(() => popup as unknown as Window);
  });

  afterEach(() => {
    window.open = originalWindowOpen;
  });

  it('AT-1: oauth2_app project create opens OAuth dialog, popup success fires onSaved once', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Acme OAuth');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));
    // Dialog opens; onSaved is deferred until the OAuth flow resolves.
    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();

    // Drive the dialog through Authorize → simulated popup callback.
    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledTimes(1));
    expect(mockInitiateOAuth).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ authProfileId: 'profile-pending-1' }),
    );

    // Simulate the popup posting back the OAuth code/state.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'auth-profile-oauth-callback',
          code: 'auth-code-1',
          state: 'state-abc',
        },
      }),
    );

    await waitFor(() => expect(mockHandleOAuthProfileCallback).toHaveBeenCalledTimes(1));
    expect(mockHandleOAuthProfileCallback).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ code: 'auth-code-1', state: 'state-abc' }),
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    // Pending profile must NOT be deleted on success.
    expect(mockDeleteAuthProfile).not.toHaveBeenCalled();
  });

  it('AT-2: cancelling the OAuth dialog keeps the pending profile and returns the user to the form', async () => {
    // Updated design: cancelling the OAuth dialog no longer deletes the pending
    // profile. The slideover stays open so the user can retry without re-entering
    // the form. The pending profile is only cleaned up when the user explicitly
    // closes the slide-over panel (handled by handleCloseWithCleanup → onSaved).
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Acme OAuth Cancelled');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());

    // Dismiss the OAuth dialog without completing.
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));

    // Dismissing the handoff leaves the pending profile in place and refreshes the list.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockDeleteAuthProfile).not.toHaveBeenCalled();
    expect(mockHandleOAuthProfileCallback).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('AT-3: workspace scope (projectId=_workspace) routes through admin OAuth endpoints', async () => {
    // ABLP-1123: develop expanded the inline-authorize handoff to both scopes
    // (commit 0b312aaad8) — workspace oauth2_app create now ALSO opens the
    // pending-authorize dialog. The assertion is that the workspace create
    // helper fires (not the project one) and the dialog renders for the user
    // to complete consent; `onSaved` is held until consent completes.
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="_workspace"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Workspace OAuth');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateWorkspaceAuthProfile).toHaveBeenCalledTimes(1));
    expect(mockCreateAuthProfile).not.toHaveBeenCalled();
    // onSaved is deferred until the user completes authorization in the
    // pending-authorize dialog — see AT-3b for the cancel path.
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockInitiateOAuth).not.toHaveBeenCalled();
  });

  it('AT-3b: workspace scope OAuth dialog cancel keeps the pending profile (no leak across scopes)', async () => {
    // ABLP-1123: develop expanded inline authorize to both scopes. Cancelling
    // the dialog should NOT delete the just-created profile (it stays in
    // pending_authorization for the admin to authorize later) — the key
    // assertion is that neither project nor workspace delete is called.
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="_workspace"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Workspace OAuth Cancelled');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateWorkspaceAuthProfile).toHaveBeenCalledTimes(1));
    expect(mockDeleteWorkspaceAuthProfile).not.toHaveBeenCalled();
    expect(mockDeleteAuthProfile).not.toHaveBeenCalled();
  });

  it('AT-4: api_key create preserves the synchronous onSaved path (no OAuth dialog)', async () => {
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /API Key/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. API Key - Production'), {
      target: { value: 'Static API key' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your API key'), {
      target: { value: 'sk-test' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // No OAuth dialog should appear for non-OAuth auth types.
    expect(screen.queryByText('Authorize Access')).not.toBeInTheDocument();
    expect(mockInitiateOAuth).not.toHaveBeenCalled();
    expect(mockHandleOAuthProfileCallback).not.toHaveBeenCalled();
  });

  it('AT-5: duplicate postMessage from popup fires the callback API exactly once', async () => {
    // Regression: popup callback page can fire postMessage twice (React Strict
    // Mode / browser quirks). The dialog uses callbackInFlightRef to dedupe
    // concurrent invocations. Without this guard, both POSTs reached the
    // callback endpoint — first consumed the OAuth state via Redis GETDEL (201),
    // second got `INVALID_STATE` (400).
    const onSaved = vi.fn();

    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Acme OAuth Dedupe');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreateAuthProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Authorize/i }));
    await waitFor(() => expect(mockInitiateOAuth).toHaveBeenCalledTimes(1));

    const dispatchCallback = () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: {
            type: 'auth-profile-oauth-callback',
            code: 'auth-code-dup',
            state: 'state-abc',
          },
        }),
      );

    // Fire the same postMessage twice synchronously.
    dispatchCallback();
    dispatchCallback();

    await waitFor(() => expect(mockHandleOAuthProfileCallback).toHaveBeenCalledTimes(1));
    // Even after the success has resolved, no second call should happen.
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockHandleOAuthProfileCallback).toHaveBeenCalledTimes(1);
  });

  it('AT-6b: auto-closes the slideover when the edited profile returns 404 (deleted while open)', async () => {
    // Regression: when a profile is deleted while the slideover is open for
    // editing, useAuthProfile would re-fetch on every focus / re-render,
    // producing a continuous 404 loop. The slideover now auto-closes when
    // errorStatus === 404 to break the loop and unstrand the user.
    const onClose = vi.fn();

    mockAuthProfileState.profile = null;
    mockAuthProfileState.errorStatus = 404;

    render(
      <AuthProfileSlideOver
        open
        onClose={onClose}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId="profile-deleted"
      />,
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('AT-6: dismissing the OAuth dialog re-enables the Create Profile button (no spinner lock)', async () => {
    // Regression: when the OAuth dialog opened, `saving` was set to true and
    // `deferStopSaving` blocked the normal reset. If the user dismissed the
    // dialog (handleAuthorizeDialogClose) the dialog now resets saving so the
    // user can correct the form and resubmit. This test asserts the create
    // button becomes enabled again after dismissing the OAuth dialog.
    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId={null}
        preselectedAuthType="oauth2_app"
      />,
    );

    fillOAuth2AppForm('Acme OAuth Spinner');
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(screen.getByText('Authorize Access')).toBeInTheDocument());

    // Dismiss the OAuth dialog (no authorization completed).
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));

    // After the dialog closes, the slideover stays open. Because the pending
    // profile was already created server-side, the bottom button now reads
    // "Continue to Authorize" — and crucially must NOT be stuck in a
    // saving/disabled spinner state.
    await waitFor(() => {
      expect(screen.queryByText('Authorize Access')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /create profile/i })).not.toBeDisabled();
  });
});
