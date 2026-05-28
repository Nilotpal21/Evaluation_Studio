import { describe, expect, test } from 'vitest';

import { validateCoordinationConfig } from '../platform/ir/validate-coordination-config.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR } from '../platform/ir/schema.js';

function makeAgent(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'coordination_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
  } as AgentIR;
}

describe('validateCoordinationConfig', () => {
  test('accepts runtime-supported timeout formats and handoff actions', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          timeout: '30s',
          on_timeout: 'respond:Please wait while I reconnect you.',
          on_return: { action: 'resume_intent', map: { answer: 'specialist_answer' } },
          remote: {
            location: 'remote',
            endpoint: 'https://example.com/a2a',
            timeout: '5s',
          },
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'always',
          purpose: 'Gather more detail',
          input: { detail: 'session.detail' },
          returns: {},
          use_result: 'delegate_result',
          timeout: '2500ms',
          on_failure: 'continue',
          remote: {
            location: 'remote',
            endpoint: 'https://example.com/helper',
            timeout: '1m',
          },
        },
      ],
    };

    expect(validateCoordinationConfig(agent)).toEqual([]);
  });

  test('accepts quoted timeout literals for compatibility with parser output', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          timeout: '"30s"',
          remote: {
            location: 'remote',
            endpoint: 'https://example.com/a2a',
            timeout: "'5s'",
          },
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'always',
          purpose: 'Gather more detail',
          input: {},
          returns: {},
          use_result: 'delegate_result',
          timeout: '"2500ms"',
          on_failure: 'continue',
        },
      ],
    };

    expect(validateCoordinationConfig(agent)).toEqual([]);
  });

  test('flags invalid timeout syntax across handoffs, delegates, and remote locations', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          timeout: '2h',
          remote: {
            location: 'remote',
            endpoint: 'https://example.com/a2a',
            timeout: 'ten-seconds',
          },
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'always',
          purpose: 'Gather more detail',
          input: {},
          returns: {},
          use_result: 'delegate_result',
          timeout: 'slow',
          on_failure: 'continue',
        },
      ],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_TIMEOUT_SYNTAX,
          path: 'coordination.handoffs[0].timeout',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_TIMEOUT_SYNTAX,
          path: 'coordination.handoffs[0].remote.timeout',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_TIMEOUT_SYNTAX,
          path: 'coordination.delegates[0].timeout',
        }),
      ]),
    );
  });

  test('flags invalid remote endpoints', () => {
    // ABLP-664 made `endpoint` optional for LOCATION: REMOTE — the runtime can
    // resolve it from the External Agent Registry. This test now verifies that
    // when an endpoint *is* explicitly provided but malformed, validation still
    // flags it for both handoffs and delegates.
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          // No endpoint — valid: runtime resolves from External Agent Registry
          remote: {
            location: 'remote',
            endpoint: 'not-a-url',
          },
        },
      ],
      delegates: [
        {
          agent: 'helper_agent',
          when: 'always',
          purpose: 'Gather more detail',
          input: {},
          returns: {},
          use_result: 'delegate_result',
          on_failure: 'continue',
          remote: {
            location: 'remote',
            endpoint: 'not-a-url',
          },
        },
      ],
    };

    const diagnostics = validateCoordinationConfig(agent);

    // Both handoff and delegate report INVALID_REMOTE_AGENT_ENDPOINT when an
    // explicit endpoint is a malformed URL (endpoint is optional, but if present
    // it must be a valid absolute URL).
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_REMOTE_AGENT_ENDPOINT,
          path: 'coordination.handoffs[0].remote.endpoint',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_REMOTE_AGENT_ENDPOINT,
          path: 'coordination.delegates[0].remote.endpoint',
        }),
      ]),
    );
  });

  test('flags unsupported handoff timeout and on_return actions', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          on_timeout: 'retry',
          on_return: { action: 'complete' },
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_HANDOFF_TIMEOUT_ACTION,
          path: 'coordination.handoffs[0].on_timeout',
          severity: 'error',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.UNSUPPORTED_HANDOFF_ON_RETURN_ACTION,
          path: 'coordination.handoffs[0].on_return.action',
          severity: 'warning',
        }),
      ]),
    );
  });

  test('flags unsupported handoff on_failure actions', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          on_failure: 'retry' as 'continue',
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_HANDOFF_FAILURE_ACTION,
          path: 'coordination.handoffs[0].on_failure',
          severity: 'error',
        }),
      ]),
    );
  });

  test('warns when on_return is configured on a permanent handoff', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route permanently' },
          return: false,
          on_return: { action: 'continue', map: { child_value: 'parent_value' } },
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.HANDOFF_ON_RETURN_WITHOUT_RETURN,
          path: 'coordination.handoffs[0].on_return',
          severity: 'warning',
        }),
      ]),
    );
  });

  test('accepts declared named return handlers and legacy shorthand references', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route permanently' },
          return: true,
          on_return: 'await_next_request',
        },
        {
          to: 'fallback_agent',
          when: 'needs_retry',
          context: { pass: [], summary: 'Retry later' },
          return: true,
          on_return: { handler: 'missing_handler', map: { child_value: 'parent_value' } },
        },
      ],
      delegates: [],
      return_handlers: {
        await_next_request: {
          respond: 'Anything else?',
          continue: true,
        },
      },
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.path === 'coordination.handoffs[0].on_return' &&
          diagnostic.code === VALIDATION_CODES.LEGACY_HANDOFF_ON_RETURN_SHORTHAND,
      ),
    ).toBe(false);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.path === 'coordination.handoffs[0].on_return' &&
          diagnostic.code === VALIDATION_CODES.UNKNOWN_HANDOFF_ON_RETURN_HANDLER,
      ),
    ).toBe(false);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.UNKNOWN_HANDOFF_ON_RETURN_HANDLER,
          path: 'coordination.handoffs[1].on_return.handler',
          severity: 'error',
        }),
      ]),
    );
  });

  test('warns for unresolved legacy on_return shorthand without failing compilation', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          on_return: 'route_authenticated_billing',
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.LEGACY_HANDOFF_ON_RETURN_SHORTHAND,
          path: 'coordination.handoffs[0].on_return',
          severity: 'warning',
        }),
      ]),
    );
  });

  test('rejects handler/action ambiguity and built-in handler name collisions', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: { pass: [], summary: 'Route to a specialist' },
          return: true,
          on_return: { action: 'continue', handler: 'await_next_request' },
        },
      ],
      delegates: [],
      return_handlers: {
        continue: {
          respond: 'Anything else?',
          continue: true,
        },
        await_next_request: {
          respond: 'Anything else?',
          resume_intent: true,
        },
      },
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.HANDOFF_ON_RETURN_ACTION_AND_HANDLER,
          path: 'coordination.handoffs[0].on_return',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.RETURN_HANDLER_NAME_COLLISION,
          path: 'coordination.return_handlers.continue',
        }),
        expect.objectContaining({
          code: VALIDATION_CODES.HANDOFF_ON_RETURN_ACTION_AND_HANDLER,
          path: 'coordination.return_handlers.await_next_request',
        }),
      ]),
    );
  });

  test('accepts readwrite execution_tree memory grants and rejects undeclared grants', () => {
    const agent = makeAgent();
    agent.memory = {
      session: [],
      persistent: [
        {
          path: 'workflow.auth_token',
          scope: 'execution_tree',
          access: 'readwrite',
        },
      ],
      remember: [],
      recall: [],
    };
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: {
            pass: [],
            summary: 'Route to a specialist',
            memory_grants: [
              { path: 'workflow.auth_token', access: 'readwrite' },
              { path: 'missing.preference', access: 'read' },
            ],
          },
          return: false,
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT,
          path: 'coordination.handoffs[0].context.memory_grants[1].path',
          severity: 'error',
        }),
      ]),
    );
    expect(
      diagnostics.find(
        (diagnostic) =>
          diagnostic.code === VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT_ACCESS &&
          diagnostic.path === 'coordination.handoffs[0].context.memory_grants[0].access',
      ),
    ).toBeUndefined();
  });

  test('rejects readwrite handoff grants for non execution_tree memory', () => {
    const agent = makeAgent();
    agent.memory = {
      session: [],
      persistent: [
        {
          path: 'user.preference',
          scope: 'user',
          access: 'readwrite',
        },
      ],
      remember: [],
      recall: [],
    };
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: {
            pass: [],
            summary: 'Route to a specialist',
            memory_grants: [{ path: 'user.preference', access: 'readwrite' }],
          },
          return: false,
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_HANDOFF_MEMORY_GRANT_ACCESS,
          path: 'coordination.handoffs[0].context.memory_grants[0].access',
          severity: 'error',
        }),
      ]),
    );
  });

  test('warns when summary_only is configured without CONTEXT.summary', () => {
    const agent = makeAgent();
    agent.coordination = {
      handoffs: [
        {
          to: 'specialist_agent',
          when: 'always',
          context: {
            pass: [],
            summary: '',
            history: 'summary_only',
          },
          return: false,
        },
      ],
      delegates: [],
    };

    const diagnostics = validateCoordinationConfig(agent);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.HANDOFF_SUMMARY_ONLY_WITHOUT_SUMMARY,
          path: 'coordination.handoffs[0].context.history',
          severity: 'warning',
        }),
      ]),
    );
  });
});
