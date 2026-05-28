/**
 * Admin sidebar access regressions
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.fn();

const mockNavigationStore = {
  page: 'members',
  navigate: mockNavigate,
};

const mockAuthStore = {
  accessToken: null as string | null,
};

const mockTenantFeatures = {
  features: {
    advanced_analytics: true,
    kms_byok: true,
    connectors: true,
  },
};

const translations: Record<string, string> = {
  'nav.back_to_projects': 'Back to Projects',
  'nav.sections.team': 'Team',
  'nav.sections.ai_configuration': 'AI Configuration',
  'nav.sections.analytics': 'Analytics',
  'nav.sections.account': 'Account',
  'nav.workspace_members': 'Workspace Members',
  'nav.custom_roles': 'Custom Roles',
  'nav.security_compliance': 'Security',
  'nav.audit_logs': 'Audit Logs',
  'nav.kms': 'KMS',
  'nav.env_vars': 'Env Vars',
  'nav.llm_providers': 'LLM Providers',
  'nav.arch': 'Arch',
  'nav.voice_services': 'Voice Services',
  'nav.guardrails': 'Guardrails',
  'nav.auth_profiles': 'Auth Profiles',
  'nav.analytics_agents': 'Agent Analytics',
  'nav.analytics_sessions': 'Session Analytics',
  'nav.analytics_traces': 'Trace Analytics',
  'nav.workspace_settings': 'Workspace Settings',
  'nav.secrets': 'Secrets',
  'nav.billing_usage': 'Billing',
  'nav.connectors': 'Connectors',
};

function buildAccessToken(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tenantId: 'tenant-1', role })).toString('base64url');
  return `${header}.${payload}.signature`;
}

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) =>
    translations[`${namespace}.${key}`] ?? `${namespace}.${key}`,
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector?: (state: typeof mockNavigationStore) => unknown) =>
    selector ? selector(mockNavigationStore) : mockNavigationStore,
}));

vi.mock('../../store/auth-store', () => ({
  useAuthStore: (selector?: (state: typeof mockAuthStore) => unknown) =>
    selector ? selector(mockAuthStore) : mockAuthStore,
}));

vi.mock('../../hooks/useBilling', () => ({
  useTenantFeatures: () => mockTenantFeatures,
}));

import { AdminSidebar } from '../../components/navigation/AdminSidebar';

const TRUNCATED_LABEL_CLIENT_WIDTH = 96;
const CHARACTER_WIDTH = 8;

function installOverflowMeasurements() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('truncate') ? TRUNCATED_LABEL_CLIENT_WIDTH : 240;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return (this.textContent ?? '').length * CHARACTER_WIDTH;
    },
  });
}

function renderSidebar(collapsed = false) {
  return render(<AdminSidebar collapsed={collapsed} onToggleCollapse={vi.fn()} />);
}

describe('AdminSidebar access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installOverflowMeasurements();
    mockTenantFeatures.features.advanced_analytics = true;
    mockTenantFeatures.features.kms_byok = true;
    mockTenantFeatures.features.connectors = true;
  });

  it('hides workspace-admin navigation for non-admin workspace members', () => {
    mockAuthStore.accessToken = buildAccessToken('MEMBER');

    renderSidebar();

    expect(screen.getByRole('button', { name: /Back to Projects/i })).toBeInTheDocument();
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace Members')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace Settings')).not.toBeInTheDocument();
  });

  it('shows workspace-admin navigation for workspace admins', () => {
    mockAuthStore.accessToken = buildAccessToken('ADMIN');

    renderSidebar();
    const activeWorkspaceMembers = screen.getByRole('button', { name: /Workspace Members/i });
    fireEvent.click(screen.getByRole('button', { name: /Custom Roles/i }));

    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Workspace Members')).toBeInTheDocument();
    expect(screen.getByText('Audit Logs')).toBeInTheDocument();
    expect(screen.getByText('Workspace Settings')).toBeInTheDocument();
    expect(activeWorkspaceMembers.className).toContain('bg-[hsl(var(--admin-sidebar-active-bg))]');
    expect(activeWorkspaceMembers.className).not.toContain(
      'bg-[hsl(var(--color-brand-active-bg))]',
    );
    expect(mockNavigate).toHaveBeenCalledWith('/admin/roles');
  });

  it('navigates to the full-screen audit log surface', () => {
    mockAuthStore.accessToken = buildAccessToken('OWNER');

    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /Audit Logs/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/audit-logs');
  });

  it('uses the real label in gated item tooltips instead of upgrade copy', async () => {
    const user = userEvent.setup();
    mockAuthStore.accessToken = buildAccessToken('OWNER');
    mockTenantFeatures.features.advanced_analytics = false;

    renderSidebar();

    const gatedAnalyticsButton = screen.getByRole('button', { name: /Agent Analytics/i });
    expect(gatedAnalyticsButton).toHaveAttribute('aria-disabled', 'true');
    expect(gatedAnalyticsButton).toHaveAttribute('title', 'Agent Analytics');

    await user.hover(gatedAnalyticsButton);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Agent Analytics');
    expect(screen.queryByText('Upgrade to unlock')).not.toBeInTheDocument();
  });
});
