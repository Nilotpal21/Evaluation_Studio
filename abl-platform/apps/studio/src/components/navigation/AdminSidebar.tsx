/**
 * AdminSidebar Component
 *
 * Linear-inspired sidebar for tenant-level admin pages.
 * Matches ProjectSidebar aesthetics via shared sidebar-primitives.
 *
 * Feature-gated items are greyed out with reduced opacity and keep the
 * full navigation label available through the shared sidebar tooltip.
 */

import {
  Users,
  Brain,
  Mic,
  Shield,
  Key,
  KeyRound,
  CreditCard,
  Sparkles,
  BarChart3,
  Activity,
  Search,
  FileText,
  Lock,
  Variable,
  ShieldCheck,
  Plug,
  UserCog,
  Wrench,
  LayoutTemplate,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigationStore, type AdminPage } from '../../store/navigation-store';
import { useAuthStore } from '../../store/auth-store';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { useTenantFeatures } from '../../hooks/useBilling';
import {
  SidebarContainer,
  SidebarHeader,
  SidebarCollapseButton,
  SidebarBackButton,
  SidebarBackIconButton,
  SidebarNav,
  SidebarGroup,
  SidebarNavItem,
  SidebarLabelTooltip,
  useSidebarLabelOverflow,
} from './sidebar-primitives';
import { canAccessWorkspaceAdmin } from '../../lib/auth-token';

export interface AdminSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface NavItem {
  id: AdminPage;
  label: string;
  Icon: LucideIcon;
  /** Feature key required to access this item (undefined = always visible) */
  featureKey?: string;
}

interface NavItemDef {
  id: AdminPage;
  Icon: LucideIcon;
  key: string;
  /** Feature key required to access this item */
  featureKey?: string;
}

const teamNavDefs: NavItemDef[] = [
  { id: 'members', Icon: Users, key: 'workspace_members' },
  { id: 'roles', Icon: UserCog, key: 'custom_roles' },
  { id: 'security', Icon: Shield, key: 'security_compliance' },
  { id: 'audit-logs', Icon: FileText, key: 'audit_logs' },
  { id: 'kms', Icon: Lock, key: 'kms', featureKey: 'kms_byok' },
  { id: 'env-vars', Icon: Variable, key: 'env_vars' },
];

const aiConfigNavDefs: NavItemDef[] = [
  { id: 'models', Icon: Brain, key: 'llm_providers' },
  { id: 'arch', Icon: Sparkles, key: 'arch' },
  { id: 'voice', Icon: Mic, key: 'voice_services' },
  { id: 'guardrails', Icon: ShieldCheck, key: 'guardrails' },
  { id: 'auth-profiles', Icon: KeyRound, key: 'auth_profiles' },
];

const analyticsNavDefs: NavItemDef[] = [
  {
    id: 'analytics-agents',
    Icon: BarChart3,
    key: 'analytics_agents',
    featureKey: 'advanced_analytics',
  },
  {
    id: 'analytics-sessions',
    Icon: Activity,
    key: 'analytics_sessions',
    featureKey: 'advanced_analytics',
  },
  {
    id: 'analytics-traces',
    Icon: Search,
    key: 'analytics_traces',
    featureKey: 'advanced_analytics',
  },
];

const accountNavDefs: NavItemDef[] = [
  { id: 'workspace-settings', Icon: Wrench, key: 'workspace_settings' },
  { id: 'secrets', Icon: Key, key: 'secrets' },
  { id: 'billing', Icon: CreditCard, key: 'billing_usage' },
  { id: 'connectors', Icon: Plug, key: 'connectors', featureKey: 'connectors' },
];

const marketplaceNavDefs: NavItemDef[] = [
  { id: 'template-manager', Icon: LayoutTemplate, key: 'template_manager' },
];

interface AdminGatedNavItemProps {
  item: NavItem;
  collapsed: boolean;
}

