/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildPageContext } from '../../lib/arch-ai/build-page-context';
import { useNavigationStore } from '../../store/navigation-store';
import { usePreferencesStore } from '../../store/preferences-store';
import { useProjectStore } from '../../store/project-store';

describe('buildPageContext', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      area: 'projects',
      projectId: null,
      page: null,
      subPage: null,
      subPageLabel: null,
      tab: null,
      subSection: null,
      breadcrumbs: [{ label: 'Projects', path: '/' }],
    });
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isLoading: false,
      error: null,
      moduleFilter: 'all',
    });
    usePreferencesStore.setState({
      insightsAnalyticsFilters: {
        version: 1,
        byProject: {},
      },
      pendingSync: {
        pinnedProjectIds: false,
        filterSurfaces: [],
      },
    });
    window.localStorage.clear();
  });

  it('maps tool detail pages into a tool-aware page context', () => {
    useProjectStore.setState({
      currentProjectId: 'proj-1',
      currentProject: {
        id: 'proj-1',
        name: 'Payments',
        slug: 'payments',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        agentCount: 4,
        sessionCount: 12,
        kind: 'application',
      },
    });
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'tools',
      subPage: 'tool-123',
      subPageLabel: 'CRM Sync',
      tab: 'testing',
      subSection: 'request-schema',
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'tools',
      tab: 'testing',
      subSection: 'request-schema',
      project: {
        id: 'proj-1',
        name: 'Payments',
        agentCount: 4,
      },
      entity: {
        type: 'tool',
        id: 'tool-123',
        name: 'CRM Sync',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining([
        'tool_management',
        'tool_testing',
        'api_integration',
        'tools_tab_testing',
        'tools_section_request-schema',
      ]),
    );
  });

  it('captures nested agent view context', () => {
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'agents',
      subPage: 'Billing_Agent',
      tab: 'config',
      subSection: 'guardrails',
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'agents',
      tab: 'config',
      subSection: 'guardrails',
      entity: {
        type: 'agent',
        id: 'Billing_Agent',
        name: 'Billing_Agent',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining(['agent_authoring', 'agents_tab_config', 'agents_section_guardrails']),
    );
  });

  it('marks agent editor pages as the agent-editor Arch surface by default', () => {
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'agents',
      subPage: 'Billing_Agent',
      tab: 'config',
      subSection: null,
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      surface: 'agent-editor',
      entity: {
        type: 'agent',
        name: 'Billing_Agent',
      },
    });
  });

  it('falls back to project Arch surface when agent editor guidance is disabled', () => {
    window.localStorage.setItem('abl.agent-editor.arch-guidance-enabled', 'false');
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'agents',
      subPage: 'Billing_Agent',
      tab: 'config',
      subSection: null,
    });

    const context = buildPageContext();

    expect(context?.surface).toBe('project');
  });

  it('maps Search AI detail pages to knowledge-base context', () => {
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'search-ai',
      subPage: 'kb-42',
      tab: 'documents',
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'search-ai',
      tab: 'documents',
      entity: {
        type: 'knowledge_base',
        id: 'kb-42',
        name: 'kb-42',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining([
        'knowledge_base_management',
        'semantic_search',
        'ingestion',
        'search-ai_tab_documents',
      ]),
    );
  });

  it('maps Analytics sessions explorer to production optimization context', () => {
    useProjectStore.setState({
      currentProjectId: 'proj-1',
      currentProject: {
        id: 'proj-1',
        name: 'Payments',
        slug: 'payments',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        agentCount: 4,
        sessionCount: 12,
        kind: 'application',
      },
    });
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'analytics',
      subPage: null,
      tab: null,
      subSection: null,
    });
    usePreferencesStore.setState({
      insightsAnalyticsFilters: {
        version: 1,
        byProject: {
          'proj-1': {
            analyticsPage: {
              dateRangeMode: 'quick',
              quickRange: '24h',
              customFrom: '',
              customTo: '',
              activeTab: 'sessions-explorer',
            },
            analyticsSessions: {
              statusFilter: 'escalated',
              search: 'refund',
              channelFilter: 'voice',
              environmentFilter: 'production',
              filters: [],
            },
          },
        },
      },
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'analytics',
      tab: 'sessions-explorer',
      project: {
        id: 'proj-1',
        name: 'Payments',
        agentCount: 4,
      },
      summary: {
        surfacePurpose: 'production_agent_optimization',
        optimizationFocus: 'containment_or_quality_improvement',
        analyticsTab: 'sessions-explorer',
        timeRange: 'last_24h',
        sessionStatusFilter: 'escalated',
        sessionEnvironmentFilter: 'production',
        sessionChannelFilter: 'voice',
        sessionSearch: 'refund',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining([
        'production_agent_optimization',
        'containment_optimization',
        'quality_improvement',
        'trace_step_analysis',
        'flow_pattern_analysis',
        'agent_goal_review',
        'session_observability',
        'session_analytics',
        'containment_analysis',
      ]),
    );
  });

  it('maps session detail pages to containment and quality improvement context', () => {
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'sessions',
      subPage: 'sess-123',
      subPageLabel: 'Checkout escalation',
      tab: 'traces',
      subSection: null,
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'sessions',
      tab: 'traces',
      entity: {
        type: 'session',
        id: 'sess-123',
        name: 'Checkout escalation',
      },
      summary: {
        surfacePurpose: 'single_session_production_diagnostics',
        optimizationFocus: 'containment_or_quality_improvement',
        sessionTab: 'traces',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining([
        'production_agent_optimization',
        'containment_optimization',
        'quality_improvement',
        'trace_step_analysis',
        'flow_pattern_analysis',
        'agent_goal_review',
        'session_observability',
        'trace_diagnostics',
      ]),
    );
  });

  it('captures Quality Monitor filters and page sections for Arch analysis', () => {
    useProjectStore.setState({
      currentProjectId: 'proj-1',
      currentProject: {
        id: 'proj-1',
        name: 'Payments',
        slug: 'payments',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        agentCount: 4,
        sessionCount: 12,
        kind: 'application',
      },
    });
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'quality-monitor',
      subPage: null,
      tab: null,
      subSection: null,
    });
    usePreferencesStore.setState({
      insightsAnalyticsFilters: {
        version: 1,
        byProject: {
          'proj-1': {
            qualityMonitor: {
              dateRange: '30d',
              dimensionFilter: 'context_preservation',
              scoreFilter: 'critical',
            },
          },
        },
      },
    });

    const context = buildPageContext();

    expect(context).toMatchObject({
      area: 'project',
      page: 'quality-monitor',
      summary: {
        dateRange: '30d',
        dimensionFilter: 'context_preservation',
        scoreFilter: 'critical',
        visibleSections: 'quality_kpis_quality_trend_dimension_details_flagged_conversations',
      },
    });
    expect(context?.capabilities).toEqual(
      expect.arrayContaining([
        'quality_monitoring',
        'quality_dimension_analysis',
        'flagged_conversation_review',
      ]),
    );
  });
});
