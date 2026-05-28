// ── Config Schema Types ──

/**
 * Single option for an enum-style ConfigField. Carries a user-facing label and
 * an optional description rendered as a subscript under the dropdown so
 * non-technical users can tell columns / tables apart.
 */
export interface ConfigFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface ConfigField {
  name: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'enum'
    | 'array'
    | 'object'
    | 'string[]'
    | 'object[]'
    /** Non-interactive help / warning banner. Rendered when `showWhen` matches. */
    | 'info';
  required: boolean;
  default?: unknown;
  description: string;
  label?: string;
  placeholder?: string;
  multiline?: boolean;
  group?: string;
  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
  };
  values?: string[];
  items?:
    | ConfigField
    | {
        type: string;
        properties: Record<string, ConfigField>;
      };
  showWhen?: {
    field: string;
    equals: string | string[];
  };
  reprocessOnChange?: boolean;
  /** For `info` fields: semantic intent for styling. Defaults to 'info'. */
  intent?: 'info' | 'warning' | 'success' | 'error';
  /**
   * When set, the Studio config form fetches options dynamically from the
   * server instead of using the static `values` array.
   *
   * - `mongo-collections` / `clickhouse-tables`: Studio fetches at runtime via
   *   the analytics hooks.
   * - `metric-tables` / `metric-columns`: the schema endpoint pre-resolves
   *   these into `options` / `optionsByDependency` on the response — no
   *   second fetch from Studio.
   */
  dynamicOptions?: 'mongo-collections' | 'clickhouse-tables' | 'metric-tables' | 'metric-columns';
  /**
   * Pre-resolved enum options. Populated by the schema endpoint for fields
   * with `dynamicOptions: 'metric-tables'`. When present, takes precedence
   * over both `values` and the `dynamicOptions` Studio hook.
   */
  options?: ConfigFieldOption[];
  /**
   * Pre-resolved enum options whose choice set depends on another field's
   * value. Populated by the schema endpoint for fields with
   * `dynamicOptions: 'metric-columns'`.
   *
   * Example: `metricColumn` depends on `metricTable` — the options map is
   * keyed by the parent table name.
   */
  optionsByDependency?: {
    field: string;
    options: Record<string, ConfigFieldOption[]>;
  };
  /**
   * When true, multiline string fields are rendered with the ExpressionEditor
   * (Monaco + Handlebars highlighting + {{steps.X.output.Y}} autocomplete +
   * ref validation). Only meaningful for `type: 'string'` with `multiline: true`.
   * (ABLP-564 Phase 5)
   */
  expressionAware?: boolean;
  /**
   * Quick-fill suggestion chips rendered below the input.
   * Clicking a chip sets the field value to chip.value.
   * Each chip can have its own `showWhen` so suggestions can be conditional
   * (e.g. show JSON suggestions only when database='mongodb').
   */
  suggestions?: Array<{
    label: string;
    value: string;
    showWhen?: { field: string; equals: string | string[] };
  }>;
  /** Field names to clear when this field's value changes (e.g. database switch resets table/collection/query). */
  resetFields?: string[];
}

// ── Trigger Types ──

export interface TriggerEntry {
  id: string;
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  eventFilter?: {
    field: string;
    equals: string;
  };
  schedule?: string;
  strategy: string;
  label: string;
  description: string;
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  /**
   * Realistic payload matching the trigger's inputSchema. Populated by
   * resolveTriggerSelections from the trigger registry. Used by the Studio
   * test drawer to pre-fill the test payload without heuristic guessing.
   * (ABLP-564 Phase 3)
   */
  exampleOutput?: Record<string, unknown>;
}

// ── Execution Strategy Types ──

export interface ExecutionStrategy {
  executionMode: 'batch' | 'realtime';
  steps: PipelineStep[];
  onStepFailure?: 'stop' | 'skip' | 'continue';
}

/**
 * Context passed to every activity service execution.
 * Contains everything the activity needs to do its work.
 */
export interface PipelineStepContext {
  /** Tenant ID — always present, used for multi-tenant isolation */
  tenantId: string;

  /** Project ID — present for project-scoped pipelines */
  projectId?: string;

  /** Session ID — present for session-triggered pipelines */
  sessionId?: string;

  /** Execution mode from the matched strategy (defaults to 'batch') */
  executionMode?: 'batch' | 'realtime';

  /** ID of the trigger that fired this run (defaults to 'default') */
  triggerId?: string;

  /** ID of the pipeline definition that owns this run */
  pipelineId?: string;

