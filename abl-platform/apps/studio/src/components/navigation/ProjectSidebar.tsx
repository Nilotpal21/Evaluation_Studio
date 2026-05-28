/**
 * ProjectSidebar Component
 *
 * Vercel-inspired left sidebar for project workspace.
 * Flat navigation items + drill-down groups that replace the sidebar
 * content when a group is active (detected from current URL).
 */

import {
  Bot,
  MessageSquare,
  Rocket,
  LayoutDashboard,
  Settings,
  ChevronsUpDown,
  ChevronRight,
  Wrench,
  BookOpen,
  Workflow,
  Plug,
  FlaskConical,
  TrendingUp,
  Activity,
  Eye,
  Sparkles,
  Bell,
  ShieldAlert,
  Landmark,
  Inbox,
  Key,
  Variable,
  GitBranch,
  PhoneForwarded,
  Headphones,
  Cpu,
  Cog,
  LineChart,
  Phone,
  Shield,
  KeyRound,
  Paperclip,
  Radio,
  LayoutTemplate,
  CreditCard,
  Package,
  Languages,
  Globe,
  Layers,
  Library,
  BarChart3,
  Database,
  ThumbsUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  SETTINGS_PAGE_SEGMENTS,
  useNavigationStore,
  type ProjectPage,
} from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { clsx } from 'clsx';
import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { usePortalDropdown } from '../../hooks/usePortalDropdown';
import { transitions, springs, STAGGER_DELAY } from '../../lib/animation';
import { useTranslations } from 'next-intl';
import { useFeatures } from '../../hooks/use-features';
import {
  SidebarContainer,
  SidebarCollapseButton,
  SidebarBackButton,
  SidebarNav,
  SidebarNavItem,
  SidebarGroup,
  SidebarZone,
  SidebarLabelTooltip,
  useSidebarLabelOverflow,
} from './sidebar-primitives';

interface ProjectSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface NavItemDef {
  id: ProjectPage;
  Icon: LucideIcon;
  key: string;
  /** Optional section label rendered above this item as a separator */
  section?: string;
}

interface NavGroup {
  id: string;
  Icon: LucideIcon;
  key: string;
  defaultPage: ProjectPage;
  pages: ProjectPage[];
  items: NavItemDef[];
}

// =============================================================================
// NAV DEFINITIONS
// =============================================================================

/** Build — primary authoring surfaces; always visible as flat nav. */
const buildNavDefs: NavItemDef[] = [
  // { id: 'arch-ai', Icon: Sparkles, key: 'arch_ai' }, // deprecated — arch v2
  { id: 'overview', Icon: LayoutDashboard, key: 'overview' },
  { id: 'agents', Icon: Bot, key: 'agents' },
  // 'profiles' (Behavior Profiles) moved into the Settings drill-down —
  // it configures HOW agents respond, alongside other agent-behavior settings.
  { id: 'workflows', Icon: Workflow, key: 'workflows' },
];

/**
 * Resource items — daily-build supporting assets. Templates and the
 * imported-modules listing were both rarely-used reference surfaces;
 * they moved into Settings (see settings group below) so the Resources
 * section stays focused on the three high-traffic dailies.
 */
const resourceNavDefs: NavItemDef[] = [
  { id: 'tools', Icon: Wrench, key: 'tools' },
  { id: 'search-ai', Icon: BookOpen, key: 'knowledge_bases' },
  { id: 'prompt-library', Icon: Library, key: 'prompt_library' },
  { id: 'connections', Icon: Plug, key: 'integrations' },
  { id: 'external-agents', Icon: Globe, key: 'external_agents' },
];

/** Operate — flattened Track 2 IA. Was a drill-down group. */
const operateNavDefs: NavItemDef[] = [
  { id: 'sessions', Icon: MessageSquare, key: 'sessions' },
  { id: 'deployments', Icon: Rocket, key: 'deployments' },
  { id: 'inbox', Icon: Inbox, key: 'inbox' },
  // 'alerts' moved into Settings drill-down — its only meaningful surface
  // is alert-rule configuration; approvals already live under Inbox.
  { id: 'transfer-sessions', Icon: PhoneForwarded, key: 'transfer_sessions' },
];

/** Evaluate — flattened Track 2 IA. Was a drill-down group. */
const evaluateNavDefs: NavItemDef[] = [
  { id: 'evals', Icon: FlaskConical, key: 'evals' },
  // Experiments is temporarily disabled in navigation. Keep the route/render
  // wiring intact so existing deep links do not break while the surface is hidden.
];

