/**
 * Connector SDK Core Types
 *
 * Defines the canonical interfaces for connectors, actions, triggers,
 * auth configurations, and execution contexts.
 */

// ─── Auth Types ────────────────────────────────────────────────────────

export type ConnectorAuthType = 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom' | 'none';

export interface ConnectorAuthField {
  name: string;
  displayName: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
}

/**
 * Per-connector "test connection" hook surfaced by the underlying piece
 * (Activepieces' `BasePieceAuthSchema.validate`). Implementations make a
 * low-impact authenticated call (e.g. `users/me`, `auth.test`) and return
 * `{ valid: true }` or `{ valid: false, error }`.
 *
 * NOT serialized into the JSON catalog — only present on runtime
 * `Connector` instances loaded through the registry.
 */
export type ConnectorAuthValidator = (input: {
  /**
   * Auth value already normalized to the shape the underlying piece expects.
   * Typed as `unknown` because Activepieces' SECRET_TEXT pieces receive a
   * raw string here, while CUSTOM_AUTH / BASIC_AUTH / OAUTH2 pieces receive
   * an object — see `normalizeAuthForPieceValidate` for the per-piece mapping.
   */
  auth: unknown;
  /** Subset of Activepieces' ServerContext sufficient for validate hooks. */
  server: { apiUrl: string; publicUrl: string };
}) => Promise<{ valid: true } | { valid: false; error: string }>;

export interface ConnectorAuth {
  type: ConnectorAuthType;
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
    pkce?: boolean;
  };
  fields?: ConnectorAuthField[];
  /**
   * Live "test connection" hook from the underlying piece. Optional — only
   * present for connectors whose author wired up Activepieces'
   * `auth.validate` function. Holds a function reference, so this field is
   * intentionally absent from `connector-catalog.json` (extract-entry.ts
   * never serializes it).
   */
  validateAuth?: ConnectorAuthValidator;
}

// ─── Property Types ────────────────────────────────────────────────────

export type ConnectorPropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'dropdown'
  | 'multi_select_dropdown'
  | 'dynamic_dropdown'
  | 'dynamic_properties'
  | 'array'
  | 'json'
  | 'date'
  | 'file'
  | 'oauth';

export interface DropdownOption {
  label: string;
  value: string | number;
}

/**
 * Response shape returned by an action prop's dynamic options resolver.
 * Mirrors Activepieces' `DropdownState` — `disabled: true` with a
 * `placeholder` lets the UI render "Select a connection first" etc.
 */
export interface DropdownState {
  disabled: boolean;
  placeholder?: string;
  options: DropdownOption[];
}

/**
 * A sub-field definition returned inside a DynamicPropertiesState map.
 * Options are pre-resolved — no further runtime fetch needed.
 */
export interface DynamicSubField {
  name: string;
  displayName: string;
  description?: string;
  type: ConnectorPropertyType;
  required: boolean;
  options?: DropdownOption[];
  /**
   * Sub-field schema for `array` dynamic sub-fields (e.g. Claude extract-structured-data
   * `schema.fields` in simple mode returns an ARRAY with named properties).
   */
  properties?: ConnectorProperty[];
}

/**
 * Response shape returned by an action/trigger prop's DynamicProperties resolver.
 * Keys are field names (e.g. "summary", "assignee"); values describe each sub-field
 * including type and any pre-resolved options.
 */
export type DynamicPropertiesState = Record<string, DynamicSubField>;

export interface ConnectorProperty {
  name: string;
  displayName: string;
  description?: string;
  type: ConnectorPropertyType;
  required: boolean;
  defaultValue?: unknown;
  options?: DropdownOption[];
  /**
   * Names of sibling props whose values this dropdown depends on.
   * Presence of `refreshers` (even an empty array) signals that the prop
   * has a runtime options resolver — see `ConnectorAction.resolveOptions`.
   */
  refreshers?: string[];
  /**
   * Sub-field schema for `array` props that use Activepieces `Property.Array`
   * with a `properties` map (e.g. Extract Structured Data's `params` field).
   * When present, the UI renders a structured row editor instead of a flat chip input.
   */
  properties?: ConnectorProperty[];
}

