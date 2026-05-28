import type { AgentIR, HandoffConfig, RemoteAgentLocation } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';
import { isValidTimeoutString } from '../constructs/executors/timeout-utils.js';
import {
  HANDOFF_ON_RETURN_ACTION_VALUES,
  HANDOFF_TIMEOUT_ACTION_VALUES,
} from '../contracts/contract-source-data.js';

const SUPPORTED_HANDOFF_TIMEOUT_ACTIONS = new Set<string>(HANDOFF_TIMEOUT_ACTION_VALUES);
const SUPPORTED_HANDOFF_ON_RETURN_ACTIONS = new Set<string>(HANDOFF_ON_RETURN_ACTION_VALUES);
const SUPPORTED_HANDOFF_FAILURE_ACTIONS = new Set<string>(['continue', 'escalate', 'respond']);

function getLegacyOnReturnShorthand(handoff: HandoffConfig): string | undefined {
  return typeof handoff.on_return === 'string' ? handoff.on_return : undefined;
}

function resolveNamedOnReturnHandler(agent: AgentIR, handoff: HandoffConfig): string | undefined {
  const onReturn = handoff.on_return;
  if (typeof onReturn === 'string') {
    if (SUPPORTED_HANDOFF_ON_RETURN_ACTIONS.has(onReturn)) {
      return undefined;
    }

    return agent.coordination?.return_handlers?.[onReturn] ? onReturn : undefined;
  }

  return onReturn?.handler;
}

function resolveOnReturnAction(handoff: HandoffConfig): string | undefined {
  const onReturn = handoff.on_return;
  if (typeof onReturn === 'string') {
    return SUPPORTED_HANDOFF_ON_RETURN_ACTIONS.has(onReturn) ? onReturn : undefined;
  }

  return onReturn?.action;
}

function pushDiagnostic(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  message: string,
  code: string,
  path: string,
  severity: 'error' | 'warning' = 'error',
): void {
  diagnostics.push({
    agent: agentName,
    message,
    type: 'validation',
    severity,
    code,
    path,
  });
}

function validateTimeoutValue(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  timeout: string | undefined,
  path: string,
  label: string,
): void {
  if (timeout === undefined) {
    return;
  }

  if (!isValidTimeoutString(timeout)) {
    pushDiagnostic(
      diagnostics,
      agentName,
      `${label} "${timeout}" is invalid. Supported timeout formats are bare milliseconds or values ending in ms, s, or m.`,
      VALIDATION_CODES.INVALID_TIMEOUT_SYNTAX,
      path,
    );
  }
}

function validateRemoteLocation(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  remote: RemoteAgentLocation | undefined,
  pathPrefix: string,
  label: string,
): void {
  if (!remote || remote.location !== 'remote') {
    return;
  }

  // Endpoint is optional when LOCATION: REMOTE — it may be resolved at runtime
  // from the External Agent Registry (registered via Studio → External Agents).
  // Only validate the URL if one is explicitly provided.
  if (typeof remote.endpoint === 'string' && remote.endpoint.trim().length > 0) {
    try {
      new URL(remote.endpoint);
    } catch {
      pushDiagnostic(
        diagnostics,
        agentName,
        `${label} endpoint "${remote.endpoint}" is not a valid absolute URL.`,
        VALIDATION_CODES.INVALID_REMOTE_AGENT_ENDPOINT,
        `${pathPrefix}.endpoint`,
      );
    }
  }

  validateTimeoutValue(
    diagnostics,
    agentName,
    remote.timeout,
    `${pathPrefix}.timeout`,
    `${label} remote timeout`,
  );
}

function validateHandoffTimeoutAction(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  const action = handoff.on_timeout;
  if (!action) {
    return;
  }

  const isRespondAction = action.startsWith('respond:') && action.slice('respond:'.length).trim();
  if (SUPPORTED_HANDOFF_TIMEOUT_ACTIONS.has(action) || isRespondAction) {
    return;
  }

  pushDiagnostic(
    diagnostics,
    agentName,
    `Handoff timeout action "${action}" is invalid. Supported actions are "escalate", "continue", or "respond:<message>".`,
    VALIDATION_CODES.INVALID_HANDOFF_TIMEOUT_ACTION,
    `${pathPrefix}.on_timeout`,
  );
}

function validateHandoffFailureAction(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  const action = handoff.on_failure;
  if (!action || SUPPORTED_HANDOFF_FAILURE_ACTIONS.has(action)) {
    return;
  }

  pushDiagnostic(
    diagnostics,
    agentName,
    `Handoff on_failure action "${action}" is invalid. Supported actions are "continue", "escalate", or "respond".`,
    VALIDATION_CODES.INVALID_HANDOFF_FAILURE_ACTION,
    `${pathPrefix}.on_failure`,
  );
}