  /** Human-readable pipeline definition name for observability/debugging sinks */
  pipelineName?: string;

  /** Whether this is a 'builtin' or 'custom' pipeline */
  pipelineType?: 'builtin' | 'custom';

  /** ID of the currently executing step/node */
  stepId?: string;

  /** Activity type of the currently executing step/node */
  stepType?: string;

  /**
   * The step's config from the pipeline definition.
   * Already validated against the activity's configSchema at save time.
   */
  config: Record<string, any>;

  /**
   * Outputs from all previously completed steps, keyed by step ID.
   * Steps that were skipped have { status: 'skipped', data: {} }.
   */
  previousSteps: Record<string, StepOutput>;

  /**
   * Accumulated execution context from graph pipeline execution.
   * Keys are well-known names (e.g., 'conversation', 'sentiment') mapped
   * from node type contextKey. Undefined for linear pipelines.
   */
  executionContext?: Record<string, Record<string, any>>;

  /**
   * Pipeline-level input — from the trigger event payload or manual execute request body.
   */
  pipelineInput: Record<string, any>;
}

/**
 * Output from a single step execution.
 */
export interface StepOutput {
  /** Whether the step succeeded, failed, or was skipped */
  status: 'success' | 'fail' | 'skipped';

  /**
   * Arbitrary output data. Shape depends on activity type.
   * Available to subsequent steps via context.previousSteps[stepId].data
   * Available in condition expressions via steps.<stepId>.output.<field>
   *
   * Special field: if data.pipelineShouldStop === true, the workflow
   * stops after this step and marks remaining steps as skipped.
   */
  data: Record<string, any>;

  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Resolved pipeline config — produced once per run by PipelineConfigService.resolveConfig().
 * Passed through the execution chain so every step can read tenant/project config.
 */
export interface ResolvedPipelineConfig {
  /** Flat pipeline-wide config (e.g. model, samplingRate, thresholds). */
  pipelineConfig: Record<string, unknown>;
  /** Per-step config overrides, keyed by step ID. */
  stepOverrides: Record<string, Record<string, unknown>>;
  /** Auto-incremented version from PipelineConfigModel. */
  configVersion: number;
  /** Where the config was resolved from. */
  configSource: 'project' | 'tenant' | 'platform_default';
}

/**
 * Input to the PipelineRun workflow.
 */
export interface PipelineRunInput {
  pipelineDefinition: PipelineDefinition;
  /** Which trigger fired this run (defaults to 'default') */
  matchedTriggerId?: string;
  /** Execution mode from the matched strategy (defaults to 'batch') */
  executionMode?: 'batch' | 'realtime';
  /** Steps from the matched strategy (falls back to definition.steps) */
  steps?: PipelineStep[];
  pipelineInput: Record<string, any>;
  resolvedConfig?: ResolvedPipelineConfig;
}

/**
 * Step definition within a pipeline.
 */
export interface PipelineStep {
  id: string;
  /** Activity type from registry (new format) */
  activity?: string;
  /** Keep for backward compat */
  name?: string;
  /** Activity type (old format, alias for activity) */
  type?: string;
  parallel?: string;
  condition?: string | { expression: string };
  config?: Record<string, any>;
  timeout?: number;
  retries?: number;
  /** What to do when this step fails. Overrides pipeline-level onStepFailure. */
  onFailure?: 'stop' | 'skip' | 'continue';
}

/**
 * Full pipeline definition (as stored in MongoDB).
 */
export interface PipelineDefinition {
  _id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  description?: string;
  /** Links this definition to a PipelineConfig pipelineType. */
  pipelineType?: string;
  version: number;
  status: 'draft' | 'active' | 'archived';

  /** Self-describing config schema for this pipeline */
  configSchema?: {
    fields: ConfigField[];
  };

  /** All triggers this pipeline supports */
  supportedTriggers?: TriggerEntry[];

  /** Which triggers are active by default (subset of supportedTriggers[].id) */
  defaultTriggerIds?: string[];

  /** Per-trigger execution strategies */
  strategies?: Record<string, ExecutionStrategy>;

  // ── Kept as optional for migration compat ──
  trigger?: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    eventFilter?: { field: string; equals: string };
    schedule?: string;
  };
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  outputSchema?: {
    properties: Record<string, { type: string; description?: string }>;
  };
  steps?: PipelineStep[];
  onStepFailure?: 'stop' | 'skip' | 'continue';

