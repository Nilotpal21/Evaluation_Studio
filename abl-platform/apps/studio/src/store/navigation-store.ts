/**
 * Navigation Store
 *
 * Manages client-side routing via history.pushState.
 * Parses URL into structured route segments and syncs state <-> URL.
 */

import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

// =============================================================================
// TYPES
// =============================================================================

export type NavigationArea = 'projects' | 'project' | 'admin' | 'settings' | 'arch';

export type ProjectPage =
  | 'overview'
  | 'arch-ai'
  | 'agents'
  | 'profiles'
  | 'tools'
  | 'mcp-servers'
  | 'sessions'
  | 'deployments'
  | 'search-ai'
  | 'workflows'
  | 'connections'
  | 'external-agents' // external A2A/REST agent registry
  | 'prompt-library' // reusable versioned prompt templates
  | 'templates' // rich content template catalog
  | 'inbox' // workflow approvals
  | 'evals' // NEW — evaluations (personas, scenarios, evaluators, eval sets, runs)
  | 'experiments' // NEW — A/B testing, versioning
  | 'dashboard' // NEW — executive KPIs
  | 'analytics' // NEW — project analytics explorers and performance dashboards
  | 'billing' // NEW — project billing units and usage reports
  | 'agent-performance' // NEW — per-agent diagnostics
  | 'quality-monitor' // NEW — watchtower
  | 'customer-insights' // NEW — intents, VoC, sentiment
  | 'feedback' // NEW — in-chat feedback viewer (ABLP-1084)
  | 'voice-analytics' // NEW — aggregated voice metrics and quality trends
  | 'agent-transfer-insights' // NEW — KoreAgentAssist queues & agents analytics
  | 'pipelines' // NEW — pipeline configuration and custom pipeline editor
  | 'alerts' // NEW — proactive notifications
  | 'guardrails-config' // NEW — guardrail policies top-level
  | 'governance' // NEW — agent registry, compliance
  | 'settings'
  | 'settings-members'
  | 'settings-api-keys'
  | 'settings-models'
  | 'settings-config-vars'
  | 'settings-localization'
  | 'settings-git'
  | 'settings-advanced'
  | 'settings-runtime-config'
  | 'settings-data-retention'
  | 'settings-trace-dimensions'
  | 'settings-agent-transfer'
  | 'settings-agent-assist'
  | 'settings-pii-protection'
  | 'settings-public-api'
  | 'settings-auth-profiles'
  | 'settings-attachments'
  | 'settings-omnichannel'
  | 'settings-modules'
  | 'module-dependencies'
  | 'transfer-sessions';

export const SETTINGS_PAGE_SEGMENTS = {
  'settings-members': 'members',
  'settings-api-keys': 'api-keys',
  'settings-models': 'models',
  'settings-config-vars': 'config-vars',
  'settings-localization': 'localization',
  'settings-git': 'git',
  'settings-advanced': 'advanced',
  'settings-runtime-config': 'runtime-config',
  'settings-data-retention': 'data-retention',
  'settings-trace-dimensions': 'trace-dimensions',
  'settings-agent-transfer': 'agent-transfer',
  'settings-agent-assist': 'agent-assist',
  'settings-pii-protection': 'pii-protection',
  'settings-auth-profiles': 'auth-profiles',
  'settings-attachments': 'attachments',
  'settings-omnichannel': 'omnichannel',
  'settings-modules': 'modules',
  'settings-public-api': 'public-api',
} as const satisfies Partial<Record<ProjectPage, string>>;

const SETTINGS_SEGMENT_TO_PAGE = Object.fromEntries(
  Object.entries(SETTINGS_PAGE_SEGMENTS).map(([page, segment]) => [segment, page]),
) as Record<string, ProjectPage>;

