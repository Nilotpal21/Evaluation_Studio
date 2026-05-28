/**
 * ActionTestService
 *
 * Runs an integration node's underlying connector action against the stored
 * connection credentials, captures the output, and persists it onto the
 * workflow node as `config.sampleOutput` so the design-time expression
 * builder can surface it as suggestions for downstream nodes.
 *
 * The persisted value is purely a design-time sample — never consumed by
 * runtime execution. Editing params inside the Test modal does NOT mutate
 * the node's saved config; only `sampleOutput` is written back.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ConnectorRegistry } from '@agent-platform/connectors';
import type { ConnectionResolver } from '@agent-platform/connectors';
import type { ActionContext, KeyValueStore } from '@agent-platform/connectors';
import { coerceParams, coerceParamsByProps, nestDotParams } from '@agent-platform/connectors';
import { DESIGN_TIME_TEST_TIMEOUT_MS, MAX_SAMPLE_PAYLOAD_BYTES } from '../constants.js';

const log = createLogger('action-test-service');

/**
 * Thrown when the requested workflow or node cannot be found within the
 * caller's tenant + project scope. Routes map this to HTTP 404.
 */
export class ActionTestNotFoundError extends Error {
  readonly code = 'NODE_OR_WORKFLOW_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ActionTestNotFoundError';
  }
}

/**
 * Thrown when the node's configuration is incomplete (missing connector,
 * action, connection) or the node type isn't a connector integration.
 * Routes map this to HTTP 400.
 */
export class ActionTestConfigError extends Error {
  readonly code = 'INVALID_NODE_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'ActionTestConfigError';
  }
}

export interface ActionTestDeps {
  registry: ConnectorRegistry;
  connectionResolver: ConnectionResolver;
  workflowModel: {
    findOne(filter: Record<string, unknown>): Promise<{
      _id: string;
      nodes?: Array<Record<string, unknown>>;
    } | null>;
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
  };
  /** Factory for a per-action KV store (mirrors connector-tool-executor). */
  storeFactory?: (nodeId: string) => KeyValueStore;
  /**
   * Optional field-level encryption for design-time sample outputs. When
   * provided, `testAction` encrypts the JSON-serialized output before persisting.
   * Omit only in test environments that do not initialise the DEK facade.
   */
  encryptField?: (plaintext: string, tenantId: string) => Promise<string>;
  /**
   * When provided, connector actions that call files.write() during a design-time
   * test receive a real fileWriter bound to the request's tenantId, so they return
   * a signed download URL instead of activating the base64 data-URI fallback.
   */
  fileWriterFactory?: (
    tenantId: string,
  ) => (fileName: string, data: Buffer, mimeType: string) => Promise<string>;
  /** Override the default timeout (ms) — for unit tests only. */
  _testTimeoutMs?: number;
}

export interface TestActionInput {
  workflowId: string;
  nodeId: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  /**
   * User-supplied params for this test run. Resolves whatever expressions or
   * literals the user typed in the modal. NOT persisted back to node.config.
   */
  params: Record<string, unknown>;
  /**
   * Optional connection override. When the modal's connection picker is used
   * to test against a different account than the node's saved connectionId,
   * the test runs with this connection. The node's persisted config is NOT
   * mutated — only `sampleOutput` is written back.
   */
  connectionId?: string;
}

export interface TestActionResult {
  output: unknown;
}

/**
 * Minimal in-memory store used when no persistent storeFactory is supplied.
 * Action tests should not write any persistent state that would survive past
 * the request, so an ephemeral map is safe.
 */
function ephemeralStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

export class ActionTestService {
  constructor(private readonly deps: ActionTestDeps) {}

