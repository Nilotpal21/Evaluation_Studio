import { z } from 'zod';

import type { ToolName } from '../../types/tools.js';

const sectionEditSchema = z.object({
  construct: z.string().min(1),
  content: z.string().nullable(),
});

const proposeModificationSchema = z
  .object({
    agentName: z.string().min(1),
    change: z.string().min(1).optional(),
    /** Full ABL rewrite — for major restructuring across 3+ sections. */
    updatedCode: z.string().min(1).optional(),
    /** Section-level edits — preferred for targeted changes. Each entry includes its header line. */
    sections: z.array(sectionEditSchema).min(1).optional(),
    /** True when proposing a brand-new agent (no existing agent to read). */
    isNew: z.boolean().optional(),
    /** @deprecated Legacy field — use updatedCode instead. */
    modification: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    // Legacy modification path — backwards-compat
    if (input.modification) return;

    if (!input.change) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['change'],
        message: 'change is required',
      });
    }

    // Must provide exactly one of updatedCode or sections
    const hasCode = Boolean(input.updatedCode);
    const hasSections = Boolean(input.sections && input.sections.length > 0);

    if (!hasCode && !hasSections) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedCode'],
        message: 'Provide either updatedCode or sections',
      });
    }
    if (hasCode && hasSections) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'Provide either updatedCode or sections, not both',
      });
    }
  });

const planMutationSchema = z.object({
  sourceTool: z.string().min(1),
  sourceAction: z.string().min(1),
  targetKind: z.enum([
    'agent_dsl',
    'agent_topology',
    'project_memory',
    'tool_binding',
    'project_config',
    'integration_config',
    'test_or_eval',
  ]),
  operation: z.enum(['create', 'modify', 'delete', 'rename', 'apply']),
  agentName: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
});

const planSectionChangeSchema = z.object({
  agentName: z.string().min(1),
  construct: z.string().min(1),
  operation: z.enum(['create', 'modify', 'delete', 'rename']),
  reason: z.string().min(1),
});

const planReferenceSchema = z.object({
  kind: z.enum(['memory', 'gather_field', 'tool', 'agent', 'cel_var']),
  sourceAgent: z.string().min(1),
  targetAgent: z.string().min(1).optional(),
  fieldName: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  variableName: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
});

const proposePlanSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  summary: z.string().min(1),
  architecturalPattern: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  affectedAgents: z.array(z.string().min(1)).default([]),
  sectionsToChange: z.array(planSectionChangeSchema).min(1),
  dependentsAnalysis: z.object({
    summary: z.string().min(1),
    referencesFound: z.array(planReferenceSchema).default([]),
  }),
  alternativesConsidered: z
    .array(
      z.object({
        option: z.string().min(1),
        rejectedBecause: z.string().min(1),
      }),
    )
    .min(1),
  citations: z
    .array(
      z.object({
        sourceType: z.enum([
          'construct_spec',
          'validation_code',
          'topology_pattern',
          'reference_analysis',
          'feasibility_check',
          'runtime_context',
          'tool_readiness',
        ]),
        reference: z.string().min(1),
        relevance: z.string().min(1),
      }),
    )
    .min(1),
  plannedMutations: z.array(planMutationSchema).min(1),
  risks: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high']),
        description: z.string().min(1),
        mitigation: z.string().min(1),
      }),
    )
    .min(1),
  questionsForUser: z.array(z.string().min(1)).optional(),
  validationNotes: z.array(z.string().min(1)).default([]),
});

