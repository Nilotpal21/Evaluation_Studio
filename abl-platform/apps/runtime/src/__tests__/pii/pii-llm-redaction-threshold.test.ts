import { describe, expect, test } from 'vitest';
import {
  PIIRecognizerRegistry,
  PIIVault,
  RegexPIIRecognizer,
  type PIIType,
} from '@abl/compiler/platform';
import { renderTextForLLMWithPIIRedaction } from '../../services/execution/pii-llm-redaction.js';

function createThresholdVault(): PIIVault {
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
      ['postal_code' as PIIType],
      /\b\d{5}\b/g,
      'postal_code' as PIIType,
      undefined,
      'regex',
      { baseConfidence: 0.4 },
    ),
  );
  return new PIIVault({ recognizerRegistry: registry });
}

describe('renderTextForLLMWithPIIRedaction confidence threshold', () => {
  test('passes confidenceThreshold into vault tokenization', () => {
    const rendered = renderTextForLLMWithPIIRedaction(
      {
        piiRedactionConfig: {
          enabled: true,
          redactInput: true,
          tier: 'standard',
          confidenceThreshold: 0.7,
        },
        piiVault: createThresholdVault(),
      },
      'Email user@example.com lives in 12345',
    );

    expect(rendered).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(rendered).toContain('12345');
    expect(rendered).not.toContain('user@example.com');
  });
});
