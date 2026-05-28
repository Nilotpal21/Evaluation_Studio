/**
 * Hook Executor Integration Tests
 *
 * Tests the HookExecutor module with DI-injected session doubles.
 * Verifies CALL, SET, RESPOND actions and critical/non-critical error behavior.
 *
 * INT-5: HookExecutor → ToolBindingExecutor CALL action
 * INT-6: HookExecutor with critical:true tool failure → error propagation
 */

import { describe, it, expect, vi } from 'vitest';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import { executeHook } from '../services/execution/hook-executor.js';
import type { HooksConfig } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../services/execution/types.js';

// =============================================================================
// TEST DOUBLES
// =============================================================================

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-hooks',
    agentName: 'test-agent',
    conversationHistory: [],
    data: { values: {}, gatheredKeys: new Set<string>() },
    initialized: true,
    isComplete: false,
    isEscalated: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    handoffStack: [],
    decisionLog: [],
    agentIR: null,
    ...overrides,
  } as unknown as RuntimeSession;
}

function createMockToolExecutor(
  behavior: 'success' | 'error' = 'success',
): RuntimeSession['toolExecutor'] {
  return {
    execute: vi.fn().mockImplementation(async (toolName: string) => {
      if (behavior === 'error') {
        throw new Error(`Tool ${toolName} execution failed`);
      }
      return { result: `${toolName} executed successfully` };
    }),
  } as unknown as RuntimeSession['toolExecutor'];
}

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function createSessionWithCustomContractPII(overrides?: Partial<RuntimeSession>): RuntimeSession {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['ContractID'],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      'ContractID',
      undefined,
      'custom',
    ),
  );

  return createMockSession({
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
    piiRecognizerRegistry: registry,
    piiVault: new PIIVault({ recognizerRegistry: registry }),
    piiPatternConfigs: [
      {
        patternName: 'ContractID',
        defaultRenderMode: 'redacted',
        consumerAccess: [],
      },
    ],
    ...overrides,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('HookExecutor', () => {
  describe('CALL action', () => {
    it('INT-5: executes tool via session toolExecutor', async () => {
      const toolExecutor = createMockToolExecutor();
      const session = createMockSession({ toolExecutor });

      const hooks: HooksConfig = {
        before_turn: { call: 'audit_logger' },
      };

      const result = await executeHook('before_turn', hooks, session);

      expect(result.executed).toBe(true);
      expect(result.actionsExecuted).toContain('call:audit_logger');
      expect(toolExecutor!.execute).toHaveBeenCalledWith('audit_logger', {}, 10_000);
    });

    it('skips CALL when toolExecutor is not available', async () => {
      const session = createMockSession({ toolExecutor: undefined });

      const hooks: HooksConfig = {
        before_turn: { call: 'my_tool' },
      };

      const result = await executeHook('before_turn', hooks, session);

      expect(result.executed).toBe(true);
      expect(result.actionsExecuted).toEqual([]);
    });
  });

  describe('SET action', () => {
    it('sets values on session data store', async () => {
      const session = createMockSession();

      const hooks: HooksConfig = {
        before_turn: { set: { turn_logged: 'true', audit_status: 'active' } },
      };

      const result = await executeHook('before_turn', hooks, session);

      expect(result.executed).toBe(true);
      expect(session.data.values.turn_logged).toBe('true');
      expect(session.data.values.audit_status).toBe('active');
      expect(result.actionsExecuted).toContain('set:turn_logged,audit_status');
    });
  });

  describe('RESPOND action', () => {
    it('pushes message to conversation history and calls onChunk', async () => {
      const session = createMockSession();
      const chunks: string[] = [];
      const onChunk = (chunk: string) => chunks.push(chunk);

      const hooks: HooksConfig = {
        after_turn: { respond: 'Turn complete.' },
      };

      const result = await executeHook('after_turn', hooks, session, onChunk);

      expect(result.executed).toBe(true);
      expect(result.actionsExecuted).toContain('respond');
      expect(session.conversationHistory).toContainEqual({
        role: 'assistant',
        content: 'Turn complete.',
      });
      expect(chunks).toContain('Turn complete.');
    });

    it('redacts custom-pattern PII for hook respond delivery while tokenizing history', async () => {
      const session = createSessionWithCustomContractPII();
      const chunks: string[] = [];

      const hooks: HooksConfig = {
        after_turn: { respond: `Contract ${rawContractId}` },
      };

      await executeHook('after_turn', hooks, session, (chunk) => chunks.push(chunk));

      expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
      expect(chunks.join('')).not.toContain(rawContractId);
      expect(String(session.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
      expect(String(session.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
    });

    it('preserves structured hook payloads in runtime history while returning delivery-safe payloads', async () => {
      const session = createSessionWithCustomContractPII();
      const chunks: string[] = [];

      const hooks: HooksConfig = {
        after_turn: {
          respond: `Contract ${rawContractId}`,
          rich_content: {
            markdown: `### Review contract ${rawContractId}`,
          } as HooksConfig['after_turn']['rich_content'],
          voice_config: {
            plain_text: `Review contract ${rawContractId}`,
          } as HooksConfig['after_turn']['voice_config'],
          actions: {
            elements: [
              {
                id: 'approve-contract',
                type: 'button',
                label: `Approve ${rawContractId}`,
                value: rawContractId,
              },
            ],
          } as HooksConfig['after_turn']['actions'],
        },
      };

      const result = await executeHook('after_turn', hooks, session, (chunk) => chunks.push(chunk));
      const emittedMessage = (
        result as {
          emittedMessage?: {
            response: string;
            richContent?: { markdown?: string };
            voiceConfig?: { plain_text?: string };
            actions?: { elements?: Array<{ label?: string; value?: string }> };
          };
        }
      ).emittedMessage;
      const persistedAssistantMessage = session.conversationHistory.at(-1) as
        | {
            content?: unknown;
            contentEnvelope?: {
              richContent?: { markdown?: string };
              voiceConfig?: { plain_text?: string };
              actions?: { elements?: Array<{ label?: string; value?: string }> };
            };
          }
        | undefined;

      expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
      expect(chunks.join('')).not.toContain(rawContractId);
      expect(emittedMessage?.response).toContain('[REDACTED_CONTRACT_ID]');
      expect(emittedMessage?.response).not.toContain(rawContractId);
      expect(emittedMessage?.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
      expect(emittedMessage?.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
      expect(emittedMessage?.actions?.elements?.[0].label).toContain('[REDACTED_CONTRACT_ID]');
      expect(emittedMessage?.actions?.elements?.[0].value).toBe(rawContractId);

      expect(String(persistedAssistantMessage?.content)).toContain('{{PII:ContractID:');
      expect(persistedAssistantMessage?.contentEnvelope?.richContent?.markdown).toContain(
        '{{PII:ContractID:',
      );
      expect(persistedAssistantMessage?.contentEnvelope?.voiceConfig?.plain_text).toContain(
        '{{PII:ContractID:',
      );
      expect(persistedAssistantMessage?.contentEnvelope?.actions?.elements?.[0].label).toContain(
        '{{PII:ContractID:',
      );
      expect(persistedAssistantMessage?.contentEnvelope?.actions?.elements?.[0].value).toBe(
        rawContractId,
      );
    });
  });

  describe('combined actions', () => {
    it('executes CALL, SET, and RESPOND in sequence', async () => {
      const toolExecutor = createMockToolExecutor();
      const session = createMockSession({ toolExecutor });
      const chunks: string[] = [];

      const hooks: HooksConfig = {
        before_turn: {
          call: 'audit_logger',
          set: { logged: 'true' },
          respond: 'Audit complete.',
        },
      };

      const result = await executeHook('before_turn', hooks, session, (c) => chunks.push(c));

      expect(result.executed).toBe(true);
      expect(result.actionsExecuted).toEqual(['call:audit_logger', 'set:logged', 'respond']);
      expect(session.data.values.logged).toBe('true');
      expect(chunks).toContain('Audit complete.');
    });
  });

  describe('critical vs non-critical error handling', () => {
    it('INT-6: critical hook failure throws error', async () => {
      const toolExecutor = createMockToolExecutor('error');
      const session = createMockSession({ toolExecutor });

      const hooks: HooksConfig = {
        before_turn: { call: 'failing_tool', critical: true },
      };

      await expect(executeHook('before_turn', hooks, session)).rejects.toThrow(
        'Tool failing_tool execution failed',
      );
    });

    it('non-critical hook failure returns error without throwing', async () => {
      const toolExecutor = createMockToolExecutor('error');
      const session = createMockSession({ toolExecutor });

      const hooks: HooksConfig = {
        before_turn: { call: 'failing_tool' },
      };

      const result = await executeHook('before_turn', hooks, session);

      expect(result.executed).toBe(true);
      expect(result.error).toContain('Tool failing_tool execution failed');
    });
  });

  describe('IR-gating', () => {
    it('returns no-op when hooks config is undefined', async () => {
      const session = createMockSession();

      const result = await executeHook('before_turn', undefined, session);

      expect(result.executed).toBe(false);
      expect(result.durationMs).toBe(0);
    });

    it('returns no-op when specific hook type is not defined', async () => {
      const session = createMockSession();

      const hooks: HooksConfig = {
        before_agent: { respond: 'Hello' },
        // before_turn is NOT defined
      };

      const result = await executeHook('before_turn', hooks, session);

      expect(result.executed).toBe(false);
    });
  });

  describe('trace events', () => {
    it('emits hook_executed trace event on success', async () => {
      const session = createMockSession();
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

      const hooks: HooksConfig = {
        after_agent: { set: { cleanup: 'done' } },
      };

      await executeHook('after_agent', hooks, session, undefined, (event) =>
        traceEvents.push(event),
      );

      const hookEvent = traceEvents.find((e) => e.type === 'hook_executed');
      expect(hookEvent).toBeDefined();
      expect(hookEvent?.data.hookType).toBe('after_agent');
      expect(hookEvent?.data.success).toBe(true);
      expect(hookEvent?.data.actionsExecuted).toContain('set:cleanup');
    });

    it('emits hook_executed trace event with error on failure', async () => {
      const toolExecutor = createMockToolExecutor('error');
      const session = createMockSession({ toolExecutor });
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

      const hooks: HooksConfig = {
        before_turn: { call: 'broken_tool' },
      };

      await executeHook('before_turn', hooks, session, undefined, (event) =>
        traceEvents.push(event),
      );

      const hookEvent = traceEvents.find((e) => e.type === 'hook_executed');
      expect(hookEvent).toBeDefined();
      expect(hookEvent?.data.success).toBe(false);
      expect(hookEvent?.data.error).toBeTruthy();
    });
  });
});
