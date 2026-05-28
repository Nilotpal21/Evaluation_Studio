/**
 * Breakpoint Manager
 *
 * Manages breakpoints and evaluates whether execution should pause.
 */

import { ExtendedTraceEvent, TraceEventType } from '../schema/trace-events.js';
import {
  Breakpoint,
  BreakpointSpec,
  BreakpointContext,
  AgentStackFrame,
  createBreakpointId,
} from './types.js';

/**
 * Context passed to breakpoint evaluation
 */
export interface EvaluationContext {
  sessionId: string;
  agentName: string;
  stepName?: string;
  traceEvent?: ExtendedTraceEvent;
  state: Record<string, unknown>;
  callStack: AgentStackFrame[];
}

// ── Safe expression evaluator (recursive-descent, no eval/Function) ──────

/** Resolve a dotted property path against state */
function resolveProperty(path: string, state: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let current: unknown = state;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'undefined' }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'not' };

const OP_CHARS = new Set(['=', '!', '>', '<', '&', '|']);

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
        }
        str += expr[i];
        i++;
      }
      i++; // closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }
    // Operators
    if (OP_CHARS.has(ch)) {
      // Special case: standalone ! (not)
      if (ch === '!' && expr[i + 1] !== '=') {
        tokens.push({ type: 'not' });
        i++;
        continue;
      }
      let op = ch;
      i++;
      if (i < expr.length && (expr[i] === '=' || expr[i] === '&' || expr[i] === '|')) {
        op += expr[i];
        i++;
      }
      tokens.push({ type: 'op', value: op });
      continue;
    }
    // Numbers
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && i + 1 < expr.length && expr[i + 1] >= '0' && expr[i + 1] <= '9')
    ) {
      let num = ch;
      i++;
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'number', value: Number(num) });
      continue;
    }
    // Identifiers and keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = ch;
      i++;
      while (
        i < expr.length &&
        ((expr[i] >= 'a' && expr[i] <= 'z') ||
          (expr[i] >= 'A' && expr[i] <= 'Z') ||
          (expr[i] >= '0' && expr[i] <= '9') ||
          expr[i] === '_' ||
          expr[i] === '.')
      ) {
        ident += expr[i];
        i++;
      }
      if (ident === 'true') tokens.push({ type: 'boolean', value: true });
      else if (ident === 'false') tokens.push({ type: 'boolean', value: false });
      else if (ident === 'null') tokens.push({ type: 'null' });
      else if (ident === 'undefined') tokens.push({ type: 'undefined' });
      else tokens.push({ type: 'ident', value: ident });
      continue;
    }
    throw new Error(`Unexpected character in expression: ${ch}`);
  }
  return tokens;
}

/**
 * Recursive-descent parser for breakpoint condition expressions.
 *
 * Grammar:
 *   expr       → or_expr
 *   or_expr    → and_expr ( '||' and_expr )*
 *   and_expr   → cmp_expr ( '&&' cmp_expr )*
 *   cmp_expr   → unary ( ('==' | '!=' | '>' | '<' | '>=' | '<=') unary )?
 *   unary      → '!' unary | primary
 *   primary    → literal | ident | '(' expr ')'
 */
