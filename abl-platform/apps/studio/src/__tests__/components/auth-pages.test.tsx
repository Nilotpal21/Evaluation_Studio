/**
 * Auth Pages Component Tests
 *
 * Comprehensive tests for all authentication page components:
 *   - LoginPage
 *   - SignupPage
 *   - ForgotPasswordPage
 *   - ResetPasswordPage
 *   - VerifyEmailPage
 *
 * Covers rendering, form fields, validation, API calls,
 * success/error states, and navigation links.
 */

import { describe, test, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Override setup.ts next/navigation mock so we can inspect router.push calls
const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/',
}));

// Mock auth store
const mockSetAuth = vi.fn();
vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({
    setAuth: mockSetAuth,
  }),
}));

// Mock auth API
const mockScheduleTokenRefresh = vi.fn();
vi.mock('@/api/auth', () => ({
  scheduleTokenRefresh: (...args: unknown[]) => mockScheduleTokenRefresh(...args),
}));

// Mock KoreIcon to a simple placeholder
vi.mock('@/components/ui/KoreLogo', () => ({
  KoreIcon: ({ className, size }: { className?: string; size?: number }) => (
    <div data-testid="kore-icon" className={className} />
  ),
}));

// Mock RuntimeConfigContext — LoginPage uses useRuntimeConfig for OAuth/dev-login flags
vi.mock('@/contexts/RuntimeConfigContext', () => ({
  useRuntimeConfig: () => ({
    googleClientId: '',
    microsoftClientId: '',
    linkedinClientId: '',
    enableDevLogin: true,
    runtimeUrl: '',
    wsUrl: '',
    sdkWsUrl: '',
    livekitUrl: '',
  }),
}));

// Static imports — vi.mock() calls above are hoisted, so mocks are applied before these load.
import LoginPage from '../../app/auth/login/page';
import SignupPage from '../../app/auth/signup/page';
import ForgotPasswordPage from '../../app/auth/forgot-password/page';
import ResetPasswordPage from '../../app/auth/reset-password/page';
import VerifyEmailPage from '../../app/auth/verify-email/page';

// ---------------------------------------------------------------------------
// Global fetch mock + helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockFetchSuccess(data: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
}

function mockFetchError(status: number, data: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => data,
  });
}

function mockFetchNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

// Prevent actual navigation via window.location.href assignment.
// originalLocation is captured lazily inside beforeEach because `window` may
// not yet exist at module-evaluation time in the forks pool.
let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockSearchParams.delete('token');
  mockSearchParams.delete('email');
  mockSearchParams.delete('invite');

  // Re-install our fetch mock — setup.tsx's afterEach reinstalls the default
  // throwing mock via installDefaultFetchMock(), overriding the module-level
  // assignment. We must re-assert ownership in every beforeEach.
  global.fetch = mockFetch;

  if (!originalLocation) {
    originalLocation = window.location;
  }

  // Stub window.location.href setter
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, href: originalLocation.href },
  });
});

// ============================================================================
// LOGIN PAGE
// ============================================================================