/** Govern — flattened Track 2 IA. Was a drill-down group. */
const governNavDefs: NavItemDef[] = [
  { id: 'guardrails-config', Icon: ShieldAlert, key: 'guardrails_config' },
  { id: 'governance', Icon: Landmark, key: 'governance_label' },
];

/**
 * Drill-down groups. Track 2 reduced this set to two — Insights (8 leaves,
 * would dominate a flat sidebar) and Settings (17 leaves with sub-sections).
 * Operate / Evaluate / Govern were promoted to flat sections above.
 */
const navGroups: NavGroup[] = [
  {
    id: 'insights',
    Icon: TrendingUp,
    key: 'insights_group',
    defaultPage: 'dashboard',
    pages: [
      'dashboard',
      'analytics',
      'billing',
      'agent-performance',
      'quality-monitor',
      'customer-insights',
      'feedback',
      'voice-analytics',
      'agent-transfer-insights',
      'pipelines',
    ],
    items: [
      { id: 'dashboard', Icon: TrendingUp, key: 'insights_dashboard' },
      { id: 'analytics', Icon: BarChart3, key: 'analytics' },
      { id: 'billing', Icon: CreditCard, key: 'billing_usage' },
      { id: 'agent-performance', Icon: Activity, key: 'agent_performance' },
      { id: 'quality-monitor', Icon: Eye, key: 'quality_monitor' },
      { id: 'customer-insights', Icon: Sparkles, key: 'customer_insights' },
      { id: 'feedback', Icon: ThumbsUp, key: 'feedback' },
      { id: 'voice-analytics', Icon: Phone, key: 'voice_analytics' },
      { id: 'agent-transfer-insights', Icon: PhoneForwarded, key: 'agent_transfer_insights' },
      { id: 'pipelines', Icon: Cpu, key: 'pipelines' },
    ],
  },
  {
    id: 'settings',
    Icon: Settings,
    key: 'settings_group',
    defaultPage: 'settings-members',
    pages: [
      'settings-members',
      'settings-api-keys',
      'settings-models',
      'settings-runtime-config',
      'settings-data-retention',
      'settings-config-vars',
      'settings-localization',
      'settings-git',
      'settings-auth-profiles',
      'profiles',
      'alerts',
      'settings-agent-transfer',
      'settings-agent-assist',
      'settings-pii-protection',
      'settings-public-api',
      'settings-attachments',
      'settings-omnichannel',
      'templates',
      'module-dependencies',
      'settings-modules',
      'settings-trace-dimensions',
      'settings-advanced',
    ],
    items: [
      { id: 'settings-members', Icon: Settings, key: 'members', section: 'General' },
      { id: 'settings-api-keys', Icon: Key, key: 'api_keys' },
      { id: 'settings-models', Icon: Cpu, key: 'models' },
      { id: 'settings-runtime-config', Icon: Cog, key: 'runtime_config' },
      { id: 'settings-data-retention', Icon: Database, key: 'data_retention' },
      { id: 'settings-config-vars', Icon: Variable, key: 'config_vars' },
      { id: 'settings-localization', Icon: Languages, key: 'localization' },
      { id: 'settings-git', Icon: GitBranch, key: 'git', section: 'Integrations' },
      { id: 'settings-auth-profiles', Icon: KeyRound, key: 'auth_profiles' },
      {
        id: 'profiles',
        Icon: Layers,
        key: 'behavior_profiles',
        section: 'Agent Behavior',
      },
      { id: 'alerts', Icon: Bell, key: 'alert_settings' },
      { id: 'settings-agent-transfer', Icon: PhoneForwarded, key: 'agent_transfer' },
      {
        id: 'settings-agent-assist',
        Icon: Headphones,
        key: 'agent_assist',
      },
      {
        id: 'settings-pii-protection',
        Icon: Shield,
        key: 'pii_protection',
        section: 'Security & Observability',
      },
      { id: 'settings-public-api', Icon: Globe, key: 'public_api' },
      { id: 'settings-attachments', Icon: Paperclip, key: 'attachments' },
      { id: 'settings-omnichannel', Icon: Radio, key: 'omnichannel' },
      // Reference / catalog surfaces — moved here from the Resources
      // section to reclaim sidebar real estate. Both are rarely visited
      // during day-to-day agent development; settings is where reference
      // and config surfaces live.
      { id: 'templates', Icon: LayoutTemplate, key: 'templates', section: 'Catalog' },
      { id: 'module-dependencies', Icon: Package, key: 'imported_modules' },
      { id: 'settings-modules', Icon: Package, key: 'module_publishing' },
      { id: 'settings-trace-dimensions', Icon: LineChart, key: 'trace_dimensions' },
      { id: 'settings-advanced', Icon: Cog, key: 'advanced', section: 'Advanced' },
    ],
  },
];