// ─── Key-Value Store ───────────────────────────────────────────────────

/** Per-connection persistent key-value store for connector state (polling cursors, tokens, etc.) */
export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── Context Types ─────────────────────────────────────────────────────

/**
 * Workflow-engine runtime services available to native connector actions that
 * want to enqueue downstream work and park the workflow on a Restate durable
 * promise (the workflow-docling extraction action; future async tools).
 *
 * Per LLD §1 these are pure function references — the action calls them, the
 * workflow-engine populates them at deps-factory time. The action constructs
 * an `AsyncParkingSentinel` referencing `callbackId` /
 * `callbackTimeoutMs` / `encryptedCallbackSecret`; the executor propagates
 * that sentinel up through the step dispatcher, which converts it into
 * `StepDispatchResult.callbackRequest` and triggers the suspension block in
 * `workflow-handler.ts`.
 *
 * Phase 2 augments the original Phase 1 surface: the Phase 1 data-bag fields
 * (`workflowExecutionId`, `stepId`, `callbackTimeoutMs`, `callbackUrl`, raw
 * secret fields) were never consumed by a connector body and have been
 * replaced with the function-reference shape the LLD specifies. The
 * `workflowExecutionId` / `stepId` correlation values now live directly on
 * `ActionContext` (Phase 1 already added them there).
 */
export interface CallbackContext {
  /** Build `${WORKFLOW_ENGINE_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}`. */
  readonly callbackUrlBuilder: (executionId: string, stepId: string) => string;
  /** Returns ciphertext for the per-step HMAC secret, tenant-keyed. */
  readonly encryptSecret: (plaintext: string, tenantId: string) => Promise<string>;
  /** Stable per-step id — typically `${executionId}:${stepId}`. */
  readonly callbackId: string;
  /**
   * Enqueue a workflow-path Docling extraction job. The workflow-engine
   * populates this with a BullMQ-backed implementation; tests can inject a
   * direct in-memory queue. Optional at the type level so non-workflow
   * callers don't need to provide it.
   */
  readonly enqueueWorkflowDoclingJob?: (payload: {
    tenantId: string;
    projectId: string;
    sourceUrl: string;
    workflowExecutionId: string;
    stepId: string;
    callbackId: string;
    callbackUrl: string;
    callbackSecret: string;
    mode: 'extraction-only';
    options?: {
      pages?: string;
      extractImages?: boolean;
      extractTables?: boolean;
      ocrEnabled?: boolean;
      language?: string;
      timeout?: number;
    };
    traceId?: string;
  }) => Promise<{ jobId: string }>;
  /**
   * Enqueue a single Azure DI poll job in the `workflow-adi-poll` queue.
   * The workflow-engine provides a BullMQ-backed implementation; absent in
   * non-workflow callers. When present, the ADI connector returns an
   * AsyncParkingSentinel instead of running the polling loop inline.
   */
  readonly enqueueADIPollJob?: (payload: {
    tenantId: string;
    projectId: string;
    workflowExecutionId: string;
    stepId: string;
    callbackId: string;
    callbackUrl: string;
    /** Plaintext — encrypted at-rest via `workflow-adi-poll` manifest. */
    callbackSecret: string;
    operationLocation: string;
    endpoint: string;
    /** Plaintext — encrypted at-rest via `workflow-adi-poll` manifest. */
    apiKey: string;
    apiVersion: string;
    sourceUrl: string;
    contentType: string;
    timeoutMs: number;
    startedAt: number;
    /** Error backoff state — 0 on first enqueue, only set after 429/5xx. */
    errorDelayMs: number;
    mode: 'workflow-adi-poll';
  }) => Promise<{ jobId: string }>;
  /**
   * Returns the shared Redis client (used to construct the per-tenant rate
   * limiter). The narrow `DoclingRedisClient` shape decouples the type-level
   * contract from the underlying ioredis class. Returns `null` when Redis is
   * unavailable; the limiter falls back to in-memory storage so dev/CI still
   * works.
   */
  readonly getSharedRedisClient?: () =>
    | import('./native/docling/rate-limiter.js').DoclingRedisClient
    | null;
}

