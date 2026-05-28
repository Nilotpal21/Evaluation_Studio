/**
 * Workflow Zod Schemas — Node-Based Canvas System
 *
 * Runtime validation schemas for 16 node types, workflow definitions,
 * and execution inputs.
 */

import { z } from 'zod';
import { WORKFLOW_STATUSES, type WorkflowStatus } from '@agent-platform/shared-kernel';

// Re-export the canonical status enum so consumers have a single import point.
export { WORKFLOW_STATUSES, type WorkflowStatus };

// ─── Node Type Enum ─────────────────────────────────────────────────────

export const NodeTypeSchema = z.enum([
  'start',
  'end',
  'condition',
  'loop',
  'delay',
  'text_to_text',
  'text_to_image',
  'audio_to_text',
  'image_to_text',
  'api',
  'function',
  'integration',
  'browser',
  'doc_search',
  'doc_intelligence',
  'human',
  'agentic_app',
  'agent',
  'tool',
  'data_entry',
]);

// ─── Node Config Schemas (per type) ─────────────────────────────────────

export const StartNodeConfigSchema = z.object({
  inputVariables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['string', 'number', 'boolean', 'json']),
        required: z.boolean().default(true),
        defaultValue: z.unknown().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * End-node output mapping. Historically a flat `Record<string, string>` where
 * the value is a resolver expression. We now also accept a richer per-field
 * object carrying a declared `type` and `description`, which Studio uses to
 * derive `workflow.outputSchema` at save time. Both shapes are valid — the
 * runtime converter (`canvas-to-steps.ts`) unwraps either form into the
 * IR-level `{name, expression}` pair, so no strict validation here.
 */
export const EndNodeOutputMappingEntrySchema = z.union([
  z.string(),
  z.object({
    expression: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
    description: z.string().optional(),
  }),
]);

export const EndNodeConfigSchema = z.object({
  outputMapping: z.record(z.string(), EndNodeOutputMappingEntrySchema).optional(),
});

export const TextToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  humanPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  timeout: z.number().int().min(30).max(180).default(60),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export const TextToImageNodeConfigSchema = z.object({
  modelId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  numImages: z.number().int().min(1).max(4).default(1),
  timeout: z.number().int().min(30).max(300).default(120),
});

export const AudioToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  audioSource: z.string().optional(),
  language: z.string().optional(),
  timeout: z.number().int().min(30).max(300).default(120),
});

export const ImageToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  imageSource: z.string().optional(),
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  timeout: z.number().int().min(30).max(180).default(60),
});

export const ApiNodeConfigSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().optional(),
  headers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string(),
      }),
    )
    .default([]),
  body: z
    .object({
      type: z.enum(['none', 'json', 'form', 'xml', 'custom']),
      content: z.string().optional(),
    })
    .default({ type: 'none' }),
  auth: z
    .object({
      type: z.enum(['none', 'pre_authorized', 'user_level']),
      profileId: z.string().min(1).optional(),
    })
    .default({ type: 'none' }),
  mode: z.enum(['sync', 'async']).default('sync'),
  timeout: z.number().int().min(5).max(300).default(60),
});

export const FunctionNodeConfigSchema = z.object({
  language: z.literal('javascript').default('javascript'),
  mode: z.enum(['inline', 'custom_script']).default('inline'),
  code: z.string().optional(),
  scriptId: z.string().min(1).optional(),
  functionName: z.string().min(1).optional(),
  inputVariables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['string', 'number', 'json', 'boolean']),
        value: z.string(),
      }),
    )
    .default([]),
  timeout: z.number().int().min(5).max(60).default(10),
});

export const IntegrationNodeConfigSchema = z.object({
  connectorId: z.string().min(1).optional(),
  actionName: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  params: z.record(z.string(), z.string()).default({}),
  paramModes: z.record(z.string(), z.enum(['static', 'expression'])).default({}),
  // Widened from .max(300) → .max(1800) for long-running parked actions
  // (workflow-docling extraction can run up to 30 min; the engine itself does
  // not hold memory while parked — the wait lives in the Restate journal).
  // Default + min unchanged: workflows authored under the prior cap remain valid.
  timeout: z.number().int().min(5).max(1800).default(60),
});

export const ConditionNodeConfigSchema = z.object({
  conditions: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().default('If'),
        field: z.string().optional(),
        operator: z
          .enum([
            'equals',
            'not_equals',
            'greater_than',
            'less_than',
            'contains',
            'not_contains',
            'is_empty',
            'is_not_empty',
            'matches_regex',
          ])
          .optional(),
        value: z.unknown().optional(),
        expression: z.string().optional(),
      }),
    )
    .default([{ id: 'if_0', label: 'If' }]),
  logic: z.enum(['and', 'or']).default('and'),
});