function validateHandoffOnReturnAction(
  diagnostics: ValidationDiagnostic[],
  agent: AgentIR,
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  const legacyShorthand = getLegacyOnReturnShorthand(handoff);
  if (legacyShorthand) {
    if (SUPPORTED_HANDOFF_ON_RETURN_ACTIONS.has(legacyShorthand)) {
      return;
    }

    if (agent.coordination?.return_handlers?.[legacyShorthand]) {
      return;
    }

    pushDiagnostic(
      diagnostics,
      agentName,
      `Inline handoff on_return shorthand "${legacyShorthand}" does not match a supported built-in action or a declared return handler. Use on_return.action or on_return.handler instead.`,
      VALIDATION_CODES.LEGACY_HANDOFF_ON_RETURN_SHORTHAND,
      `${pathPrefix}.on_return`,
      'warning',
    );
    return;
  }

  const structuredOnReturn =
    typeof handoff.on_return === 'object' && handoff.on_return !== null
      ? handoff.on_return
      : undefined;

  if (structuredOnReturn?.action && structuredOnReturn?.handler) {
    pushDiagnostic(
      diagnostics,
      agentName,
      'Handoff on_return must choose either a built-in action or a named handler, not both.',
      VALIDATION_CODES.HANDOFF_ON_RETURN_ACTION_AND_HANDLER,
      `${pathPrefix}.on_return`,
    );
  }

  const action = resolveOnReturnAction(handoff);
  const namedHandler = resolveNamedOnReturnHandler(agent, handoff);
  const hasNamedHandler = !!namedHandler && !!agent.coordination?.return_handlers?.[namedHandler];

  if (namedHandler && !hasNamedHandler) {
    pushDiagnostic(
      diagnostics,
      agentName,
      `Handoff on_return handler "${namedHandler}" is not declared in coordination.return_handlers.`,
      VALIDATION_CODES.UNKNOWN_HANDOFF_ON_RETURN_HANDLER,
      `${pathPrefix}.on_return.handler`,
    );
  }

  if (namedHandler) {
    return;
  }

  if (!action || SUPPORTED_HANDOFF_ON_RETURN_ACTIONS.has(action)) {
    return;
  }

  pushDiagnostic(
    diagnostics,
    agentName,
    `Handoff on_return action "${action}" is not currently supported at runtime. Supported actions are "continue" and "resume_intent".`,
    VALIDATION_CODES.UNSUPPORTED_HANDOFF_ON_RETURN_ACTION,
    `${pathPrefix}.on_return.action`,
    'warning',
  );
}

function validateHandoffOnReturnReachability(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  if (!handoff.on_return || handoff.return) {
    return;
  }

  pushDiagnostic(
    diagnostics,
    agentName,
    'Handoff on_return is unreachable unless RETURN is true. Remove on_return or enable return-to-parent behavior.',
    VALIDATION_CODES.HANDOFF_ON_RETURN_WITHOUT_RETURN,
    `${pathPrefix}.on_return`,
    'warning',
  );
}

function validateHandoffHistoryStrategy(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  if (handoff.context.history !== 'summary_only') {
    return;
  }

  if (handoff.context.summary.trim().length > 0) {
    return;
  }

  pushDiagnostic(
    diagnostics,
    agentName,
    'Handoff history "summary_only" requires CONTEXT.summary. Without a summary, the child will receive neither raw history nor a synthesized summary.',
    VALIDATION_CODES.HANDOFF_SUMMARY_ONLY_WITHOUT_SUMMARY,
    `${pathPrefix}.context.history`,
    'warning',
  );
}

function validateHandoffMemoryGrants(
  diagnostics: ValidationDiagnostic[],
  agent: AgentIR,
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  const memoryGrants = handoff.context.memory_grants ?? [];
  if (memoryGrants.length === 0) {
    return;
  }

  const persistentDeclarations = new Map(
    (agent.memory?.persistent ?? []).map((entry) => [entry.path, entry]),
  );

  for (let i = 0; i < memoryGrants.length; i++) {
    const grant = memoryGrants[i];
    const grantPath = `${pathPrefix}.context.memory_grants[${i}]`;
    const normalizedGrantPath = grant.path.startsWith('execution_tree.')
      ? grant.path.slice('execution_tree.'.length)
      : grant.path;

    if (!grant.path || grant.path.trim().length === 0) {
      pushDiagnostic(
        diagnostics,
        agentName,
        'Handoff memory grants require a non-empty path.',
        VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT,
        `${grantPath}.path`,
      );
      continue;
    }

    const declaration =
      persistentDeclarations.get(grant.path) ?? persistentDeclarations.get(normalizedGrantPath);
    const isExecutionTreeGrant =
      grant.path.startsWith('execution_tree.') || declaration?.scope === 'execution_tree';

    if (!isExecutionTreeGrant && !declaration) {
      pushDiagnostic(
        diagnostics,
        agentName,
        `Handoff memory grant "${grant.path}" must reference a declared persistent memory path or the execution_tree namespace.`,
        VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT,
        `${grantPath}.path`,
      );
      continue;
    }

    if (grant.access === 'readwrite') {
      if (isExecutionTreeGrant && (!declaration || declaration.access !== 'read')) {
        continue;
      }

      pushDiagnostic(
        diagnostics,
        agentName,
        `Handoff memory grant "${grant.path}" cannot request readwrite access because the source path is not execution_tree-scoped readwrite memory.`,
        VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT_ACCESS,
        `${grantPath}.access`,
      );
    }
  }
}

