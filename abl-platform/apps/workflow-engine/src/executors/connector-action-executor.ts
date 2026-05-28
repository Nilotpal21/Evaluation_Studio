/**
 * Connector Action Step Executor
 *
 * Resolves expressions in step parameters and delegates to ConnectorToolExecutor.
 */

import type { ConnectorToolExecutor } from '@agent-platform/connectors/executor';
import { resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_STEP_TIMEOUT_MS } from '../constants.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:connector-action-executor');

export interface ConnectorActionStep {
  id: string;
  type: 'connector_action';
  connector: string;
  action: string;
  params: Record<string, string>;
  /**
   * Per-param input mode, aligned with `workflow-schemas.paramModes`.
   * - `static` (default): value is a literal. We still try JSON.parse for
   *   complex types (arrays/objects from multi-select dropdowns, dicts),
   *   but we do NOT run expression resolution, so literal `{{…}}` survives.
   * - `expression`: value is an expression string — run expression resolution.
   */
  paramModes?: Record<string, 'static' | 'expression'>;
  connectionId?: string;
  timeout?: number;
  retry?: import('../handlers/step-dispatcher.js').RetryConfig;
}

export interface ConnectorActionDeps {
  connectorToolExecutor: ConnectorToolExecutor;
}

/**
 * Try to coerce a JSON-looking string into its parsed value.
 *
 * UI inputs such as `multi_select_dropdown` (JSON array) and `object`
 * (JSON object) are stored as stringified JSON in the step config. The
 * runtime needs the structured value at `ctx.params`, otherwise pieces
 * calling array methods on it blow up with `TypeError`.
 *
 * Only strings that clearly begin with `[` or `{` are considered —
 * anything else is returned as-is.
 */
function tryParseJsonShape(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    // "String(someObject)" produces "[object Object]" — a serialization bug upstream.
    // Return empty collection so pieces calling .map() don't crash, but warn so
    // the producer-side bug can be diagnosed.
    log.warn('tryParseJsonShape: unparseable JSON-shape string — likely String(obj) upstream', {
      raw: trimmed.slice(0, 120),
    });
    return trimmed.startsWith('[') ? [] : {};
  }
}

export async function executeConnectorAction(
  step: ConnectorActionStep,
  ctx: WorkflowContextData,
  deps: ConnectorActionDeps,
): Promise<unknown> {
  const resolvedParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.params)) {
    const mode = step.paramModes?.[key] ?? 'expression';
    const resolved =
      mode === 'static' ? tryParseJsonShape(value) : resolveExpressionTyped(value, ctx);
    // If the resolved value is an object, stringify it so downstream pieces
    // (e.g. nodemailer, Buffer.from) receive a string, not a raw object.
    resolvedParams[key] =
      resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)
        ? JSON.stringify(resolved)
        : resolved;
  }

  const toolName = `${step.connector}.${step.action}`;
  const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT_MS;

  return deps.connectorToolExecutor.execute(toolName, resolvedParams, timeout, step.connectionId);
}