/**
 * Async parking sentinel returned by an action's `run(ctx)` when the action
 * has already enqueued downstream work (e.g. a BullMQ extraction job) and
 * wants the workflow to suspend on a Restate promise until a callback POSTs
 * the result. Recognized via `isAsyncParkingSentinel` by the step dispatcher.
 */
export interface AsyncParkingSentinel {
  readonly __asyncParking: true;
  callbackId: string;
  callbackTimeoutMs: number;
  /**
   * Per-step encrypted HMAC secret persisted onto the step record as the
   * canonical source of truth for callback signature verification.
   *
   * **Fail-safe**: when omitted the callback route at
   * `apps/workflow-engine/src/routes/workflow-callbacks.ts:89-95` rejects ALL
   * inbound callbacks with HTTP 401 ("Callback authentication not configured").
   * The step then times out via the engine's `raceTimeout`. Omitting is
   * therefore safe (no auth bypass) but renders the step un-completable —
   * actions that intend to resume MUST populate this field.
   */
  encryptedCallbackSecret?: string;
}

export function isAsyncParkingSentinel(value: unknown): value is AsyncParkingSentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __asyncParking?: unknown }).__asyncParking === true
  );
}

/**
 * Workflow-engine-injected services for the Azure Document Intelligence
 * AP-format piece (LLD §3 Phase 3 D-13 + Task 3.5). Keeps the piece itself
 * free of direct Mongoose / circuit-breaker-registry imports — the
 * workflow-engine wires the implementations at deps-factory time.
 */
export interface AzureDocumentIntelligenceServices {
  /**
   * Read the current monthly-usage doc for a `ConnectorConnection`. Returns
   * `null` when the connection is missing. All reads are tenant-scoped on
   * the workflow-engine side.
   */
  checkUsage(connectionId: string): Promise<{
    usageCount: number;
    usageSoftCap: number | null;
    usageHardCap: number | null;
    usagePeriodStart: Date | null;
  } | null>;
  /**
   * Atomic month-boundary CAS reset + `$inc` of `usageCount`. Returns the
   * post-increment view. Implemented in `apps/workflow-engine/src/services/
   * azure-di-usage-counter.ts` per LLD Task 3.12.
   */
  recordUsage(connectionId: string): Promise<{
    usageCount: number;
    usagePeriodStart: Date;
  }>;
  /**
   * Tenant-pre-keyed circuit-breaker handle from `@agent-platform/circuit-
   * breaker`. Actions wrap each outbound Azure call in `breaker.execute(fn)`;
   * the registry tracks success/failure transitions atomically via Lua.
   */
  breaker: { execute<T>(fn: () => Promise<T>): Promise<T> };
}

export interface ActionContext {
  auth: Record<string, unknown>;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  userId?: string;
  connectionScope: 'tenant' | 'user';
  executionId: string;
  store: KeyValueStore;
  connectorName?: string;
  /**
   * Optional file writer — stores binary content emitted by an action (e.g.
   * Gmail "Find Email" returns parsed attachments via `context.files.write`)
   * and returns a public download URL. Same shape as `TriggerRunContext.fileWriter`.
   * When unset, attempting to write throws.
   */
  fileWriter?: (fileName: string, data: Buffer, mimeType: string) => Promise<string>;
  /**
   * Connection id of the resolved `ConnectorConnection` (string form of the
   * Mongo `_id`). Mirrors `TriggerContext.connectionId` — needed by actions
   * that scope state to the connection (e.g. Azure DI cost-cap counter in
   * Phase 3). Optional for non-workflow callers (agent tool path).
   */
  connectionId?: string;
  /**
   * Workflow execution context for actions invoked via a workflow step. Used
   * by actions that need to construct workflow-scoped state keys
   * (e.g. `azuredi:${workflowExecutionId}:${stepId}` for Azure DI replay
   * safety). Absent when invoked from a non-workflow caller.
   */
  workflowExecutionId?: string;
  stepId?: string;
  /**
   * Callback wiring for actions that want to park the workflow on a Restate
   * durable promise. The action constructs an {@link AsyncParkingSentinel}
   * using these fields and returns it from `run(ctx)`.
   */
  callbackContext?: CallbackContext;
  /**
   * Workflow-engine-injected Azure DI services bag (cost-cap counter + circuit
   * breaker). Populated by `connectorDepsFactory` only when the connector
   * being invoked is `azure-document-intelligence` AND the workflow context is
   * complete. The Azure DI piece hard-fails with `INTEGRATION_UNAVAILABLE`
   * when this is absent.
   */
  azureDocumentIntelligence?: AzureDocumentIntelligenceServices;
}

