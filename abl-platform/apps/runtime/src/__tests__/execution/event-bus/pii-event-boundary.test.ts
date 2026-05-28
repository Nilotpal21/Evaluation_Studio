import { describe, expect, it } from 'vitest';
import {
  PIIRecognizerRegistry,
  PIIVault,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  type PIIPatternConfig,
} from '@abl/compiler/platform/security/index.js';
import { renderPayloadForPipelineEvent } from '../../../services/event-bus/pii-event-boundary.js';

function makeContext(patternConfigs: PIIPatternConfig[] = []) {
  const registry = new PIIRecognizerRegistry();
  registerBuiltInRecognizers(registry);
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['custom_contract_id'],
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi,
      'custom_contract_id',
      undefined,
      'custom',
    ),
  );

  return {
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
    piiVault: new PIIVault({ recognizerRegistry: registry }),
    piiPatternConfigs: patternConfigs,
  };
}

describe('EventBus PII boundary', () => {
  it('tokenizes raw user message content before pipeline publication', () => {
    const rawId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';

    const payload = renderPayloadForPipelineEvent(
      { messageId: 'msg-1', content: `contract ${rawId}`, messageIndex: 0 },
      makeContext(),
      'user',
    );

    expect(payload.content).toMatch(/\{\{PII:custom_contract_id:[a-f0-9-]+\}\}/);
    expect(payload.content).not.toContain(rawId);
  });

  it('forces tokenized pipeline events even when a custom pattern default is random', () => {
    const rawId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';

    const payload = renderPayloadForPipelineEvent(
      {
        toolName: 'execute_query',
        parameters: { query: `SELECT * FROM contracts WHERE id = '${rawId}'` },
      },
      makeContext([
        {
          patternName: 'custom_contract_id',
          defaultRenderMode: 'random',
          consumerAccess: [{ consumer: 'user', renderMode: 'masked' }],
          randomConfig: { charset: 'numeric', length: 12 },
          redactionLabel: '[REDACTED_CUSTOM]',
        },
      ]),
    );

    expect(payload.parameters.query).toMatch(/\{\{PII:custom_contract_id:[a-f0-9-]+\}\}/);
    expect(payload.parameters.query).not.toContain(rawId);
    expect(payload.parameters.query).not.toMatch(/\d{12}/);
  });
});