export const toolInputSchemas: Partial<Record<ToolName, z.ZodSchema>> = {
  dry_run_compile: z.object({
    code: z.string().min(1),
    agentName: z.string().min(1),
  }),

  run_feasibility_check: z.object({
    code: z.string().min(1),
    declaredToolNames: z.array(z.string().min(1)).optional(),
    resolvedToolNames: z.array(z.string().min(1)).optional(),
    checkName: z
      .enum([
        'empty-response',
        'tool-binding',
        'voice-model-feasibility',
        'provider-allowlist',
        'memory-scope-identity',
      ])
      .optional(),
  }),

  get_construct_spec: z.object({
    construct: z.string().min(1),
  }),

  list_valid_combinations: z.object({
    construct: z.string().min(1).optional(),
  }),

  get_cel_grammar: z.object({
    context: z.enum([
      'handoff_when',
      'delegate_when',
      'flow_when',
      'complete_when',
      'constraint_condition',
      'guardrail_when',
      'routing_rule_when',
      'recall_condition',
      'digression_condition',
    ]),
  }),

  lookup_validation_code: z.object({
    code: z.string().min(1),
  }),

  read_agent: z.object({
    agentName: z.string().min(1, 'agentName is required'),
  }),

  find_memory_refs: z.object({
    memoryName: z.string().min(1),
    agentName: z.string().min(1).optional(),
  }),

  find_gather_field_refs: z.object({
    fieldName: z.string().min(1),
    agentName: z.string().min(1).optional(),
  }),

  find_tool_consumers: z.object({
    toolName: z.string().min(1),
  }),

  find_agent_refs: z.object({
    agentName: z.string().min(1),
  }),

  find_cel_var_refs: z.object({
    variableName: z.string().min(1),
    agentName: z.string().min(1).optional(),
  }),

  query_traces: z.object({
    agentName: z.string().optional(),
    sessionId: z.string().optional(),
    eventType: z.string().optional(),
    eventTypes: z.array(z.string()).optional(),
    severity: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
    includeData: z.boolean().optional(),
  }),

  trace_diagnosis: z.object({
    action: z.enum(['discover', 'deep_dive', 'aggregate', 'compare', 'errors', 'explain']),
    query: z.string().optional(),
    sessionId: z.string().optional(),
    compareWithSessionId: z.string().optional(),
    compareWithTimeRange: z.string().optional(),
    compareFrom: z.string().optional(),
    compareTo: z.string().optional(),
    environment: z.string().optional(),
    compareWithEnvironment: z.string().optional(),
    groupByEnvironment: z.boolean().optional(),
    sessionRef: z.string().optional(),
    agentName: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    disposition: z.string().optional(),
    mine: z.boolean().optional(),
    timeRange: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
    traceTypes: z.array(z.string()).optional(),
    spanId: z.string().optional(),
  }),

  session_ops: z.object({
    action: z.enum(['list', 'get', 'get_analysis']),
    sessionId: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
    status: z.string().optional(),
  }),

  health_check: z.object({}),

  compile_abl: z.object({
    dsl: z.string().min(1, 'dsl content is required'),
  }),

  propose_plan: proposePlanSchema,

  propose_modification: proposeModificationSchema,

  apply_modification: z.object({
    agentName: z.string().min(1),
  }),

  dismiss_proposal: z.object({}),

  run_test: z.object({
    agentName: z.string().min(1),
    testMessage: z.string().min(1),
    expectedBehavior: z.string().optional(),
  }),

  ask_user: z.object({
    question: z.string().min(1),
    widgetType: z.enum(['SingleSelect', 'MultiSelect', 'TextInput', 'Confirmation']),
    options: z
      .array(z.union([z.string(), z.object({ label: z.string(), value: z.string() })]))
      .optional(),
    allowCustom: z.boolean().optional(),
    defaultValue: z.string().optional(),
    defaultValues: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    confirmLabel: z.string().optional(),
    denyLabel: z.string().optional(),
    minSelect: z.number().optional(),
    maxSelect: z.number().optional(),
  }),

  collect_file: z.object({
    message: z.string().min(1),
    accept: z.array(z.string()).optional(),
    maxFiles: z.number().optional(),
  }),

  read_topology: z.object({}),

  read_blueprint: z.object({
    version: z.number().int().positive().optional(),
    section: z.string().min(1).optional(),
  }),

  propose_blueprint_edit: z.object({
    sectionId: z.string().min(1),
    changes: z.unknown(),
    reason: z.string().min(1),
  }),

  lock_blueprint_version: z.object({}),

  fork_blueprint: z.object({}),

  rebuild_agents_from_blueprint: z.object({
    fromVersion: z.number().int().positive(),
    confirmOverwriteLocalEdits: z.boolean().optional().default(false),
  }),

  get_topology_patterns: z.object({
    filter: z
      .enum(['all', 'simple', 'complex'])
      .optional()
      .describe(
        'Filter topology patterns by complexity. simple = single_agent + triage; complex = pipeline + hub_spoke + mesh.',
      ),
    currentPattern: z
      .string()
      .optional()
      .describe('Current topology pattern to exclude when asking for alternatives'),
  }),

  read_journal: z.object({
    type: z.enum(['decision', 'consultation', 'mutation', 'validation', 'analysis']).optional(),
    phase: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  recommend_model: z.object({
    agentName: z.string().min(1).describe('Agent name to analyze, or "all" for topology-wide'),
  }),

  analyze_constraints: z.object({
    agentName: z.string().min(1).describe('Agent name or "all" for full coverage matrix'),
    regulations: z
      .array(z.string())
      .optional()
      .describe('Regulations to check: PCI-DSS, HIPAA, GDPR, SOC2'),
  }),

  validate_agent: z.object({
    agentName: z.string().min(1).describe('Agent name to validate, or "all" for all agents'),
    depth: z.enum(['quick', 'deep']).optional().default('deep').describe('Validation depth'),
  }),

  diagnose_project: z.object({
    focus: z
      .enum(['handoffs', 'tools', 'constraints', 'data_flow', 'all'])
      .optional()
      .default('all')
      .describe('Focus area for diagnosis'),
  }),

  explain_diagnostic: z.object({
    code: z.string().min(1).describe('Diagnostic code (e.g. H-01, CO-04, T-01)'),
    agentName: z.string().optional().describe('Agent name for context-specific explanation'),
  }),

  read_insights: z.object({
    action: z
      .enum([
        'overview',
        'quality',
        'outcomes',
        'agent_performance',
        'sentiment',
        'tool_performance',
      ])
      .describe('Type of insight to read'),
    agentName: z.string().optional().describe('Filter results by agent name'),
    timeRange: z
      .enum(['1h', '24h', '7d', '30d'])
      .optional()
      .default('7d')
      .describe('Time range for the query'),
  }),

  configure_model: z.object({
    action: z.enum(['inspect', 'diff', 'apply']).describe('Action to perform'),
    agentName: z.string().min(1).describe('Agent name, or "all" for topology-wide'),
    source: z
      .enum(['recommendation', 'manual'])
      .optional()
      .describe('Required for apply: recommendation or manual'),
    modelId: z
      .string()
      .optional()
      .describe('LiteLLM model ID for manual source, e.g. "claude-sonnet-4-6"'),
    provider: z.string().optional().describe('Provider key for manual source, e.g. "anthropic"'),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).optional(),
    operationModels: z
      .record(z.string(), z.string())
      .optional()
      .describe('Per-operation model ID overrides'),
    confirmed: z.boolean().optional().describe('Dangerous-action confirmation flag'),
  }),

  platform_context: z.object({
    action: z
      .enum([
        'get_summary',
        'list_agents',
        'list_models',
        'list_tools',
        'list_channels',
        'list_auth_profiles',
      ])
      .describe('Platform context action to perform'),
    agentName: z.string().optional().describe('Filter by agent name (for agent-specific data)'),
    toolType: z.string().optional().describe('Filter by tool type (for list_tools)'),
  }),

  tools_ops: z.object({
    action: z.enum(['read', 'list', 'create', 'update', 'test', 'delete']),
    toolId: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
    testInput: z.record(z.unknown()).optional(),
    confirmed: z.boolean().optional(),
  }),
  auth_ops: z.object({
    action: z.enum(['create', 'read', 'update', 'delete', 'list', 'validate']),
    profileId: z.string().min(1).optional(),
    profileName: z.string().min(1).optional(),
    authType: z
      .enum([
        'api_key',
        'bearer',
        'oauth2_app',
        'oauth2_client_credentials',
        'basic',
        'custom_header',
        'digest',
        'azure_ad',
        'none',
      ])
      .optional(),
    config: z.record(z.unknown()).optional(),
    flowId: z.string().min(1).optional(),
    confirmed: z.boolean().optional(),
  }),
  collect_secret: z.object({
    flowId: z.string().min(1),
    field: z.string().min(1),
    label: z.string().min(1),
  }),
  integration_ops: z.object({
    action: z.enum([
      'start',
      'get_active',
      'list',
      'update',
      'run_tool_test',
      'complete',
      'archive',
    ]),
    draftId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    providerKey: z.string().nullable().optional(),
    source: z.enum(['onboarding', 'in_project']).optional(),
    targetAgentNames: z.array(z.string().min(1)).optional(),
    pendingSteps: z.array(z.string().min(1)).optional(),
    addPendingSteps: z.array(z.string().min(1)).optional(),
    removePendingSteps: z.array(z.string().min(1)).optional(),
    lastIntentSummary: z.string().nullable().optional(),
    status: z
      .enum([
        'draft',
        'needs_input',
        'ready_to_test',
        'ready_to_apply',
        'complete',
        'archived',
        'failed',
      ])
      .optional(),
    includeCompleted: z.boolean().optional(),
    toolId: z.string().min(1).optional(),
    testInput: z.record(z.unknown()).optional(),
    toolIds: z.array(z.string().min(1)).optional(),
    authProfileIds: z.array(z.string().min(1)).optional(),
    envVarKeys: z.array(z.string().min(1)).optional(),
    configVarKeys: z.array(z.string().min(1)).optional(),
    variableNamespaceIds: z.array(z.string().min(1)).optional(),
  }),

  search_docs: z.object({
    query: z
      .string()
      .min(1)
      .describe('Search query — use specific terms, API paths, or feature names'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe('Max document sections to return'),
  }),
};
