import { z } from 'zod';

// =============================================================================
// SHARED FILTER TYPES
// =============================================================================

export const PERSISTED_FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'before',
  'after',
  'is_set',
  'is_not_set',
] as const;

export type PersistedFilterOperator = (typeof PERSISTED_FILTER_OPERATORS)[number];

export interface PersistedFilterRow {
  id: string;
  columnKey: string;
  operator: PersistedFilterOperator;
  value: string;
}

export interface PageFilterChip {
  key: string;
  label: string;
  value: string;
}

export interface AtAGlanceFilters {
  dateRange: '7d' | '30d' | '90d';
  activeTab: 'overview' | 'trends' | 'roi' | 'conversations';
  conversationFilter: string;
}

export interface AnalyticsPageFilters {
  dateRangeMode: 'quick' | 'custom';
  quickRange: '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '2d' | '7d' | '30d';
  customFrom: string;
  customTo: string;
  activeTab: 'overview' | 'llm' | 'sessions-explorer' | 'traces-explorer' | 'query';
}

export interface AnalyticsSessionsFilters {
  statusFilter: 'all' | 'active' | 'completed' | 'escalated' | 'failed' | 'ended';
  search: string;
  channelFilter: string;
  environmentFilter: string;
  /** Session source filter — controls which sessions are queried from the analytics backend.
   *  'production' excludes eval/synthetic; 'all' includes everything; specific values filter to that type. */
  sourceFilter: 'production' | 'eval' | 'synthetic' | 'all';
  filters: PersistedFilterRow[];
}

export interface AnalyticsTracesFilters {
  activeSubTab: 'traces' | 'generations';
  typeFilter: 'all' | 'llm_call' | 'tool_call' | 'decision' | 'handoff' | 'error' | 'agent';
  searchQuery: string;
  filterRows: PersistedFilterRow[];
}

export interface AnalyticsGenerationsFilters {
  searchQuery: string;
  filterRows: PersistedFilterRow[];
}

export interface BillingUsageFilters {
  dateRange: '7d' | '30d' | '90d';
}

export interface AgentPerformanceFilters {
  dateRange: '7d' | '30d' | '90d';
  compareEnabled: boolean;
  search: string;
  statusFilter: 'all' | 'critical' | 'warning';
}

export interface QualityMonitorFilters {
  dateRange: '7d' | '30d' | '90d';
  dimensionFilter: string;
  scoreFilter: 'all' | 'critical' | 'warning' | 'healthy';
}

export interface CustomerInsightsFilters {
  dateRange: '7d' | '30d' | '90d';
}

export interface VoiceAnalyticsFilters {
  dateRange: '24h' | '7d' | '30d';
}

export interface SurfaceStateMap {
  atAGlance: AtAGlanceFilters;
  analyticsPage: AnalyticsPageFilters;
  analyticsSessions: AnalyticsSessionsFilters;
  analyticsTraces: AnalyticsTracesFilters;
  analyticsGenerations: AnalyticsGenerationsFilters;
  billingUsage: BillingUsageFilters;
  agentPerformance: AgentPerformanceFilters;
  qualityMonitor: QualityMonitorFilters;
  customerInsights: CustomerInsightsFilters;
  voiceAnalytics: VoiceAnalyticsFilters;
}

export type SurfaceKey = keyof SurfaceStateMap;

export type PersistedInsightsAnalyticsProjectFilters = Partial<{
  [K in SurfaceKey]: SurfaceStateMap[K];
}>;

export interface PersistedInsightsAnalyticsFilters {
  version: 1;
  byProject: Record<string, PersistedInsightsAnalyticsProjectFilters>;
}

export interface InsightsAnalyticsSurfaceDescriptor<T> {
  defaults: T;
  normalize: (raw: unknown) => T;
  countNonDefault: (state: T) => number;
  getResetState: (state: T) => T;
  getPageChips: (state: T) => PageFilterChip[];
  clearPageChip: (state: T, chipKey: string) => T;
}

// =============================================================================
// DEFAULTS
// =============================================================================

export const DEFAULT_AT_A_GLANCE_FILTERS: AtAGlanceFilters = {
  dateRange: '30d',
  activeTab: 'overview',
  conversationFilter: '',
};