function safeEvaluate(expr: string, state: Record<string, unknown>): unknown {
  const tokens = tokenize(expr.trim());
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }
  function advance(): Token {
    return tokens[pos++];
  }

  function parseExpr(): unknown {
    return parseOr();
  }

  function parseOr(): unknown {
    let left = parseAnd();
    while (peek()?.type === 'op' && (peek() as { value: string }).value === '||') {
      advance();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseAnd(): unknown {
    let left = parseComparison();
    while (peek()?.type === 'op' && (peek() as { value: string }).value === '&&') {
      advance();
      const right = parseComparison();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  function parseComparison(): unknown {
    const left = parseUnary();
    const tok = peek();
    if (tok?.type === 'op') {
      const op = (tok as { value: string }).value;
      if (['==', '!=', '>', '<', '>=', '<='].includes(op)) {
        advance();
        const right = parseUnary();
        switch (op) {
          case '==':
            return left === right;
          case '!=':
            return left !== right;
          case '>':
            return (left as number) > (right as number);
          case '<':
            return (left as number) < (right as number);
          case '>=':
            return (left as number) >= (right as number);
          case '<=':
            return (left as number) <= (right as number);
        }
      }
    }
    return left;
  }

  function parseUnary(): unknown {
    if (peek()?.type === 'not') {
      advance();
      return !parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): unknown {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');
    switch (tok.type) {
      case 'number':
        advance();
        return tok.value;
      case 'string':
        advance();
        return tok.value;
      case 'boolean':
        advance();
        return tok.value;
      case 'null':
        advance();
        return null;
      case 'undefined':
        advance();
        return undefined;
      case 'ident':
        advance();
        return resolveProperty(tok.value, state);
      case 'paren':
        if (tok.value === '(') {
          advance();
          const val = parseExpr();
          const closing = advance();
          if (closing?.type !== 'paren' || closing.value !== ')') {
            throw new Error('Expected closing parenthesis');
          }
          return val;
        }
        throw new Error(`Unexpected token: ${tok.value}`);
      default:
        throw new Error(`Unexpected token type: ${tok.type}`);
    }
  }

  const result = parseExpr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected token after expression: ${JSON.stringify(tokens[pos])}`);
  }
  return result;
}

/**
 * Manages breakpoints and checks for hits
 */
export class BreakpointManager {
  private breakpoints: Map<string, Breakpoint> = new Map();

  /**
   * Add a new breakpoint
   */
  addBreakpoint(spec: BreakpointSpec): Breakpoint {
    const bp: Breakpoint = {
      id: createBreakpointId(),
      spec,
      enabled: true,
      hitCount: 0,
      createdAt: new Date(),
    };
    this.breakpoints.set(bp.id, bp);
    return bp;
  }

  /**
   * Remove a breakpoint
   */
  removeBreakpoint(id: string): boolean {
    return this.breakpoints.delete(id);
  }

  /**
   * Enable or disable a breakpoint
   */
  setBreakpointEnabled(id: string, enabled: boolean): boolean {
    const bp = this.breakpoints.get(id);
    if (bp) {
      bp.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Get all breakpoints
   */
  getAllBreakpoints(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  /**
   * Get a breakpoint by ID
   */
  getBreakpoint(id: string): Breakpoint | undefined {
    return this.breakpoints.get(id);
  }

  /**
   * Clear all breakpoints
   */
  clearAll(): void {
    this.breakpoints.clear();
  }

  /**
   * Check if any breakpoint should trigger
   */
  checkBreakpoints(context: EvaluationContext): BreakpointContext | null {
    for (const bp of this.breakpoints.values()) {
      if (!bp.enabled) continue;

      const hit = this.evaluateBreakpoint(bp, context);
      if (hit) {
        bp.hitCount++;
        return {
          breakpoint: bp,
          sessionId: context.sessionId,
          agentName: context.agentName,
          stepName: context.stepName,
          traceEvent: context.traceEvent,
          stateSnapshot: { ...context.state },
          callStack: [...context.callStack],
        };
      }
    }
    return null;
  }

  /**
   * Check a specific breakpoint type
   */
  private evaluateBreakpoint(bp: Breakpoint, context: EvaluationContext): boolean {
    const { spec } = bp;

    switch (spec.type) {
      case 'agent':
        return this.evaluateAgentBreakpoint(spec, context);

      case 'step':
        return this.evaluateStepBreakpoint(spec, context);

      case 'event':
        return this.evaluateEventBreakpoint(spec, context);

      case 'condition':
        return this.evaluateConditionalBreakpoint(spec, context);

      default:
        return false;
    }
  }

  private evaluateAgentBreakpoint(
    spec: { name: string; on?: 'entry' | 'exit' | 'both' },
    context: EvaluationContext,
  ): boolean {
    // Check agent name matches
    if (context.agentName !== spec.name) {
      return false;
    }

    // Check entry/exit based on trace event
    const event = context.traceEvent;
    if (!event) return false;

    const on = spec.on ?? 'both';
    if (on === 'entry' || on === 'both') {
      if (event.type === 'agent_enter') return true;
    }
    if (on === 'exit' || on === 'both') {
      if (event.type === 'agent_exit') return true;
    }

    return false;
  }

  private evaluateStepBreakpoint(
    spec: { agent: string; step: string },
    context: EvaluationContext,
  ): boolean {
    // Check agent and step match
    if (context.agentName !== spec.agent) return false;
    if (context.stepName !== spec.step) return false;

    // Only break on step entry
    const event = context.traceEvent;
    return event?.type === 'flow_step_enter';
  }

  private evaluateEventBreakpoint(
    spec: { eventType: TraceEventType },
    context: EvaluationContext,
  ): boolean {
    return context.traceEvent?.type === spec.eventType;
  }

  private evaluateConditionalBreakpoint(
    spec: { expr: string },
    context: EvaluationContext,
  ): boolean {
    try {
      // Simple expression evaluation
      // Supports: state.path.to.value, comparisons, boolean operators
      return this.evaluateExpression(spec.expr, context.state);
    } catch {
      // If expression fails to evaluate, don't break
      return false;
    }
  }

  /**
   * Simple expression evaluator for conditions
   * Supports: property access, comparisons (==, !=, >, <, >=, <=), boolean operators (&&, ||, !)
   */
  private evaluateExpression(expr: string, state: Record<string, unknown>): boolean {
    const result = safeEvaluate(expr, state);
    return Boolean(result);
  }
}

/**
 * Check if a breakpoint matches a specific agent entry event
 */
export function matchesAgentEntry(bp: Breakpoint, agentName: string): boolean {
  const { spec } = bp;
  if (spec.type !== 'agent') return false;
  if (spec.name !== agentName) return false;
  const on = spec.on ?? 'both';
  return on === 'entry' || on === 'both';
}

/**
 * Check if a breakpoint matches a specific agent exit event
 */
export function matchesAgentExit(bp: Breakpoint, agentName: string): boolean {
  const { spec } = bp;
  if (spec.type !== 'agent') return false;
  if (spec.name !== agentName) return false;
  const on = spec.on ?? 'both';
  return on === 'exit' || on === 'both';
}

/**
 * Check if a breakpoint matches a specific step
 */
export function matchesStep(bp: Breakpoint, agentName: string, stepName: string): boolean {
  const { spec } = bp;
  if (spec.type !== 'step') return false;
  return spec.agent === agentName && spec.step === stepName;
}

/**
 * Check if a breakpoint matches an event type
 */
export function matchesEventType(bp: Breakpoint, eventType: TraceEventType): boolean {
  const { spec } = bp;
  if (spec.type !== 'event') return false;
  return spec.eventType === eventType;
}
