import { describe, it, expect } from 'vitest';
import {
  resolveExpression,
  resolveExpressionTyped,
  resolveExpressionMap,
  type AgentContextProjection,
  type AgentSessionProjection,
  type MemoryProjection,
  type WorkflowContextData,
} from '../context/expression-resolver.js';
import { materializeAgentContext } from '../context/agent-projection.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', amount: 99.5, tags: ['urgent', 'vip'] },
    metadata: { firedAt: '2026-02-27' },
  },
  workflow: { id: 'wf-1', name: 'test-workflow', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    'fetch-order': {
      output: { customer: 'John', items: [1, 2] },
      status: 'completed',
      durationMs: 100,
      completedAt: '2026-02-27',
    },
    start: {
      input: { postId: 1 },
      output: { postId: 1 },
      status: 'completed',
    },
  },
  vars: { retryCount: 3, flag: true },
};

describe('resolveExpression', () => {
  it('resolves trigger.payload paths', () => {
    expect(resolveExpression('{{trigger.payload.orderId}}', ctx)).toBe('ORD-123');
  });

  it('resolves step output paths', () => {
    expect(resolveExpression('{{steps.fetch-order.output.customer}}', ctx)).toBe('John');
  });

  it('does not resolve bare vars alias', () => {
    // Bare `vars.x` (without the `context.` prefix) is intentionally not a
    // resolvable path. resolveExpression renders unresolved values as the
    // empty string per the undefined-interpolation guard in
    // expression-resolver.ts (introduced by commit 21cba0dba2). The previous
    // expected value 'undefined' reflected the JS String(undefined) coercion
    // that existed before that guard was added.
    expect(resolveExpression('{{vars.retryCount}}', ctx)).toBe('');
  });

  it('resolves declared vars through context prefix', () => {
    expect(resolveExpression('{{context.vars.retryCount}}', ctx)).toBe('3');
  });

  it('resolves workflow metadata paths', () => {
    expect(resolveExpression('{{workflow.executionId}}', ctx)).toBe('exec-1');
  });

  it('resolves tenant paths', () => {
    expect(resolveExpression('{{tenant.tenantId}}', ctx)).toBe('t1');
  });

  it('resolves trigger metadata paths', () => {
    expect(resolveExpression('{{trigger.metadata.firedAt}}', ctx)).toBe('2026-02-27');
  });

  it('interpolates within strings', () => {
    expect(
      resolveExpression(
        'Order {{trigger.payload.orderId}} from {{steps.fetch-order.output.customer}}',
        ctx,
      ),
    ).toBe('Order ORD-123 from John');
  });

  it('returns empty string for missing paths', () => {
    expect(resolveExpression('{{trigger.payload.missing}}', ctx)).toBe('');
  });

  it('handles nested missing paths', () => {
    expect(resolveExpression('{{steps.nonexistent.output.value}}', ctx)).toBe('');
  });

  it('preserves text without expressions', () => {
    expect(resolveExpression('No expressions here', ctx)).toBe('No expressions here');
  });

  it('handles spaces in expressions', () => {
    expect(resolveExpression('{{ trigger.payload.orderId }}', ctx)).toBe('ORD-123');
  });
});

describe('resolveExpressionTyped', () => {
  it('returns numeric value for single expression', () => {
    expect(resolveExpressionTyped('{{trigger.payload.amount}}', ctx)).toBe(99.5);
  });

  it('returns boolean value for single expression', () => {
    expect(resolveExpressionTyped('{{context.vars.flag}}', ctx)).toBe(true);
  });

  it('returns array value for single expression', () => {
    expect(resolveExpressionTyped('{{trigger.payload.tags}}', ctx)).toEqual(['urgent', 'vip']);
  });

  it('returns object value for single expression', () => {
    expect(resolveExpressionTyped('{{steps.fetch-order.output}}', ctx)).toEqual({
      customer: 'John',
      items: [1, 2],
    });
  });

  it('returns string for mixed text + expression', () => {
    expect(resolveExpressionTyped('Order: {{trigger.payload.orderId}}', ctx)).toBe(
      'Order: ORD-123',
    );
  });

  it('returns undefined for missing single expression', () => {
    expect(resolveExpressionTyped('{{trigger.payload.missing}}', ctx)).toBeUndefined();
  });

  it('returns integer value for single expression', () => {
    expect(resolveExpressionTyped('{{context.vars.retryCount}}', ctx)).toBe(3);
  });
});