export const DEFAULT_ANALYTICS_PAGE_FILTERS: AnalyticsPageFilters = {
  dateRangeMode: 'quick',
  quickRange: '7d',
  customFrom: '',
  customTo: '',
  activeTab: 'overview',
};

export const DEFAULT_ANALYTICS_SESSIONS_FILTERS: AnalyticsSessionsFilters = {
  statusFilter: 'all',
  search: '',
  channelFilter: '',
  environmentFilter: '',
  sourceFilter: 'production',
  filters: [],
};

export const DEFAULT_ANALYTICS_TRACES_FILTERS: AnalyticsTracesFilters = {
  activeSubTab: 'traces',
  typeFilter: 'all',
  searchQuery: '',
  filterRows: [],
};

export const DEFAULT_ANALYTICS_GENERATIONS_FILTERS: AnalyticsGenerationsFilters = {
  searchQuery: '',
  filterRows: [],
};

export const DEFAULT_BILLING_USAGE_FILTERS: BillingUsageFilters = {
  dateRange: '7d',
};

export const DEFAULT_AGENT_PERFORMANCE_FILTERS: AgentPerformanceFilters = {
  dateRange: '7d',
  compareEnabled: false,
  search: '',
  statusFilter: 'all',
};

export const DEFAULT_QUALITY_MONITOR_FILTERS: QualityMonitorFilters = {
  dateRange: '30d',
  dimensionFilter: 'all',
  scoreFilter: 'all',
};

export const DEFAULT_CUSTOMER_INSIGHTS_FILTERS: CustomerInsightsFilters = {
  dateRange: '30d',
};

export const DEFAULT_VOICE_ANALYTICS_FILTERS: VoiceAnalyticsFilters = {
  dateRange: '7d',
};

export const DEFAULT_INSIGHTS_ANALYTICS_FILTERS: PersistedInsightsAnalyticsFilters = {
  version: 1,
  byProject: {},
};

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const insightsDateRangeSchema = z.enum(['7d', '30d', '90d']);
const voiceDateRangeSchema = z.enum(['24h', '7d', '30d']);
const analyticsQuickRangeSchema = z.enum([
  '30m',
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '2d',
  '7d',
  '30d',
]);
const filterOperatorSchema = z.enum(PERSISTED_FILTER_OPERATORS);

const strictFilterRowSchema = z
  .object({
    id: z.string().min(1),
    columnKey: z.string().min(1),
    operator: filterOperatorSchema,
    value: z.string(),
  })
  .strict();

const atAGlanceHydrateSchema = z
  .object({
    dateRange: insightsDateRangeSchema.catch(DEFAULT_AT_A_GLANCE_FILTERS.dateRange),
    activeTab: z
      .enum(['overview', 'trends', 'roi', 'conversations'])
      .catch(DEFAULT_AT_A_GLANCE_FILTERS.activeTab),
    conversationFilter: z.string().catch(DEFAULT_AT_A_GLANCE_FILTERS.conversationFilter),
  })
  .catch(DEFAULT_AT_A_GLANCE_FILTERS);

const atAGlanceStrictSchema = z
  .object({
    dateRange: insightsDateRangeSchema,
    activeTab: z.enum(['overview', 'trends', 'roi', 'conversations']),
    conversationFilter: z.string(),
  })
  .strict();

const analyticsPageHydrateSchema = z
  .object({
    dateRangeMode: z.enum(['quick', 'custom']).catch(DEFAULT_ANALYTICS_PAGE_FILTERS.dateRangeMode),
    quickRange: analyticsQuickRangeSchema.catch(DEFAULT_ANALYTICS_PAGE_FILTERS.quickRange),
    customFrom: z.string().catch(DEFAULT_ANALYTICS_PAGE_FILTERS.customFrom),
    customTo: z.string().catch(DEFAULT_ANALYTICS_PAGE_FILTERS.customTo),
    activeTab: z
      .enum(['overview', 'llm', 'sessions-explorer', 'traces-explorer', 'query'])
      .catch(DEFAULT_ANALYTICS_PAGE_FILTERS.activeTab),
  })
  .catch(DEFAULT_ANALYTICS_PAGE_FILTERS);

