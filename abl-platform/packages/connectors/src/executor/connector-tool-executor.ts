/**
 * ConnectorToolExecutor
 *
 * Orchestrates connector action execution:
 * 1. Parse tool name (connector.action)
 * 2. Look up connector + action from registry
 * 3. Resolve connection credentials
 * 4. Execute action with timeout
 *
 * Produces OpenTelemetry spans for each execution with connector,
 * action, tenant, and connection scope attributes.
 */

import type { ConnectorRegistry } from '../registry.js';
import type { ConnectionResolver, ResolvedConnection } from '../auth/connection-resolver.js';
import type {
  ActionContext,
  AzureDocumentIntelligenceServices,
  CallbackContext,
  KeyValueStore,
} from '../types.js';
import {
  coerceParams,
  coerceParamsByProps,
  nestDotParams,
} from '../adapters/activepieces/context-translator.js';
import crypto from 'crypto';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

export interface ExecutorContext {
  tenantId: string;
  projectId: string;
  userId?: string;
  /**
   * Workflow execution context. Threaded from
   * `apps/workflow-engine/src/index.ts:connectorDepsFactory` when the executor
   * is constructed inside a workflow step dispatch. Used by actions that need
   * workflow-scoped state keys (Azure DI replay safety in Phase 3) and by the
   * async parking sentinel flow.
   */
  workflowExecutionId?: string;
  stepId?: string;
  /**
   * Optional connector-specific service bag injected by the workflow-engine
   * (Phase 3 D-13). Currently only populated for the Azure Document
   * Intelligence piece. Other pieces ignore it.
   */
  azureDocumentIntelligence?: AzureDocumentIntelligenceServices;
}

/**
 * Factory that produces a tenant-bound fileWriter. Workflow-engine constructs
 * this once at startup (backed by NFS / S3 storage) and the executor calls
 * the factory with the current tenantId so connector actions emitting
 * attachments get a tenant-scoped storage key.
 */
export type FileWriterFactory = (
  tenantId: string,
) => (fileName: string, data: Buffer, mimeType: string) => Promise<string>;

const tracer = trace.getTracer('abl-connectors', '1.0.0');

function extractConnectionId(connection: unknown): string {
  if (connection === null || typeof connection !== 'object') return '';
  const raw = (connection as { _id?: unknown })._id;
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

/** No-op store for when no KV store client is provided */
const NOOP_STORE: KeyValueStore = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

export class ConnectorToolExecutor {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly connectionResolver: ConnectionResolver,
    private readonly sessionContext: ExecutorContext,
    private readonly kvStore: KeyValueStore = NOOP_STORE,
    private readonly callbackContext?: CallbackContext,
    private readonly fileWriterFactory?: FileWriterFactory,
  ) {}

  /**
   * Execute a connector action by tool name.
   * @param toolName - Dotted name like "slack.send_message"
   * @param params - Tool parameters
   * @param timeoutMs - Maximum execution time
   * @param connectionId - Optional specific connection ID to use
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    connectionId?: string,
  ): Promise<unknown> {
    const { connectorName, actionName } = this.parseToolName(toolName);
    const executionId = crypto.randomUUID();

    return tracer.startActiveSpan(
      'connector.execute',
      {
        attributes: {
          'connector.name': connectorName,
          'action.name': actionName,
          'tenant.id': this.sessionContext.tenantId,
          'project.id': this.sessionContext.projectId,
          'execution.id': executionId,
        },
      },
      async (span: Span) => {
        try {
          // Look up connector and action (lazy-loads on first use)
          const action = await this.registry.getAction(connectorName, actionName);
          if (!action) {
            throw new Error(`Action "${actionName}" not found on connector "${connectorName}"`);
          }

          // Resolve connection and decrypt credentials
          const resolved: ResolvedConnection = await this.connectionResolver.resolve({
            connectorName,
            tenantId: this.sessionContext.tenantId,
            projectId: this.sessionContext.projectId,
            userId: this.sessionContext.userId,
            ...(connectionId && { connectionId }),
          });

          span.setAttribute('connection.scope', resolved.scope);

          const auth = await this.connectionResolver.resolveAuth(resolved.connection);

          // Nest dot-notation sub-field keys before validation so dynamic_properties
          // props (e.g. issueFields) arrive as nested objects rather than flat empty
          // strings alongside issueFields.summary etc. The validation below would
          // otherwise see issueFields="" and incorrectly throw "missing required".
          const nestedParams = nestDotParams(coerceParams(params));

          // Coerce string params to the type declared by the action's prop schema.
          // Shared with action-test-service so design-time test matches runtime.
          const coercedParams = coerceParamsByProps(nestedParams, action.props);

          // Validate required props before execution to give a clear error
          // instead of letting the piece crash with e.g. Buffer.from(undefined)
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
            throw new Error(
              `Missing required parameter(s) for ${connectorName}.${actionName}: ${missingRequired.join(', ')}`,
            );
          }

          // Build action context — the resolved Mongoose document's `_id`
          // is either a string or an ObjectId depending on whether the model
          // was returned via `.lean()`. Normalize to a string id once.
          // fileWriter is bound to this tenantId so connector actions that
          // emit attachments (e.g. Gmail Find Email) get a tenant-scoped key.
          const resolvedConnectionId = extractConnectionId(resolved.connection);
          const ctx: ActionContext = {
            auth,
            params: coercedParams,
            tenantId: this.sessionContext.tenantId,
            projectId: this.sessionContext.projectId,
            userId: this.sessionContext.userId,
            connectionScope: resolved.scope,
            executionId,
            store: this.kvStore,
            connectorName,
            ...(resolvedConnectionId ? { connectionId: resolvedConnectionId } : {}),
            ...(this.sessionContext.workflowExecutionId
              ? { workflowExecutionId: this.sessionContext.workflowExecutionId }
              : {}),
            ...(this.sessionContext.stepId ? { stepId: this.sessionContext.stepId } : {}),
            ...(this.callbackContext ? { callbackContext: this.callbackContext } : {}),
            ...(this.sessionContext.azureDocumentIntelligence &&
            connectorName === 'azure-document-intelligence'
              ? { azureDocumentIntelligence: this.sessionContext.azureDocumentIntelligence }
              : {}),
            ...(this.fileWriterFactory
              ? { fileWriter: this.fileWriterFactory(this.sessionContext.tenantId) }
              : {}),
          };

          // Execute with timeout
          const result = await this.executeWithTimeout(action.run(ctx), timeoutMs, toolName);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          if (err instanceof Error) {
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private parseToolName(toolName: string): { connectorName: string; actionName: string } {
    const dotIndex = toolName.indexOf('.');
    if (dotIndex === -1) {
      throw new Error(`Invalid tool name "${toolName}": expected format "connector.action"`);
    }
    return {
      connectorName: toolName.substring(0, dotIndex),
      actionName: toolName.substring(dotIndex + 1),
    };
  }

  private executeWithTimeout(
    promise: Promise<unknown>,
    timeoutMs: number,
    toolName: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connector action "${toolName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
