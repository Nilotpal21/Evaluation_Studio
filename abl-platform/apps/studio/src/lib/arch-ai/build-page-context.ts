/**
 * buildPageContext() — Assembles a PageContext from current Studio navigation state.
 * B02: Page Context Awareness
 *
 * Reads Zustand stores imperatively (getState()) — NOT hooks.
 * Called once before each message send in useArchChat.
 */

import type { PageContext } from '@agent-platform/arch-ai';
import { useNavigationStore } from '@/store/navigation-store';
import { useProjectStore } from '@/store/project-store';
import { usePreferencesStore } from '@/store/preferences-store';
import {
  getSurfaceState,
  type AnalyticsPageFilters,
} from '@/lib/preferences/insights-analytics-filters';
import {
  resolvePageContextCapabilities,
  resolvePageContextEntity,
  resolvePageContextSummary,
  type PageContextNavState,
} from '@/lib/arch-ai/page-context-registry';
import { isAgentEditorArchGuidanceEnabled } from '@/lib/arch-ai/agent-editor-arch-guidance';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Max approximate tokens for the serialized context (rough: 4 chars ≈ 1 token) */
const MAX_CONTEXT_CHARS = 8000; // ~2000 tokens
const MAX_CONTEXT_CAPABILITIES = 12;

export function buildPageContext(): PageContext | null {
  try {
    const nav = useNavigationStore.getState();
    const projectStore = useProjectStore.getState();
    const dynamicContext = resolveDynamicPageContext(nav);

    const context: PageContext = {
      area: nav.area,
      page: nav.page ?? nav.area,
    };
    if (nav.tab) {
      context.tab = nav.tab;
    }
    if (nav.subSection) {
      context.subSection = nav.subSection;
    }
    if (!context.tab && dynamicContext?.tab) {
      context.tab = dynamicContext.tab;
    }
    const timeZone = getBrowserTimeZone();
    if (timeZone) {
      context.timeZone = timeZone;
    }

    // Add project context if in a project
    if (nav.area === 'project' && projectStore.currentProject) {
      context.project = {
        id: projectStore.currentProject.id,
        name: projectStore.currentProject.name,
        agentCount: projectStore.currentProject.agentCount,
      };
    }

    const entity = resolvePageContextEntity(nav);
    if (entity) {
      // For integration-relevant pages, ensure provider/connection identifiers
      // surface in entity.metadata so the integration-methodologist specialist
      // can ground its response without round-tripping the user.
      const enriched = enrichIntegrationEntityMetadata(entity, nav);
      context.entity = enriched ?? entity;
    }

    if (nav.area === 'project') {
      context.surface =
        nav.page === 'agents' &&
        context.entity?.type === 'agent' &&
        isAgentEditorArchGuidanceEnabled()
          ? 'agent-editor'
          : 'project';
    }

    const capabilities = mergeCapabilities(
      resolvePageContextCapabilities(nav),
      dynamicContext?.capabilities,
    );
    if (capabilities && capabilities.length > 0) {
      context.capabilities = capabilities;
    }

    const summary = mergeSummary(resolvePageContextSummary(nav), dynamicContext?.summary);
    if (summary && Object.keys(summary).length > 0) {
      context.summary = summary;
    }

    // Enforce token budget
    return enforceTokenBudget(context);
  } catch (err: unknown) {
    // Never throw — return null on any failure, but log for diagnosis
    console.warn(
      '[build-page-context] failed to build context',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

interface DynamicPageContext {
  tab?: string;
  capabilities?: string[];
  summary?: Record<string, unknown>;
}

function resolveDynamicPageContext(nav: PageContextNavState): DynamicPageContext | null {
  if (!nav.projectId) {
    return null;
  }

  const filters = usePreferencesStore.getState().insightsAnalyticsFilters;
  if (nav.page === 'dashboard') {
    const atAGlanceState = getSurfaceState(filters, nav.projectId, 'atAGlance');
    return {
      tab: atAGlanceState.activeTab,
      capabilities: [`dashboard_tab_${atAGlanceState.activeTab}`],
      summary: {
        activeTab: atAGlanceState.activeTab,
        dateRange: atAGlanceState.dateRange,
        conversationFilter: atAGlanceState.conversationFilter || 'all',
      },
    };
  }

  if (nav.page === 'agent-performance') {
    const agentPerformanceState = getSurfaceState(filters, nav.projectId, 'agentPerformance');
    return {
      capabilities: ['agent_performance_analysis'],
      summary: {
        dateRange: agentPerformanceState.dateRange,
        compareEnabled: agentPerformanceState.compareEnabled,
        agentSearch: agentPerformanceState.search || 'all',
        statusFilter: agentPerformanceState.statusFilter,
      },
    };
  }

  if (nav.page === 'quality-monitor') {
    const qualityState = getSurfaceState(filters, nav.projectId, 'qualityMonitor');
    return {
      capabilities: ['quality_dimension_analysis', 'flagged_conversation_review'],
      summary: {
        dateRange: qualityState.dateRange,
        dimensionFilter: qualityState.dimensionFilter,
        scoreFilter: qualityState.scoreFilter,
        visibleSections: 'quality_kpis_quality_trend_dimension_details_flagged_conversations',
      },
    };
  }

  if (nav.page === 'customer-insights') {
    const customerInsightsState = getSurfaceState(filters, nav.projectId, 'customerInsights');
    return {
      capabilities: ['intent_analysis', 'sentiment_analysis'],
      summary: {
        dateRange: customerInsightsState.dateRange,
        visibleSections: 'intent_distribution_sentiment_trajectory_trends_top_intents',
      },
    };
  }

  if (nav.page === 'voice-analytics') {
    const voiceAnalyticsState = getSurfaceState(filters, nav.projectId, 'voiceAnalytics');
    return {
      capabilities: ['voice_quality_analysis'],
      summary: {
        dateRange: voiceAnalyticsState.dateRange,
      },
    };
  }

  if (nav.page !== 'analytics') {
    return null;
  }

  const analyticsState = getSurfaceState(filters, nav.projectId, 'analyticsPage');
  const capabilities = getAnalyticsTabCapabilities(analyticsState.activeTab);
  const summary: Record<string, unknown> = {
    analyticsTab: analyticsState.activeTab,
    timeRange:
      analyticsState.dateRangeMode === 'custom' ? 'custom' : `last_${analyticsState.quickRange}`,
    expectedAnalysis:
      'all_analytics_menus_session_trace_agent_goal_flow_steps_and_improvement_recommendations',
  };

  if (analyticsState.activeTab === 'sessions-explorer') {
    const sessionFilters = getSurfaceState(filters, nav.projectId, 'analyticsSessions');
    summary.sessionStatusFilter = sessionFilters.statusFilter;
    summary.sessionEnvironmentFilter = sessionFilters.environmentFilter || 'all';
    summary.sessionChannelFilter = sessionFilters.channelFilter || 'all';
    if (sessionFilters.search.trim().length > 0) {
      summary.sessionSearch = sessionFilters.search.trim();
    }
  }

  if (analyticsState.activeTab === 'traces-explorer') {
    const traceFilters = getSurfaceState(filters, nav.projectId, 'analyticsTraces');
    summary.traceView = traceFilters.activeSubTab;
    summary.traceTypeFilter = traceFilters.typeFilter;
    if (traceFilters.searchQuery.trim().length > 0) {
      summary.traceSearch = traceFilters.searchQuery.trim();
    }
  }

  return {
    tab: analyticsState.activeTab,
    capabilities,
    summary,
  };
}

function getAnalyticsTabCapabilities(activeTab: AnalyticsPageFilters['activeTab']): string[] {
  const capabilities = [
    'production_agent_optimization',
    'containment_optimization',
    'quality_improvement',
    `analytics_tab_${activeTab}`,
  ];

  if (activeTab === 'sessions-explorer') {
    capabilities.push('session_observability', 'session_analytics', 'containment_analysis');
  }

  if (activeTab === 'traces-explorer') {
    capabilities.push('trace_diagnostics', 'trace_step_analysis', 'quality_debugging');
  }

  if (activeTab === 'llm') {
    capabilities.push('llm_performance');
  }

  if (activeTab === 'query') {
    capabilities.push('analytics_querying');
  }

  return capabilities;
}

function mergeCapabilities(
  primary?: PageContext['capabilities'],
  secondary?: PageContext['capabilities'],
): PageContext['capabilities'] {
  const merged = Array.from(new Set([...(primary ?? []), ...(secondary ?? [])])).slice(
    0,
    MAX_CONTEXT_CAPABILITIES,
  );
  return merged.length > 0 ? merged : undefined;
}

function mergeSummary(
  primary: Record<string, unknown> | null,
  secondary?: Record<string, unknown>,
): Record<string, unknown> | null {
  const merged = {
    ...(primary ?? {}),
    ...(secondary ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

function getBrowserTimeZone(): string | undefined {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// INTEGRATION ENTITY METADATA ENRICHMENT
// =============================================================================

const INTEGRATION_RELEVANT_PAGES = new Set([
  'connections',
  'tools',
  'mcp-servers',
  'integrations',
  'agents',
]);

const INTEGRATION_QUERY_PARAM_ALLOWLIST: ReadonlyArray<string> = [
  'providerKey',
  'connection_id',
  'connectionId',
  'authProfileId',
  'profileId',
  'draftId',
];

function readIntegrationSearchParams(): Record<string, string> | null {
  try {
    if (typeof window === 'undefined' || !window.location?.search) {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    const projected: Record<string, string> = {};
    for (const key of INTEGRATION_QUERY_PARAM_ALLOWLIST) {
      const value = params.get(key);
      if (typeof value === 'string' && value.trim().length > 0) {
        projected[key] = value.trim();
      }
    }
    return Object.keys(projected).length > 0 ? projected : null;
  } catch {
    return null;
  }
}

function enrichIntegrationEntityMetadata(
  entity: NonNullable<PageContext['entity']>,
  nav: PageContextNavState,
): NonNullable<PageContext['entity']> | null {
  const isIntegrationPage =
    typeof nav.page === 'string' && INTEGRATION_RELEVANT_PAGES.has(nav.page);
  const isIntegrationEntity =
    entity.type === 'connection' ||
    entity.type === 'tool' ||
    entity.type === 'mcp_server' ||
    entity.type === 'integration_draft';

  if (!isIntegrationPage && !isIntegrationEntity) {
    return null;
  }

  const queryMetadata = readIntegrationSearchParams();
  if (!queryMetadata) {
    return null;
  }

  return {
    ...entity,
    metadata: {
      ...(entity.metadata ?? {}),
      ...queryMetadata,
    },
  };
}

// =============================================================================
// TOKEN BUDGET ENFORCEMENT
// =============================================================================

function enforceTokenBudget(context: PageContext): PageContext {
  const serialized = JSON.stringify(context);
  if (serialized.length <= MAX_CONTEXT_CHARS) {
    return context;
  }

  // Truncation strategy: remove metadata first, then summary
  const trimmed = { ...context };

  if (trimmed.entity?.metadata) {
    trimmed.entity = { ...trimmed.entity, metadata: undefined };
  }

  if (JSON.stringify(trimmed).length <= MAX_CONTEXT_CHARS) {
    return trimmed;
  }

  if (trimmed.capabilities) {
    trimmed.capabilities = undefined;
  }

  if (JSON.stringify(trimmed).length <= MAX_CONTEXT_CHARS) {
    return trimmed;
  }

  if (trimmed.summary) {
    trimmed.summary = undefined;
  }

  return trimmed;
}
