import { describe, expect, it } from 'vitest';
import {
  PIIRecognizerRegistry,
  PIIVault,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  renderValueForPIIBoundary,
  type PIIPatternConfig,
} from '../../platform/security/index.js';

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

describe('PII boundary rendering', () => {
  it('forces pipeline LLM and read consumers to tokenized values for custom patterns', () => {
    const context = makeContext([
      {
        patternName: 'custom_contract_id',
        defaultRenderMode: 'random',
        consumerAccess: [
          { consumer: 'pipeline_llm', renderMode: 'random' },
          { consumer: 'pipeline_read', renderMode: 'masked' },
        ],
        redactionLabel: '[REDACTED_CUSTOM]',
        randomConfig: { charset: 'numeric', length: 12 },
      },
    ]);
    const rawId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';

    const llmValue = renderValueForPIIBoundary(`id ${rawId}`, context, {
      consumer: 'pipeline_llm',
      role: 'user',
    });
    const readValue = renderValueForPIIBoundary(`id ${rawId}`, context, {
      consumer: 'pipeline_read',
      role: 'user',
    });

    expect(llmValue).toMatch(/\{\{PII:custom_contract_id:[a-f0-9-]+\}\}/);
    expect(readValue).toMatch(/\{\{PII:custom_contract_id:[a-f0-9-]+\}\}/);
    expect(llmValue).not.toContain(rawId);
    expect(readValue).not.toContain(rawId);
  });

  it('redacts unresolved tokens for user/session and action surfaces', () => {
    const tokenized = 'contract {{PII:custom_contract_id:00000000-0000-0000-0000-000000000000}}';

    const sessionValue = renderValueForPIIBoundary(tokenized, makeContext(), {
      consumer: 'session_read',
      role: 'assistant',
    });
    const actionValue = renderValueForPIIBoundary(tokenized, makeContext(), {
      consumer: 'pipeline_action',
      role: 'assistant',
    });

    expect(sessionValue).toBe('contract [REDACTED_CUSTOM_CONTRACT_ID]');
    expect(actionValue).toBe('contract [REDACTED_CUSTOM_CONTRACT_ID]');
  });

  it('honors disabled input/output phases by role', () => {
    const context = makeContext();
    context.piiRedactionConfig = { enabled: true, redactInput: false, redactOutput: true };
    const email = 'john.doe@example.com';

    const userValue = renderValueForPIIBoundary(email, context, {
      consumer: 'pipeline_read',
      role: 'user',
    });
    const assistantValue = renderValueForPIIBoundary(email, context, {
      consumer: 'pipeline_read',
      role: 'assistant',
    });

    expect(userValue).toBe(email);
    expect(assistantValue).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
  });

  it('honors confidence threshold when tokenizing boundary values', () => {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'high-email',
        ['email'],
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        'email',
      ),
    );
    registry.register(
      new RegexPIIRecognizer(
        'low-postal-code',
        ['postal_code'],
        /\b\d{5}\b/g,
        'postal_code',
        undefined,
        'regex',
        { baseConfidence: 0.4 },
      ),
    );
    const context = {
      piiRedactionConfig: {
        enabled: true,
        redactInput: true,
        redactOutput: true,
        confidenceThreshold: 0.7,
      },
      piiVault: new PIIVault({ recognizerRegistry: registry }),
      piiPatternConfigs: [],
    };

    const rendered = renderValueForPIIBoundary('Email user@example.com lives in 12345', context, {
      consumer: 'pipeline_llm',
      role: 'user',
    });

    expect(rendered).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(rendered).toContain('12345');
    expect(rendered).not.toContain('user@example.com');
  });

  it('derives input/output phase from nested message roles', () => {
    const context = makeContext();
    context.piiRedactionConfig = { enabled: true, redactInput: false, redactOutput: true };
    const userEmail = 'user@example.com';
    const assistantEmail = 'assistant@example.com';

    const rendered = renderValueForPIIBoundary(
      {
        messages: [
          { role: 'user', content: `user ${userEmail}` },
          { role: 'assistant', content: `assistant ${assistantEmail}` },
        ],
      },
      context,
      {
        consumer: 'pipeline_llm',
        role: 'user',
      },
    );

    expect(rendered.messages[0].content).toContain(userEmail);
    expect(rendered.messages[1].content).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(rendered.messages[1].content).not.toContain(assistantEmail);
  });
});