function AdminGatedNavItem({ item, collapsed }: AdminGatedNavItemProps) {
  const { labelRef, labelOverflows } = useSidebarLabelOverflow(item.label, !collapsed);
  const showTooltip = collapsed || labelOverflows;

  return (
    <SidebarLabelTooltip content={item.label} enabled={showTooltip}>
      <button
        key={item.id}
        type="button"
        aria-disabled="true"
        title={item.label}
        className={clsx(
          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm font-medium text-[hsl(var(--admin-sidebar-text))] opacity-40 cursor-not-allowed',
          collapsed && 'justify-center',
        )}
      >
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
          <item.Icon className="w-4 h-4" />
        </span>
        {!collapsed && (
          <span ref={labelRef} className="truncate">
            {item.label}
          </span>
        )}
      </button>
    </SidebarLabelTooltip>
  );
}

export function AdminSidebar({ collapsed, onToggleCollapse }: AdminSidebarProps) {
  const t = useTranslations('nav');
  const page = useNavigationStore((s) => s.page);
  const navigate = useNavigationStore((s) => s.navigate);
  const accessToken = useAuthStore((s) => s.accessToken);
  const activePage = page || 'members';
  const { features } = useTenantFeatures();
  const canOpenWorkspaceAdmin = canAccessWorkspaceAdmin(accessToken);

  const buildNavItems = (defs: NavItemDef[]): NavItem[] =>
    defs.map(({ id, Icon, key, featureKey }) => ({
      id,
      label: t(key),
      Icon,
      featureKey,
    }));

  const teamNav = buildNavItems(teamNavDefs);
  const aiConfigNav = buildNavItems(aiConfigNavDefs);
  const analyticsNav = buildNavItems(analyticsNavDefs);
  const accountNav = buildNavItems(accountNavDefs);
  const marketplaceNav = buildNavItems(marketplaceNavDefs);

  const renderNavItem = (item: NavItem) => {
    const isActive = activePage === item.id;
    const isGated = item.featureKey ? features[item.featureKey] === false : false;

    if (isGated) {
      return <AdminGatedNavItem key={item.id} item={item} collapsed={collapsed} />;
    }

    return (
      <SidebarNavItem
        key={item.id}
        section={item.id}
        label={item.label}
        Icon={item.Icon}
        isActive={isActive}
        collapsed={collapsed}
        onClick={() => navigate(`/admin/${item.id}`)}
        surface="admin"
      />
    );
  };

  const renderSection = (label: string, items: NavItem[]) => (
    <SidebarGroup label={label} collapsed={collapsed} surface="admin">
      {items.map(renderNavItem)}
    </SidebarGroup>
  );

  return (
    <SidebarContainer
      surface="admin"
      collapsed={collapsed}
      width={240}
      collapsedWidth={56}
      ariaLabel="Admin sidebar"
    >
      <SidebarHeader collapsed={collapsed} surface="admin">
        {!collapsed ? (
          <>
            <SidebarBackButton
              onClick={() => navigate('/')}
              label={t('back_to_projects')}
              surface="admin"
            />
            <SidebarCollapseButton
              collapsed={collapsed}
              onToggle={onToggleCollapse}
              surface="admin"
              ariaLabel={t('collapse_sidebar')}
              title={t('collapse_sidebar')}
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <SidebarBackIconButton
              onClick={() => navigate('/')}
              surface="admin"
              ariaLabel={t('back_to_projects')}
              title={t('back_to_projects')}
            />
            <SidebarCollapseButton
              collapsed={collapsed}
              onToggle={onToggleCollapse}
              surface="admin"
              ariaLabel={t('expand_sidebar')}
              title={t('expand_sidebar')}
            />
          </div>
        )}
      </SidebarHeader>

      {canOpenWorkspaceAdmin && (
        <SidebarNav collapsed={collapsed} surface="admin">
          {renderSection(t('sections.team'), teamNav)}
          {renderSection(t('sections.ai_configuration'), aiConfigNav)}
          {renderSection(t('sections.analytics'), analyticsNav)}
          {renderSection(t('sections.account'), accountNav)}
          {renderSection(t('sections.marketplace'), marketplaceNav)}
        </SidebarNav>
      )}
    </SidebarContainer>
  );
}
