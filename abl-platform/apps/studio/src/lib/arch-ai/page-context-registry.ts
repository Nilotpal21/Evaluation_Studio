import type { PageContext, PageContextEntity } from '@agent-platform/arch-ai';

export interface PageContextNavState {
  area: string;
  page: string | null;
  subPage: string | null;
  subPageLabel: string | null;
  tab: string | null;
  subSection: string | null;
  projectId: string | null;
}

interface PageContextRegistryEntry {
  entityType?: PageContextEntity['type'];
  capabilities?: string[];
  summary?: (nav: PageContextNavState) => Record<string, unknown> | null;
  /**
   * Optional metadata projector for the entity. Used by integration-relevant
   * pages (connections, tools, mcp-servers, etc.) to surface IDs that the
   * specialist needs to ground its response (connection_id, providerKey, ...).
   */
  entityMetadata?: (nav: PageContextNavState) => Record<string, unknown> | null;
}

const PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES = [
  'production_agent_optimization',
  'containment_optimization',
  'quality_improvement',
  'trace_step_analysis',
  'flow_pattern_analysis',
  'agent_goal_review',
];

const SENSITIVE_SETTINGS_PAGES = new Set([
  'settings-api-keys',
  'settings-models',
  'settings-git',
  'settings-advanced',
  'settings-pii-protection',
  'settings-auth-profiles',
]);

const PAGE_CONTEXT_REGISTRY: Record<string, PageContextRegistryEntry> = {
  agents: {
    entityType: 'agent',
    capabilities: ['agent_authoring', 'agent_debugging'],
    entityMetadata: (nav) => {
      // When the user is on an agent sub-page that focuses on tools/integrations,
      // project the agent identifier so an integration-aware specialist can
      // look up the right binding without round-tripping the user.
      if (nav.tab === 'tools' || nav.subSection === 'tools') {
        return nav.subPage ? { agentName: nav.subPage } : null;
      }
      return null;
    },
  },
  tools: {
    entityType: 'tool',
    capabilities: ['tool_management', 'tool_testing', 'api_integration'],
    entityMetadata: (nav) =>
      nav.subPage
        ? {
            toolId: nav.subPage,
            ...(nav.tab ? { focusTab: nav.tab } : {}),
          }
        : null,
  },
  'mcp-servers': {
    entityType: 'mcp_server',
    capabilities: ['mcp_management', 'tool_import'],
    entityMetadata: (nav) =>
      nav.subPage
        ? {
            mcpServerId: nav.subPage,
            ...(nav.tab ? { focusTab: nav.tab } : {}),
          }
        : null,
  },
  sessions: {
    entityType: 'session',
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'session_observability',
      'trace_diagnostics',
      'containment_analysis',
      'quality_debugging',
    ],
    summary: (nav) => ({
      surfacePurpose: nav.subPage
        ? 'single_session_production_diagnostics'
        : 'production_session_review',
      optimizationFocus: 'containment_or_quality_improvement',
      expectedAnalysis:
        'trace_steps_flow_patterns_agent_goal_flow_steps_performance_and_improvement_recommendations',
      ...(nav.tab ? { sessionTab: nav.tab } : {}),
    }),
  },
  'search-ai': {
    entityType: 'knowledge_base',
    capabilities: ['knowledge_base_management', 'semantic_search', 'ingestion'],
  },
  workflows: {
    entityType: 'workflow',
    capabilities: ['workflow_design', 'workflow_monitoring'],
    summary: (nav) => (nav.tab ? { workflowTab: nav.tab } : null),
  },
  pipelines: {
    entityType: 'pipeline',
    capabilities: ['pipeline_configuration', 'pipeline_debugging'],
  },
  connections: {
    entityType: 'connection',
    capabilities: ['connection_management', 'oauth_configuration'],
    entityMetadata: (nav) =>
      nav.subPage
        ? {
            connection_id: nav.subPage,
            ...(nav.tab ? { focusTab: nav.tab } : {}),
          }
        : null,
  },
  integrations: {
    entityType: 'integration_draft',
    capabilities: [
      'integration_authoring',
      'integration_drafting',
      'api_integration',
      'oauth_configuration',
    ],
    entityMetadata: (nav) =>
      nav.subPage
        ? {
            draftId: nav.subPage,
            ...(nav.tab ? { focusTab: nav.tab } : {}),
            ...(nav.subSection ? { focusSection: nav.subSection } : {}),
          }
        : null,
    summary: (nav) => ({
      surfacePurpose: 'integration_authoring',
      ...(nav.subPage ? { draftId: nav.subPage } : {}),
    }),
  },
  deployments: {
    capabilities: ['channel_configuration', 'voice_configuration'],
  },
  dashboard: {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'project_observability',
      'analytics',
    ],
    summary: () => ({
      view: 'dashboard',
      surfacePurpose: 'production_agent_optimization',
      optimizationFocus: 'containment_or_quality_improvement',
      expectedAnalysis:
        'metrics_to_trace_drilldown_agent_goal_flow_steps_and_modification_recommendations',
    }),
  },
  analytics: {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'analytics',
      'session_analytics',
      'production_observability',
    ],
    summary: () => ({
      surfacePurpose: 'production_agent_optimization',
      optimizationFocus: 'containment_or_quality_improvement',
      expectedAnalysis:
        'all_analytics_menus_session_trace_agent_goal_flow_steps_and_improvement_recommendations',
    }),
  },
  'agent-performance': {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'agent_observability',
      'analytics',
      'performance_optimization',
    ],
  },
  'quality-monitor': {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'monitoring',
      'analytics',
      'quality_monitoring',
    ],
  },
  'customer-insights': {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'analytics',
      'insights',
      'customer_intent_analysis',
    ],
  },
  'voice-analytics': {
    capabilities: [
      ...PRODUCTION_AGENT_OPTIMIZATION_CAPABILITIES,
      'analytics',
      'voice',
      'voice_quality',
    ],
  },
  evals: {
    capabilities: ['testing_evaluation'],
  },
  experiments: {
    capabilities: ['experimentation'],
  },
  'guardrails-config': {
    capabilities: ['guardrail_management'],
    summary: () => ({ view: 'guardrails-config' }),
  },
  'settings-members': {
    capabilities: ['settings_management', 'member_management'],
  },
  'settings-api-keys': {
    capabilities: ['settings_management', 'credentials_management'],
  },
  'settings-models': {
    capabilities: ['settings_management', 'model_configuration'],
  },
  'settings-config-vars': {
    capabilities: ['settings_management', 'config_variables'],
  },
  'settings-runtime-config': {
    capabilities: ['settings_management', 'runtime_configuration'],
  },
  'settings-trace-dimensions': {
    capabilities: ['settings_management', 'trace_configuration'],
  },
  'settings-agent-transfer': {
    capabilities: ['settings_management', 'agent_transfer'],
  },
  'settings-agent-assist': {
    capabilities: ['settings_management', 'agent_assist'],
  },
  'settings-pii-protection': {
    capabilities: ['settings_management', 'compliance'],
  },
  'settings-auth-profiles': {
    capabilities: ['settings_management', 'oauth_configuration'],
  },
  'settings-attachments': {
    capabilities: ['settings_management', 'attachments'],
  },
  'settings-omnichannel': {
    capabilities: ['settings_management', 'channel_configuration'],
  },
  'settings-modules': {
    capabilities: ['settings_management', 'module_management'],
  },
};