function validateRetiredCompatibilityShorthands(
  diagnostics: ValidationDiagnostic[],
  agentName: string,
  handoff: HandoffConfig,
  pathPrefix: string,
): void {
  const legacyContext = handoff.context as HandoffConfig['context'] & {
    grant_memory?: string[];
  };
  if (Array.isArray(legacyContext.grant_memory) && legacyContext.grant_memory.length > 0) {
    pushDiagnostic(
      diagnostics,
      agentName,
      'Legacy handoff context grant_memory is no longer supported. Use context.memory_grants with explicit path/access entries.',
      VALIDATION_CODES.LEGACY_HANDOFF_GRANT_MEMORY_SHORTHAND,
      `${pathPrefix}.context.grant_memory`,
    );
  }
}

function validateReturnHandlers(
  diagnostics: ValidationDiagnostic[],
  agent: AgentIR,
  agentName: string,
): void {
  const handlers = agent.coordination?.return_handlers;
  if (!handlers) {
    return;
  }

  for (const [name, handler] of Object.entries(handlers)) {
    if (SUPPORTED_HANDOFF_ON_RETURN_ACTIONS.has(name)) {
      pushDiagnostic(
        diagnostics,
        agentName,
        `Return handler "${name}" collides with a built-in ON_RETURN action. Choose a different handler name.`,
        VALIDATION_CODES.RETURN_HANDLER_NAME_COLLISION,
        `coordination.return_handlers.${name}`,
      );
    }

    if (handler.respond && handler.resume_intent) {
      pushDiagnostic(
        diagnostics,
        agentName,
        `Return handler "${name}" cannot combine RESPOND with resume_intent because the resumed execution becomes the visible follow-up response.`,
        VALIDATION_CODES.HANDOFF_ON_RETURN_ACTION_AND_HANDLER,
        `coordination.return_handlers.${name}`,
      );
    }
  }
}

export function validateCoordinationConfig(agent: AgentIR): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const agentName = agent.metadata.name;

  validateReturnHandlers(diagnostics, agent, agentName);

  for (let i = 0; i < (agent.coordination?.handoffs?.length ?? 0); i++) {
    const handoff = agent.coordination!.handoffs[i];
    const pathPrefix = `coordination.handoffs[${i}]`;

    validateTimeoutValue(
      diagnostics,
      agentName,
      handoff.timeout,
      `${pathPrefix}.timeout`,
      'Handoff timeout',
    );
    validateRemoteLocation(
      diagnostics,
      agentName,
      handoff.remote,
      `${pathPrefix}.remote`,
      `Handoff "${handoff.to}"`,
    );
    validateRetiredCompatibilityShorthands(diagnostics, agentName, handoff, pathPrefix);
    validateHandoffFailureAction(diagnostics, agentName, handoff, pathPrefix);
    validateHandoffTimeoutAction(diagnostics, agentName, handoff, pathPrefix);
    validateHandoffOnReturnAction(diagnostics, agent, agentName, handoff, pathPrefix);
    validateHandoffOnReturnReachability(diagnostics, agentName, handoff, pathPrefix);
    validateHandoffHistoryStrategy(diagnostics, agentName, handoff, pathPrefix);
    validateHandoffMemoryGrants(diagnostics, agent, agentName, handoff, pathPrefix);
  }

  for (let i = 0; i < (agent.coordination?.delegates?.length ?? 0); i++) {
    const delegate = agent.coordination!.delegates[i];
    const pathPrefix = `coordination.delegates[${i}]`;

    validateTimeoutValue(
      diagnostics,
      agentName,
      delegate.timeout,
      `${pathPrefix}.timeout`,
      'Delegate timeout',
    );
    validateRemoteLocation(
      diagnostics,
      agentName,
      delegate.remote,
      `${pathPrefix}.remote`,
      `Delegate "${delegate.agent}"`,
    );
  }

  return diagnostics;
}
