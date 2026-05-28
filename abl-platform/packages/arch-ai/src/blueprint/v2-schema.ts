import { z } from 'zod';

const GUARDRAIL_KIND_VALUES = [
  'input',
  'output',
  'tool_input',
  'tool_output',
  'handoff',
  'both',
] as const;

const GUARDRAIL_ACTION_VALUES = [
  'block',
  'warn',
  'redact',
  'escalate',
  'fix',
  'reask',
  'filter',
] as const;

const guardrailKindValues = [...GUARDRAIL_KIND_VALUES] as [
  (typeof GUARDRAIL_KIND_VALUES)[number],
  ...(typeof GUARDRAIL_KIND_VALUES)[number][],
];

const guardrailActionValues = [...GUARDRAIL_ACTION_VALUES] as [
  (typeof GUARDRAIL_ACTION_VALUES)[number],
  ...(typeof GUARDRAIL_ACTION_VALUES)[number][],
];

export const BlueprintAgentNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Agent names must be valid ABL identifiers');

export const BlueprintExecutionModeSchema = z.enum(['reasoning', 'scripted', 'hybrid']);

export const BlueprintV2MetadataSchema = z
  .object({
    schemaVersion: z.literal('2.0'),
    projectName: z.string().min(1),
    generatedAt: z.string().min(1),
    authoringMode: z
      .enum(['llm_generated', 'derived_from_project', 'manual'])
      .default('llm_generated'),
  })
  .strict();

