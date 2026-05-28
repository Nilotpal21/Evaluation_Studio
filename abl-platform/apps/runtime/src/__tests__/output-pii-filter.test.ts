/**
 * Output PII Filter Tests
 *
 * Tests the output PII redaction filter that removes PII from agent responses
 * before delivery to users. Covers all config combinations, PII types,
 * exemptions, edge cases, and logging behavior.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockLogInfo } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      info: mockLogInfo,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

import {
  filterOutputPII,
  type OutputPIIFilterResult,
} from '../services/execution/output-pii-filter.js';
import {
  PIIVault,
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  type PIIType,
} from '@abl/compiler/platform';

// =============================================================================
// HELPERS
// =============================================================================

function enabledConfig(overrides?: { redactOutput?: boolean; redactInput?: boolean }) {
  return {
    enabled: true,
    redactInput: overrides?.redactInput ?? true,
    redactOutput: overrides?.redactOutput ?? true,
  };
}

function disabledConfig() {
  return { enabled: false, redactInput: false, redactOutput: false };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Output PII Filter', () => {
  beforeEach(() => {
    mockLogInfo.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. Basic PII redaction
  // -------------------------------------------------------------------------

  test('redacts email in agent response', () => {
    const result = filterOutputPII('Your account email is user@example.com', enabledConfig());
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_EMAIL]');
    expect(result.text).not.toContain('user@example.com');
    expect(result.redactedTypes).toContain('email');
  });

  test('redacts phone number in agent response', () => {
    const result = filterOutputPII('We have your phone as (555) 123-4567', enabledConfig());
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_PHONE]');
    expect(result.text).not.toContain('4567');
    expect(result.redactedTypes).toContain('phone');
  });

  test('masks custom MemberId values and lets disabled built-in phone stop matching alphanumeric IDs', () => {
    const registry = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(registry);
    registry.disableType('phone');
    registry.register(
      new RegexPIIRecognizer(
        'custom-MemberId',
        ['MemberId'],
        /\b[A-Za-z0-9]{6,15}\b/g,
        'MemberId',
        undefined,
        'custom',
      ),
    );
    const vault = new PIIVault({ recognizerRegistry: registry });

    const result = filterOutputPII(
      'IDs AB1234567 and A8006170900; call 555-123-4567',
      enabledConfig(),
      {
        vault,
        recognizerRegistry: registry,
        patternConfigs: [
          {
            patternName: 'MemberId',
            defaultRenderMode: 'masked',
            consumerAccess: [{ consumer: 'user', renderMode: 'masked' }],
            maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
          },
        ],
        consumer: 'user',
      },
    );

    expect(result.filtered).toBe(true);
    expect(result.text).toContain('*****4567');
    expect(result.text).toContain('*******0900');
    expect(result.text).not.toContain('AB1234567');
    expect(result.text).not.toContain('A8006170900');
    expect(result.text).not.toContain('[REDACTED_PHONE]');
    expect(result.text).toContain('555-123-4567');
  });

  test('honors custom predefined redaction labels for live output filtering', () => {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['custom'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'custom',
        undefined,
        'custom',
      ),
    );
    const vault = new PIIVault({ recognizerRegistry: registry });
    const rawContractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';

    const result = filterOutputPII(`Contract ${rawContractId}`, enabledConfig(), {
      vault,
      recognizerRegistry: registry,
      patternConfigs: [
        {
          patternName: 'custom',
          defaultRenderMode: 'redacted',
          consumerAccess: [],
          redactionLabel: '[REDACTED]',
        },
      ],
      consumer: 'user',
    });

    expect(result.filtered).toBe(true);
    expect(result.text).toBe('Contract [REDACTED]');
    expect(result.text).not.toContain(rawContractId);
    expect(result.text).not.toContain('[REDACTED_CUSTOM]');
  });

  // -------------------------------------------------------------------------
  // 2. Config flags
  // -------------------------------------------------------------------------

  test('returns original text when redactOutput is false', () => {
    const original = 'Your email is user@example.com';
    const result = filterOutputPII(original, enabledConfig({ redactOutput: false }));
    expect(result.filtered).toBe(false);
    expect(result.text).toBe(original);
    expect(result.redactedTypes).toEqual([]);
  });

  test('returns original text when PII redaction is disabled', () => {
    const original = 'Your SSN is 123-45-6789';
    const result = filterOutputPII(original, disabledConfig());
    expect(result.filtered).toBe(false);
    expect(result.text).toBe(original);
    expect(result.redactedTypes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. No PII present
  // -------------------------------------------------------------------------

  test('returns original text when no PII found', () => {
    const original = 'Your order has been shipped successfully.';
    const result = filterOutputPII(original, enabledConfig());
    expect(result.filtered).toBe(false);
    expect(result.text).toBe(original);
    expect(result.redactedTypes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. Multiple PII types
  // -------------------------------------------------------------------------

  test('redacts multiple PII types', () => {
    const result = filterOutputPII(
      'Contact user@example.com or call (555) 123-4567. SSN: 123-45-6789',
      enabledConfig(),
    );
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_EMAIL]');
    expect(result.text).toContain('[REDACTED_PHONE]');
    expect(result.text).toContain('[REDACTED_SSN]');
    expect(result.redactedTypes).toContain('email');
    expect(result.redactedTypes).toContain('phone');
    expect(result.redactedTypes).toContain('ssn');
  });

  // -------------------------------------------------------------------------
  // 5. Exemptions
  // -------------------------------------------------------------------------

  test('exempts types when exemptTypes provided', () => {
    const exempt: Set<PIIType> = new Set(['email']);
    const result = filterOutputPII(
      'Email: user@example.com, SSN: 123-45-6789',
      enabledConfig(),
      exempt,
    );
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('user@example.com');
    expect(result.text).toContain('[REDACTED_SSN]');
    expect(result.redactedTypes).toContain('ssn');
    expect(result.redactedTypes).not.toContain('email');
  });

  // -------------------------------------------------------------------------
  // 6. Edge cases
  // -------------------------------------------------------------------------

  test('handles empty string input', () => {
    const result = filterOutputPII('', enabledConfig());
    expect(result.filtered).toBe(false);
    expect(result.text).toBe('');
    expect(result.redactedTypes).toEqual([]);
  });

  test('handles config with enabled undefined (falsy)', () => {
    const config = {
      enabled: undefined as unknown as boolean,
      redactInput: true,
      redactOutput: true,
    };
    const result = filterOutputPII('Email: user@example.com', config);
    expect(result.filtered).toBe(false);
    expect(result.text).toBe('Email: user@example.com');
  });

  // -------------------------------------------------------------------------
  // 7. Individual PII types
  // -------------------------------------------------------------------------

  test('redacts SSN in agent response', () => {
    const result = filterOutputPII('Your SSN on file is 123-45-6789', enabledConfig());
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_SSN]');
    expect(result.text).not.toContain('123-45-6789');
    expect(result.redactedTypes).toContain('ssn');
  });

  test('redacts credit card in agent response', () => {
    const result = filterOutputPII(
      'Your card ending in 4111 1111 1111 1111 was charged',
      enabledConfig(),
    );
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_CARD]');
    expect(result.text).not.toContain('4111 1111 1111 1111');
    expect(result.redactedTypes).toContain('credit_card');
  });

  test('redacts IP address in agent response', () => {
    const result = filterOutputPII('Your request came from 192.168.1.100', enabledConfig());
    expect(result.filtered).toBe(true);
    expect(result.text).toContain('[REDACTED_IP]');
    expect(result.text).not.toContain('192.168.1.100');
    expect(result.redactedTypes).toContain('ip_address');
  });

  // -------------------------------------------------------------------------
  // 8. Logging verification
  // -------------------------------------------------------------------------

  test('logs redacted types when filtering occurs', () => {
    filterOutputPII('Your email is user@example.com', enabledConfig());
    expect(mockLogInfo).toHaveBeenCalledWith('output-pii-filtered', {
      redactedTypes: ['email'],
      exemptedTypes: [],
    });
  });

  test('does not log when no PII is found', () => {
    filterOutputPII('Hello world', enabledConfig());
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  test('does not log when filtering is disabled', () => {
    filterOutputPII('Email: user@example.com', disabledConfig());
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});
