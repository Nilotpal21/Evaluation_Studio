/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UserMenu } from '../../components/auth/UserMenu';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useThemeStore } from '../../store/theme-store';

vi.mock('../../api/auth', () => ({
  logout: vi.fn(),
  scheduleTokenRefresh: vi.fn(),
}));

vi.mock('../../components/auth/ProfilePanel', () => ({
  ProfilePanel: () => null,
}));

vi.mock('../../components/settings/ApiKeysPanel', () => ({
  ApiKeysPanel: () => null,
}));

describe('UserMenu', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'studio-user@kore.ai',
        name: 'Studio User',
      },
      accessToken: null,
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      isAuthenticated: true,
      isLoading: false,
    });
    useNavigationStore.setState({
      area: 'projects',
      projectId: null,
      page: null,
      subPage: null,
      subPageLabel: null,
      tab: null,
      subSection: null,
      breadcrumbs: [],
      sidebarCollapsed: false,
      kgView: 'graph',
    });
    useThemeStore.setState({
      mode: 'system',
      resolved: 'dark',
    });
  });

  test('opens docs in a new tab from the user menu', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<UserMenu />);

    fireEvent.click(screen.getByTestId('user-menu-trigger'));
    fireEvent.click(screen.getByRole('button', { name: /docs/i }));

    expect(openSpy).toHaveBeenCalledWith('/docs', '_blank', 'noopener,noreferrer');
  });

  test('opens academy in a new tab from the user menu', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<UserMenu />);

    fireEvent.click(screen.getByTestId('user-menu-trigger'));
    fireEvent.click(screen.getByRole('button', { name: /graduationcap academy/i }));

    expect(openSpy).not.toHaveBeenCalledWith('/academy', '_blank', 'noopener,noreferrer');
    expect(window.location.href).toContain('/academy');
  });
});
