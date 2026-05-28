import { describe, expect, it } from 'vitest';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import type { RuntimeSession } from '../types.js';
import {
  emitProtectedAssistantMessage,
  emitProtectedExecutionResult,
  protectExecutionResultForUser,
  protectStructuredOutputForUser,
  protectSessionOutputForUser,
  shouldRedactRawOutputPII,
} from '../session-output-protection.js';

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function createResolvedPIIConfig(
  overrides: Partial<NonNullable<RuntimeSession['piiRedactionConfig']>> = {},
): NonNullable<RuntimeSession['piiRedactionConfig']> {
  return {
    enabled: true,
    redactInput: true,
    redactOutput: true,
    tier: 'basic',
    latencyBudgetMs: 200,
    confidenceThreshold: 0.5,
    enabledRecognizerPacks: ['core'],
    ...overrides,
  };
}

function createSessionWithCustomContractPII(
  overrides: Partial<RuntimeSession> = {},
): Pick<
  RuntimeSession,
  | 'id'
  | 'tenantId'
  | 'projectId'
  | 'piiRedactionConfig'
  | 'piiVault'
  | 'piiPatternConfigs'
  | 'piiRecognizerRegistry'
> {
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

  return {
    id: 'session-output-protection',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    piiRedactionConfig: createResolvedPIIConfig(),
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
  };
}