const analyticsPageStrictSchema = z
  .object({
    dateRangeMode: z.enum(['quick', 'custom']),
    quickRange: analyticsQuickRangeSchema,
    customFrom: z.string(),
    customTo: z.string(),
    activeTab: z.enum(['overview', 'llm', 'sessions-explorer', 'traces-explorer', 'query']),
  })
  .strict();

const analyticsSessionsHydrateSchema = z
  .object({
    statusFilter: z
      .enum(['all', 'active', 'completed', 'escalated', 'failed', 'ended'])
      .catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.statusFilter),
    search: z.string().catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.search),
    channelFilter: z.string().catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.channelFilter),
    environmentFilter: z.string().catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.environmentFilter),
    sourceFilter: z
      .enum(['production', 'eval', 'synthetic', 'all'])
      .catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.sourceFilter),
    filters: z.array(strictFilterRowSchema).catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS.filters),
  })
  .catch(DEFAULT_ANALYTICS_SESSIONS_FILTERS);

const analyticsSessionsStrictSchema = z
  .object({
    statusFilter: z.enum(['all', 'active', 'completed', 'escalated', 'failed', 'ended']),
    search: z.string(),
    channelFilter: z.string(),
    environmentFilter: z.string(),
    sourceFilter: z.enum(['production', 'eval', 'synthetic', 'all']),
    filters: z.array(strictFilterRowSchema),
  })
  .strict();

const analyticsTracesHydrateSchema = z
  .object({
    activeSubTab: z
      .enum(['traces', 'generations'])
      .catch(DEFAULT_ANALYTICS_TRACES_FILTERS.activeSubTab),
    typeFilter: z
      .enum(['all', 'llm_call', 'tool_call', 'decision', 'handoff', 'error', 'agent'])
      .catch(DEFAULT_ANALYTICS_TRACES_FILTERS.typeFilter),
    searchQuery: z.string().catch(DEFAULT_ANALYTICS_TRACES_FILTERS.searchQuery),
    filterRows: z.array(strictFilterRowSchema).catch(DEFAULT_ANALYTICS_TRACES_FILTERS.filterRows),
  })
  .catch(DEFAULT_ANALYTICS_TRACES_FILTERS);

const analyticsTracesStrictSchema = z
  .object({
    activeSubTab: z.enum(['traces', 'generations']),
    typeFilter: z.enum(['all', 'llm_call', 'tool_call', 'decision', 'handoff', 'error', 'agent']),
    searchQuery: z.string(),
    filterRows: z.array(strictFilterRowSchema),
  })
  .strict();

const analyticsGenerationsHydrateSchema = z
  .object({
    searchQuery: z.string().catch(DEFAULT_ANALYTICS_GENERATIONS_FILTERS.searchQuery),
    filterRows: z
      .array(strictFilterRowSchema)
      .catch(DEFAULT_ANALYTICS_GENERATIONS_FILTERS.filterRows),
  })
  .catch(DEFAULT_ANALYTICS_GENERATIONS_FILTERS);

const analyticsGenerationsStrictSchema = z
  .object({
    searchQuery: z.string(),
    filterRows: z.array(strictFilterRowSchema),
  })
  .strict();

const billingUsageHydrateSchema = z
  .object({
    dateRange: insightsDateRangeSchema.catch(DEFAULT_BILLING_USAGE_FILTERS.dateRange),
  })
  .catch(DEFAULT_BILLING_USAGE_FILTERS);

const billingUsageStrictSchema = z
  .object({
    dateRange: insightsDateRangeSchema,
  })
  .strict();

const agentPerformanceHydrateSchema = z
  .object({
    dateRange: insightsDateRangeSchema.catch(DEFAULT_AGENT_PERFORMANCE_FILTERS.dateRange),
    compareEnabled: z.boolean().catch(DEFAULT_AGENT_PERFORMANCE_FILTERS.compareEnabled),
    search: z.string().catch(DEFAULT_AGENT_PERFORMANCE_FILTERS.search),
    statusFilter: z
      .enum(['all', 'critical', 'warning'])
      .catch(DEFAULT_AGENT_PERFORMANCE_FILTERS.statusFilter),
  })
  .catch(DEFAULT_AGENT_PERFORMANCE_FILTERS);