export interface TriggerContext {
  auth: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  connectionId: string;
  store: KeyValueStore;
  webhookUrl?: string;
  connectorName?: string;
}

export interface TriggerRunContext extends TriggerContext {
  /** Last polling cursor / state from previous run */
  lastRunData?: unknown;
  /** User-configured trigger parameters (e.g. subject filter, label filter) */
  propsValue?: Record<string, unknown>;
  /**
   * Optional file writer — stores binary content and returns a public download URL.
   * When provided, trigger attachments are uploaded and returned as links instead
   * of base64 data URIs. Implementations typically back this with Redis + a
   * signed download endpoint on the workflow-engine.
   */
  fileWriter?: (fileName: string, data: Buffer, mimeType: string) => Promise<string>;
}

export interface WebhookVerifyContext {
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  auth: Record<string, unknown>;
}

// ─── Trigger ───────────────────────────────────────────────────────────

export type ConnectorTriggerType = 'webhook' | 'cron' | 'event' | 'polling';

export interface ConnectorTrigger {
  name: string;
  displayName: string;
  description: string;
  triggerType: ConnectorTriggerType;
  props: ConnectorProperty[];
  sampleData?: unknown;
  onEnable(ctx: TriggerContext): Promise<void>;
  onDisable(ctx: TriggerContext): Promise<void>;
  run(ctx: TriggerRunContext): Promise<unknown[]>;
  /** Fetch sample items for design-time testing — no "new since last check" constraint. */
  testRun?(ctx: TriggerRunContext): Promise<unknown[]>;
  verify?(ctx: WebhookVerifyContext): Promise<boolean>;
  pollingIntervalMs?: number;
  resolveOptions?(propName: string, ctx: ResolveOptionsContext): Promise<DropdownState>;
  resolveDynamicProps?(
    propName: string,
    ctx: ResolveOptionsContext,
  ): Promise<DynamicPropertiesState>;
}

// ─── Action ────────────────────────────────────────────────────────────

/**
 * Context passed to an action's `resolveOptions` hook.
 *
 * - `auth` is the resolved credential bundle (same shape as `ActionContext.auth`).
 * - `propsValue` carries the current form values for sibling props — the
 *   adapter uses this to feed refresher dependencies into the underlying
 *   resolver (e.g. passing `spreadsheetId` when resolving sheet names).
 * - `store` is a no-op at design-time; implementations that need persistent
 *   state should fall back gracefully when reads return undefined.
 */
export interface ResolveOptionsContext {
  auth: Record<string, unknown>;
  propsValue: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  store: KeyValueStore;
  searchValue?: string;
  connectorName?: string;
}

export interface ConnectorAction {
  name: string;
  displayName: string;
  description: string;
  props: ConnectorProperty[];
  run(ctx: ActionContext): Promise<unknown>;
  /**
   * Resolve dynamic dropdown options for a prop on this action.
   * Only populated for actions whose underlying piece exposes a runtime
   * options resolver (currently: Activepieces `Property.Dropdown` with an
   * async `options` function). Absent for static-dropdown or non-dropdown
   * props.
   */
  resolveOptions?(propName: string, ctx: ResolveOptionsContext): Promise<DropdownState>;
  resolveDynamicProps?(
    propName: string,
    ctx: ResolveOptionsContext,
  ): Promise<DynamicPropertiesState>;
}

// ─── Connector ─────────────────────────────────────────────────────────

export interface Connector {
  name: string;
  displayName: string;
  version: string;
  description: string;
  auth: ConnectorAuth;
  triggers: ConnectorTrigger[];
  actions: ConnectorAction[];
}
