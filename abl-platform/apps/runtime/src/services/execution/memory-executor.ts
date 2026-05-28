/**
 * MemoryExecutor — Evaluates REMEMBER triggers and executes RECALL instructions.
 *
 * REMEMBER: After state changes (entity extraction, tool result, SET), evaluate
 * trigger conditions and store matching values to the FactStore.
 *
 * RECALL: On detected events (session_start, search_initiated, etc.), load
 * facts from the FactStore and inject into session context.
 */

import type {
  RememberTrigger,
  RecallInstruction,
  RecallAction,
} from '@abl/compiler/platform/ir/schema.js';
import { createLogger } from '@abl/compiler/platform';
import type { FactStore, Fact } from '@abl/compiler/platform/stores/fact-store.js';
import { eventMatches } from './event-matching.js';

const log = createLogger('memory-executor');

export interface MemoryExecutorConfig {
  factStore?: FactStore;
  tenantId?: string;
  userId?: string;
}

/**
 * Evaluate all REMEMBER triggers against current session state.
 * Returns a list of fact store operations to perform.
 */
export function evaluateRememberTriggers(
  triggers: RememberTrigger[],
  sessionValues: Record<string, unknown>,
  config: MemoryExecutorConfig,
): Array<{ key: string; value: unknown; ttl?: string }> {
  if (!config.userId || !config.factStore) {
    log.debug(
      'Evaluating REMEMBER without a user-scoped fact store; non-user memory targets may still be handled by the runtime integration layer',
    );
  }

  const operations: Array<{ key: string; value: unknown; ttl?: string }> = [];

  for (const trigger of triggers) {
    // Evaluate condition
    if (!evaluateSimpleCondition(trigger.when, sessionValues)) {
      continue;
    }

    // Resolve value from session — handles both simple paths and composite objects
    const value = resolveStoreValue(trigger.store.value, sessionValues);
    if (value === undefined || value === null) {
      log.debug('REMEMBER value resolved to null/undefined', { path: trigger.store.value });
      continue;
    }

    // Key is just the target path — store enforces (tenantId, userId, projectId) isolation
    const key = trigger.store.target;

    operations.push({
      key,
      value,
      ttl: trigger.ttl,
    });
  }

  return operations;
}

/**
 * Execute RECALL instructions for matching events.
 * Returns data to inject into the session context.
 */
export async function executeRecallInstructions(
  instructions: RecallInstruction[],
  detectedEvents: string[],
  config: MemoryExecutorConfig,
): Promise<Record<string, unknown>> {
  if (!config.userId || !config.factStore) {
    log.debug('Skipping RECALL — no userId or factStore configured');
    return {};
  }

  const injectedData: Record<string, unknown> = {};

  for (const instruction of instructions) {
    // Check if any detected event matches this instruction's event
    if (!eventMatches(instruction.event, detectedEvents)) {
      continue;
    }

    const action = instruction.action as RecallAction | undefined;
    if (!action) {
      // Legacy format: instruction-only, no action — log and skip
      log.debug('RECALL with no action — prompt_llm only', { event: instruction.event });
      continue;
    }

    switch (action.type) {
      case 'inject_context': {
        const paths = action.paths ?? [];
        if (paths.length > 0) {
          try {
            const factMap = await config.factStore.getMany(paths);
            for (const [key, fact] of factMap) {
              injectedData[key] = fact.value;
            }
          } catch (err) {
            log.warn('RECALL inject_context batch failed', {
              paths,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }
      case 'load_memory': {
        const domain = action.domain;
        const prefix = domain ? `preferences.${domain}` : 'preferences';
        try {
          const facts: Fact[] = await config.factStore.query({ prefix });
          if (facts && facts.length > 0) {
            for (const fact of facts) {
              injectedData[fact.key] = fact.value;
            }
          }
        } catch (err) {
          log.warn('RECALL load_memory failed', { prefix, error: String(err) });
        }
        break;
      }
      case 'prompt_llm': {
        // Store instruction for later injection into LLM context
        if (!injectedData._recallPrompts) {
          injectedData._recallPrompts = [];
        }
        (injectedData._recallPrompts as string[]).push(action.instruction);
        break;
      }
    }
  }

  return injectedData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple condition evaluation for REMEMBER WHEN clauses.
 * Supports: field_name IS SET, field_name == value, field_name != value, etc.
 */
function evaluateSimpleCondition(condition: string, values: Record<string, unknown>): boolean {
  const trimmed = condition.trim();

  // "field IS SET" pattern
  const isSetMatch = trimmed.match(/^(\w[\w.]*)\s+IS\s+SET$/i);
  if (isSetMatch) {
    const val = resolvePathValue(isSetMatch[1], values);
    return val !== undefined && val !== null && val !== '';
  }

  // "field IS NOT SET" pattern
  const isNotSetMatch = trimmed.match(/^(\w[\w.]*)\s+IS\s+NOT\s+SET$/i);
  if (isNotSetMatch) {
    const val = resolvePathValue(isNotSetMatch[1], values);
    return val === undefined || val === null || val === '';
  }

  // Comparison patterns: field op value
  const cmpMatch = trimmed.match(/^(\w[\w.]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const [, field, op, rawVal] = cmpMatch;
    const left = resolvePathValue(field, values);
    const right = parseValue(rawVal.trim());
    return compareValues(left, op, right);
  }

  // Simple truthy check — treat the whole condition as a field name
  const val = resolvePathValue(trimmed, values);
  return !!val;
}

function resolvePathValue(path: string, values: Record<string, unknown>): unknown {
  // Try flat key first (session values use dotted keys like 'user.preferred_destinations')
  if (path in values) return values[path];

  // Fall back to nested dot-path traversal
  const parts = path.split('.');
  let current: unknown = values;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Resolve a STORE value expression. Handles:
 * - Simple path: "destination" → resolves via dot-path
 * - Composite object: "{destination: destination, travelers: num_travelers}" → resolves each
 *   value path and constructs an object
 */
function resolveStoreValue(expr: string, values: Record<string, unknown>): unknown {
  const trimmed = expr.trim();

  // Composite object expression: {key1: path1, key2: path2}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return undefined;

    const result: Record<string, unknown> = {};
    const pairs = inner.split(',');
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const key = pair.slice(0, colonIdx).trim();
      const valuePath = pair.slice(colonIdx + 1).trim();
      const resolved = resolvePathValue(valuePath, values);
      if (resolved !== undefined && resolved !== null) {
        result[key] = resolved;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  // Simple path reference
  return resolvePathValue(trimmed, values);
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  // Strip both single and double quotes from string literals
  return raw.replace(/^['"]|['"]$/g, '');
}

/**
 * Coerce a value to match the type of a target for type-insensitive comparison.
 * Handles string↔boolean and string↔number mismatches that JS loose equality
 * does not resolve intuitively (e.g. "true" == true is false in JS).
 */
function coerceToType(value: unknown, target: unknown): unknown {
  if (typeof value === typeof target) return value;

  if (typeof target === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (typeof target === 'string' && typeof value === 'boolean') {
    return String(value);
  }
  if (typeof target === 'number' && typeof value === 'string') {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }
  return value;
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case '==':
      return coerceToType(left, right) == right;
    case '!=':
      return coerceToType(left, right) != right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}