const agentPerformanceStrictSchema = z
  .object({
    dateRange: insightsDateRangeSchema,
    compareEnabled: z.boolean(),
    search: z.string(),
    statusFilter: z.enum(['all', 'critical', 'warning']),
  })
  .strict();

const qualityMonitorHydrateSchema = z
  .object({
    dateRange: insightsDateRangeSchema.catch(DEFAULT_QUALITY_MONITOR_FILTERS.dateRange),
    dimensionFilter: z.string().catch(DEFAULT_QUALITY_MONITOR_FILTERS.dimensionFilter),
    scoreFilter: z
      .enum(['all', 'critical', 'warning', 'healthy'])
      .catch(DEFAULT_QUALITY_MONITOR_FILTERS.scoreFilter),
  })
  .catch(DEFAULT_QUALITY_MONITOR_FILTERS);

const qualityMonitorStrictSchema = z
  .object({
    dateRange: insightsDateRangeSchema,
    dimensionFilter: z.string(),
    scoreFilter: z.enum(['all', 'critical', 'warning', 'healthy']),
  })
  .strict();

const customerInsightsHydrateSchema = z
  .object({
    dateRange: insightsDateRangeSchema.catch(DEFAULT_CUSTOMER_INSIGHTS_FILTERS.dateRange),
  })
  .catch(DEFAULT_CUSTOMER_INSIGHTS_FILTERS);

const customerInsightsStrictSchema = z
  .object({
    dateRange: insightsDateRangeSchema,
  })
  .strict();

const voiceAnalyticsHydrateSchema = z
  .object({
    dateRange: voiceDateRangeSchema.catch(DEFAULT_VOICE_ANALYTICS_FILTERS.dateRange),
  })
  .catch(DEFAULT_VOICE_ANALYTICS_FILTERS);

const voiceAnalyticsStrictSchema = z
  .object({
    dateRange: voiceDateRangeSchema,
  })
  .strict();

const strictProjectFiltersSchema = z
  .object({
    atAGlance: atAGlanceStrictSchema.optional(),
    analyticsPage: analyticsPageStrictSchema.optional(),
    analyticsSessions: analyticsSessionsStrictSchema.optional(),
    analyticsTraces: analyticsTracesStrictSchema.optional(),
    analyticsGenerations: analyticsGenerationsStrictSchema.optional(),
    billingUsage: billingUsageStrictSchema.optional(),
    agentPerformance: agentPerformanceStrictSchema.optional(),
    qualityMonitor: qualityMonitorStrictSchema.optional(),
    customerInsights: customerInsightsStrictSchema.optional(),
    voiceAnalytics: voiceAnalyticsStrictSchema.optional(),
  })
  .strict();

export const strictInsightsAnalyticsFiltersSchema = z
  .object({
    version: z.literal(1),
    byProject: z.record(z.string().min(1), strictProjectFiltersSchema),
  })
  .strict();

const hydratePayloadSchema = z
  .object({
    version: z.literal(1),
    byProject: z.record(z.string().min(1), z.unknown()),
  })
  .passthrough();

// =============================================================================
// DESCRIPTORS
// =============================================================================

function defaultClearPageChip<T>(state: T): T {
  return state;
}

function defaultGetPageChips(): PageFilterChip[] {
  return [];
}

function createDescriptor<T>({
  defaults,
  normalizeSchema,
  countNonDefault,
  getResetState,
  getPageChips,
  clearPageChip,
}: {
  defaults: T;
  normalizeSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  countNonDefault: (state: T) => number;
  getResetState?: (state: T) => T;
  getPageChips?: (state: T) => PageFilterChip[];
  clearPageChip?: (state: T, chipKey: string) => T;
}): InsightsAnalyticsSurfaceDescriptor<T> {
  return {
    defaults,
    normalize: (raw: unknown) => normalizeSchema.parse(raw),
    countNonDefault,
    getResetState: getResetState ?? (() => normalizeSchema.parse(defaults)),
    getPageChips: getPageChips ?? defaultGetPageChips,
    clearPageChip: clearPageChip ?? defaultClearPageChip,
  };
}