  /**
   * Resolve auth + execute the action + persist sampleOutput onto the node.
   * Returns the raw output. Errors propagate; the caller maps them to HTTP.
   */
  async testAction(input: TestActionInput): Promise<TestActionResult> {
    const { workflowId, nodeId, tenantId, projectId, userId, params } = input;
    const connectionIdOverride = input.connectionId;

    // ── 1. Locate the node within the workflow ──────────────────────────
    const workflow = await this.deps.workflowModel.findOne({
      _id: workflowId,
      tenantId,
      projectId,
    });
    if (!workflow) {
      throw new ActionTestNotFoundError(`Workflow not found: ${workflowId}`);
    }
    const node = (workflow.nodes ?? []).find(
      (n) => (n as Record<string, unknown>).id === nodeId,
    ) as Record<string, unknown> | undefined;
    if (!node) {
      throw new ActionTestNotFoundError(`Node not found: ${nodeId}`);
    }
    if (node.nodeType !== 'integration') {
      throw new ActionTestConfigError(
        `Test action is only supported for integration nodes (got ${String(node.nodeType)})`,
      );
    }

    const config = (node.config as Record<string, unknown> | undefined) ?? {};
    const connectorName = (config.connectorId as string | undefined) ?? '';
    const actionName = (config.actionName as string | undefined) ?? '';
    const connectionId = connectionIdOverride || (config.connectionId as string | undefined) || '';
    if (!connectorName || !actionName) {
      throw new ActionTestConfigError('Node is missing connectorId or actionName');
    }
    if (!connectionId) {
      throw new ActionTestConfigError(
        'Node is missing connectionId — select a connection before testing',
      );
    }

    // ── 2. Get the action from the registry ─────────────────────────────
    const action = await this.deps.registry.getAction(connectorName, actionName);
    if (!action) {
      throw new ActionTestNotFoundError(
        `Action "${actionName}" not found on connector "${connectorName}"`,
      );
    }

    // ── 3. Resolve connection + auth via the shared resolver ────────────
    const resolved = await this.deps.connectionResolver.resolve({
      connectorName,
      tenantId,
      projectId,
      userId,
      connectionId,
    });
    const auth = await this.deps.connectionResolver.resolveAuth(resolved.connection);

    // ── 4. Coerce params using the same rules as the live action runner ─
    //    (shared `coerceParamsByProps` ensures test results match real runs).
    //    Studio sends every form value as a string; pieces validate native types.
    const nestedParams = nestDotParams(coerceParams(params));
    const coercedParams = coerceParamsByProps(nestedParams, action.props);

    // ── 5. Validate required props so the error is actionable instead of
    //       a deep AP piece crash like "Buffer.from(undefined)". ─────────
    const missingRequired = action.props
      .filter(
        (p) =>
          p.required &&
          (coercedParams[p.name] === undefined ||
            coercedParams[p.name] === null ||
            coercedParams[p.name] === ''),
      )
      .map((p) => p.displayName || p.name);
    if (missingRequired.length > 0) {
      throw new ActionTestConfigError(
        `Missing required parameter(s) for ${connectorName}.${actionName}: ${missingRequired.join(', ')}`,
      );
    }

    // ── 6. Build action context and invoke ──────────────────────────────
    const store = this.deps.storeFactory ? this.deps.storeFactory(nodeId) : ephemeralStore();
    const ctx: ActionContext = {
      auth,
      params: coercedParams,
      tenantId,
      projectId,
      userId,
      connectionScope: resolved.scope,
      executionId: `test-action-${nodeId}-${Date.now()}`,
      store,
      connectorName,
      fileWriter: this.deps.fileWriterFactory?.(tenantId),
    };

    const timeoutMs = this.deps._testTimeoutMs ?? DESIGN_TIME_TEST_TIMEOUT_MS;
    const testTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Connector action timed out after ${DESIGN_TIME_TEST_TIMEOUT_MS / 1000}s`),
          ),
        timeoutMs,
      ),
    );
    const output = await Promise.race([action.run(ctx), testTimeout]);

    // ── 7. Persist the sample on the node so downstream suggestions
    //       and the modal's history step can reuse it. Updates only
    //       `nodes.$.config.sampleOutput` — never the node's params/config.
    //       The positional `$` operator targets the FIRST element whose
    //       `nodes.id === nodeId`. Workflow node ids are assumed unique
    //       within a workflow (enforced upstream during node creation /
    //       canvas authoring); duplicates would leave the second copy stale. ──
    try {
      // Cap to MAX_SAMPLE_PAYLOAD_BYTES and encrypt before persisting so
      // connector output (which may contain PII) is protected at rest.
      const rawJson = JSON.stringify(output);
      const cappedJson =
        Buffer.byteLength(rawJson, 'utf8') > MAX_SAMPLE_PAYLOAD_BYTES
          ? JSON.stringify({ _truncated: true, _reason: 'payload exceeded 64 KB limit' })
          : rawJson;
      const encryptFn = this.deps.encryptField;
      const storedValue = encryptFn ? await encryptFn(cappedJson, tenantId) : cappedJson;
      await this.deps.workflowModel.findOneAndUpdate(
        { _id: workflowId, tenantId, projectId, 'nodes.id': nodeId },
        { $set: { 'nodes.$.config.sampleOutput': storedValue } },
      );
    } catch (err) {
      // Persistence failure should not fail the test response — the user
      // already has the output. Log and continue.
      log.warn('Failed to persist sampleOutput', {
        workflowId,
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { output };
  }
}
