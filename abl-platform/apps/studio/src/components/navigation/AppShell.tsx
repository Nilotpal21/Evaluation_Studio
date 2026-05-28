/**
 * AppShell Component
 *
 * Top-level layout router. Reads navigation store to render the correct
 * sidebar + content combination.
 *
 * Layout structure:
 *   [Header] ─────────────────────────────────────
 *   [Sidebar] | [Page Content]
 *
 * Mobile: sidebar becomes overlay drawer, header gets hamburger menu.
 */

import { useState, useEffect, useRef } from 'react';
import { Menu, X, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AnimatePresence, motion } from 'framer-motion';

import { springs } from '../../lib/animation';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useAuthStore } from '../../store/auth-store';
import { useModuleStore } from '../../store/module-store';
import { fetchProject, loadProjects } from '../../api/projects';
import { canAccessWorkspaceAdmin } from '../../lib/auth-token';
import { ProjectSidebar } from './ProjectSidebar';
import { AdminSidebar } from './AdminSidebar';
import { ThemeToggle } from '../ui/ThemeToggle';
import { ArchIcon } from '@/components/arch-shared/ArchIcon';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { WebSocketProvider } from '../../contexts/WebSocketContext';
import { useRuntimeConfig } from '../../contexts/RuntimeConfigContext';
import { PageHeaderProvider, usePageHeaderState } from '../../contexts/PageHeaderContext';
import { PageBreadcrumb } from '../ui/PageBreadcrumb';
import { SoftphoneButton } from '../softphone/SoftphoneButton';
import { KoreIcon } from '../ui/KoreLogo';
import { UserMenu } from '../auth/UserMenu';
import { IsolatedErrorBoundary } from '../ui/IsolatedErrorBoundary';
import { UniversalSearch } from './UniversalSearch';
import { syncProjectSelectionFromNavigation } from './project-selection-sync';
import { deriveDefaultWsUrl } from '../../utils/derive-ws-url';
import { useFeatures } from '../../hooks/use-features';