export const LoopNodeConfigSchema = z.object({
  source: z.string().optional(),
  itemAlias: z.string().default('currentItem'),
  outputField: z.string().optional(),
  onError: z.enum(['continue', 'terminate', 'remove_failed']).default('continue'),
  maxIterations: z.number().int().positive().default(1000),
});

export const HumanNodeConfigSchema = z.object({
  subject: z.string().optional(),
  message: z.string().optional(),
  assignTo: z.enum(['everyone', 'specific']).default('everyone'),
  assignees: z.array(z.string().email()).optional(),
  contextFields: z.array(z.string()).optional(),
  timeout: z
    .object({
      duration: z.number().int().positive(),
      unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
    })
    .optional(),
  onTimeout: z.enum(['terminate', 'skip']).default('terminate'),
});

export const DataEntryNodeConfigSchema = z.object({
  subject: z.string().optional(),
  message: z.string().optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['text', 'number', 'boolean', 'select', 'textarea', 'date']),
        label: z.string().optional(),
        required: z.boolean().default(false),
        options: z.array(z.string()).optional(),
        optionsExpression: z.string().optional(),
        defaultValue: z.unknown().optional(),
      }),
    )
    .default([]),
  assignTo: z.enum(['everyone', 'specific']).default('everyone'),
  assignees: z.array(z.string().email()).optional(),
  timeout: z
    .object({
      duration: z.number().int().positive(),
      unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
    })
    .optional(),
  onTimeout: z.enum(['terminate', 'skip']).default('terminate'),
});

export const AgenticAppNodeConfigSchema = z.object({
  agentId: z.string().min(1).optional(),
  deploymentEnv: z.string().min(1).optional(),
  input: z.string().optional(),
  timeout: z.number().int().min(30).max(600).default(120),
});

export const AgentNodeConfigSchema = z.object({
  agentId: z.string().min(1).optional(),
  agentName: z.string().optional(),
  input: z.string().optional(),
  sessionId: z.string().optional(),
  timeout: z.number().int().min(30).max(600).default(120),
});

const DefaultCallbackKeySchema = (defaultValue: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().min(1).default(defaultValue),
  );

export const ToolNodeConfigSchema = z.object({
  toolId: z.string().min(1).optional(),
  toolName: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  timeout: z.number().int().min(5).max(300).default(30),
  executionMode: z.enum(['sync', 'async_continue', 'async_wait']).default('sync'),
  callbackConfig: z
    .object({
      enabled: z.boolean().default(true),
      location: z.enum(['body', 'query', 'header']).default('body'),
      callbackUrlKey: DefaultCallbackKeySchema('callbackUrl'),
      callbackSecretKey: DefaultCallbackKeySchema('callbackSecret'),
    })
    .optional(),
  asyncHttpSuccess: z
    .object({
      acceptedStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).optional(),
      acceptedBodyPath: z.string().min(1).optional(),
      acceptedBodyEquals: z.string().optional(),
    })
    .optional(),
});

export const DelayNodeConfigSchema = z.object({
  duration: z.number().int().positive().default(5),
  unit: z.enum(['seconds', 'minutes', 'hours', 'days']).default('seconds'),
});

export const BrowserNodeConfigSchema = z.object({
  automationId: z.string().min(1).optional(),
  inputMapping: z.record(z.string(), z.string()).default({}),
});

export const DocSearchNodeConfigSchema = z.object({
  query: z.string().min(1).optional(),
});

export const DocIntelligenceNodeConfigSchema = z.object({
  documentSource: z.string().min(1).optional(),
});

// ─── Config Schema Map ──────────────────────────────────────────────────

/** Per-node-type config schemas. Keyed by NodeType to ensure exhaustiveness. */
export const NODE_CONFIG_SCHEMAS: Record<z.infer<typeof NodeTypeSchema>, z.ZodType> = {
  start: StartNodeConfigSchema,
  end: EndNodeConfigSchema,
  text_to_text: TextToTextNodeConfigSchema,
  text_to_image: TextToImageNodeConfigSchema,
  audio_to_text: AudioToTextNodeConfigSchema,
  image_to_text: ImageToTextNodeConfigSchema,
  api: ApiNodeConfigSchema,
  function: FunctionNodeConfigSchema,
  integration: IntegrationNodeConfigSchema,
  condition: ConditionNodeConfigSchema,
  loop: LoopNodeConfigSchema,
  human: HumanNodeConfigSchema,
  data_entry: DataEntryNodeConfigSchema,
  agentic_app: AgenticAppNodeConfigSchema,
  agent: AgentNodeConfigSchema,
  tool: ToolNodeConfigSchema,
  delay: DelayNodeConfigSchema,
  browser: BrowserNodeConfigSchema,
  doc_search: DocSearchNodeConfigSchema,
  doc_intelligence: DocIntelligenceNodeConfigSchema,
};

