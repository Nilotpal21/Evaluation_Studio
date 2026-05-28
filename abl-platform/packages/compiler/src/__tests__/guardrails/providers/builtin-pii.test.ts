import { describe, it, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '../../../platform/security/pii-recognizer-registry';
import { BuiltinPIIProvider } from '../../../platform/guardrails/providers/builtin-pii';

describe('BuiltinPIIProvider', () => {
  const provider = new BuiltinPIIProvider();

  it('should have correct name and zero cost', () => {
    expect(provider.name).toBe('builtin-pii');
    expect(provider.costPerEvalUsd).toBe(0);
  });

  it('should always be available', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('should detect email PII', async () => {
    const result = await provider.evaluate({
      content: 'Contact john@example.com for details',
      category: 'pii',
    });
    expect(result.score).toBe(1.0);
    expect(result.severity).not.toBe('safe');
    expect(result.label).toBe('email');
    expect(result.category).toBe('pii');
  });

  it('should detect SSN PII', async () => {
    const result = await provider.evaluate({
      content: 'My SSN is 123-45-6789',
      category: 'pii',
    });
    expect(result.score).toBe(1.0);
    expect(result.label).toBe('ssn');
  });

  it('should return safe for clean text', async () => {
    const result = await provider.evaluate({
      content: 'Hello, how are you doing today?',
      category: 'pii',
    });
    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });

  it('should track latency', async () => {
    const result = await provider.evaluate({
      content: 'test content',
      category: 'pii',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should include raw detection result', async () => {
    const result = await provider.evaluate({
      content: 'My email is test@test.com',
      category: 'pii',
    });
    expect(result.raw).toBeDefined();
    expect((result.raw as any).hasPII).toBe(true);
  });

  it('should detect custom project patterns when a recognizer registry is supplied', async () => {
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

    const result = await provider.evaluate({
      content: 'Contract 780b4d1c-1166-487e-ae7a-27eedd12905b',
      category: 'pii',
      context: { piiRecognizerRegistry: registry },
    });

    expect(result.score).toBe(1.0);
    expect(result.label).toBe('ContractID');
  });

  it('should honor disabled builtin recognizers from the supplied registry', async () => {
    const registry = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(registry);
    registry.disableType('phone');

    const result = await provider.evaluate({
      content: 'Call me at 555-123-4567',
      category: 'pii',
      context: { piiRecognizerRegistry: registry },
    });

    expect(result.score).toBe(0.0);
    expect(result.severity).toBe('safe');
  });
});