describe('LoginPage', () => {
  // ---- Rendering ----------------------------------------------------------

  test('renders without crashing', () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in');
  });

  test('shows expected form fields', () => {
    render(<LoginPage />);
    // Step 1 shows only email; password appears after advancing to step 2
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });

  test('shows expected buttons', () => {
    render(<LoginPage />);
    // Step 1 has "Continue" submit button and social login buttons (accessible via title)
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  test('shows Dev Login button in development mode', () => {
    render(<LoginPage />);
    // isDev evaluates to true in test environment (NODE_ENV !== production and no GOOGLE_CLIENT_ID)
    expect(screen.getByRole('button', { name: /dev login/i })).toBeInTheDocument();
  });

  // ---- Navigation links ---------------------------------------------------

  test('has link to forgot password page on password step', async () => {
    const user = userEvent.setup();
    // resolve-account returns existing user to advance to password step
    mockFetchSuccess({ status: 'existing' });

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email address/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => {
      const link = screen.getByText(/forgot password/i);
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute('href', '/auth/forgot-password');
    });
  });

  test('has link to sign up page', () => {
    render(<LoginPage />);
    const link = screen.getByText('Sign Up');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/auth/signup');
  });

  // ---- Form submission (two-step: email resolve → password login) ---------

  /** Helper: advance past step 1 (email) to step 2 (password) */
  async function advanceToPasswordStep(
    user: ReturnType<typeof userEvent.setup>,
    email = 'test@example.com',
  ) {
    // Step 1: resolve-account returns existing user
    mockFetchSuccess({ status: 'existing' });

    await user.type(screen.getByLabelText(/email address/i), email);
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // Wait for password field to appear (step 2)
    await waitFor(() => {
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    });
  }

  test('submits login form with correct payload on success', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await advanceToPasswordStep(user);

    // Step 2: login
    mockFetchSuccess({
      user: { id: '1', email: 'test@example.com', name: 'Test' },
      accessToken: 'tok_123',
      expiresIn: 900,
    });

    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
      });
    });
  });

  test('calls setAuth and scheduleTokenRefresh on successful login', async () => {
    const user = userEvent.setup();
    const responseData = {
      user: { id: '1', email: 'test@example.com', name: 'Test' },
      accessToken: 'tok_123',
      expiresIn: 900,
    };

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchSuccess(responseData);
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockSetAuth).toHaveBeenCalledWith(responseData.user, responseData.accessToken);
      expect(mockScheduleTokenRefresh).toHaveBeenCalledWith(900);
    });
  });

  test('redirects to home on successful login without onboarding', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchSuccess({
      user: { id: '1', email: 'test@example.com' },
      accessToken: 'tok_123',
      expiresIn: 900,
    });
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(window.location.href).toBe('/');
    });
  });

  test('redirects to onboarding when needsOnboarding is true', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchSuccess({
      user: { id: '1', email: 'test@example.com' },
      accessToken: 'tok_123',
      expiresIn: 900,
      needsOnboarding: true,
    });
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(window.location.href).toBe('/onboarding');
    });
  });

  test('redirects to MFA page when mfaRequired is true', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchSuccess({ mfaRequired: true });
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/auth/mfa');
    });
  });

  // ---- Form submission (error on password step) ---------------------------

  test('displays server error message on failed login', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user, 'bad@example.com');

    mockFetchError(401, { error: 'Invalid credentials' });
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  test('displays fallback error message when server error has no message', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user, 'bad@example.com');

    mockFetchError(500, {});
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Login failed. Please try again.')).toBeInTheDocument();
    });
  });

  test('displays generic error on network failure', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchNetworkError();
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    });
  });

  test('shows the verification prompt when login requires a verified email', async () => {
    const user = userEvent.setup();

    render(<LoginPage />);

    await advanceToPasswordStep(user);

    mockFetchError(403, { error: 'Please verify your email address before signing in.' });
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /resend verification/i })).toBeInTheDocument();
    });
  });

  // ---- Dev Login ----------------------------------------------------------

  test('dev login calls /api/auth/dev-login with preset credentials', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({
      user: { id: 'dev', email: 'dev@kore.ai', name: 'Developer' },
      accessToken: 'dev_tok',
      expiresIn: 900,
    });

    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /dev login/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: 'dev@kore.ai', name: 'Developer' }),
      });
    });
  });

  test('dev login shows error on failure', async () => {
    const user = userEvent.setup();
    mockFetchError(500, { error: 'Dev login failed' });

    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /dev login/i }));

    await waitFor(() => {
      expect(screen.getByText('Dev login failed')).toBeInTheDocument();
    });
  });

  test('dev login shows network error message on exception', async () => {
    const user = userEvent.setup();
    mockFetchNetworkError();

    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /dev login/i }));

    await waitFor(() => {
      expect(screen.getByText('Dev login failed: Server not reachable')).toBeInTheDocument();
    });
  });

  // ---- Google Login -------------------------------------------------------

  test('Google login button redirects to OAuth endpoint', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(window.location.href).toBe('/api/auth/google');
  });
});

// ============================================================================
// SIGNUP PAGE
// ============================================================================