describe('session-output-protection', () => {
  it('redacts delivery while tokenizing history for vault-backed custom patterns', () => {
    const session = createSessionWithCustomContractPII();

    const result = protectSessionOutputForUser(session, `Contract ${rawContractId}`);

    expect(result.deliveryText).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.deliveryText).not.toContain(rawContractId);
    expect(result.historyText).toContain('{{PII:ContractID:');
    expect(result.historyText).not.toContain(rawContractId);
  });

  it('renders existing PII tokens for the user even when raw output redaction is disabled', () => {
    const session = createSessionWithCustomContractPII({
      piiRedactionConfig: createResolvedPIIConfig({ redactOutput: false }),
    });
    const tokenized = session.piiVault!.tokenize(`Contract ${rawContractId}`).text;

    const result = protectSessionOutputForUser(session, tokenized);

    expect(result.deliveryText).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.deliveryText).not.toContain(rawContractId);
    expect(result.historyText).toContain('{{PII:ContractID:');
  });

  it('falls back to raw-text filtering when no vault is available', () => {
    const session = createSessionWithCustomContractPII({
      piiVault: undefined,
    });

    const result = protectSessionOutputForUser(session, `Contract ${rawContractId}`);

    expect(result.deliveryText).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.deliveryText).not.toContain(rawContractId);
    expect(result.historyText).toContain('[REDACTED_CONTRACT_ID]');
  });

  it('redacts structured payloads for delivery while preserving tokenized history text', () => {
    const session = createSessionWithCustomContractPII();

    const result = protectStructuredOutputForUser(session, {
      richContent: {
        markdown: `Contract ${rawContractId}`,
        form: {
          title: `Review ${rawContractId}`,
          fields: [
            {
              id: 'contract-id',
              type: 'input',
              label: `Contract ${rawContractId}`,
              placeholder: `Enter ${rawContractId}`,
            },
          ],
          submit_label: `Approve ${rawContractId}`,
        },
      },
      voiceConfig: {
        plain_text: `Say ${rawContractId}`,
        provider: 'elevenlabs',
        voice_id: 'aria',
      },
      actions: {
        elements: [
          {
            id: 'approve-contract',
            type: 'button',
            label: `Approve ${rawContractId}`,
            value: rawContractId,
          },
        ],
        submit_label: `Submit ${rawContractId}`,
        submit_id: 'submit-contract',
        renderId: 'render-contract',
      },
    });

    expect(result.delivery.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.delivery.richContent?.markdown).not.toContain(rawContractId);
    expect(result.history.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(result.history.richContent?.markdown).not.toContain(rawContractId);

    expect(result.delivery.richContent?.form?.title).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.delivery.richContent?.form?.fields[0].label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.delivery.richContent?.form?.fields[0].placeholder).toContain(
      '[REDACTED_CONTRACT_ID]',
    );
    expect(result.history.richContent?.form?.submit_label).toContain('{{PII:ContractID:');

    expect(result.delivery.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.delivery.voiceConfig?.provider).toBe('elevenlabs');
    expect(result.delivery.voiceConfig?.voice_id).toBe('aria');
    expect(result.history.voiceConfig?.plain_text).toContain('{{PII:ContractID:');

    expect(result.delivery.actions?.elements[0].label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.history.actions?.elements[0].label).toContain('{{PII:ContractID:');
    expect(result.delivery.actions?.elements[0].value).toBe(rawContractId);
    expect(result.delivery.actions?.submit_id).toBe('submit-contract');
    expect(result.delivery.actions?.renderId).toBe('render-contract');
  });

  it('protects execution result delivery text and structured payloads while tokenizing history', () => {
    const session = createSessionWithCustomContractPII();

    const result = protectExecutionResultForUser(session, {
      response: `Contract ${rawContractId}`,
      action: { type: 'complete', message: `Contract ${rawContractId}` },
      richContent: {
        markdown: `Contract ${rawContractId}`,
      },
      voiceConfig: {
        plain_text: `Say ${rawContractId}`,
        provider: 'elevenlabs',
        voice_id: 'aria',
      },
    });

    expect(result.result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.response).not.toContain(rawContractId);
    expect(result.historyText).toContain('{{PII:ContractID:');
    expect(result.historyText).not.toContain(rawContractId);
    expect(result.result.action.message).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.action.message).not.toContain(rawContractId);
    expect(result.result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.voiceConfig?.provider).toBe('elevenlabs');
  });

  it('emits structured-only execution results into assistant history with a tokenized content envelope', () => {
    const session = {
      ...createSessionWithCustomContractPII(),
      conversationHistory: [],
    };
    const chunks: string[] = [];

    const result = emitProtectedExecutionResult(
      session,
      {
        response: '',
        action: { type: 'respond', message: '' },
        richContent: {
          markdown: `Contract ${rawContractId}`,
        },
        voiceConfig: {
          plain_text: `Say ${rawContractId}`,
          provider: 'elevenlabs',
          voice_id: 'aria',
        },
        actions: {
          elements: [
            {
              id: 'approve-contract',
              type: 'button',
              label: `Approve ${rawContractId}`,
              value: rawContractId,
            },
          ],
        },
      },
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual([]);
    expect(result.result.response).toBe('');
    expect(result.result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.richContent?.markdown).not.toContain(rawContractId);
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0]).toMatchObject({
      role: 'assistant',
      content: '',
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        text: '',
        richContent: {
          markdown: expect.stringContaining('{{PII:ContractID:'),
        },
        voiceConfig: {
          plain_text: expect.stringContaining('{{PII:ContractID:'),
          provider: 'elevenlabs',
          voice_id: 'aria',
        },
        actions: {
          elements: [
            {
              label: expect.stringContaining('{{PII:ContractID:'),
              value: rawContractId,
            },
          ],
        },
      },
    });
  });

  it('emits protected assistant messages to custom history targets', () => {
    const session = createSessionWithCustomContractPII();
    const chunks: string[] = [];
    const historyTarget: Array<{ role: string; content: string }> = [];

    const result = emitProtectedAssistantMessage(session, `Contract ${rawContractId}`, {
      onChunk: (chunk) => chunks.push(chunk),
      historyTarget,
      historyTextFormatter: (historyText) => `[RemoteAgent]: ${historyText}`,
    });

    expect(result.deliveryText).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.deliveryText).not.toContain(rawContractId);
    expect(chunks).toEqual([expect.stringContaining('[REDACTED_CONTRACT_ID]')]);
    expect(historyTarget).toEqual([
      {
        role: 'assistant',
        content: expect.stringContaining('[RemoteAgent]: Contract {{PII:ContractID:'),
      },
    ]);
    expect(historyTarget[0].content).not.toContain(rawContractId);
  });

  it('reports whether raw output redaction is active', () => {
    expect(shouldRedactRawOutputPII(createSessionWithCustomContractPII())).toBe(true);
    expect(
      shouldRedactRawOutputPII(
        createSessionWithCustomContractPII({
          piiRedactionConfig: createResolvedPIIConfig({ redactOutput: false }),
        }),
      ),
    ).toBe(false);
  });
});