function dedupeStrings(values: Array<string | null | undefined>): string[] | undefined {
  const deduped = Array.from(
    new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
  return deduped.length > 0 ? deduped : undefined;
}

export function resolvePageContextEntity(nav: PageContextNavState): PageContext['entity'] | null {
  if (!nav.page || !nav.subPage) {
    return null;
  }

  const entry = PAGE_CONTEXT_REGISTRY[nav.page];
  if (!entry?.entityType) {
    return null;
  }

  const entity: NonNullable<PageContext['entity']> = {
    type: entry.entityType,
    id: nav.subPage,
    name: nav.subPageLabel ?? nav.subPage,
  };

  const metadata = entry.entityMetadata?.(nav);
  if (metadata && Object.keys(metadata).length > 0) {
    entity.metadata = metadata;
  }

  return entity;
}

export function resolvePageContextCapabilities(
  nav: PageContextNavState,
): PageContext['capabilities'] {
  if (!nav.page) {
    return undefined;
  }

  const entry = PAGE_CONTEXT_REGISTRY[nav.page];
  return dedupeStrings([
    ...(entry?.capabilities ?? []),
    nav.tab ? `${nav.page}_tab_${nav.tab}` : null,
    nav.subSection ? `${nav.page}_section_${nav.subSection}` : null,
  ]);
}

export function resolvePageContextSummary(
  nav: PageContextNavState,
): Record<string, unknown> | null {
  if (!nav.page) {
    return null;
  }

  if (nav.page.startsWith('settings')) {
    return {
      settingsTab: nav.page.replace('settings-', ''),
      ...(SENSITIVE_SETTINGS_PAGES.has(nav.page) ? { sensitive: true } : {}),
    };
  }

  const entry = PAGE_CONTEXT_REGISTRY[nav.page];
  return entry?.summary?.(nav) ?? null;
}