export const SURFACE_DESCRIPTORS: {
  [K in SurfaceKey]: InsightsAnalyticsSurfaceDescriptor<SurfaceStateMap[K]>;
} = {
  atAGlance: createDescriptor<AtAGlanceFilters>({
    defaults: DEFAULT_AT_A_GLANCE_FILTERS,
    normalizeSchema: atAGlanceHydrateSchema,
    countNonDefault: (state) =>
      Number(state.dateRange !== DEFAULT_AT_A_GLANCE_FILTERS.dateRange) +
      Number(state.activeTab !== DEFAULT_AT_A_GLANCE_FILTERS.activeTab) +
      Number(state.conversationFilter.trim().length > 0),
  }),
  analyticsPage: createDescriptor<AnalyticsPageFilters>({
    defaults: DEFAULT_ANALYTICS_PAGE_FILTERS,
    normalizeSchema: analyticsPageHydrateSchema,
    countNonDefault: (state) => {
      return state.dateRangeMode === 'custom'
        ? Number(Boolean(state.customFrom) || Boolean(state.customTo))
        : Number(state.quickRange !== DEFAULT_ANALYTICS_PAGE_FILTERS.quickRange);
    },
    getResetState: (state) => ({
      ...state,
      dateRangeMode: DEFAULT_ANALYTICS_PAGE_FILTERS.dateRangeMode,
      quickRange: DEFAULT_ANALYTICS_PAGE_FILTERS.quickRange,
      customFrom: DEFAULT_ANALYTICS_PAGE_FILTERS.customFrom,
      customTo: DEFAULT_ANALYTICS_PAGE_FILTERS.customTo,
    }),
  }),
  analyticsSessions: createDescriptor<AnalyticsSessionsFilters>({
    defaults: DEFAULT_ANALYTICS_SESSIONS_FILTERS,
    normalizeSchema: analyticsSessionsHydrateSchema,
    countNonDefault: (state) =>
      Number(state.statusFilter !== DEFAULT_ANALYTICS_SESSIONS_FILTERS.statusFilter) +
      Number(state.search.trim().length > 0) +
      Number(state.channelFilter.length > 0) +
      Number(state.environmentFilter.length > 0) +
      Number(state.sourceFilter !== DEFAULT_ANALYTICS_SESSIONS_FILTERS.sourceFilter) +
      state.filters.length,
    getPageChips: (state) => {
      const chips: PageFilterChip[] = [];
      if (state.statusFilter !== DEFAULT_ANALYTICS_SESSIONS_FILTERS.statusFilter) {
        chips.push({
          key: 'statusFilter',
          label: 'Status',
          value: capitalizeLabel(state.statusFilter),
        });
      }
      if (state.search.trim()) {
        chips.push({ key: 'search', label: 'Search', value: state.search.trim() });
      }
      if (state.channelFilter) {
        chips.push({ key: 'channelFilter', label: 'Channel', value: state.channelFilter });
      }
      if (state.environmentFilter) {
        chips.push({
          key: 'environmentFilter',
          label: 'Environment',
          value: state.environmentFilter,
        });
      }
      if (state.sourceFilter !== DEFAULT_ANALYTICS_SESSIONS_FILTERS.sourceFilter) {
        chips.push({
          key: 'sourceFilter',
          label: 'Source',
          value: capitalizeLabel(state.sourceFilter),
        });
      }
      return chips;
    },
    clearPageChip: (state, chipKey) => {
      switch (chipKey) {
        case 'statusFilter':
          return { ...state, statusFilter: DEFAULT_ANALYTICS_SESSIONS_FILTERS.statusFilter };
        case 'search':
          return { ...state, search: DEFAULT_ANALYTICS_SESSIONS_FILTERS.search };
        case 'channelFilter':
          return { ...state, channelFilter: DEFAULT_ANALYTICS_SESSIONS_FILTERS.channelFilter };
        case 'environmentFilter':
          return {
            ...state,
            environmentFilter: DEFAULT_ANALYTICS_SESSIONS_FILTERS.environmentFilter,
          };
        case 'sourceFilter':
          return { ...state, sourceFilter: DEFAULT_ANALYTICS_SESSIONS_FILTERS.sourceFilter };
        default:
          return state;
      }
    },
  }),
  analyticsTraces: createDescriptor<AnalyticsTracesFilters>({
    defaults: DEFAULT_ANALYTICS_TRACES_FILTERS,
    normalizeSchema: analyticsTracesHydrateSchema,
    countNonDefault: (state) =>
      Number(state.typeFilter !== DEFAULT_ANALYTICS_TRACES_FILTERS.typeFilter) +
      Number(state.searchQuery.trim().length > 0) +
      state.filterRows.length,
    getResetState: (state) => ({
      ...DEFAULT_ANALYTICS_TRACES_FILTERS,
      activeSubTab: state.activeSubTab,
    }),
    getPageChips: (state) => {
      const chips: PageFilterChip[] = [];
      if (state.typeFilter !== DEFAULT_ANALYTICS_TRACES_FILTERS.typeFilter) {
        chips.push({
          key: 'typeFilter',
          label: 'Type',
          value: formatTraceTypeFilterLabel(state.typeFilter),
        });
      }
      if (state.searchQuery.trim()) {
        chips.push({ key: 'searchQuery', label: 'Search', value: state.searchQuery.trim() });
      }
      return chips;
    },
    clearPageChip: (state, chipKey) => {
      switch (chipKey) {
        case 'typeFilter':
          return { ...state, typeFilter: DEFAULT_ANALYTICS_TRACES_FILTERS.typeFilter };
        case 'searchQuery':
          return { ...state, searchQuery: DEFAULT_ANALYTICS_TRACES_FILTERS.searchQuery };
        default:
          return state;
      }
    },
  }),
  analyticsGenerations: createDescriptor<AnalyticsGenerationsFilters>({
    defaults: DEFAULT_ANALYTICS_GENERATIONS_FILTERS,
    normalizeSchema: analyticsGenerationsHydrateSchema,
    countNonDefault: (state) =>
      Number(state.searchQuery.trim().length > 0) + state.filterRows.length,
    getPageChips: (state) =>
      state.searchQuery.trim()
        ? [{ key: 'searchQuery', label: 'Search', value: state.searchQuery.trim() }]
        : [],
    clearPageChip: (state, chipKey) =>
      chipKey === 'searchQuery'
        ? { ...state, searchQuery: DEFAULT_ANALYTICS_GENERATIONS_FILTERS.searchQuery }
        : state,
  }),
  billingUsage: createDescriptor<BillingUsageFilters>({
    defaults: DEFAULT_BILLING_USAGE_FILTERS,
    normalizeSchema: billingUsageHydrateSchema,
    countNonDefault: (state) => Number(state.dateRange !== DEFAULT_BILLING_USAGE_FILTERS.dateRange),
  }),
  agentPerformance: createDescriptor<AgentPerformanceFilters>({
    defaults: DEFAULT_AGENT_PERFORMANCE_FILTERS,
    normalizeSchema: agentPerformanceHydrateSchema,
    countNonDefault: (state) =>
      Number(state.dateRange !== DEFAULT_AGENT_PERFORMANCE_FILTERS.dateRange) +
      Number(state.compareEnabled) +
      Number(state.search.trim().length > 0) +
      Number(state.statusFilter !== DEFAULT_AGENT_PERFORMANCE_FILTERS.statusFilter),
  }),
  qualityMonitor: createDescriptor<QualityMonitorFilters>({
    defaults: DEFAULT_QUALITY_MONITOR_FILTERS,
    normalizeSchema: qualityMonitorHydrateSchema,
    countNonDefault: (state) =>
      Number(state.dateRange !== DEFAULT_QUALITY_MONITOR_FILTERS.dateRange) +
      Number(state.dimensionFilter !== DEFAULT_QUALITY_MONITOR_FILTERS.dimensionFilter) +
      Number(state.scoreFilter !== DEFAULT_QUALITY_MONITOR_FILTERS.scoreFilter),
  }),
  customerInsights: createDescriptor<CustomerInsightsFilters>({
    defaults: DEFAULT_CUSTOMER_INSIGHTS_FILTERS,
    normalizeSchema: customerInsightsHydrateSchema,
    countNonDefault: (state) =>
      Number(state.dateRange !== DEFAULT_CUSTOMER_INSIGHTS_FILTERS.dateRange),
  }),
  voiceAnalytics: createDescriptor<VoiceAnalyticsFilters>({
    defaults: DEFAULT_VOICE_ANALYTICS_FILTERS,
    normalizeSchema: voiceAnalyticsHydrateSchema,
    countNonDefault: (state) =>
      Number(state.dateRange !== DEFAULT_VOICE_ANALYTICS_FILTERS.dateRange),
  }),
};