describe('explicit steps path resolution', () => {
  it('does not resolve context.start.input shorthand', () => {
    expect(resolveExpressionTyped('{{context.start.input.postId}}', ctx)).toBeUndefined();
  });

  it('resolves context.steps.start.input', () => {
    expect(resolveExpressionTyped('{{context.steps.start.input.postId}}', ctx)).toBe(1);
  });

  it('resolves context.steps.start.output', () => {
    expect(resolveExpressionTyped('{{context.steps.start.output.postId}}', ctx)).toBe(1);
  });

  it('resolves context.steps.<stepName>.output', () => {
    expect(resolveExpressionTyped('{{context.steps.fetch-order.output.customer}}', ctx)).toBe(
      'John',
    );
  });

  it('falls back to vars for unknown segments', () => {
    expect(resolveExpressionTyped('{{context.unknownVar}}', ctx)).toBeUndefined();
  });

  it('resolves step name without context. prefix via steps. prefix', () => {
    expect(resolveExpressionTyped('{{steps.start.input.postId}}', ctx)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// UT-1 — first-class top-level keys: agentSession, agentContext, memory
// ─────────────────────────────────────────────────────────────────────

const agentSession: AgentSessionProjection = Object.freeze({
  sessionId: 'sess-1',
  agentName: 'sales-agent',
  channel: 'web',
  source: 'public',
  endUserId: 'user-42',
  locale: 'en-US',
  startedAt: '2026-04-27T12:00:00Z',
  lastActivityAt: '2026-04-27T12:05:00Z',
});

const agentContext: AgentContextProjection = Object.freeze({
  caller: Object.freeze({ type: 'agent', id: 'sales-agent' }),
  invocation: Object.freeze({
    tool: 'sendQuote',
    args: Object.freeze({ amount: 100 }) as Record<string, unknown>,
  }),
  attachments: Object.freeze([
    Object.freeze({
      id: 'att-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      // Single-pass interpolation regression — UT-7 uses this exact value
      name: '{{memory.project.secret}}',
    }),
  ]) as ReadonlyArray<{
    readonly id: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly name: string;
  }>,
  messageMetadata: Object.freeze({ correlationId: 'corr-1' }) as Record<string, unknown>,
});

const memory: MemoryProjection = {
  workflow: { lastCursor: 'wf-cursor-7', counter: 12 },
  project: { theme: 'dark', secret: 'should-NEVER-resolve-recursively' },
  user: { preferredLanguage: 'en' },
};

const richCtx: WorkflowContextData = {
  ...ctx,
  agentSession,
  agentContext,
  memory,
};

describe('UT-1 — first-class top-level keys', () => {
  it('resolves {{agentSession.channel}} typed when agentSession populated', () => {
    expect(resolveExpressionTyped('{{agentSession.channel}}', richCtx)).toBe('web');
  });

  it('resolves {{agentSession.source}} typed', () => {
    expect(resolveExpressionTyped('{{agentSession.source}}', richCtx)).toBe('public');
  });

  it('resolves {{memory.workflow.lastCursor}} typed', () => {
    expect(resolveExpressionTyped('{{memory.workflow.lastCursor}}', richCtx)).toBe('wf-cursor-7');
  });

  it('resolves {{memory.project.theme}} typed', () => {
    expect(resolveExpressionTyped('{{memory.project.theme}}', richCtx)).toBe('dark');
  });

  it('resolves {{memory.user.preferredLanguage}} typed', () => {
    expect(resolveExpressionTyped('{{memory.user.preferredLanguage}}', richCtx)).toBe('en');
  });

  it('resolves {{agentContext.caller.type}} typed', () => {
    expect(resolveExpressionTyped('{{agentContext.caller.type}}', richCtx)).toBe('agent');
  });

  it('resolves nested numeric {{memory.workflow.counter}}', () => {
    expect(resolveExpressionTyped('{{memory.workflow.counter}}', richCtx)).toBe(12);
  });

  it('returns undefined for {{agentSession.foo}} when agentSession is undefined', () => {
    // Agent-less webhook/cron run — agentSession not populated. Must NOT throw.
    expect(resolveExpressionTyped('{{agentSession.foo}}', ctx)).toBeUndefined();
    expect(resolveExpressionTyped('{{agentContext.caller.id}}', ctx)).toBeUndefined();
  });

  it('returns undefined for {{memory.user.x}} when memory.user is undefined', () => {
    const noUserMemory: WorkflowContextData = {
      ...ctx,
      memory: { workflow: {}, project: {}, user: undefined },
    };
    expect(
      resolveExpressionTyped('{{memory.user.preferredLanguage}}', noUserMemory),
    ).toBeUndefined();
  });

  it('does NOT shadow steps.memory or vars.memory — top-level lookup wins', () => {
    // Even though `memory` is added to KNOWN_TOP_LEVEL_KEYS, a step or var
    // named `memory` would collide. The resolver must prefer the top-level
    // memory projection over `vars.memory`.
    const collide: WorkflowContextData = {
      ...richCtx,
      vars: { ...richCtx.vars, memory: 'should-not-leak' },
    };
    expect(resolveExpressionTyped('{{memory.workflow.lastCursor}}', collide)).toBe('wf-cursor-7');
  });
});

// ─────────────────────────────────────────────────────────────────────
// UT-7 — single-pass interpolation regression
// ─────────────────────────────────────────────────────────────────────

describe('UT-7 — single-pass interpolation (resolved values are inert literals)', () => {
  it('does NOT recursively resolve {{...}} inside resolved string values', () => {
    // agentContext.attachments[0].name === '{{memory.project.secret}}'.
    // The resolver must return the literal string, NOT the resolved secret.
    const result = resolveExpressionTyped('{{agentContext.attachments.0.name}}', richCtx);
    expect(result).toBe('{{memory.project.secret}}');
    expect(result).not.toBe('should-NEVER-resolve-recursively');
  });

  it('does NOT recursively resolve {{...}} when interpolated as a string', () => {
    // String interpolation pathway — `resolveExpression` (not Typed).
    const result = resolveExpression('Name: {{agentContext.attachments.0.name}}', richCtx);
    expect(result).toBe('Name: {{memory.project.secret}}');
    expect(result).not.toContain('should-NEVER-resolve-recursively');
  });

  it('treats memory-loaded values that look like templates as raw literals', () => {
    // Authors might write `{{memory.project.welcomeMsg}}` where the stored
    // value is itself `Hello {{memory.user.name}}`. We must NOT recursively
    // resolve — that would create a path traversal where one memory key can
    // expand into another.
    const recursiveCtx: WorkflowContextData = {
      ...ctx,
      memory: {
        workflow: {},
        project: { welcomeMsg: 'Hello {{memory.user.name}}' },
        user: { name: 'Mallory' },
      },
    };
    expect(resolveExpressionTyped('{{memory.project.welcomeMsg}}', recursiveCtx)).toBe(
      'Hello {{memory.user.name}}',
    );
  });
});

describe('resolveExpressionMap', () => {
  it('resolves all values in a map', () => {
    const result = resolveExpressionMap(
      {
        orderId: '{{trigger.payload.orderId}}',
        customer: '{{steps.fetch-order.output.customer}}',
        tenant: '{{tenant.tenantId}}',
      },
      ctx,
    );

    expect(result).toEqual({
      orderId: 'ORD-123',
      customer: 'John',
      tenant: 't1',
    });
  });

  it('passes through static values', () => {
    const result = resolveExpressionMap(
      { static: 'no-expression', dynamic: '{{context.vars.retryCount}}' },
      ctx,
    );

    expect(result).toEqual({ static: 'no-expression', dynamic: '3' });
  });
});

describe('materializeAgentContext — messageMetadata cap', () => {
  const baseInput = {
    caller: { type: 'agent', id: 'agent-x' },
    invocation: { tool: 'do-thing', args: {} },
    attachments: [],
  };

  it('preserves small messageMetadata (under 16 KiB)', () => {
    const result = materializeAgentContext({
      ...baseInput,
      messageMetadata: { phone: '+1-555-0100', correlationId: 'corr-1' },
    });
    expect(result?.messageMetadata).toEqual({
      phone: '+1-555-0100',
      correlationId: 'corr-1',
    });
  });

  it('drops oversize messageMetadata (>16 KiB) so it does not propagate', () => {
    // 17 KiB of single-key payload — comfortably above the 16 KiB cap.
    const oversize = { huge: 'a'.repeat(17 * 1024) };
    const result = materializeAgentContext({
      ...baseInput,
      messageMetadata: oversize,
    });
    // Caller / invocation are still projected — the run continues, just
    // without messageMetadata. Author code that touched messageMetadata
    // sees `undefined` rather than a partial / corrupted record.
    expect(result).toBeDefined();
    expect(result?.caller).toEqual({ type: 'agent', id: 'agent-x' });
    expect(result?.messageMetadata).toBeUndefined();
  });

  it('drops non-serializable messageMetadata (circular reference)', () => {
    const circular: Record<string, unknown> = { ok: 1 };
    circular.self = circular;
    const result = materializeAgentContext({
      ...baseInput,
      messageMetadata: circular,
    });
    expect(result?.messageMetadata).toBeUndefined();
  });
});
