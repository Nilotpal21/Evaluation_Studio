/**
 * ON_ERROR RESPOND Streaming — Slice 1 lock test (ABLP-412)
 *
 * Bruce feedback item 2.1: `RESPOND` in `ON_ERROR` reaches the user in reasoning
 * mode but NOT in flow mode. `executeToolWithErrorHandling` never received an
 * `onChunk` param, so the handler's respond text was stored in metadata and
 * dropped at the boundary.
 *
 * Contract:
 *   - Flow-mode step with a failing tool call + matching `then: continue`
 *     ON_ERROR handler emits trace events but does not stream `respond` into
 *     user-visible assistant text.
 *   - `error_handler_response` trace event still captures the handler copy.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ErrorHandlingConfig } from '@abl/compiler/platform/ir/schema.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../services/execution/localized-messages.js';

const FLOW_AGENT = `
AGENT: Flow_Error_Agent

GOAL: "Call a tool that fails and surface ON_ERROR respond"

TOOLS:
  flaky_tool() -> object
    description: "A tool that may fail"

FLOW:
  start -> call_flaky -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: call_flaky

  call_flaky:
    CALL: flaky_tool()
      AS: result
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

const LOCALIZED_FLOW_AGENT = `
AGENT: Flow_Error_Agent

GOAL: "Call a tool that fails and surface localized default error copy"

MESSAGES:
  error_default: "Mensaje de error predeterminado del agente."

TOOLS:
  flaky_tool() -> object
    description: "A tool that may fail"

FLOW:
  start -> call_flaky -> done

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: call_flaky

  call_flaky:
    CALL: flaky_tool()
      AS: result
    THEN: done

  done:
    REASONING: false
    RESPOND: "Complete"
    THEN: COMPLETE
`;

const TERMINAL_FLOW_AGENT = `
AGENT: Flow_Error_Terminal_Agent

GOAL: "Fail a tool call and stop on the ON_ERROR response"

TOOLS:
  flaky_tool() -> object
    description: "A tool that may fail"

FLOW:
  start -> call_flaky

  start:
    REASONING: false
    RESPOND: "Starting"
    THEN: call_flaky

  call_flaky:
    REASONING: false
    CALL: flaky_tool()
      AS: result
`;

describe('ON_ERROR continue handlers stay out of user-visible tool error text', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('matching ON_ERROR continue handler respond is traced but not streamed', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_AGENT], 'Flow_Error_Agent'),
    );

    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool upstream 503 Service Unavailable');
      },
    } as any;

    const errorHandling: ErrorHandlingConfig = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'The upstream service is slow — please give me a moment.',
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'continue', respond: 'Something went wrong.' },
    };
    session.agentIR!.error_handling = errorHandling;

    const chunks: string[] = [];
    const tc = createTraceCollector();
    await executor.initializeSession(session.id, (c) => chunks.push(c), tc.callback);

    const output = chunks.join('');
    expect(output).toContain('Starting');
    expect(output).toContain('Complete');
    expect(output).not.toContain('The upstream service is slow');

    const responseTraces = filterTraces(tc.traces, 'error_handler_response');
    expect(responseTraces.length).toBeGreaterThanOrEqual(1);
    expect(responseTraces[0].data.respond).toBe(
      'The upstream service is slow — please give me a moment.',
    );
  });

  test('no onChunk provided → no crash, respond still captured in trace', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_AGENT], 'Flow_Error_Agent'),
    );

    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool 503 Service Unavailable');
      },
    } as any;

    session.agentIR!.error_handling = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'Silent-mode respond.',
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'continue' },
    };

    const tc = createTraceCollector();
    // Pass undefined for onChunk — must not throw.
    await expect(
      executor.initializeSession(session.id, undefined, tc.callback),
    ).resolves.not.toThrow();

    const responseTraces = filterTraces(tc.traces, 'error_handler_response');
    expect(responseTraces.length).toBeGreaterThanOrEqual(1);
  });

  test('compiler default error message is localized from locale assets before streaming', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([LOCALIZED_FLOW_AGENT], 'Flow_Error_Agent'),
    );
    session.data.values._locale = 'es-MX';
    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:es/flow_error_agent.json': JSON.stringify({
          error_default: 'Mensaje de error traducido desde Studio.',
        }),
      }),
    );
    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool upstream 503 Service Unavailable');
      },
    } as any;

    const chunks: string[] = [];
    const tc = createTraceCollector();
    await executor.initializeSession(session.id, (chunk) => chunks.push(chunk), tc.callback);

    expect(chunks.join('')).not.toContain('Mensaje de error traducido desde Studio.');
    expect(chunks.join('')).not.toContain('An error occurred. Please try again.');

    const responseTraces = filterTraces(tc.traces, 'error_handler_response');
    expect(
      responseTraces.some(
        (trace) => trace.data.respond === 'Mensaje de error traducido desde Studio.',
      ),
    ).toBe(true);
  });

  test('flow-mode ON_ERROR continue does not expose rich content payloads', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_AGENT], 'Flow_Error_Agent'),
    );

    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool upstream 503 Service Unavailable');
      },
    } as any;

    session.agentIR!.error_handling = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'The upstream service is slow — please give me a moment.',
          rich_content: {
            markdown: '### Retry options\n- Wait a moment\n- Try another account',
          },
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'continue' },
    };

    await executor.initializeSession(session.id);

    expect(session.pendingRichContent).toBeUndefined();
  });

  test('flow-mode ON_ERROR preserves voice config and actions across auto-advance', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([FLOW_AGENT], 'Flow_Error_Agent'),
    );

    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool upstream 503 Service Unavailable');
      },
    } as any;

    session.agentIR!.flow!.definitions.done.voice_config = {
      plain_text: 'Complete',
    };
    session.agentIR!.flow!.definitions.done.rich_content = undefined;
    session.agentIR!.flow!.definitions.done.actions = undefined;

    session.agentIR!.error_handling = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'The upstream service is slow — please give me a moment.',
          rich_content: {
            markdown: '### Retry options\n- Wait a moment\n- Try another account',
          },
          voice_config: {
            plain_text: 'The upstream service is slow — please give me a moment.',
          },
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
          },
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'continue' },
    };

    const result = await executor.initializeSession(session.id);

    expect(result?.response).toBe('Complete');
    expect(result?.richContent).toBeUndefined();
    expect(result?.voiceConfig).toEqual({
      plain_text: 'Complete',
    });
    expect(result?.actions).toBeUndefined();
  });

  test('flow-mode ON_ERROR continue does not become the terminal response', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([TERMINAL_FLOW_AGENT], 'Flow_Error_Terminal_Agent'),
    );

    session.toolExecutor = {
      execute: async () => {
        throw new Error('flaky_tool upstream 503 Service Unavailable');
      },
    } as any;

    session.agentIR!.error_handling = {
      handlers: [
        {
          type: 'tool_error',
          then: 'continue',
          respond: 'The upstream service is slow — please give me a moment.',
          rich_content: {
            markdown: '### Retry options\n- Wait a moment\n- Try another account',
          },
          voice_config: {
            plain_text: 'The upstream service is slow — please give me a moment.',
          },
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
          },
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'continue' },
    };

    const result = await executor.initializeSession(session.id);

    expect(result?.response ?? '').not.toContain('The upstream service is slow');
    expect(result?.richContent).toBeUndefined();
    expect(result?.voiceConfig).toBeUndefined();
    expect(result?.actions).toBeUndefined();
  });
});