describe('SignupPage', () => {
  // ---- Rendering ----------------------------------------------------------

  test('renders without crashing', () => {
    render(<SignupPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create account');
  });

  test('shows expected form fields', () => {
    render(<SignupPage />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  test('shows expected buttons', () => {
    render(<SignupPage />);
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  // ---- Navigation links ---------------------------------------------------

  test('has link to sign in page', () => {
    render(<SignupPage />);
    const link = screen.getByText('Sign in');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/auth/login');
  });

  // ---- Password strength checks -------------------------------------------

  test('shows password strength checks when password is entered', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.type(screen.getByLabelText(/password/i), 'a');

    expect(screen.getByText('8+ characters')).toBeInTheDocument();
    expect(screen.getByText('Uppercase letter')).toBeInTheDocument();
    expect(screen.getByText('Lowercase letter')).toBeInTheDocument();
    expect(screen.getByText('Number')).toBeInTheDocument();
  });

  test('does not show password checks when password field is empty', () => {
    render(<SignupPage />);
    expect(screen.queryByText('8+ characters')).not.toBeInTheDocument();
  });

  // ---- Validation ---------------------------------------------------------

  test('shows error when submitting with weak password', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'weak');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText('Please meet all password requirements')).toBeInTheDocument();
    });
    // Should NOT have called the API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ---- Form submission (success) ------------------------------------------

  test('submits signup form with correct payload', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({ message: 'Account created' });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'StrongPass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'StrongPass1',
          name: 'Test User',
        }),
      });
    });
  });

  test('shows success state after successful signup', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({ message: 'Account created' });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'StrongPass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText('Account created!')).toBeInTheDocument();
      expect(screen.getByText('Check your email to verify your account.')).toBeInTheDocument();
    });
  });

  // ---- Form submission (error) --------------------------------------------

  test('displays server error message on failed signup', async () => {
    const user = userEvent.setup();
    mockFetchError(409, { error: 'Email already registered' });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'StrongPass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText('Email already registered')).toBeInTheDocument();
    });
  });

  test('displays fallback error when server error has no message', async () => {
    const user = userEvent.setup();
    mockFetchError(500, {});

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'StrongPass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText('Signup failed. Please try again.')).toBeInTheDocument();
    });
  });

  test('displays generic error on network failure', async () => {
    const user = userEvent.setup();
    mockFetchNetworkError();

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'StrongPass1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    });
  });

  // ---- Google signup ------------------------------------------------------

  test('Google signup button redirects to OAuth endpoint', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(window.location.href).toBe('/api/auth/google');
  });
});

// ============================================================================
// FORGOT PASSWORD PAGE
// ============================================================================

