import { describe, expect, it } from 'vitest';
import {
  PIIVault,
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform';
import {
  renderSessionMessagesForUserSurface,
  renderTraceEventsForReadSurface,
} from '../../services/pii/runtime-pii-boundary-service.js';

describe('runtime pii boundary service', () => {
  function createContractPIIContext(
    defaultRenderMode: 'redacted' | 'masked' | 'original' | 'random',
    consumerAccess: Array<{
      consumer: string;
      renderMode: 'redacted' | 'masked' | 'original' | 'random';
    }> = [],
  ) {
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
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiVault: new PIIVault({
        recognizerRegistry: registry,
        randomReplacementGenerator: () => '82e5e7bb-c111-4999-a999-4d9048f40b67',
      }),
      piiPatternConfigs: [
        {
          patternName: 'ContractID',
          defaultRenderMode,
          consumerAccess,
          maskConfig: { showFirst: 5, showLast: 6, maskChar: '*' },
          randomConfig: { charset: 'alphanumeric', length: 36 },
        },
      ],
    };
  }

  function createBuiltInPIIContext(options: { disablePhone?: boolean } = {}) {
    const registry = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(registry);
    if (options.disablePhone) {
      registry.disableType('phone');
    }

    return {
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiVault: new PIIVault({ recognizerRegistry: registry }),
      piiPatternConfigs: options.disablePhone
        ? [
            {
              patternName: 'phone',
              defaultRenderMode: 'redacted' as const,
              consumerAccess: [],
            },
          ]
        : [],
    };
  }

  it('scrubs message content and structured message fields for client surfaces', () => {
    const [message] = renderSessionMessagesForUserSurface([
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'Email jane.doe@example.com and card 4111 1111 1111 1111',
        rawContent: {
          email: 'jane.doe@example.com',
          card: '4111 1111 1111 1111',
        },
        contentEnvelope: {
          blocks: [{ type: 'text', text: 'jane.doe@example.com' }],
        },
        metadata: {
          authorization: 'Bearer secret-token',
        },
      },
    ]);

    expect(message.content).toContain('[REDACTED_EMAIL]');
    expect(message.content).toContain('[REDACTED_CARD]');
    expect(JSON.stringify(message)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(message)).not.toContain('4111 1111 1111 1111');
    expect(JSON.stringify(message)).not.toContain('secret-token');
  });

  it('renders custom-pattern raw values through the session read boundary', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'user',
          content: `Contract ${rawContractId}`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createContractPIIContext('redacted'),
    );

    expect(message.content).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(message)).not.toContain(rawContractId);
  });

  it('renders custom-pattern values inside structured envelopes on session read surfaces', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Summary ready',
          contentEnvelope: {
            version: 2,
            format: 'abl.message.v2',
            text: `Contract ${rawContractId}`,
            richContent: {
              markdown: `Contract ${rawContractId}`,
            },
            voiceConfig: {
              plain_text: `Contract ${rawContractId}`,
            },
            actions: {
              elements: [
                {
                  label: `Open ${rawContractId}`,
                  value: `open-${rawContractId}`,
                },
              ],
            },
          },
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createContractPIIContext('redacted'),
    );

    const serializedMessage = JSON.stringify(message);
    expect(message.contentEnvelope).toMatchObject({
      text: 'Contract [REDACTED_CONTRACT_ID]',
      richContent: {
        markdown: 'Contract [REDACTED_CONTRACT_ID]',
      },
      voiceConfig: {
        plain_text: 'Contract [REDACTED_CONTRACT_ID]',
      },
      actions: {
        elements: [
          {
            label: 'Open [REDACTED_CONTRACT_ID]',
            value: 'open-[REDACTED_CONTRACT_ID]',
          },
        ],
      },
    });
    expect(serializedMessage).not.toContain(rawContractId);
  });

  it('renders built-in raw values through the same session read boundary', () => {
    const rawEmail = 'jane.doe@example.com';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'user',
          content: `Email ${rawEmail}`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createBuiltInPIIContext(),
    );

    expect(message.content).toBe('Email [REDACTED_EMAIL]');
    expect(JSON.stringify(message)).not.toContain(rawEmail);
  });

  it('honors disabled built-in recognizers when project PII context is available', () => {
    const rawPhone = '555-123-4567';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'user',
          content: `Call ${rawPhone}`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createBuiltInPIIContext({ disablePhone: true }),
    );

    expect(message.content).toBe(`Call ${rawPhone}`);
  });

  it('does not honor original rendering on normal session read surfaces', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'user',
          content: `Contract ${rawContractId}`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createContractPIIContext('original'),
    );

    expect(message.content).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(message)).not.toContain(rawContractId);
  });

  it('masks custom-pattern values on normal session read surfaces when configured', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'user',
          content: `Contract ${rawContractId}`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createContractPIIContext('masked'),
    );

    expect(message.content).toMatch(/^Contract 780b4\*+12905b$/);
    expect(JSON.stringify(message)).not.toContain(rawContractId);
  });

  it('renders session reads from the original token when user masking overrides a random default', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [message] = renderSessionMessagesForUserSurface(
      [
        {
          id: 'msg-1',
          role: 'assistant',
          content: `No contract record was found with the ID ${rawContractId}.`,
          timestamp: '2026-04-27T00:00:00.000Z',
        },
      ],
      createContractPIIContext('random', [{ consumer: 'user', renderMode: 'masked' }]),
    );

    expect(message.content).toBe(
      'No contract record was found with the ID 780b4*************************12905b.',
    );
    expect(message.content).not.toContain('82e5e7');
    expect(JSON.stringify(message)).not.toContain(rawContractId);
  });

  it('scrubs trace event data for read surfaces', () => {
    const [event] = renderTraceEventsForReadSurface([
      {
        id: 'trace-1',
        data: {
          response: 'Email jane.doe@example.com',
          requestHeaders: {
            authorization: 'Bearer secret-token',
          },
        },
      },
    ]);

    expect(JSON.stringify(event.data)).toContain('[REDACTED_EMAIL]');
    expect(JSON.stringify(event.data)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(event.data)).not.toContain('secret-token');
  });

  it('renders custom-pattern trace payloads through the same read boundary', () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const [event] = renderTraceEventsForReadSurface(
      [
        {
          id: 'trace-1',
          data: {
            response: `Contract ${rawContractId}`,
          },
        },
      ],
      createContractPIIContext('redacted'),
    );

    expect(JSON.stringify(event.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(event.data)).not.toContain(rawContractId);
  });

  it('honors disabled built-in recognizers on trace read surfaces', () => {
    const rawPhone = '555-123-4567';
    const [event] = renderTraceEventsForReadSurface(
      [
        {
          id: 'trace-1',
          data: {
            response: `Call ${rawPhone}`,
          },
        },
      ],
      createBuiltInPIIContext({ disablePhone: true }),
    );

    expect(JSON.stringify(event.data)).toContain(rawPhone);
    expect(JSON.stringify(event.data)).not.toContain('[REDACTED_PHONE]');
  });
});
