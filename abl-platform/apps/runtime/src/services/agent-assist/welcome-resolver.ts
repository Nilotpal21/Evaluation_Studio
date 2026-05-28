import type { AgentIR } from '@abl/compiler';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { DeploymentResolver } from '../deployment-resolver.js';
import { getSessionService } from '../session/session-service.js';
import type { AgentAssistBinding } from './types.js';

const log = createLogger('agent-assist:welcome-resolver');

/**
 * `/sessions` fires before any session variables exist, so we cannot meaningfully
 * interpolate `{{placeholder}}`-style templates. When the author's configured
 * welcome string contains placeholders, we skip it and fall through to the
 * next tier rather than leak a literal `{{user.name}}` to the end user.
 */
const INTERPOLATION_PATTERN = /\{\{[^}]+\}\}/;

function hasRenderableText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !INTERPOLATION_PATTERN.test(value);
}

/**
 * Pure: resolve the text to show in the V1 `Welcome_Event` for a given AgentIR.
 *
 * Priority chain:
 *   1. `agentIR.on_start.respond` — the canonical per-agent welcome slot.
 *   2. `agentIR.messages.greeting` — secondary author-configured greeting
 *      used by the digital runtime when no fields are pending.
 *   3. `DEFAULT_MESSAGES.greeting` — platform default (`"How can I help you?"`).
 *
 * Steps 1 and 2 are skipped when the string is empty or contains unresolved
 * template placeholders (see INTERPOLATION_PATTERN).
 */
export function resolveWelcomeTextFromIR(agentIR: AgentIR): string {
  const onStart = agentIR.on_start?.respond;
  if (hasRenderableText(onStart)) return onStart;

  const greeting = agentIR.messages?.greeting;
  if (hasRenderableText(greeting)) return greeting;

  return DEFAULT_MESSAGES.greeting;
}

/**
 * Resolve the welcome text for a binding by loading its active deployment and
 * reading the entry AgentIR. Best-effort: any failure (missing deployment, bad
 * IR shape, resolver exception) returns an empty string and logs a warning —
 * the `/sessions` route must never 5xx because of welcome lookup.
 */
export async function resolveWelcomeTextForBinding(binding: AgentAssistBinding): Promise<string> {
  try {
    const resolver = new DeploymentResolver(getSessionService());
    const resolved = await resolver.resolve({
      projectId: binding.projectId,
      tenantId: binding.tenantId,
      deploymentId: binding.deploymentId,
      environment: binding.environment,
    });
    const entryIR = resolved.agents[resolved.entryAgent];
    if (!entryIR) {
      log.warn('agent-assist welcome-resolver: entry agent IR missing from resolved deployment', {
        appId: binding.appId,
        environment: binding.environment,
        entryAgent: resolved.entryAgent,
      });
      return '';
    }
    return resolveWelcomeTextFromIR(entryIR);
  } catch (err) {
    log.warn('agent-assist welcome-resolver: deployment resolution failed', {
      tenantId: binding.tenantId,
      projectId: binding.projectId,
      appId: binding.appId,
      environment: binding.environment,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}