// =============================================================================
// ANIMATION VARIANTS
// =============================================================================

const containerVariants = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { staggerChildren: STAGGER_DELAY, delayChildren: 0.04 } },
  exit: { opacity: 0, transition: { staggerChildren: 0.02, staggerDirection: -1 } },
};

const navItemVariants = {
  enter: { opacity: 0, y: 6 },
  center: { opacity: 1, y: 0, transition: springs.soft },
  exit: { opacity: 0, y: -3 },
};

interface ProjectGroupNavItemProps {
  group: NavGroup;
  activePage: ProjectPage;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigate: (pageId: ProjectPage) => void;
  label: string;
}

function ProjectGroupNavItem({
  group,
  activePage,
  collapsed,
  onToggleCollapse,
  onNavigate,
  label,
}: ProjectGroupNavItemProps) {
  const isGroupActive = group.pages.includes(activePage);
  const { labelRef, labelOverflows } = useSidebarLabelOverflow(label, !collapsed);
  const showTooltip = collapsed || labelOverflows;

  return (
    <SidebarLabelTooltip content={label} enabled={showTooltip}>
      <button
        onClick={() => {
          if (collapsed) {
            onToggleCollapse();
          }
          onNavigate(group.defaultPage);
        }}
        title={label}
        aria-current={isGroupActive ? 'page' : undefined}
        className={clsx(
          'w-full relative flex items-center gap-2 rounded text-sm tracking-[-0.01em] transition-default',
          collapsed ? 'justify-center px-0 py-1.5' : 'px-2 py-1.5',
          isGroupActive
            ? 'bg-[hsl(var(--color-brand-active-bg))] font-medium'
            : 'text-foreground font-normal hover:bg-[hsl(var(--sidebar-hover))]',
        )}
      >
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
          <group.Icon
            className={clsx(
              'w-4 h-4',
              isGroupActive ? 'text-[hsl(var(--color-brand-primary))]' : 'text-foreground',
            )}
          />
        </span>
        {!collapsed && (
          <>
            <span
              ref={labelRef}
              className={clsx(
                'truncate flex-1 text-left',
                isGroupActive &&
                  'from-[hsl(var(--color-brand-primary))] to-[hsl(var(--color-brand-secondary))] bg-clip-text text-transparent bg-gradient-to-r',
              )}
            >
              {label}
            </span>
            <ChevronRight
              className={clsx(
                'w-3.5 h-3.5 shrink-0',
                isGroupActive ? 'text-[hsl(var(--color-brand-primary))]' : 'text-subtle',
              )}
            />
          </>
        )}
      </button>
    </SidebarLabelTooltip>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ProjectSidebar({ collapsed, onToggleCollapse }: ProjectSidebarProps) {
  const t = useTranslations('nav');
  const tSidebar = useTranslations('app_shell.project_sidebar');
  const page = useNavigationStore((s) => s.page);
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const { hasGovernance } = useFeatures();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherDropdownRef = useRef<HTMLDivElement>(null);
  const { coords: switcherCoords, updateCoords: updateSwitcherCoords } = usePortalDropdown(
    switcherTriggerRef,
    { align: 'left', gap: 4 },
  );

  const activePage = (page || 'overview') as ProjectPage;
  const visibleGovernNavDefs = useMemo(
    () => governNavDefs.filter((def) => def.id !== 'governance' || hasGovernance),
    [hasGovernance],
  );

  // Derive active group from current page URL
  const activeGroup = useMemo(
    () => navGroups.find((g) => g.pages.includes(activePage)) || null,
    [activePage],
  );

  // Close switcher on click outside — listener only attached while open.
  useEffect(() => {
    if (!switcherOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !switcherTriggerRef.current?.contains(target) &&
        !switcherDropdownRef.current?.contains(target)
      ) {
        setSwitcherOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [switcherOpen]);

  const handleNav = (pageId: ProjectPage) => {
    if (projectId) {
      const settingsSegment = SETTINGS_PAGE_SEGMENTS[pageId as keyof typeof SETTINGS_PAGE_SEGMENTS];
      navigate(
        settingsSegment
          ? `/projects/${projectId}/settings/${settingsSegment}`
          : `/projects/${projectId}/${pageId}`,
      );
    }
  };

  const handleProjectSwitch = (pid: string) => {
    navigate(`/projects/${pid}`);
    setSwitcherOpen(false);
  };

  const handleBackToMain = () => {
    if (projectId) {
      navigate(`/projects/${projectId}/overview`);
    }
  };

  // ─── Height rhythm ───────────────────────────────────────────
  // ALL interactive rows in the sidebar must use py-1 (4px top + 4px bottom).
  // This gives ~28px for text rows and ~32px for rows with a 24px avatar/icon.
  // NEVER change individual paddings without updating ALL zones below.
  // Zones: search button, switcher button, switcher container, user menu wrapper.

  // ─── Render helpers ──────────────────────────────────────────

  const renderNavItem = (def: NavItemDef) => {
    const isActive = activePage === def.id;
    const label = t(def.key);
    return (
      <motion.div key={def.id} variants={navItemVariants}>
        <SidebarNavItem
          section={def.id}
          label={label}
          Icon={def.Icon}
          isActive={isActive}
          collapsed={collapsed}
          onClick={() => handleNav(def.id)}
          surface="project"
        />
      </motion.div>
    );
  };

  const renderGroupItem = (group: NavGroup) => {
    const label = t(group.key);
    return (
      <ProjectGroupNavItem
        key={group.id}
        group={group}
        activePage={activePage}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onNavigate={handleNav}
        label={label}
      />
    );
  };

  // ─── Sidebar content ──────────────────────────────────────────

  const mainView = (
    <motion.div
      key="main"
      variants={containerVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={transitions.stageSlide}
      className="space-y-1"
    >
      <SidebarGroup label={t('section_build')} collapsed={collapsed} surface="project">
        {buildNavDefs.map(renderNavItem)}
      </SidebarGroup>
      <SidebarGroup label={t('section_resources')} collapsed={collapsed} surface="project">
        {resourceNavDefs.map(renderNavItem)}
      </SidebarGroup>
      <SidebarGroup label={t('section_evaluate')} collapsed={collapsed} surface="project">
        {evaluateNavDefs.map(renderNavItem)}
      </SidebarGroup>
      <SidebarGroup label={t('section_operate')} collapsed={collapsed} surface="project">
        {operateNavDefs.map(renderNavItem)}
      </SidebarGroup>
      <SidebarGroup label={t('section_govern')} collapsed={collapsed} surface="project">
        {visibleGovernNavDefs.map(renderNavItem)}
      </SidebarGroup>
      <div className="pt-2">{navGroups.map(renderGroupItem)}</div>
    </motion.div>
  );

  const drillDownView = activeGroup && (
    <motion.div
      key={`group-${activeGroup.id}`}
      variants={containerVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={transitions.stageSlide}
      className="space-y-1"
    >
      {/* Back button */}
      <SidebarBackButton onClick={handleBackToMain} label={t(activeGroup.key)} surface="project" />

      {/* Sub-items */}
      {activeGroup.items.map((item) => (
        <div key={item.id}>
          {item.section && (
            <p className="px-[var(--sidebar-gutter)] pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-[0.07em] text-muted">
              {item.section}
            </p>
          )}
          {renderNavItem(item)}
        </div>
      ))}
    </motion.div>
  );

  return (
    <>
      <SidebarContainer
        surface="project"
        collapsed={collapsed}
        width={240}
        collapsedWidth={56}
        ariaLabel="Project sidebar"
      >
        {/* Project Switcher + Collapse toggle — single row */}
        <SidebarZone
          collapsed={collapsed}
          center
          className={collapsed ? 'flex-col' : 'h-12 flex items-center border-b border-default'}
        >
          {collapsed ? (
            <>
              <div className="h-12 flex items-center justify-center border-b border-default">
                <button
                  ref={switcherTriggerRef}
                  onClick={() => {
                    if (!switcherOpen) updateSwitcherCoords();
                    setSwitcherOpen(!switcherOpen);
                  }}
                  aria-label="Switch project"
                  aria-expanded={switcherOpen}
                  aria-haspopup="listbox"
                  className="w-6 h-6 rounded bg-accent flex items-center justify-center text-accent-foreground text-xs font-bold hover:opacity-80 transition-default"
                >
                  {(currentProject?.name || 'P')[0].toUpperCase()}
                </button>
              </div>
              <div className="h-12 flex items-center justify-center">
                <SidebarCollapseButton
                  collapsed={collapsed}
                  onToggle={onToggleCollapse}
                  surface="project"
                  ariaLabel={t('expand')}
                  title={t('expand')}
                />
              </div>
            </>
          ) : (
            <div className="w-full flex items-center gap-1.5">
              <button
                ref={switcherTriggerRef}
                onClick={() => {
                  if (!switcherOpen) updateSwitcherCoords();
                  setSwitcherOpen(!switcherOpen);
                }}
                aria-label="Switch project"
                aria-expanded={switcherOpen}
                aria-haspopup="listbox"
                title={currentProject?.name || t('select_project')}
                className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[hsl(var(--sidebar-hover))] transition-default text-left group"
              >
                <div className="w-5 h-5 rounded bg-accent flex items-center justify-center text-accent-foreground text-xs font-bold shrink-0">
                  {(currentProject?.name || 'P')[0].toUpperCase()}
                </div>
                <span className="text-sm font-normal text-foreground truncate flex-1">
                  {currentProject?.name || t('select_project')}
                </span>
                <ChevronsUpDown className="w-3.5 h-3.5 text-subtle shrink-0" />
              </button>
              <SidebarCollapseButton
                collapsed={collapsed}
                onToggle={onToggleCollapse}
                surface="project"
                ariaLabel={t('collapse')}
                title={t('collapse')}
              />
            </div>
          )}
        </SidebarZone>

        {/* Navigation — flat items + drill-down groups */}
        <SidebarNav collapsed={collapsed}>
          {collapsed ? (
            // Collapsed: show all items as icons with separators
            <div className="space-y-1">
              <SidebarGroup label={t('section_build')} collapsed={collapsed} surface="project">
                {buildNavDefs.map(renderNavItem)}
              </SidebarGroup>
              <SidebarGroup label={t('section_resources')} collapsed={collapsed} surface="project">
                {resourceNavDefs.map(renderNavItem)}
              </SidebarGroup>
              <SidebarGroup label={t('section_evaluate')} collapsed={collapsed} surface="project">
                {evaluateNavDefs.map(renderNavItem)}
              </SidebarGroup>
              <SidebarGroup label={t('section_operate')} collapsed={collapsed} surface="project">
                {operateNavDefs.map(renderNavItem)}
              </SidebarGroup>
              <SidebarGroup label={t('section_govern')} collapsed={collapsed} surface="project">
                {visibleGovernNavDefs.map(renderNavItem)}
              </SidebarGroup>
              <div className="pt-2">{navGroups.map(renderGroupItem)}</div>
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {activeGroup ? drillDownView : mainView}
            </AnimatePresence>
          )}
        </SidebarNav>
      </SidebarContainer>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {switcherOpen && switcherCoords && (
              <motion.div
                ref={switcherDropdownRef}
                style={switcherCoords}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                role="listbox"
                className="w-56 bg-[hsl(var(--background-elevated))] border border-default rounded-xl shadow-xl z-portal-dropdown overflow-hidden"
              >
                <div className="px-2 pt-2 pb-1">
                  <input
                    type="text"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    placeholder={tSidebar('search_projects_placeholder')}
                    className="w-full px-2 py-1 text-xs bg-background border border-default rounded text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-[hsl(var(--border-focus))]"
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {projects
                    .filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleProjectSwitch(p.id)}
                        role="option"
                        aria-selected={p.id === projectId}
                        title={p.name}
                        className={clsx(
                          'w-full flex items-center gap-2 px-2 py-1 text-sm text-left transition-default',
                          p.id === projectId
                            ? 'bg-accent-subtle text-accent'
                            : 'text-muted hover:text-foreground hover:bg-background-muted',
                        )}
                      >
                        <div className="w-5 h-5 rounded bg-background-muted flex items-center justify-center text-xs font-bold shrink-0">
                          {p.name[0].toUpperCase()}
                        </div>
                        <span className="truncate">{p.name}</span>
                      </button>
                    ))}
                </div>
                <div className="border-t border-default">
                  <button
                    onClick={() => {
                      navigate('/');
                      setSwitcherOpen(false);
                    }}
                    className="w-full px-3 py-2 text-xs text-left text-muted hover:text-foreground hover:bg-background-muted transition-default"
                  >
                    {tSidebar('view_all_projects')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
