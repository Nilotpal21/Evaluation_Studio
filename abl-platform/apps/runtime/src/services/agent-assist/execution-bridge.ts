import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { CallerContext } from '@agent-platform/shared-auth';
import { DeploymentResolver } from '../deployment-resolver.js';
import { buildExecutionResultContentEnvelope } from '../execution/types.js';
import { getRuntimeExecutor } from '../runtime-executor.js';
import { getSessionService } from '../session/session-service.js';
import { AGENT_ASSIST_FACADE_TAG, AGENT_ASSIST_SOURCE_TAG } from './constants.js';
import { sessionIdFor } from './session-envelope.js';
import type { AgentAssistBinding, AgentAssistExecutionInput } from './types.js';
import type { V1OutputBlock } from './types.js';

const log = createLogger('agent-assist:execution-bridge');

/** Stable per-binding key so two different bindings never share a runtime session. */
function materializeExternalReference(
  binding: AgentAssistBinding,
  sessionReference: string,
): string {
  const bindingKey =
    binding.apiKeyId ?? `${binding.tenantId}:${binding.appId}:${binding.environment}`;
  return `${bindingKey}:${sessionReference}`;
}

/**
 * Public wrapper around the internal `sessionIdFor` mapping. Callers (e.g. the async-push
 * branch of the V1 facade) need the session ID BEFORE invoking `executeTurn` so that the
 * initial 202 envelope and the subsequent callback envelope stay correlated.
 */
export function computeAgentAssistSessionId(
  binding: AgentAssistBinding,
  sessionReference: string,
): string {
  return sessionIdFor(binding, sessionReference);
}

export interface BridgeExecutionRequest {
  binding: AgentAssistBinding;
  input: AgentAssistExecutionInput;
  /** Stream chunks as they arrive from the executor (for V1 SSE). */
  onChunk?: (delta: string) => void;
  /** Caller / `x-api-key` principal forwarded into session.callerContext for per-key isolation. */
  apiKeyId?: string;
  /** Optional userId derived from the API-key resolution. */
  userId?: string;
  /**
   * Optional pre-computed runId. When provided, the bridge uses it instead of generating
   * one — required for async-push so the initial 202 envelope and the eventual callback
   * envelope carry the same runId.
   */
  runId?: string;
}

export interface BridgeExecutionResult {
  sessionId: string;
  runId: string;
  responseText: string;
  richContent?: V1OutputBlock['richContent'];
  actions?: V1OutputBlock['actions'];
  voiceConfig?: V1OutputBlock['voiceConfig'];
  contentEnvelope?: V1OutputBlock['contentEnvelope'];
  /** Deployment actually targeted. */
  deploymentId?: string;
}

/**
 * Execute a single Agent Assist V1 turn against ABL's RuntimeExecutor.
 *
 * Resolves the binding's deployment, creates or resumes the deterministic session,
 * and runs the turn. Errors bubble out sanitized to the caller — the facade never
 * silently swallows executor failures.
 */
export async function executeTurn(request: BridgeExecutionRequest): Promise<BridgeExecutionResult> {
  const { binding, input } = request;
  const sessionId = sessionIdFor(binding, input.sessionReference);
  const runId = request.runId ?? crypto.randomUUID();

  const resolver = new DeploymentResolver(getSessionService());
  const resolved = await resolver.resolve({
    projectId: binding.projectId,
    tenantId: binding.tenantId,
    deploymentId: binding.deploymentId,
    environment: binding.environment,
  });

  const executor = getRuntimeExecutor();

  // Create or re-use the runtime session. `createSessionFromResolved` is idempotent
  // on `sessionId` — calling it twice for the same id returns the existing session.
  const existing = executor.getSession(sessionId);
  // Build a valid CallerContext per shared-auth's strict shape. Agentic-compat
  // specifics (source, facade, appId, bindingId, …) live under session metadata.
  const callerContext: CallerContext = {
    tenantId: binding.tenantId,
    channel: 'api',
    initiatedById: request.userId,
    identityTier: 0,
    verificationMethod: 'none',
  };
  const compatMetadata: Record<string, unknown> = {
    ...(input.messageMetadata ?? {}),
    _agentAssist: {
      source: AGENT_ASSIST_SOURCE_TAG,
      facade: AGENT_ASSIST_FACADE_TAG,
      appId: binding.appId,
      environment: binding.environment,
      bindingId: binding.bindingId ?? binding.apiKeyId ?? `${binding.tenantId}:${binding.appId}`,
      apiKeyId: request.apiKeyId ?? binding.apiKeyId,
      externalReference: materializeExternalReference(binding, input.sessionReference),
    },
  };
  const session =
    existing ??
    executor.createSessionFromResolved(resolved, {
      sessionId,
      tenantId: binding.tenantId,
      projectId: binding.projectId,
      userId: request.userId,
      channelType: 'api',
      deploymentId: resolved.versionInfo.deploymentId ?? binding.deploymentId,
      callerContext,
      metadata: compatMetadata,
    });

  // Eagerly run ON_START so the lazy-init path in `executor.executeMessage`
  // does not return the welcome RESPOND in place of the agent's answer to the
  // user's first turn. The V1 `/sessions` route already delivered the welcome
  // text in its `Welcome_Event` envelope (see welcome-resolver.ts), so we run
  // ON_START purely for its side effects (memory init, before_agent hook,
  // SET/CALL) and discard any RESPOND output by passing `undefined` for
  // onChunk. `initializeSession` is idempotent on `session.initialized`, so
  // resumed sessions short-circuit harmlessly.
  if (!session.initialized) {
    await executor.initializeSession(session.id);
  }

  // Note: we intentionally do NOT forward V1 `metadata` into `executeMessage` as
  // `messageMetadata`. `SdkMessageMetadata` is a strict `Record<string,
  // SdkMessageMetadataValue>` shape and incoming V1 metadata can contain arbitrary
  // shapes (parsed `aa_uamsgs` history, nested operator objects). Forwarding a
  // sanitized subset (conversationId/botId/language/source) is tracked as a
  // follow-up against feature spec FR-20.
  const executionResult = await executor.executeMessage(
    session.id,
    input.userMessage,
    request.onChunk,
    undefined,
    {
      channelMetadata: {
        channel: 'agent-assist-v1',
        contentLength: input.userMessage.length,
      },
    },
  );

  log.info('agent-assist agent turn executed', {
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    appId: binding.appId,
    sessionId: session.id,
    runId,
    actionType: executionResult.action?.type,
  });

  const contentEnvelope = buildExecutionResultContentEnvelope(executionResult);

  return {
    sessionId: session.id,
    runId,
    responseText: executionResult.response,
    ...(executionResult.richContent ? { richContent: executionResult.richContent } : {}),
    ...(executionResult.actions ? { actions: executionResult.actions } : {}),
    ...(executionResult.voiceConfig ? { voiceConfig: executionResult.voiceConfig } : {}),
    ...(contentEnvelope ? { contentEnvelope } : {}),
    deploymentId: resolved.versionInfo.deploymentId ?? binding.deploymentId,
  };
}