// Page imports
import { ProjectDashboard } from '../projects/ProjectDashboard';
import { ChatWithDebugPanel } from '../chat/ChatWithDebugPanel';
import { SessionsListPage } from '../session/SessionsListPage';
import { SessionDetailPage } from '../session/SessionDetailPage';
import { AgentListPage } from '../agents/AgentListPage';
import { AgentDetailPage } from '../agents/AgentDetailPage';
import { AgentEditorPage } from '../agent-editor';
import { AGENT_EDITOR_CONFIG } from '../agent-editor/agent-editor-config';
import { ProfileListPage } from '../profiles/ProfileListPage';
import { ProfileDetailPage } from '../profiles/ProfileDetailPage';
import { ProjectMembersTab } from '../settings/ProjectMembersTab';
import { ApiKeysTab } from '../settings/ApiKeysTab';
import { ModelConfigTab } from '../settings/ModelConfigTab';
import { ConfigVariablesTab } from '../settings/ConfigVariablesTab';
import { LocalizationSettingsPage } from '../settings/LocalizationSettingsPage';
import { GitIntegrationTab } from '../settings/GitIntegrationTab';
import { AdvancedSettingsTab } from '../settings/AdvancedSettingsTab';
import { RuntimeConfigTab } from '../settings/RuntimeConfigTab';
import { DataRetentionSettingsPage } from '../settings/DataRetentionSettingsPage';
import { TraceDimensionsTab } from '../settings/TraceDimensionsTab';
import { AgentTransferSettingsPage } from '../settings/AgentTransferSettingsPage';
import { AgentAssistSettingsPage } from '../settings/AgentAssistSettingsPage';
import { PIIProtectionTab } from '../settings/PIIProtectionTab';
import { PublicApiAccessTab } from '../settings/PublicApiAccessTab';
import { AuthProfilesPage } from '../auth-profiles/AuthProfilesPage';
import { AttachmentSettingsTab } from '../settings/AttachmentSettingsTab';
import { OmnichannelSettingsPanel } from '../projects/OmnichannelSettingsPanel';
import { ApiKeysPage } from '../settings/ApiKeysPage';
import { DeploymentsPage } from '../deployments/DeploymentsPage';
import { ModuleDependenciesPage } from '../modules/ModuleDependenciesPage';
import { ModuleSettingsPage } from '../modules/ModuleSettingsPage';
import { ProjectOverviewPage } from '../overview/ProjectOverviewPage';
import { ProjectBillingPage } from '../projects/ProjectBillingPage';
// Imported agent/tool detail loaders
import { ImportedAgentDetailLoader } from '../agents/ImportedAgentDetailLoader';
import { ImportedToolDetailLoader } from '../tools/ImportedToolDetailLoader';
// Tool pages
import { ToolsListPage } from '../tools/ToolsListPage';
import { ToolDetailPage } from '../tools/ToolDetailPage';
import { ToolCreatePage } from '../tools/ToolCreatePage';
// MCP Server pages
import { McpServerDetailPage } from '../mcp-servers/McpServerDetailPage';
// Voice Analytics page
import { VoiceAnalyticsPage } from '../voice-analytics/VoiceAnalyticsPage';
// Agent Transfer Insights page (lazy-loaded)
const AgentTransferInsightsPage = dynamic(
  () =>
    import('../agent-transfer-insights/AgentTransferInsightsPage').then((m) => ({
      default: m.AgentTransferInsightsPage,
    })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
// Insights pages (lazy-loaded — contains recharts)
import dynamic from 'next/dynamic';
const AtAGlancePage = dynamic(
  () => import('../insights/AtAGlancePage').then((m) => ({ default: m.AtAGlancePage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const AnalyticsPage = dynamic(
  () => import('../analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const CustomerInsightsPage = dynamic(
  () =>
    import('../insights/CustomerInsightsPage').then((m) => ({
      default: m.CustomerInsightsPage,
    })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
// Pipeline pages (lazy-loaded)
const PipelinesListPage = dynamic(
  () => import('../pipelines/PipelinesListPage').then((m) => ({ default: m.PipelinesListPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const PipelineConfigPage = dynamic(
  () => import('../pipelines/PipelineConfigPage').then((m) => ({ default: m.PipelineConfigPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const PipelineEditorPage = dynamic(
  () => import('../pipelines/PipelineEditorPage').then((m) => ({ default: m.PipelineEditorPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
// SearchAI pages
import { KnowledgeBaseDashboardPage } from '../search-ai/KnowledgeBaseDashboardPage';
import { KnowledgeBaseDetailPage } from '../search-ai/KnowledgeBaseDetailPage';
import { UnifiedSourcePage } from '../search-ai/source-page/UnifiedSourcePage';
// Workflow pages
import { WorkflowsListPage } from '../workflows/WorkflowsListPage';
import { WorkflowDetailPage } from '../workflows/WorkflowDetailPage';
import { WorkflowCanvasPage } from '../workflows/canvas/WorkflowCanvasPage';
import { ConnectionsPage } from '../connections/ConnectionsPage';
// External Agents page
import { ExternalAgentsPage } from '../external-agents/ExternalAgentsPage';
// Evals page
import { EvalsPage } from '../evals/EvalsPage';
// Experiments pages
import { ExperimentsPage } from '../experiments/ExperimentsPage';
import { ExperimentDetail } from '../experiments/ExperimentDetail';
// Unified Inbox (human-in-the-loop tasks)
import { UnifiedInboxPage } from '../inbox/UnifiedInboxPage';
// Alerts page
import { AlertsPage } from '../alerts/AlertsPage';
// Governance page
import { GovernancePage } from '../governance/GovernancePage';
// Transfer Sessions (operate)
import { TransferSessionsPage } from '../operate/TransferSessionsPage';
// Arch v4 in-project overlay (lazy)
const ArchV4Overlay = dynamic(
  () =>
    import('@/lib/arch-ai/components/arch/overlay/ArchOverlay').then((m) => ({
      default: m.ArchOverlay,
    })),
  { ssr: false },
);
// Arch v0.3 standalone page (lazy)
const ArchV3Page = dynamic(() => import('../../app/arch/page'), {
  ssr: false,
  loading: () => <div className="h-screen animate-pulse bg-background" />,
});
// Agent Performance page (lazy-loaded — contains recharts)
const AgentPerformancePage = dynamic(
  () =>
    import('../insights/AgentPerformancePage').then((m) => ({
      default: m.AgentPerformancePage,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    ),
  },
);
// Quality Monitor page (lazy-loaded — contains recharts)
const QualityMonitorPage = dynamic(
  () =>
    import('../insights/QualityMonitorPage').then((m) => ({
      default: m.QualityMonitorPage,
    })),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" />,
  },
);
// Feedback viewer page (ABLP-1084)
const FeedbackPage = dynamic(
  () => import('../insights/FeedbackPage').then((m) => ({ default: m.FeedbackPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
// Admin pages
import { MembersPage } from '../admin/MembersPage';
import { ModelsPage } from '../admin/ModelsPage';
import { SecurityPage } from '../admin/SecurityPage';
import { AuditLogsPage } from '../admin/audit/AuditLogsPage';
import { SecretsPage } from '../admin/SecretsPage';
import { VoiceServicesPage } from '../admin/VoiceServicesPage';
import { ArchSettingsPage } from '../admin/ArchSettingsPage';
const BillingPage = dynamic(
  () => import('../admin/BillingPage').then((m) => ({ default: m.BillingPage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
import { CustomRolesPage } from '../admin/CustomRolesPage';
import { WorkspaceSettingsPage } from '../admin/WorkspaceSettingsPage';
// Workspace admin pages (Batch 5-8)
import { KMSPage } from '../admin/KMSPage';
import { EnvVarsPage } from '../admin/EnvVarsPage';
import { GuardrailsPage } from '../admin/GuardrailsPage';
import { ConnectorsPage } from '../admin/ConnectorsPage';
import { TemplateManagerPage } from '../admin/TemplateManagerPage';
// Analytics admin pages (lazy-loaded — contains recharts)
const AdminAgentPerformancePage = dynamic(
  () => import('../admin/AgentPerformancePage').then((m) => ({ default: m.AgentPerformancePage })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
import { SessionExplorerPage } from '../admin/SessionExplorerPage';
import { TraceViewerPage } from '../admin/TraceViewerPage';
// Guardrails config page (project-level)
import { GuardrailsConfigPage } from '../guardrails/GuardrailsConfigPage';
// Template Catalog page
import { TemplateCatalogPage } from '../templates/TemplateCatalogPage';
// Prompt Library pages
import { PromptLibraryListPage } from '../prompt-library/PromptLibraryListPage';
import { PromptLibraryDetailPage } from '../prompt-library/PromptLibraryDetailPage';
import { PromptLibraryComparePage } from '../prompt-library/PromptLibraryComparePage';
// Settings tab components (for direct sub-page routing)

const SIDEBAR_EXPANDED_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 56;

function ComingSoonPage({
  titleKey,
  descriptionKey,
}: {
  titleKey: string;
  descriptionKey: string;
}) {
  const t = useTranslations('coming_soon');
  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <EmptyState
        icon={<div className="w-6 h-6 rounded-full bg-accent/20 border border-accent/30" />}
        title={t(titleKey)}
        description={t(descriptionKey)}
      />
    </div>
  );
}

function WorkspaceAdminAccessDeniedPage() {
  const t = useTranslations('admin.access');

  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <EmptyState
        icon={<Settings className="w-6 h-6" />}
        title={t('title')}
        description={t('description')}
      />
    </div>
  );
}

export function AppShell() {
  const t = useTranslations('app_shell');
  const { wsUrl: configWsUrl } = useRuntimeConfig();
  const wsUrl = deriveDefaultWsUrl(configWsUrl);
  const area = useNavigationStore((s) => s.area);
  const page = useNavigationStore((s) => s.page);
  const subPage = useNavigationStore((s) => s.subPage);
  const tab = useNavigationStore((s) => s.tab);
  const subSection = useNavigationStore((s) => s.subSection);
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);
  const openOverlay = useArchAIStore((s) => s.openOverlay);
  const overlayState = useArchAIStore((s) => s.overlayState);
  const accessToken = useAuthStore((s) => s.accessToken);
  const setCurrentProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadDependencies = useModuleStore((s) => s.loadDependencies);
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const { hasGovernance, isLoading: featuresLoading } = useFeatures();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const sidebarWasCollapsedRef = useRef(false);
  // Detect if agent editor is active (full page — slider no longer signals the old store)
  const isAgentEditorPage = page === 'agents' && !!subPage;
  // Detect if workflow canvas (Flow tab) is active
  const isWorkflowCanvasActive = page === 'workflows' && !!subPage && tab === 'flow';
  const isEditorActive = isAgentEditorPage || isWorkflowCanvasActive;
  const canOpenWorkspaceAdmin = canAccessWorkspaceAdmin(accessToken);
  const routeBoundaryKey = `${area}:${page ?? ''}:${subPage ?? ''}:${tab ?? ''}:${subSection ?? ''}:${projectId ?? ''}`;
  const sidebarBoundaryKey = `${area}:${projectId ?? ''}:${sidebarCollapsed}`;

  // Auto-collapse sidebar when the agent editor or workflow canvas is active
  useEffect(() => {
    if (isEditorActive) {
      sidebarWasCollapsedRef.current = sidebarCollapsed;
      setSidebarCollapsed(true);
    } else if (!sidebarWasCollapsedRef.current) {
      setSidebarCollapsed(false);
    }
  }, [isEditorActive]);

  // Load projects on mount so sidebar/switcher always has data
  useEffect(() => {
    loadProjects();
  }, []);

  // Arch v0.3 — context is auto-detected via buildPageContext() from nav store.

  // Track whether we already attempted a refetch for the current projectId
  const projectRefetchedRef = useRef<string | null>(null);

  // Sync navigation store's projectId to project store.
  // Depends only on projectId — NOT on `projects`. When loadProjects()
  // completes, setProjects() already resolves currentProject internally
  // using the currentProjectId we set here, so re-running on projects
  // change is unnecessary and was the source of an infinite fetch loop.
  useEffect(() => {
    syncProjectSelectionFromNavigation({
      projectId,
      projectRefetchedRef,
      setCurrentProjectId,
      getProjectState: useProjectStore.getState,
      loadProjects,
    });
  }, [projectId, setCurrentProjectId]);

  useEffect(() => {
    if (projectId) {
      void loadDependencies(projectId);
    }
  }, [projectId, loadDependencies]);

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [area, page, subPage]);

  // Redirect legacy entrypoints to the current v3 surfaces.
  useEffect(() => {
    if (area === 'projects' && (page === 'chat' || page === 'new')) {
      navigate('/arch');
    }
  }, [area, page, navigate]);

  useEffect(() => {
    if (area === 'project' && page === 'arch-ai' && projectId) {
      navigate(`/projects/${projectId}`);
    }
  }, [area, page, projectId, navigate]);

  useEffect(() => {
    if (
      area === 'project' &&
      page === 'governance' &&
      projectId &&
      !featuresLoading &&
      !hasGovernance
    ) {
      navigate(`/projects/${projectId}`, { replace: true });
    }
  }, [area, page, projectId, featuresLoading, hasGovernance, navigate]);

  // Direction-aware page transitions
  // Drill-down (list → detail): slide from right
  // Back (detail → list): slide from left
  // Peer navigation: crossfade (default)
  const prevNavRef = useRef({ area, page, subPage });
  const transitionDirection = useRef<'forward' | 'back' | 'peer'>('peer');

  useEffect(() => {
    const prev = prevNavRef.current;
    const cur = { area, page, subPage };

    if (prev.area === cur.area && prev.page === cur.page) {
      // Same page: subPage change → drill-down/back
      if (!prev.subPage && cur.subPage) transitionDirection.current = 'forward';
      else if (prev.subPage && !cur.subPage) transitionDirection.current = 'back';
      else transitionDirection.current = 'peer';
    } else if (prev.area !== cur.area) {
      // Area change (projects → project, project → admin)
      transitionDirection.current = cur.area === 'projects' ? 'back' : 'forward';
    } else {
      transitionDirection.current = 'peer';
    }

    prevNavRef.current = cur;
  }, [area, page, subPage]);

  const getTransitionVariants = () => {
    const dir = transitionDirection.current;
    if (dir === 'forward') {
      return {
        initial: { opacity: 0, x: 24 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: -24 },
      };
    }
    if (dir === 'back') {
      return {
        initial: { opacity: 0, x: -24 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: 24 },
      };
    }
    // peer: subtle y-fade (original behavior, slightly enhanced)
    return {
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -6 },
    };
  };

  const hasSidebar = area === 'project' || (area === 'admin' && canOpenWorkspaceAdmin);

  return (
    <div
      className="h-full flex flex-col bg-background text-foreground"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      {/* Header */}
      <header className="h-12 flex items-center justify-between pl-5 pr-4 border-b border-default bg-background shrink-0 relative z-10">
        <IsolatedErrorBoundary
          name="Top navigation"
          resetKey={`top-nav:${routeBoundaryKey}`}
          fallbackClassName="h-full flex-1 border-0 bg-transparent p-0"
        >
          {/* Left side */}
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile menu toggle */}
            {hasSidebar && (
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
                className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default lg:hidden"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            )}

            {/* Logo */}
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-2 hover:opacity-80 transition-default shrink-0"
            >
              <KoreIcon className="text-foreground" size={20} />
              <span className="text-sm font-semibold text-foreground hidden sm:inline">
                {t('agent_platform')}
              </span>
            </button>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-1.5">
            {/* Softphone (only in project area — hides if no voice numbers) */}
            {area === 'project' && projectId && <SoftphoneButton projectId={projectId} />}

            {/* Universal Search (only in project area; click-only, ⌘K is owned by CommandPalette) */}
            {area === 'project' && projectId && (
              <div className="hidden sm:block">
                <UniversalSearch />
              </div>
            )}

            {/* Arch toggle button — opens v4 in-project overlay */}
            {area === 'project' && (
              <button
                data-testid="arch-toggle"
                onClick={() => {
                  const s = useArchAIStore.getState();
                  if (s.overlayState === 'closed') {
                    s.openOverlay();
                  } else {
                    s.closeOverlay();
                  }
                }}
                aria-label={t('toggle_arch')}
                className="p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default hidden sm:block"
                title={t('toggle_arch')}
              >
                <ArchIcon size={16} />
              </button>
            )}

            {/* Arch-v3 status + settings */}
            {area === 'arch' && canOpenWorkspaceAdmin && (
              <>
                <div className="w-px h-4 bg-border mx-1 hidden sm:block" />
                <button
                  onClick={() => navigate('/admin/arch')}
                  aria-label="Arch settings"
                  className="p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default hidden sm:block"
                  title="Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </>
            )}

            {/* Exit Arch — back to projects list */}
            {area === 'arch' && (
              <button
                onClick={() => navigate('/')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground rounded-md border border-border bg-white shadow-sm transition-colors hover:bg-background-muted hidden sm:flex"
              >
                <X className="h-3.5 w-3.5" />
                Exit
              </button>
            )}

            {/* Settings / Admin link — only for users with workspace-admin permission */}
            {area !== 'admin' && area !== 'arch' && canOpenWorkspaceAdmin && (
              <button
                onClick={() => navigate('/admin/members')}
                aria-label={t('admin')}
                className="p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default hidden sm:block"
                title={t('admin')}
              >
                <Settings className="w-4 h-4" />
              </button>
            )}

            <div className="w-px h-4 bg-border mx-1.5" />

            <UserMenu />
          </div>
        </IsolatedErrorBoundary>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        <AnimatePresence>
          {mobileMenuOpen && hasSidebar && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-overlay z-40 lg:hidden"
                onClick={() => setMobileMenuOpen(false)}
              />
              {/* Drawer */}
              <motion.div
                initial={{ x: -280 }}
                animate={{ x: 0 }}
                exit={{ x: -280 }}
                transition={springs.gentle}
                className="fixed inset-y-0 left-0 z-50 w-[280px] lg:hidden relative"
              >
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close menu"
                  className="absolute top-3 right-3 p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default z-10"
                >
                  <X className="w-4 h-4" />
                </button>
                <IsolatedErrorBoundary
                  name="Mobile navigation"
                  resetKey={`mobile-sidebar:${sidebarBoundaryKey}`}
                  fallbackClassName="h-full w-full rounded-none border-0 border-r border-default"
                >
                  {area === 'project' && (
                    <ProjectSidebar collapsed={false} onToggleCollapse={() => {}} />
                  )}
                  {area === 'admin' && canOpenWorkspaceAdmin && (
                    <AdminSidebar collapsed={false} onToggleCollapse={() => {}} />
                  )}
                </IsolatedErrorBoundary>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Desktop sidebar */}
        <div className="hidden lg:block">
          <IsolatedErrorBoundary
            name="Sidebar"
            resetKey={`desktop-sidebar:${sidebarBoundaryKey}`}
            fallbackClassName="h-full w-14 rounded-none border-0 border-r border-default"
          >
            {area === 'project' && (
              <ProjectSidebar
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              />
            )}
            {area === 'admin' && canOpenWorkspaceAdmin && (
              <AdminSidebar
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              />
            )}
          </IsolatedErrorBoundary>
        </div>

        {/* Content — only include tab in key when it changes the top-level component
           (e.g. agent detail vs chat). Pages with internal tabs handle switching themselves. */}
        <AnimatePresence mode="wait">
          <motion.main
            key={
              area === 'project' && page === 'agents' && subPage
                ? `${area}-${page}-${subPage}-${tab}`
                : `${area}-${page}-${subPage}`
            }
            {...getTransitionVariants()}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
          >
            <PageHeaderProvider>
              {area === 'admin' && !canOpenWorkspaceAdmin ? (
                <WorkspaceAdminAccessDeniedPage />
              ) : area === 'project' ? (
                <>
                  {/* Agent editor renders its own AgentEditorHeader inside its content column,
                      so we suppress the outer ProjectContentHeader here to avoid a duplicate. */}
                  {!isAgentEditorPage && (
                    <IsolatedErrorBoundary
                      name="Page header"
                      resetKey={`page-header:${routeBoundaryKey}`}
                      fallbackClassName="h-[56px] min-h-0 shrink-0 rounded-none border-0 border-b border-default bg-background"
                    >
                      <ProjectContentHeader
                        fallbackTitle={currentProject?.name ?? 'Agent Platform'}
                        onOpenMobileMenu={hasSidebar ? () => setMobileMenuOpen(true) : undefined}
                        mobileMenuOpen={mobileMenuOpen}
                      />
                    </IsolatedErrorBoundary>
                  )}
                  <div className="flex-1 overflow-auto min-h-0">
                    <IsolatedErrorBoundary
                      name="Page content"
                      resetKey={`page-content:${routeBoundaryKey}`}
                      fallbackClassName="h-full min-h-full rounded-none border-0 bg-background"
                    >
                      <AppShellContent
                        area={area}
                        page={page}
                        subPage={subPage}
                        tab={tab}
                        subSection={subSection}
                        projectId={projectId}
                        wsUrl={wsUrl}
                        hasGovernance={hasGovernance}
                      />
                    </IsolatedErrorBoundary>
                  </div>
                </>
              ) : (
                <div className="flex-1 overflow-auto min-h-0">
                  <IsolatedErrorBoundary
                    name="Page content"
                    resetKey={`page-content:${routeBoundaryKey}`}
                    fallbackClassName="h-full min-h-full rounded-none border-0 bg-background"
                  >
                    <AppShellContent
                      area={area}
                      page={page}
                      subPage={subPage}
                      tab={tab}
                      subSection={subSection}
                      projectId={projectId}
                      wsUrl={wsUrl}
                      hasGovernance={hasGovernance}
                    />
                  </IsolatedErrorBoundary>
                </div>
              )}
            </PageHeaderProvider>
          </motion.main>
        </AnimatePresence>

        {/* Arch v4 in-project overlay */}
        {area === 'project' && projectId && (
          <IsolatedErrorBoundary
            name="Arch overlay"
            resetKey={`arch-overlay:${projectId}`}
            fallbackClassName="fixed bottom-4 right-4 z-50 w-80 rounded-lg shadow-lg"
          >
            <ArchV4Overlay projectId={projectId} />
          </IsolatedErrorBoundary>
        )}
      </div>
    </div>
  );
}

interface AppShellContentProps {
  area: string;
  page: string | null;
  subPage: string | null;
  tab: string | null;
  subSection: string | null;
  projectId: string | null;
  wsUrl: string;
  hasGovernance: boolean;
}

function AppShellContent({
  area,
  page,
  subPage,
  tab,
  subSection,
  projectId,
  wsUrl,
  hasGovernance,
}: AppShellContentProps) {
  const projects = useProjectStore((s) => s.projects);
  const sessionLoaded = useProjectStore((s) => s.sessionLoaded);
  const navigate = useNavigationStore((s) => s.navigate);

  // While the user is on a project page, poll every 60 s to detect mid-session
  // access revocation. On 404 the project is removed from the store and the
  // guard below immediately shows the no-access screen.
  useEffect(() => {
    if (area !== 'project' || !projectId || !sessionLoaded) return;

    const checkAccess = async () => {
      try {
        await fetchProject(projectId);
      } catch (error) {
        // Only remove the project when the server confirms it is gone or
        // inaccessible. Transient errors (5xx, network, aborts) must not
        // delete projects from the local store, or the user sees a spurious
        // "no access" screen and loses their session context.
        const status = (error as { statusCode?: number } | null)?.statusCode;
        if (status === 403 || status === 404) {
          useProjectStore.getState().removeProject(projectId);
        }
      }
    };

    const intervalId = setInterval(() => void checkAccess(), 60_000);
    return () => clearInterval(intervalId);
  }, [area, projectId, sessionLoaded]);

  // Guard: show no-access screen only after a live fetch confirms the project
  // is not in this user's accessible list. sessionLoaded is set by the store
  // (not persisted) so it's always false on first load and true only after
  // the first real loadProjects() fetch completes in this browser session.
  if (area === 'project' && projectId && sessionLoaded) {
    const accessible = projects.find((p) => p.id === projectId);
    if (!accessible) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold text-foreground">
            You don&apos;t have access to this project
          </h2>
          <p className="text-sm text-muted max-w-sm">
            Your access may have been removed. Contact a workspace admin if you believe this is a
            mistake.
          </p>
          <button
            onClick={() => navigate('/projects')}
            className="text-sm text-accent hover:underline"
          >
            Back to Projects
          </button>
        </div>
      );
    }
  }

  return renderContent(area, page, subPage, tab, subSection, projectId, wsUrl, hasGovernance);
}

/**
 * Content header bar — sits at h-[56px] to align with the sidebar switcher row.
 * Reads page title + actions registered by the current page via PageHeaderContext.
 * Falls back to the project name when no page has registered a title.
 */
function ProjectContentHeader({
  fallbackTitle,
  onOpenMobileMenu,
  mobileMenuOpen,
}: {
  fallbackTitle: string;
  onOpenMobileMenu?: () => void;
  mobileMenuOpen?: boolean;
}) {
  const { title, description, actions, breadcrumbs } = usePageHeaderState();
  const navigate = useNavigationStore((s) => s.navigate);

  // Build the crumb list: if breadcrumbs registered, use them;
  // otherwise fall back to a single crumb for the current page title.
  const displayTitle = title || fallbackTitle;
  const crumbs = breadcrumbs.length > 0 ? breadcrumbs : [{ label: displayTitle }];

  return (
    <div className="shrink-0 h-[56px] flex items-center justify-between px-6 bg-background">
      <div className="flex items-center gap-3 min-w-0">
        {onOpenMobileMenu && (
          <button
            onClick={onOpenMobileMenu}
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen ?? false}
            className="lg:hidden shrink-0 p-1.5 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-colors"
          >
            <Menu className="w-4 h-4" />
          </button>
        )}
        <PageBreadcrumb
          crumbs={crumbs}
          description={description || undefined}
          onNavigate={navigate}
        />
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

function renderContent(
  area: string,
  page: string | null,
  subPage: string | null,
  tab: string | null,
  subSection: string | null,
  projectId: string | null,
  wsUrl: string,
  hasGovernance: boolean,
) {
  // Arch AI v0.3 standalone page
  if (area === 'arch') {
    return <ArchV3Page />;
  }

  // Projects dashboard
  if (area === 'projects') {
    return <ProjectDashboard />;
  }

  // Project workspace
  if (area === 'project') {
    switch (page) {
      case 'overview':
        return <ProjectOverviewPage />;

      case 'agents':
        if (subPage === null) {
          return <AgentListPage />;
        }
        // Imported agent detail — subPage='imported', tab=alias, subSection=agentName
        if (subPage === 'imported' && tab && subSection && projectId) {
          return (
            <ImportedAgentDetailLoader
              alias={tab}
              agentName={subSection}
              onBack={() => useNavigationStore.getState().navigate(`/projects/${projectId}/agents`)}
            />
          );
        }
        // Chat tab — render chat with optional debug split-pane
        // Key on projectId+subPage forces a full remount when the user navigates
        // between agents or projects. Without this, React reuses the component tree
        // and stale messages/session state from the previous agent can flash before
        // the clearSession() useEffect fires.
        if (tab === 'chat') {
          return (
            <WebSocketProvider key={`${projectId ?? ''}:${subPage ?? ''}`} url={wsUrl}>
              <ChatWithDebugPanel />
            </WebSocketProvider>
          );
        }
        // Route depends on listViewMode config:
        // 'page' → full-page editor (old behavior)
        // 'slider' → list page with slider overlay (AgentListPage handles it)
        {
          const listMode = AGENT_EDITOR_CONFIG.listViewMode ?? AGENT_EDITOR_CONFIG.containerMode;
          if (listMode === 'page') {
            return <AgentEditorPage projectId={projectId!} agentName={subPage} />;
          }
          return <AgentListPage />;
        }

      case 'profiles':
        if (subPage === null) {
          return <ProfileListPage />;
        }
        return <ProfileDetailPage />;

      case 'tools':
        if (subPage === 'new') {
          return <ToolCreatePage />;
        }
        // Imported tool detail — subPage='imported', tab=alias, subSection=toolName
        if (subPage === 'imported' && tab && subSection && projectId) {
          return (
            <ImportedToolDetailLoader
              alias={tab}
              toolName={subSection}
              projectId={projectId}
              onBack={() => useNavigationStore.getState().navigate(`/projects/${projectId}/tools`)}
            />
          );
        }
        if (subPage) {
          return <ToolDetailPage />;
        }
        return <ToolsListPage />;

      case 'mcp-servers':
        if (subPage) {
          return <McpServerDetailPage />;
        }
        // MCP servers list is now inside Tools page (MCP tab)
        return <ToolsListPage />;

      case 'sessions':
        if (subPage) {
          return (
            <SessionDetailPage sessionId={subPage} spanId={tab === 'traces' ? subSection : null} />
          );
        }
        return <SessionsListPage />;

      case 'deployments':
        return <DeploymentsPage />;

      case 'search-ai':
        if (subPage && tab === 'sources' && subSection) {
          // /projects/:id/search-ai/:kbId/sources/:sourceId → Unified Source Page
          return <UnifiedSourcePage projectId={projectId!} kbId={subPage} sourceId={subSection} />;
        }
        if (subPage) return <KnowledgeBaseDetailPage />;
        return <KnowledgeBaseDashboardPage />;

      case 'workflows':
        if (subPage) {
          return <WorkflowDetailPage />;
        }
        return <WorkflowsListPage />;
      case 'connections':
        return <ConnectionsPage />;
      case 'external-agents':
        return <ExternalAgentsPage />;
      case 'prompt-library':
        if (subPage === null) {
          return <PromptLibraryListPage />;
        }
        if (tab === 'compare') {
          return <PromptLibraryComparePage promptId={subPage} />;
        }
        return <PromptLibraryDetailPage promptId={subPage} />;
      case 'module-dependencies':
        return <ModuleDependenciesPage />;
      case 'templates':
        return <TemplateCatalogPage />;
      case 'evals':
        return <EvalsPage />;
      case 'inbox':
        return <UnifiedInboxPage />;
      case 'experiments':
        if (subPage) {
          return <ExperimentDetail />;
        }
        return <ExperimentsPage />;
      case 'dashboard':
        return <AtAGlancePage />;
      case 'analytics':
        return <AnalyticsPage />;
      case 'billing':
        return <ProjectBillingPage />;
      case 'agent-performance':
        return <AgentPerformancePage />;
      case 'quality-monitor':
        return <QualityMonitorPage />;
      case 'customer-insights':
        return <CustomerInsightsPage />;
      case 'feedback':
        return <FeedbackPage />;
      case 'voice-analytics':
        return <VoiceAnalyticsPage />;
      case 'agent-transfer-insights':
        return <AgentTransferInsightsPage />;
      case 'pipelines':
        if (!subPage) {
          return <PipelinesListPage />;
        }
        // Custom pipelines use UUIDv7 IDs (e.g., '0190f000-1234-7abc-...') or 'new';
        // everything else is a builtin pipelineType (e.g., 'simulation', 'sentiment_analysis')
        if (
          subPage === 'new' ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subPage)
        ) {
          return <PipelineEditorPage />;
        }
        return <PipelineConfigPage />;
      case 'alerts':
        return <AlertsPage />;
      case 'guardrails-config':
        return <GuardrailsConfigPage />;
      case 'governance':
        if (!hasGovernance) {
          return <ProjectOverviewPage />;
        }
        return <GovernancePage />;
      case 'settings':
      case 'settings-members':
        return <ProjectMembersTab />;
      case 'settings-api-keys':
        return <ApiKeysTab />;
      case 'settings-models':
        return <ModelConfigTab />;
      case 'settings-config-vars':
        return <ConfigVariablesTab />;
      case 'settings-localization':
        return <LocalizationSettingsPage />;
      case 'settings-git':
        return <GitIntegrationTab />;
      case 'settings-advanced':
        return <AdvancedSettingsTab />;
      case 'settings-runtime-config':
        return <RuntimeConfigTab />;
      case 'settings-data-retention':
        return <DataRetentionSettingsPage />;
      case 'settings-trace-dimensions':
        return <TraceDimensionsTab />;
      case 'settings-agent-transfer':
        return <AgentTransferSettingsPage />;
      case 'settings-agent-assist':
        return <AgentAssistSettingsPage />;
      case 'settings-pii-protection':
        return <PIIProtectionTab />;
      case 'settings-public-api':
        return <PublicApiAccessTab />;
      case 'settings-auth-profiles':
        return <AuthProfilesPage />;
      case 'settings-attachments':
        return <AttachmentSettingsTab />;
      case 'settings-omnichannel':
        return <OmnichannelSettingsPanel />;
      case 'settings-modules':
        return <ModuleSettingsPage />;
      case 'transfer-sessions':
        return <TransferSessionsPage />;
      default:
        return <ProjectOverviewPage />;
    }
  }

  // Admin pages (workspace-level)
  if (area === 'admin') {
    switch (page) {
      case 'members':
        return <MembersPage />;
      case 'roles':
        return <CustomRolesPage />;
      case 'models':
        return <ModelsPage />;
      case 'voice':
        return <VoiceServicesPage />;
      case 'security':
        return <SecurityPage />;
      case 'audit-logs':
        return <AuditLogsPage />;
      case 'secrets':
        return <SecretsPage />;
      case 'arch':
        return <ArchSettingsPage />;
      case 'billing':
        return <BillingPage />;
      case 'kms':
        return <KMSPage />;
      case 'env-vars':
        return <EnvVarsPage />;
      case 'guardrails':
        return <GuardrailsPage />;
      case 'connectors':
        return <ConnectorsPage />;
      case 'auth-profiles':
        return <AuthProfilesPage scope="workspace" />;
      case 'analytics-agents':
        return <AdminAgentPerformancePage />;
      case 'analytics-sessions':
        return <SessionExplorerPage />;
      case 'analytics-traces':
        return <TraceViewerPage />;
      case 'workspace-settings':
        return <WorkspaceSettingsPage />;
      case 'template-manager':
        return <TemplateManagerPage />;
      default:
        return <MembersPage />;
    }
  }

  // User settings pages
  if (area === 'settings') {
    switch (page) {
      case 'api-keys':
        return <ApiKeysPage />;
      default:
        return <ComingSoonPage titleKey="settings_title" descriptionKey="settings_description" />;
    }
  }

  return <ComingSoonPage titleKey="not_found_title" descriptionKey="not_found_description" />;
}