describe('ForgotPasswordPage', () => {
  // ---- Rendering ----------------------------------------------------------

  test('renders without crashing', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset password');
  });

  test('shows email input field', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  test('shows submit button', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  // ---- Navigation links ---------------------------------------------------

  test('has back link to sign in page', () => {
    render(<ForgotPasswordPage />);
    const links = screen.getAllByText(/back to sign in/i);
    // The "Back to sign in" link in the form header
    expect(links[0].closest('a')).toHaveAttribute('href', '/auth/login');
  });

  // ---- Form submission (success) ------------------------------------------

  test('submits forgot password form with correct payload', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({});

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });
    });
  });

  test('shows success state after submitting email', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({});

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeInTheDocument();
      expect(
        screen.getByText(/if an account with that email exists, we sent a password reset link/i),
      ).toBeInTheDocument();
    });
  });

  test('success state has link back to sign in', async () => {
    const user = userEvent.setup();
    mockFetchSuccess({});

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      const backLink = screen.getByText(/back to sign in/i);
      expect(backLink.closest('a')).toHaveAttribute('href', '/auth/login');
    });
  });

  // ---- Form submission (error) --------------------------------------------

  test('displays server error on failed submission', async () => {
    const user = userEvent.setup();
    mockFetchError(429, { error: 'Too many requests' });

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByText('Too many requests')).toBeInTheDocument();
    });
  });

  test('displays fallback error when server response has no error field', async () => {
    const user = userEvent.setup();
    mockFetchError(500, {});

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    });
  });

  test('displays generic error on network failure', async () => {
    const user = userEvent.setup();
    mockFetchNetworkError();

    render(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// RESET PASSWORD PAGE
// ============================================================================

describe('ResetPasswordPage', () => {
  // ---- No token state -----------------------------------------------------

  test('renders invalid link message when no token in URL', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByText('Invalid reset link')).toBeInTheDocument();
    expect(
      screen.getByText(/this password reset link is invalid or has expired/i),
    ).toBeInTheDocument();
  });

  test('shows link to request a new reset when no token', () => {
    render(<ResetPasswordPage />);
    const link = screen.getByText('Request a new reset link');
    expect(link.closest('a')).toHaveAttribute('href', '/auth/forgot-password');
  });

  // ---- With valid token ---------------------------------------------------

  describe('with token in URL', () => {
    beforeEach(() => {
      mockSearchParams.set('token', 'valid-reset-token');
    });

    test('renders form fields when token is present', () => {
      render(<ResetPasswordPage />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set new password');
      expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });

    test('shows submit button', () => {
      render(<ResetPasswordPage />);
      expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
    });

    // ---- Password strength checks -----------------------------------------

    test('shows password strength checks when password is entered', async () => {
      const user = userEvent.setup();
      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'a');

      expect(screen.getByText('8+ characters')).toBeInTheDocument();
      expect(screen.getByText('Uppercase letter')).toBeInTheDocument();
      expect(screen.getByText('Lowercase letter')).toBeInTheDocument();
      expect(screen.getByText('Number')).toBeInTheDocument();
    });

    test('shows passwords match check when confirm password is entered', async () => {
      const user = userEvent.setup();
      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'Test123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'Test');

      expect(screen.getByText('Passwords match')).toBeInTheDocument();
    });

    // ---- Validation -------------------------------------------------------

    test('shows error when passwords do not match', async () => {
      const user = userEvent.setup();
      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'StrongPass1');
      await user.type(screen.getByLabelText(/confirm password/i), 'DifferentPass1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // ---- Form submission (success) ----------------------------------------

    test('submits reset password form with correct payload', async () => {
      const user = userEvent.setup();
      mockFetchSuccess({ message: 'Password reset successful' });

      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'NewStrong1');
      await user.type(screen.getByLabelText(/confirm password/i), 'NewStrong1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'valid-reset-token', newPassword: 'NewStrong1' }),
        });
      });
    });

    test('shows success state after password reset', async () => {
      const user = userEvent.setup();
      mockFetchSuccess({ message: 'Password reset successful' });

      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'NewStrong1');
      await user.type(screen.getByLabelText(/confirm password/i), 'NewStrong1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(screen.getByText('Password reset!')).toBeInTheDocument();
        expect(screen.getByText('Redirecting to sign in...')).toBeInTheDocument();
      });
    });

    // ---- Form submission (error) ------------------------------------------

    test('displays server error on failed reset', async () => {
      const user = userEvent.setup();
      mockFetchError(400, { error: 'Token expired' });

      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'NewStrong1');
      await user.type(screen.getByLabelText(/confirm password/i), 'NewStrong1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(screen.getByText('Token expired')).toBeInTheDocument();
      });
    });

    test('displays fallback error when server response has no error field', async () => {
      const user = userEvent.setup();
      mockFetchError(500, {});

      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'NewStrong1');
      await user.type(screen.getByLabelText(/confirm password/i), 'NewStrong1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
      });
    });

    test('displays generic error on network failure', async () => {
      const user = userEvent.setup();
      mockFetchNetworkError();

      render(<ResetPasswordPage />);

      await user.type(screen.getByLabelText(/new password/i), 'NewStrong1');
      await user.type(screen.getByLabelText(/confirm password/i), 'NewStrong1');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
      });
    });
  });
});

// ============================================================================
// VERIFY EMAIL PAGE
// ============================================================================