export type AdminPage =
  | 'members'
  | 'models'
  | 'voice'
  | 'security'
  | 'audit-logs'
  | 'secrets'
  | 'billing'
  | 'arch'
  | 'kms'
  | 'env-vars'
  | 'guardrails'
  | 'connectors'
  | 'auth-profiles'
  | 'analytics-agents'
  | 'analytics-sessions'
  | 'analytics-traces'
  | 'roles'
  | 'workspace-settings'
  | 'template-manager';

export interface Breadcrumb {
  label: string;
  path: string;
}

interface NavigateOptions {
  replace?: boolean;
}

interface NavigationState {
  // Route segments
  area: NavigationArea;
  projectId: string | null;
  page: string | null;
  subPage: string | null;
  subPageLabel: string | null;
  tab: string | null;
  subSection: string | null;

  // UI state
  sidebarCollapsed: boolean;

  // Derived
  breadcrumbs: Breadcrumb[];

  // KG tab view state (used by KnowledgeGraphTab + KG Hub Card auto-navigation)
  kgView: 'graph' | 'statistics' | 'attributes';
  setKgView: (view: 'graph' | 'statistics' | 'attributes') => void;

  // Actions
  navigate: (path: string, options?: NavigateOptions) => void;
  goBack: () => void;
  setTab: (tab: string | null) => void;
  setSubSection: (subSection: string | null) => void;
  setTabAndSubSection: (tab: string | null, subSection: string | null) => void;
  setSubPageLabel: (label: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

// =============================================================================
// URL PARSING
// =============================================================================

function parseUrl(
  pathname: string,
): Pick<NavigationState, 'area' | 'projectId' | 'page' | 'subPage' | 'tab' | 'subSection'> {
  const pathOnly = pathname.split(/[?#]/)[0] ?? '';
  const parts = pathOnly.split('/').filter(Boolean);

  // Redirect old platform-admin URLs to root (migrated to Admin App)
  if (parts[0] === 'platform-admin') {
    return {
      area: 'projects',
      projectId: null,
      page: null,
      subPage: null,
      tab: null,
      subSection: null,
    };
  }

  // /admin/*
  if (parts[0] === 'admin') {
    return {
      area: 'admin',
      projectId: null,
      page: parts[1] || 'members',
      subPage: parts[2] || null,
      tab: null,
      subSection: null,
    };
  }

  // /settings/*
  if (parts[0] === 'settings') {
    return {
      area: 'settings',
      projectId: null,
      page: parts[1] || null,
      subPage: parts[2] || null,
      tab: null,
      subSection: null,
    };
  }

  // /chat — legacy alias for the v3 standalone page
  if (parts[0] === 'chat') {
    return {
      area: 'projects',
      projectId: null,
      page: 'chat',
      subPage: null,
      tab: null,
      subSection: null,
    };
  }

  // /arch — Arch AI v0.3 standalone page
  if (parts[0] === 'arch') {
    return {
      area: 'arch',
      projectId: null,
      page: null,
      subPage: null,
      tab: null,
      subSection: null,
    };
  }

  // /projects/new — legacy alias for project creation via Arch
  if (parts[0] === 'projects' && parts[1] === 'new') {
    return {
      area: 'projects',
      projectId: null,
      page: 'new',
      subPage: null,
      tab: null,
      subSection: null,
    };
  }

  // /projects/:id/*
  if (parts[0] === 'projects' && parts[1]) {
    const projectId = parts[1];
    let page = parts[2] || 'overview';
    const subPage = parts[3] || null;
    let tab = parts[4] || null;
    const subSection = parts[5] || null;

    // Settings sub-pages: /projects/:id/settings/members → page: 'settings-members'
    if (page === 'settings' && subPage) {
      const mapped = SETTINGS_SEGMENT_TO_PAGE[subPage];
      if (mapped) {
        return {
          area: 'project',
          projectId,
          page: mapped,
          subPage: null,
          tab,
          subSection: null,
        };
      }
    }

    // Bare /projects/:id/settings → default to settings-members
    if (page === 'settings' && !subPage) {
      return {
        area: 'project',
        projectId,
        page: 'settings-members',
        subPage: null,
        tab: null,
        subSection: null,
      };
    }

    // Legacy URL redirects
    if (page === 'observability' || page === 'contacts') {
      page = 'overview';
    }
    if (page === 'traces') {
      page = 'sessions';
      tab = 'traces';
    }
    return {
      area: 'project',
      projectId,
      page,
      subPage,
      tab,
      subSection,
    };
  }

  // / (root) → projects dashboard
  return {
    area: 'projects',
    projectId: null,
    page: null,
    subPage: null,
    tab: null,
    subSection: null,
  };
}

const LABEL_OVERRIDES: Record<string, string> = {
  'search-ai': 'Search AI',
  'mcp-servers': 'MCP Servers',
  connections: 'Integrations',
  'external-agents': 'External Agents',
  'module-dependencies': 'Dependencies',
  'settings-modules': 'Modules',
  'settings-api-keys': 'API Keys',
  'settings-pii-protection': 'PII Protection',
  'settings-localization': 'Localization',
  'settings-public-api': 'Public API Access',
};

function slugToLabel(slug: string): string {
  return (
    LABEL_OVERRIDES[slug] ??
    slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function buildBreadcrumbs(
  state: Pick<
    NavigationState,
    'area' | 'projectId' | 'page' | 'subPage' | 'subPageLabel' | 'tab' | 'subSection'
  >,
): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [];

  if (state.area === 'projects') {
    crumbs.push({ label: 'Projects', path: '/' });
  }

  if (state.area === 'project' && state.projectId) {
    crumbs.push({ label: 'Projects', path: '/' });
    const project = useProjectStore.getState().projects.find((p) => p.id === state.projectId);
    const projectLabel = project?.name || 'Project';
    crumbs.push({ label: projectLabel, path: `/projects/${state.projectId}` });

    if (state.page && state.page !== 'overview') {
      const label = slugToLabel(state.page);
      crumbs.push({
        label,
        path: buildPath({
          area: 'project',
          projectId: state.projectId,
          page: state.page,
          subPage: null,
          tab: null,
          subSection: null,
        }),
      });
    }

    if (state.subPage) {
      crumbs.push({
        label: state.subPageLabel ?? state.subPage,
        path: `/projects/${state.projectId}/${state.page}/${state.subPage}`,
      });
    }

    if (state.subSection) {
      const label = slugToLabel(state.subSection);
      crumbs.push({
        label,
        path: `/projects/${state.projectId}/${state.page}/${state.subPage}${state.tab ? `/${state.tab}` : ''}/${state.subSection}`,
      });
    }
  }

  if (state.area === 'arch') {
    crumbs.push({ label: 'All Projects', path: '/' });
    crumbs.push({ label: 'Arch', path: '/arch' });
  }

  if (state.area === 'admin') {
    crumbs.push({ label: 'Projects', path: '/' });
    crumbs.push({ label: 'Admin', path: '/admin' });
    if (state.page) {
      const label = slugToLabel(state.page);
      crumbs.push({ label, path: `/admin/${state.page}` });
    }
  }

  return crumbs;
}

function buildPath(
  state: Pick<NavigationState, 'area' | 'projectId' | 'page' | 'subPage' | 'tab' | 'subSection'>,
): string {
  if (state.area === 'admin') {
    return `/admin/${state.page || 'members'}${state.subPage ? `/${state.subPage}` : ''}`;
  }
  if (state.area === 'project' && state.projectId) {
    if (state.page && state.page in SETTINGS_PAGE_SEGMENTS) {
      return `/projects/${state.projectId}/settings/${SETTINGS_PAGE_SEGMENTS[state.page as keyof typeof SETTINGS_PAGE_SEGMENTS]}`;
    }

    let path = `/projects/${state.projectId}`;
    if (state.page) path += `/${state.page}`;
    if (state.subPage) path += `/${state.subPage}`;
    if (state.tab) path += `/${state.tab}`;
    if (state.subSection) path += `/${state.subSection}`;
    return path;
  }
  return '/';
}

// =============================================================================
// LOCAL PREFERENCES (sidebar collapse)
// =============================================================================
//
// Sidebar collapse is a per-user UI preference and should persist across
// page reloads, navigation, and browser sessions. We use localStorage
// directly rather than the server-backed preferences-store because the
// state is small, latency-sensitive (we want it hydrated synchronously
// before first paint), and not worth a server round-trip.

const SIDEBAR_COLLAPSED_KEY = 'studio:sidebar-collapsed';

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — silently
    // skip; the runtime store still holds the value for the session.
  }
}

// =============================================================================
// STORE
// =============================================================================

export const useNavigationStore = create<NavigationState>((set, get) => {
  // Parse initial URL
  const parsed =
    typeof window !== 'undefined'
      ? parseUrl(window.location.pathname)
      : {
          area: 'projects' as const,
          projectId: null,
          page: null,
          subPage: null,
          tab: null,
          subSection: null,
        };
  const initial = { ...parsed, subPageLabel: null };

  return {
    ...initial,
    sidebarCollapsed: loadSidebarCollapsed(),
    kgView: 'graph',
    breadcrumbs: buildBreadcrumbs(initial),

    setKgView: (view: 'graph' | 'statistics' | 'attributes') => {
      set({ kgView: view });
    },

    navigate: (path: string, options?: NavigateOptions) => {
      const current = get();
      const parsed = parseUrl(path);
      if (current.area === 'arch' && parsed.area === 'project') {
        useArchAIStore.getState().resetProjectState();
      }
      const withLabel = { ...parsed, subPageLabel: null };
      const breadcrumbs = buildBreadcrumbs(withLabel);
      if (options?.replace) {
        window.history.replaceState({}, '', path);
      } else {
        window.history.pushState({}, '', path);
      }
      set({ ...withLabel, breadcrumbs });
    },

    goBack: () => {
      window.history.back();
    },

    setTab: (tab: string | null) => {
      const state = get();
      // Reset subSection when switching tabs to prevent stale sub-routes
      const newState = { ...state, tab, subSection: null };
      const path = buildPath(newState);
      window.history.pushState({}, '', path);
      const breadcrumbs = buildBreadcrumbs({ ...state, tab, subSection: null });
      set({ tab, subSection: null, breadcrumbs });
    },

    setSubSection: (subSection: string | null) => {
      const state = get();
      const newState = { ...state, subSection };
      const path = buildPath(newState);
      window.history.pushState({}, '', path);
      const breadcrumbs = buildBreadcrumbs({ ...state, subSection });
      set({ subSection, breadcrumbs });
    },

    setTabAndSubSection: (tab: string | null, subSection: string | null) => {
      const state = get();
      const newState = { ...state, tab, subSection };
      const path = buildPath(newState);
      window.history.pushState({}, '', path);
      const breadcrumbs = buildBreadcrumbs({ ...state, tab, subSection });
      set({ tab, subSection, breadcrumbs });
    },

    setSubPageLabel: (label: string | null) => {
      const state = get();
      const breadcrumbs = buildBreadcrumbs({ ...state, subPageLabel: label });
      set({ subPageLabel: label, breadcrumbs });
    },

    setSidebarCollapsed: (collapsed: boolean) => {
      set({ sidebarCollapsed: collapsed });
      saveSidebarCollapsed(collapsed);
    },
  };
});

// Listen for browser back/forward
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const current = useNavigationStore.getState();
    const parsed = parseUrl(window.location.pathname);
    if (current.area === 'arch' && parsed.area === 'project') {
      useArchAIStore.getState().resetProjectState();
    }
    const withLabel = { ...parsed, subPageLabel: null };
    const breadcrumbs = buildBreadcrumbs(withLabel);
    useNavigationStore.setState({ ...withLabel, breadcrumbs });
  });
}