export const SURFACE_KEYS = Object.keys(SURFACE_DESCRIPTORS) as SurfaceKey[];

// =============================================================================
// HELPERS
// =============================================================================

function capitalizeLabel(value: string): string {
  return value
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function formatTraceTypeFilterLabel(filter: AnalyticsTracesFilters['typeFilter']): string {
  switch (filter) {
    case 'llm_call':
      return 'LLM Call';
    case 'tool_call':
      return 'Tool Call';
    default:
      return capitalizeLabel(filter);
  }
}

function areStatesEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assignNormalizedProjectSurface<K extends SurfaceKey>(
  nextProjectState: PersistedInsightsAnalyticsProjectFilters,
  surfaceKey: K,
  rawSurface: unknown,
): void {
  nextProjectState[surfaceKey] = SURFACE_DESCRIPTORS[surfaceKey].normalize(rawSurface);
}

export function normalizeInsightsAnalyticsFilters(raw: unknown): PersistedInsightsAnalyticsFilters {
  const parsed = hydratePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return DEFAULT_INSIGHTS_ANALYTICS_FILTERS;
  }

  const byProject: PersistedInsightsAnalyticsFilters['byProject'] = {};

  for (const [projectId, rawProjectState] of Object.entries(parsed.data.byProject)) {
    if (!rawProjectState || typeof rawProjectState !== 'object') {
      continue;
    }

    const projectRecord = rawProjectState as Record<string, unknown>;
    const nextProjectState: PersistedInsightsAnalyticsProjectFilters = {};

    for (const surfaceKey of SURFACE_KEYS) {
      if (surfaceKey in projectRecord) {
        assignNormalizedProjectSurface(nextProjectState, surfaceKey, projectRecord[surfaceKey]);
      }
    }

    if (Object.keys(nextProjectState).length > 0) {
      byProject[projectId] = nextProjectState;
    }
  }

  return {
    version: 1,
    byProject,
  };
}

