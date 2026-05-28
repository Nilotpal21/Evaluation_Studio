import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const navState = vi.hoisted(() => ({
  projectId: 'proj-1' as string | null,
}));

const translate = Object.assign((key: string) => key, {
  has: () => false,
});

vi.mock('next-intl', () => ({
  useTranslations: () => translate,
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => navState,
}));

vi.mock('../../hooks/usePermissions', () => ({
  useHasPermission: () => true,
}));

vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfile: () => ({
    profile: null,
    isLoading: false,
    error: null,
    errorStatus: null,
    refresh: vi.fn(),
  }),
  useAuthProfiles: () => ({
    profiles: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useWorkspaceAuthProfiles: () => ({
    profiles: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  // ABLP-1123: pre-push mock-export-drift guard — keep these in sync with
  // the real hook module's exports even though this test doesn't exercise them.
  buildWorkspaceAuthProfilesKey: vi.fn(),
}));

vi.mock('../../api/auth-profiles', () => ({
  bulkAuthProfiles: vi.fn(),
  deleteAuthProfile: vi.fn(),
  revokeAuthProfile: vi.fn(),
  fetchAuthProfileConsumers: vi.fn(),
  // ABLP-1123: workspace-surface stubs for mock-export-drift guard
  deleteWorkspaceAuthProfile: vi.fn(),
  revokeWorkspaceAuthProfile: vi.fn(),
  fetchIntegrationProviders: vi.fn(),
  fetchWorkspaceIntegrationProviders: vi.fn(),
  fetchWorkspaceAuthProfiles: vi.fn(),
  // ABLP-1123 lifecycle UI: workspace consumer fetch + disable-toggle updates
  fetchWorkspaceAuthProfileConsumers: vi.fn(),
  updateAuthProfile: vi.fn(),
  updateWorkspaceAuthProfile: vi.fn(),
}));

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
  mutate: vi.fn(),
}));

vi.mock('../../components/auth-profiles/AuthProfileStatusBadge', () => ({
  AuthProfileStatusBadge: () => null,
}));

vi.mock('../../components/auth-profiles/AuthProfileListHealthPill', () => ({
  AuthProfileListHealthPill: () => null,
}));

vi.mock('../../components/auth-profiles/AuthProfileSlideOver', () => ({
  AuthProfileSlideOver: () => null,
}));

vi.mock('../../components/auth-profiles/IntegrationAuthTab', () => ({
  IntegrationAuthTab: () => <div>integrations</div>,
  buildProvidersKey: () => 'providers-key',
}));

vi.mock('../../components/auth-profiles/AuthProfileOAuthDialog', () => ({
  AuthProfileOAuthDialog: () => null,
}));

vi.mock('../../components/connections/ConnectorLogo', () => ({
  ConnectorLogo: () => null,
}));

vi.mock('../../components/ui/Badge', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock('../../components/ui/Checkbox', () => ({
  Checkbox: () => <input type="checkbox" />,
}));

vi.mock('../../components/ui/Tabs', () => ({
  Tabs: () => null,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

import { AuthProfilesPage } from '../../components/auth-profiles/AuthProfilesPage';

describe('AuthProfilesPage home navigation regression', () => {
  beforeEach(() => {
    navState.projectId = 'proj-1';
  });

  it('does not break hook ordering when projectId clears during navigation home', () => {
    const { rerender, container } = render(<AuthProfilesPage />);

    navState.projectId = null;

    expect(() => rerender(<AuthProfilesPage />)).not.toThrow();
    expect(container).toBeEmptyDOMElement();
  });
});