// ─── Workflow Node Schema ───────────────────────────────────────────────

export const WorkflowNodeSchema = z
  .object({
    id: z.string().min(1),
    nodeType: NodeTypeSchema,
    name: z.string().min(1),
    position: z.object({
      x: z.number(),
      y: z.number(),
    }),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((node, ctx) => {
    const configSchema = NODE_CONFIG_SCHEMAS[node.nodeType];
    if (configSchema) {
      const result = configSchema.safeParse(node.config);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            ...issue,
            path: ['config', ...issue.path],
          });
        }
      }
    }
  });

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
});

// ─── Deployment Schema ──────────────────────────────────────────────────

export const WorkflowDeploymentSchema = z.object({
  endpointSlug: z.string().min(1),
  mode: z.enum(['sync', 'async_poll', 'async_push']),
  asyncPushConfig: z
    .object({
      webhookUrl: z.string().url(),
      accessToken: z.string().min(1),
    })
    .optional(),
  timeout: z.number().int().min(60).max(600).default(180),
  deployedAt: z.date().or(z.string()),
  deployedBy: z.string().min(1),
  deployedVersion: z.number().int().positive(),
});

// ─── Workflow Definition Schema ─────────────────────────────────────────

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  envVars: z.record(z.string(), z.string()).default({}),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(WORKFLOW_STATUSES).default('draft'),
});

// ─── Execution Status Enums ─────────────────────────────────────────────
// Must stay in sync with EXECUTION_STATUSES in
// packages/database/src/models/workflow-execution.model.ts. Per-node statuses
// live here only — NodeExecutionStatus is no longer mirrored on the database
// model since context.steps replaced the legacy nodeExecutions array.

export const ExecutionStatusSchema = z.enum([
  'running',
  'waiting_human',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'waiting_approval',
  'waiting_callback',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const NodeExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
  'waiting_approval',
  'waiting_human_task',
  'waiting_callback',
  'waiting_delay',
]);
export type NodeExecutionStatus = z.infer<typeof NodeExecutionStatusSchema>;

// ─── Node Execution Schema ──────────────────────────────────────────────

export const NodeExecutionSchema = z.object({
  nodeId: z.string().min(1),
  nodeName: z.string().min(1),
  nodeType: NodeTypeSchema,
  status: NodeExecutionStatusSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  startedAt: z.date().or(z.string()).optional(),
  completedAt: z.date().or(z.string()).optional(),
  durationMs: z.number().optional(),
  iteration: z.number().optional(),
  iterationResults: z.array(z.unknown()).optional(),
});

// ─── Trigger Type Constants ────────────────────────────────────────────
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];

/** Trigger types valid for registrations (not studio/agent) */
export const REGISTRATION_TRIGGER_TYPES = ['webhook', 'cron', 'event'] as const;
export type RegistrationTriggerType = (typeof REGISTRATION_TRIGGER_TYPES)[number];

// ─── Workflow Execution Input Schema ────────────────────────────────────

export const WorkflowExecutionInputSchema = z
  .object({
    workflowId: z.string().min(1),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    triggerType: z.enum(TRIGGER_TYPES).default('studio'),
    webhookMode: z.enum(WEBHOOK_MODES).optional(),
    webhookDelivery: z.enum(WEBHOOK_DELIVERIES).optional(),
    callbackUrl: z.string().url().optional(),
    accessToken: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.triggerType !== 'webhook') {
      if (data.webhookMode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'webhookMode is only valid when triggerType is webhook',
          path: ['webhookMode'],
        });
      }
      return;
    }
    if (!data.webhookMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookMode is required when triggerType is webhook',
        path: ['webhookMode'],
      });
      return;
    }
    if (data.webhookMode === 'sync' && data.webhookDelivery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookDelivery must be absent when webhookMode is sync',
        path: ['webhookDelivery'],
      });
    }
    if (data.webhookMode === 'async' && !data.webhookDelivery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookDelivery is required when webhookMode is async',
        path: ['webhookDelivery'],
      });
    }
    if (data.webhookDelivery === 'push' && !data.callbackUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'callbackUrl is required when webhookDelivery is push',
        path: ['callbackUrl'],
      });
    }
  });