export function getSurfaceState<K extends SurfaceKey>(
  filters: PersistedInsightsAnalyticsFilters | undefined,
  projectId: string | null,
  surfaceKey: K,
): SurfaceStateMap[K] {
  const descriptor = SURFACE_DESCRIPTORS[surfaceKey];
  if (!projectId || !filters) {
    return descriptor.normalize(descriptor.defaults);
  }

  return descriptor.normalize(filters.byProject[projectId]?.[surfaceKey]);
}

export function setSurfaceState<K extends SurfaceKey>(
  filters: PersistedInsightsAnalyticsFilters | undefined,
  projectId: string,
  surfaceKey: K,
  nextState: SurfaceStateMap[K],
): PersistedInsightsAnalyticsFilters {
  const normalizedFilters = normalizeInsightsAnalyticsFilters(filters);
  const descriptor = SURFACE_DESCRIPTORS[surfaceKey];
  const normalizedState = descriptor.normalize(nextState);
  const nextByProject = { ...normalizedFilters.byProject };
  const nextProjectState = { ...(nextByProject[projectId] ?? {}) };

  if (areStatesEqual(normalizedState, descriptor.defaults)) {
    delete nextProjectState[surfaceKey];
  } else {
    nextProjectState[surfaceKey] = normalizedState;
  }

  if (Object.keys(nextProjectState).length === 0) {
    delete nextByProject[projectId];
  } else {
    nextByProject[projectId] = nextProjectState;
  }

  return {
    version: 1,
    byProject: nextByProject,
  };
}

export function resetSurfaceState<K extends SurfaceKey>(
  filters: PersistedInsightsAnalyticsFilters | undefined,
  projectId: string,
  surfaceKey: K,
): PersistedInsightsAnalyticsFilters {
  const currentState = getSurfaceState(filters, projectId, surfaceKey);
  const descriptor = SURFACE_DESCRIPTORS[surfaceKey];
  return setSurfaceState(filters, projectId, surfaceKey, descriptor.getResetState(currentState));
}
