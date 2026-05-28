/**
 * Expression Resolver
 *
 * Resolves {{path}} expressions against a WorkflowContext.
 * Supports `context.` prefix (optional) and custom vars.
 *
 * Supported paths:
 *   - context.steps.API0001.output.body   (name-keyed step output)
 *   - context.steps.start.input           (workflow input via start node)
 *   - context.myCustomVar                 (custom root variable)
 *   - trigger.payload.orderId
 *   - steps.API0001.output.customer
 *   - context.retryCount
 *   - workflow.executionId
 *   - tenant.tenantId
 */

export {
  CONTEXT_SYSTEM_KEYS,
  getContextVariables,
  type WorkflowContextData,
  type WorkflowStepData,
} from './step-context-schema.js';

/**
 * Positive-list projection of session metadata pushed by the runtime when a
 * workflow is invoked from an agent tool call. Fields are explicit — no spread
 * — so additions to the source `Session` schema don't leak into workflow scope
 * (privacy-by-default). All fields are deep-frozen on the host before emission;
 * inside a function-node isolate they are re-frozen by the materializer.
 */
export interface AgentSessionProjection {
  readonly sessionId: string;
  readonly agentName: string;
  readonly channel: string;
  readonly source: 'public' | 'channel' | 'studio-debug';
  readonly endUserId: string | undefined;
  readonly locale: string | undefined;
  readonly startedAt: string;
  readonly lastActivityAt: string;
}

/**
 * Positive-list projection of the per-call invocation context (caller, tool
 * arguments, attachments, message metadata). Every field is explicit; runtime
 * additions stay invisible to workflow code unless added to the projection.
 */
export interface AgentContextProjection {
  readonly caller: { readonly type: string; readonly id: string };
  readonly invocation: { readonly tool: string; readonly args: Record<string, unknown> };
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly name: string;
  }>;
  readonly messageMetadata: Record<string, unknown> | undefined;
}

/**
 * Memory projection loaded at workflow start. `user` is `undefined` when the
 * trigger has no resolved end-user identity (cron, anonymous webhook, etc.) —
 * code paths that touch `memory.user.*` see `undefined` rather than throwing.
 */
export interface MemoryProjection {
  workflow: Record<string, unknown>;
  project: Record<string, unknown>;
  user: Record<string, unknown> | undefined;
}

import { FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS } from '@agent-platform/shared-kernel/types';
import type { WorkflowContextData } from './step-context-schema.js';

const EXPRESSION_PATTERN = /\{\{(.+?)\}\}/g;

/**
 * Resolve all {{path}} expressions in a string, converting values to strings.
 * Returns the full string with all expressions interpolated.
 */
export function resolveExpression(template: unknown, ctx: WorkflowContextData): string {
  if (template == null) return '';
  // Non-string inputs (numbers, booleans) have no expressions to resolve —
  // coerce to string so callers that expect a string (e.g. delay duration
  // parsers) keep working instead of throwing `template.replace is not a function`.
  if (typeof template !== 'string') return String(template);
  return template.replace(EXPRESSION_PATTERN, (_match, path: string) => {
    const value = getNestedValue(ctx, path.trim());
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      // Guard against circular references — JSON.stringify would throw and
      // abort the whole template replacement. Fall back to String(value)
      // which renders as `[object Object]` but keeps the pipeline alive.
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
}

/**
 * Resolve a single {{path}} expression preserving the original type.
 * If the template contains only a single expression (no surrounding text),
 * returns the typed value. Otherwise falls back to string interpolation.
 */
export function resolveExpressionTyped(template: unknown, ctx: WorkflowContextData): unknown {
  if (template == null) return undefined;
  // Non-string inputs carry their own value — there is no `{{...}}` to resolve.
  if (typeof template !== 'string') return template;
  const trimmed = template.trim();

  // Check if the entire template is a single expression
  const singleMatch = /^\{\{(.+?)\}\}$/.exec(trimmed);
  if (singleMatch) {
    return getNestedValue(ctx, singleMatch[1].trim());
  }

  // Multiple expressions or mixed text — return interpolated string
  return resolveExpression(trimmed, ctx);
}

/**
 * Resolve expressions in all values of an object (shallow).
 */
export function resolveExpressionMap(
  map: Record<string, string>,
  ctx: WorkflowContextData,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    result[key] = resolveExpression(value, ctx);
  }
  return result;
}

// ─── Expression Tracing ──────────────────────────────────────────────

/** Trace of a single expression resolution */
export interface ExpressionTrace {
  expression: string;
  resolvedValue: unknown;
}

/**
 * Resolve a single expression and return both the value and traces
 * for each {{path}} found in the template.
 */
export function resolveExpressionWithTrace(
  template: string,
  ctx: WorkflowContextData,
): { value: unknown; traces: ExpressionTrace[] } {
  const traces: ExpressionTrace[] = [];
  if (template == null) return { value: undefined, traces };
  // Non-string inputs carry their own value — no `{{...}}` to trace.
  if (typeof template !== 'string') return { value: template, traces };
  const trimmed = template.trim();

  // Collect all expression traces using a fresh regex (avoid global state)
  const pattern = /\{\{(.+?)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    const path = match[1].trim();
    const resolvedValue = getNestedValue(ctx, path);
    traces.push({ expression: `{{${path}}}`, resolvedValue });
  }

  // Resolve the actual value
  const value = resolveExpressionTyped(trimmed, ctx);
  return { value, traces };
}

/**
 * Traverse nested object by dot-separated path.
 * Supports `context.` prefix — strips it before resolving against the WorkflowContextData root.
 * Paths like `context.steps.API0001.output.body` resolve to `ctx.steps.API0001.output.body`.
 * Root context variables (e.g., `context.myVar`) resolve directly from the
 * context root. Step data must be accessed explicitly through `context.steps`.
 */

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([...FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS, 'vars']);

/** Keys that must never be traversed to prevent prototype pollution reads */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Find a key in an object matching `target` case-insensitively, returning
 * the exact-cased key or undefined if no match. Used as a fallback so
 * `{{context.steps.integration1}}` resolves when the step was saved as
 * "Integration1" — canvas labels are user-entered and drift in case.
 */
function findKeyCaseInsensitive(obj: Record<string, unknown>, target: string): string | undefined {
  const targetLower = target.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === targetLower) return key;
  }
  return undefined;
}

function getNestedValue(obj: unknown, path: string): unknown {
  // Strip `context.` prefix if present
  const hasContextPrefix = path.startsWith('context.');
  const normalizedPath = hasContextPrefix ? path.slice(8) : path;
  // Bare `vars.*` (without `context.` prefix) is not valid — use `context.vars.*` instead.
  if (!hasContextPrefix && (normalizedPath === 'vars' || normalizedPath.startsWith('vars.'))) {
    return undefined;
  }
  const parts = normalizedPath.split('.');

  let current: unknown = obj;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (DANGEROUS_KEYS.has(part)) return undefined;
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }

    const currentObj = current as Record<string, unknown>;
    let next = currentObj[part];

    // Case-insensitive fallback for the step-name segment only.
    // Path shape: steps.<stepName>.output.<field>... — the segment
    // immediately after 'steps' is the step key that users hand-type.
    // Other segments stay case-sensitive to preserve output-field fidelity.
    if (next === undefined && i >= 1 && parts[i - 1] === 'steps') {
      const resolvedKey = findKeyCaseInsensitive(currentObj, part);
      if (resolvedKey !== undefined) {
        next = currentObj[resolvedKey];
      }
    }

    current = next;
  }

  return current;
}
