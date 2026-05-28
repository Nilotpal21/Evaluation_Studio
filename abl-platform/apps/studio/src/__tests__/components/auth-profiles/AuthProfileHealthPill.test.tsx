import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthProfileHealthPill } from '@/components/auth-profiles/AuthProfileHealthPill';

describe('AuthProfileHealthPill', () => {
  it('renders a Loading… placeholder when health is undefined', () => {
    render(<AuthProfileHealthPill health={undefined} />);
    expect(screen.getByText(/Checking|Loading/i)).toBeInTheDocument();
  });

  it('renders the connected label when grant + refresh token present', () => {
    render(
      <AuthProfileHealthPill
        health={{
          state: 'connected',
          reason: 'OAuth profile is authorized and will auto-renew on token expiry.',
          refreshTokenStored: true,
        }}
      />,
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders the warning label when a grant exists with no refresh token (the user-pain case)', () => {
    render(
      <AuthProfileHealthPill
        health={{
          state: 'connected_no_auto_renew',
          reason:
            'OAuth profile is authorized but no refresh token is stored. Re-authorize with offline-access enabled.',
          refreshTokenStored: false,
        }}
      />,
    );
    expect(screen.getByText('Connected (no auto-refresh)')).toBeInTheDocument();
  });

  it('renders the reauth_required label when expired with no refresh token', () => {
    render(
      <AuthProfileHealthPill
        health={{
          state: 'reauth_required',
          reason: 'OAuth token expired and no refresh token is stored.',
          refreshTokenStored: false,
        }}
      />,
    );
    expect(screen.getByText('Re-authorization required')).toBeInTheDocument();
  });

  it('renders the inline reason line and relative-time when showReason=true', () => {
    const lastVerified = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
    render(
      <AuthProfileHealthPill
        showReason
        health={{
          state: 'connected',
          reason: 'OAuth profile is authorized and will auto-renew on token expiry.',
          refreshTokenStored: true,
          lastVerifiedAt: lastVerified,
        }}
      />,
    );
    expect(screen.getByText(/auto-renew/i)).toBeInTheDocument();
    expect(screen.getByText(/Verified 5m ago/i)).toBeInTheDocument();
  });

  it('exposes accessible aria-label combining label and reason for screen readers', () => {
    render(
      <AuthProfileHealthPill
        health={{
          state: 'not_authorized',
          reason: 'OAuth authorization has not been completed for this profile yet.',
        }}
      />,
    );
    const pill = screen.getByLabelText(
      /Not authorized: OAuth authorization has not been completed/,
    );
    expect(pill).toBeInTheDocument();
    expect(pill).not.toHaveAttribute('title');
  });

  it('respects the compact prop with tighter padding', () => {
    const { container } = render(
      <AuthProfileHealthPill compact health={{ state: 'verified', reason: 'OK' }} />,
    );
    const pill = container.querySelector('span');
    expect(pill?.className).toMatch(/px-2\.5 py-1/);
  });
});