export const BlueprintV2SpecificationSchema = z
  .object({
    summary: z.string().min(1),
    users: z.array(z.string().min(1)).default([]),
    channels: z.array(z.string().min(1)).default([]),
    languages: z.array(z.string().min(1)).default(['English']),
    successCriteria: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const BlueprintV2TopologyAgentSchema = z
  .object({
    name: BlueprintAgentNameSchema,
    role: z.string().min(1),
    executionMode: BlueprintExecutionModeSchema,
    description: z.string().min(1),
  })
  .strict();

export const BlueprintV2TopologyEdgeSchema = z
  .object({
    from: BlueprintAgentNameSchema,
    to: BlueprintAgentNameSchema,
    type: z.enum(['delegate', 'escalate', 'transfer']),
    experienceMode: z
      .enum(['shared_voice_handoff', 'visible_handoff', 'silent_delegate', 'human_escalation'])
      .optional(),
    condition: z.string().min(1),
    allowCycle: z.boolean().optional(),
    expectReturn: z.boolean().optional(),
  })
  .strict();

export const BlueprintV2TopologySchema = z
  .object({
    pattern: z.enum(['single_agent', 'triage', 'pipeline', 'hub_spoke', 'mesh']).default('triage'),
    agents: z.array(BlueprintV2TopologyAgentSchema).min(1),
    edges: z.array(BlueprintV2TopologyEdgeSchema).default([]),
    entryPoint: BlueprintAgentNameSchema,
  })
  .strict();

export const BlueprintV2PersonaSchema = z
  .object({
    summary: z.string().min(1),
    tone: z.array(z.string().min(1)).default([]),
    rationale: z.string().min(1).optional(),
    limitations: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const BlueprintV2ToolConfirmationSchema = z
  .object({
    require: z.enum(['always', 'never', 'when_side_effects']).default('when_side_effects'),
    immutableParams: z.array(z.string().min(1)).default([]),
    consentRequiredIn: z.enum(['conversation', 'explicit_prompt']).optional(),
    consentScope: z.array(z.string().min(1)).default([]),
    consentAction: z.string().min(1).optional(),
    consentFallback: z.enum(['explicit_prompt', 'block']).optional(),
  })
  .strict();

export const BlueprintV2ToolRefSchema = z
  .object({
    ref: z.string().min(1),
    purpose: z.string().min(1),
    signature: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    sideEffects: z.boolean().optional(),
    confirmation: BlueprintV2ToolConfirmationSchema.optional(),
  })
  .strict();

export const BlueprintV2GatherFieldSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean().default(true),
    source: z.enum(['user', 'context', 'tool', 'memory']).default('user'),
    enumValues: z.array(z.string().min(1)).optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
    validation: z.string().min(1).optional(),
    sensitive: z.boolean().optional(),
    piiType: z
      .enum(['email', 'phone', 'ssn', 'credit_card', 'address', 'name', 'custom'])
      .optional(),
  })
  .strict();

export const BlueprintV2MemorySchema = z
  .object({
    session: z.array(z.string().min(1)).default([]),
    persistent: z
      .array(
        z
          .object({
            path: z.string().min(1),
            scope: z.enum(['user', 'project', 'execution_tree']),
            access: z.enum(['read', 'write', 'readwrite']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const BlueprintV2ConstraintSchema = z
  .object({
    label: z.string().min(1).default('always'),
    kind: z.enum(['require', 'limit', 'restrict', 'warning']).default('require'),
    condition: z.string().min(1),
    onFail: z.string().min(1),
    when: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
  })
  .strict();

export const BlueprintV2GuardrailSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(guardrailKindValues).default('input'),
    check: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    llmCheck: z.string().min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    action: z.enum(guardrailActionValues).default('block'),
    message: z.string().min(1).optional(),
    priority: z.number().int().optional(),
  })
  .strict()
  .superRefine((guardrail, ctx) => {
    const executableFields = [guardrail.check, guardrail.provider, guardrail.llmCheck].filter(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );
    if (executableFields.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Guardrail must define exactly one of check, provider, or llmCheck.',
        path: ['check'],
      });
    }
  });

export const BlueprintV2CompletionConditionSchema = z
  .object({
    when: z.string().min(1),
    respond: z.string().min(1).optional(),
    store: z.string().min(1).optional(),
  })
  .strict();

export const BlueprintV2HandoffSchema = z
  .object({
    to: BlueprintAgentNameSchema,
    when: z.string().min(1),
    context: z
      .object({
        pass: z.array(z.string().min(1)).default([]),
        summary: z.string().min(1),
        history: z
          .union([
            z.enum(['auto', 'none', 'summary_only', 'full']),
            z.object({ lastN: z.number().int().positive() }).strict(),
          ])
          .optional(),
      })
      .strict(),
    return: z.boolean().default(true),
    onFailure: z.enum(['continue', 'escalate', 'respond']).optional(),
    failureMessage: z.string().min(1).optional(),
  })
  .strict();

export const BlueprintV2ModelPolicySchema = z
  .object({
    agentType: z
      .enum(['classifier', 'support', 'dispatcher', 'research', 'reasoning'])
      .default('support'),
    reasoningRequired: z.boolean().default(false),
    defaultModelClass: z.enum(['fast_tool_capable', 'reasoning', 'research']).optional(),
  })
  .strict();

export const BlueprintV2ModelDefaultsSchema = z
  .object({
    fastToolCapable: z.string().min(1).optional(),
    reasoning: z.string().min(1).optional(),
    research: z.string().min(1).optional(),
  })
  .strict();

export const BlueprintV2PerAgentSpecSchema = z
  .object({
    role: z.string().min(1),
    goal: z.string().min(1),
    model: z.string().min(1).optional(),
    modelPolicy: BlueprintV2ModelPolicySchema.optional(),
    executionMode: BlueprintExecutionModeSchema,
    persona: BlueprintV2PersonaSchema,
    tools: z.array(BlueprintV2ToolRefSchema).default([]),
    gather: z
      .object({
        fields: z.array(BlueprintV2GatherFieldSchema).default([]),
      })
      .strict()
      .default({ fields: [] }),
    memory: BlueprintV2MemorySchema.default({ session: [], persistent: [] }),
    constraints: z.array(BlueprintV2ConstraintSchema).default([]),
    guardrails: z.array(BlueprintV2GuardrailSchema).default([]),
    complete: z
      .object({
        conditions: z.array(BlueprintV2CompletionConditionSchema).default([]),
      })
      .strict()
      .default({ conditions: [] }),
    handoffs: z.array(BlueprintV2HandoffSchema).default([]),
  })
  .strict();

export const BlueprintV2ToolBootstrapSchema = z
  .object({
    type: z.literal('http'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.string().min(1),
  })
  .strict();

export const BlueprintV2IntegrationToolSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    type: z.enum([
      'http',
      'mcp',
      'function',
      'mock',
      'sandbox',
      'lambda',
      'connector',
      'workflow',
      'searchai',
      'async_webhook',
    ]),
    description: z.string().min(1),
    bootstrapDescriptor: BlueprintV2ToolBootstrapSchema.optional(),
  })
  .strict();

export const BlueprintV2IntegrationsSchema = z
  .object({
    tools: z.array(BlueprintV2IntegrationToolSchema).default([]),
    apiSpecs: z
      .array(z.object({ name: z.string().min(1), source: z.string().optional() }))
      .default([]),
  })
  .strict();

export const BlueprintV2GovernanceSchema = z
  .object({
    compliance: z.array(z.string().min(1)).default([]),
    guardrails: z.array(BlueprintV2GuardrailSchema).default([]),
    policies: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            enforcement: z.enum(['block', 'warn', 'log']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const BlueprintV2OutputSchema = z
  .object({
    version: z.literal('2.0'),
    metadata: BlueprintV2MetadataSchema,
    specification: BlueprintV2SpecificationSchema,
    topology: BlueprintV2TopologySchema,
    perAgent: z.record(BlueprintV2PerAgentSpecSchema),
    governance: BlueprintV2GovernanceSchema.default({
      compliance: [],
      guardrails: [],
      policies: [],
    }),
    integrations: BlueprintV2IntegrationsSchema.default({ tools: [], apiSpecs: [] }),
    modelDefaults: BlueprintV2ModelDefaultsSchema.optional(),
    buildOrder: z.array(BlueprintAgentNameSchema),
    approvedAt: z.string().optional(),
  })
  .strict();

export type BlueprintV2Output = z.infer<typeof BlueprintV2OutputSchema>;
export type BlueprintV2PerAgentSpec = z.infer<typeof BlueprintV2PerAgentSpecSchema>;
export type BlueprintV2ValidationIssue = {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'warning';
};

function issue(
  code: string,
  message: string,
  path: string,
  severity: 'error' | 'warning' = 'error',
): BlueprintV2ValidationIssue {
  return { code, message, path, severity };
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function validateBlueprintV2Output(input: unknown): BlueprintV2ValidationIssue[] {
  const parsed = BlueprintV2OutputSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((zodIssue) =>
      issue('SCHEMA_INVALID', zodIssue.message, zodIssue.path.join('.') || '$'),
    );
  }

  const blueprint = parsed.data;
  const issues: BlueprintV2ValidationIssue[] = [];
  const agentNames = blueprint.topology.agents.map((agent) => agent.name);
  const agentNameSet = new Set(agentNames);

  if (agentNameSet.size !== agentNames.length) {
    issues.push(issue('DUPLICATE_AGENT', 'Topology agent names must be unique', 'topology.agents'));
  }

  if (!agentNameSet.has(blueprint.topology.entryPoint)) {
    issues.push(
      issue(
        'ENTRYPOINT_UNKNOWN',
        `Entry point "${blueprint.topology.entryPoint}" is not a topology agent`,
        'topology.entryPoint',
      ),
    );
  }

  for (const name of agentNames) {
    if (!blueprint.perAgent[name]) {
      issues.push(
        issue('PER_AGENT_MISSING', `Missing perAgent spec for "${name}"`, `perAgent.${name}`),
      );
    }
  }

  for (const name of Object.keys(blueprint.perAgent)) {
    if (!agentNameSet.has(name)) {
      issues.push(
        issue('PER_AGENT_ORPHAN', `perAgent spec "${name}" is not in topology`, `perAgent.${name}`),
      );
    }
  }

  if (!sameMembers(blueprint.buildOrder, agentNames)) {
    issues.push(
      issue(
        'BUILD_ORDER_MISMATCH',
        'buildOrder must contain exactly the topology agent names',
        'buildOrder',
      ),
    );
  }

  blueprint.topology.edges.forEach((edge, index) => {
    if (!agentNameSet.has(edge.from)) {
      issues.push(
        issue(
          'EDGE_FROM_UNKNOWN',
          `Edge source "${edge.from}" is unknown`,
          `topology.edges.${index}.from`,
        ),
      );
    }
    if (!agentNameSet.has(edge.to)) {
      issues.push(
        issue(
          'EDGE_TO_UNKNOWN',
          `Edge target "${edge.to}" is unknown`,
          `topology.edges.${index}.to`,
        ),
      );
    }
    if (!edge.experienceMode) {
      issues.push(
        issue(
          'EDGE_EXPERIENCE_MODE_MISSING',
          `Edge from "${edge.from}" to "${edge.to}" should declare what the customer experiences`,
          `topology.edges.${index}.experienceMode`,
          'warning',
        ),
      );
    }
    if (
      edge.type === 'escalate' &&
      edge.experienceMode &&
      edge.experienceMode !== 'human_escalation'
    ) {
      issues.push(
        issue(
          'EDGE_EXPERIENCE_MODE_MISMATCH',
          `Escalation edge from "${edge.from}" to "${edge.to}" cannot use experienceMode "${edge.experienceMode}"`,
          `topology.edges.${index}.experienceMode`,
        ),
      );
    }
    if (edge.experienceMode === 'silent_delegate' && edge.type !== 'delegate') {
      issues.push(
        issue(
          'EDGE_EXPERIENCE_MODE_MISMATCH',
          `silent_delegate experience requires a delegate edge from "${edge.from}" to "${edge.to}"`,
          `topology.edges.${index}.experienceMode`,
        ),
      );
    }
    if (
      (edge.experienceMode === 'shared_voice_handoff' ||
        edge.experienceMode === 'visible_handoff') &&
      edge.type !== 'transfer'
    ) {
      issues.push(
        issue(
          'EDGE_EXPERIENCE_MODE_MISMATCH',
          `${edge.experienceMode} experience requires a transfer edge from "${edge.from}" to "${edge.to}"`,
          `topology.edges.${index}.experienceMode`,
        ),
      );
    }
    if (edge.experienceMode === 'human_escalation' && edge.type !== 'escalate') {
      issues.push(
        issue(
          'EDGE_EXPERIENCE_MODE_MISMATCH',
          `human_escalation experience requires an escalate edge from "${edge.from}" to "${edge.to}"`,
          `topology.edges.${index}.experienceMode`,
        ),
      );
    }
  });

  for (const [agentName, agent] of Object.entries(blueprint.perAgent)) {
    agent.handoffs.forEach((handoff, index) => {
      if (!agentNameSet.has(handoff.to)) {
        issues.push(
          issue(
            'HANDOFF_TARGET_UNKNOWN',
            `Handoff from "${agentName}" targets unknown agent "${handoff.to}"`,
            `perAgent.${agentName}.handoffs.${index}.to`,
          ),
        );
      }
    });
  }

  blueprint.integrations.tools.forEach((tool, index) => {
    if (tool.bootstrapDescriptor && tool.type !== 'http') {
      issues.push(
        issue(
          'NON_HTTP_BOOTSTRAP_UNSUPPORTED',
          `Tool "${tool.name}" has bootstrapDescriptor but type "${tool.type}" is not supported in v1`,
          `integrations.tools.${index}.bootstrapDescriptor`,
        ),
      );
    }
    if (tool.type !== 'http' && !tool.id) {
      issues.push(
        issue(
          'NON_HTTP_TOOL_REF_REQUIRES_ID',
          `Non-HTTP tool "${tool.name}" must reference an existing Project Tool by id`,
          `integrations.tools.${index}.id`,
        ),
      );
    }
  });

  return issues;
}

export function assertValidBlueprintV2Output(input: unknown): BlueprintV2Output {
  const issues = validateBlueprintV2Output(input);
  const errors = issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((item) => `${item.code}: ${item.message}`).join('; '));
  }
  return BlueprintV2OutputSchema.parse(input);
}