  /** Graph-based flow (universal pipeline engine) */
  nodes?: PipelineNode[];
  entryNodeId?: string;
  /** Default failure strategy for all nodes */
  onNodeFailure?: 'stop' | 'skip' | 'continue';

  /** Categorization tags for filtering/grouping pipelines. */
  tags?: string[];
  /** Max concurrent runs for this pipeline (enforced by scheduler). */
  maxConcurrency?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Execution state tracked in workflow durable state and persisted to MongoDB.
 */
export interface PipelineRunState {
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
    /** ID of the trigger that fired */
    triggerId?: string;
    /** Execution mode from the matched strategy */
    executionMode?: 'batch' | 'realtime';
  };
  input: Record<string, any>;
  steps: Array<{
    id: string;
    name: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
  }>;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: {
    stepId: string;
    message: string;
  };
}

// ── Node Type System (Universal Pipeline Engine) ──

export type NodeCategory = 'data' | 'logic' | 'integration' | 'compute' | 'action';

export interface PortSchema {
  properties: Record<
    string,
    {
      type: string;
      description?: string;
    }
  >;
}

export interface NodeTypeDefinition {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon?: string;
  configSchema: { fields: ConfigField[] };
  inputSchema?: PortSchema;
  outputSchema?: PortSchema;
  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout?: number;
  defaultRetries?: number;
  retryable?: boolean;
  requiredCapabilities?: string[];
  /** Well-known key this node writes to in the execution context (e.g., 'conversation', 'sentiment'). */
  contextKey?: string;
}

export interface NodeTransition {
  target: string;
  condition?: string;
  order?: number;
  label?: string;
}

export interface GroupChildNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, any>;
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
}

export interface PipelineNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, any>;
  transitions: NodeTransition[];
  children?: GroupChildNode[];
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
  maxVisits?: number;
  position?: { x: number; y: number };
  /**
   * Contract version this node was authored against (ABLP-564 Phase 1+).
   * Absent for legacy pipelines saved before the contract system shipped —
   * validateGraphPipeline treats missing contractVersion as "legacy mode"
   * (warnings only, no hard failures). Stamped at save time by Studio POST/PATCH.
   */
  contractVersion?: number;
}

// ── Config-Driven Node Type System ──

export type NodeTrait = 'compute' | 'llm' | 'storage';

export interface ConfigFieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'object' | 'object[]' | 'info';
  required: boolean;
  default?: unknown;
  label: string;
  description: string;
  placeholder?: string;
  multiline?: boolean;
  /** When true, multiline fields render with the ExpressionEditor in Studio. */
  expressionAware?: boolean;
  group?: string;

  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
  };
  values?: string[];

  showWhen?: {
    field: string;
    equals: string | string[];
  };

  /** For `info` fields: semantic intent for styling. Defaults to 'info'. */
  intent?: 'info' | 'warning' | 'success' | 'error';

  /** When set, Studio fetches options dynamically from the server. */
  dynamicOptions?: 'mongo-collections' | 'clickhouse-tables' | 'metric-tables' | 'metric-columns';

  /** Quick-fill suggestion chips rendered below the input. */
  suggestions?: Array<{
    label: string;
    value: string;
    showWhen?: { field: string; equals: string | string[] };
  }>;
  /**
   * Field names to clear when this field's value changes.
   * Used to reset dependent fields (e.g. clearing query/table/collection when database changes).
   */
  resetFields?: string[];

  itemSchema?: ConfigFieldDefinition[];
}

export interface StorageColumnDefinition {
  name: string;
  type: string;
  source: 'system' | 'computed';
  description: string;
}

export interface StorageTableDefinition {
  table: string;
  granularity: 'message' | 'session' | 'customer' | 'metric';
  columns: StorageColumnDefinition[];
}

/**
 * MongoDB document shape for the node_type_definitions collection.
 * This is the DB-backed replacement for ACTIVITY_TYPES + registerBuiltinNodes.
 */
export interface NodeTypeDefinitionDoc {
  _id: string;
  tenantId: string;

  label: string;
  description: string;
  category: NodeCategory;
  icon?: string;

  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout: number;
  defaultRetries: number;
  retryable?: boolean;
  requiredCapabilities?: string[];
  /** Well-known key this node writes to in the execution context. */
  contextKey?: string;

  traits: NodeTrait[];

  configSchema: ConfigFieldDefinition[];

  outputSchema?: Record<string, { type: string; description: string }>;

  storageSchema?: {
    tables: StorageTableDefinition[];
  };

  inputSchema?: {
    requiresPreviousStep?: string;
    requiredInputFields?: string[];
  };

  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