describe('VerifyEmailPage', () => {
  // ---- Waiting state (no token, with email) -------------------------------

  describe('waiting state (email only, no token)', () => {
    beforeEach(() => {
      mockSearchParams.set('email', 'test@example.com');
    });

    test('renders check your email message', () => {
      render(<VerifyEmailPage />);
      expect(screen.getByText('Check your email')).toBeInTheDocument();
    });

    test('displays the email address provided', () => {
      render(<VerifyEmailPage />);
      expect(screen.getByText(/test@example.com/)).toBeInTheDocument();
    });

    test('shows resend verification email button', () => {
      render(<VerifyEmailPage />);
      expect(screen.getByText('Resend verification email')).toBeInTheDocument();
    });

    test('has link to sign up again', () => {
      render(<VerifyEmailPage />);
      const link = screen.getByText('Sign up again');
      expect(link.closest('a')).toHaveAttribute('href', '/auth/signup');
    });

    // ---- Resend verification ------------------------------------------------

    test('resend calls /api/auth/resend-verification with correct email', async () => {
      const user = userEvent.setup();
      mockFetchSuccess({});

      render(<VerifyEmailPage />);

      await user.click(screen.getByText('Resend verification email'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/auth/resend-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        });
      });
    });

    test('shows resend success message after successful resend', async () => {
      const user = userEvent.setup();
      mockFetchSuccess({});

      render(<VerifyEmailPage />);

      await user.click(screen.getByText('Resend verification email'));

      await waitFor(() => {
        expect(screen.getByText('Verification email resent!')).toBeInTheDocument();
      });
    });
  });

  // ---- Waiting state (no email, no token) ---------------------------------

  describe('waiting state (no email, no token)', () => {
    test('renders generic message when no email provided', () => {
      render(<VerifyEmailPage />);
      expect(screen.getByText('Check your email')).toBeInTheDocument();
      expect(screen.getByText(/We sent a verification link to/)).toBeInTheDocument();
    });

    test('does not show resend button when no email provided', () => {
      render(<VerifyEmailPage />);
      expect(screen.queryByText('Resend verification email')).not.toBeInTheDocument();
    });
  });

  // ---- Verifying state (with token) ---------------------------------------

  describe('verifying state (with token)', () => {
    beforeEach(() => {
      mockSearchParams.set('token', 'verify-token-123');
    });

    test('shows verifying message while processing', () => {
      // Set up a fetch that never resolves to keep verifying state
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      render(<VerifyEmailPage />);
      expect(screen.getByText('Verifying your email...')).toBeInTheDocument();
    });

    test('calls /api/auth/verify-email with token', async () => {
      mockFetchSuccess({
        user: { id: '1', email: 'test@example.com' },
        accessToken: 'tok_verified',
        expiresIn: 900,
      });

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'verify-token-123' }),
        });
      });
    });

    test('shows success state after successful verification', async () => {
      mockFetchSuccess({
        user: { id: '1', email: 'test@example.com' },
        accessToken: 'tok_verified',
        expiresIn: 900,
      });

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText('Email verified!')).toBeInTheDocument();
        expect(screen.getByText('Redirecting...')).toBeInTheDocument();
      });
    });

    test('calls setAuth and scheduleTokenRefresh on successful verification', async () => {
      const responseData = {
        user: { id: '1', email: 'test@example.com' },
        accessToken: 'tok_verified',
        expiresIn: 900,
      };
      mockFetchSuccess(responseData);

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(mockSetAuth).toHaveBeenCalledWith(responseData.user, responseData.accessToken);
        expect(mockScheduleTokenRefresh).toHaveBeenCalledWith(900);
      });
    });

    test('shows error state on failed verification', async () => {
      mockFetchError(400, { error: 'Token expired or invalid' });

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText('Verification failed')).toBeInTheDocument();
        expect(screen.getByText('Token expired or invalid')).toBeInTheDocument();
      });
    });

    test('error state has link to try signing up again', async () => {
      mockFetchError(400, { error: 'Invalid token' });

      render(<VerifyEmailPage />);

      await waitFor(() => {
        const link = screen.getByText('Try signing up again');
        expect(link.closest('a')).toHaveAttribute('href', '/auth/signup');
      });
    });

    test('shows generic error on network failure', async () => {
      mockFetchNetworkError();

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText('Verification failed')).toBeInTheDocument();
        expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
      });
    });
  });
});
