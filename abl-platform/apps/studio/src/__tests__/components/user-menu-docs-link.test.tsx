import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserMenu } from '../../components/auth/UserMenu';
import { useAuthStore } from '../../store/auth-store';
import { useThemeStore } from '../../store/theme-store';

vi.mock('../../components/auth/ProfilePanel', () => ({
  ProfilePanel: () => null,
}));

vi.mock('../../components/settings/ApiKeysPanel', () => ({
  ApiKeysPanel: () => null,
}));

describe('UserMenu docs link', () => {
  const openSpy = vi.fn();
  let originalLocation: Location;

  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'engineer@kore.ai',
        name: 'Docs User',
      },
      accessToken: null,
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      isAuthenticated: true,
      isLoading: false,
    });

    useThemeStore.setState({
      mode: 'light',
      resolved: 'light',
    });

    if (!originalLocation) {
      originalLocation = window.location;
    }

    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: originalLocation.href },
    });

    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: openSpy,
    });

    openSpy.mockReset();
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('opens docs in a new tab without replacing the current Studio session', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    const originalHref = window.location.href;
    window.open('/sanity-check', '_blank');
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockClear();

    await user.click(screen.getByTestId('user-menu-trigger'));
    await user.click(
      within(screen.getByTestId('user-menu-dropdown')).getByRole('button', { name: /docs/i }),
    );

    expect(openSpy).toHaveBeenCalled();
    expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(['/docs', '_blank']);
    expect(window.location.href).toBe(originalHref);
  });
});
