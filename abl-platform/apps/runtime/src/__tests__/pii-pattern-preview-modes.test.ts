import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRegistryOverride = vi.hoisted(() => vi.fn());

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

vi.mock('@abl/compiler/platform/security/pii-recognizer-registry.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const getDefaultRegistry = actual.getDefaultPIIRecognizerRegistry as () => unknown;

  return {
    ...actual,
    getDefaultPIIRecognizerRegistry: () => mockRegistryOverride() ?? getDefaultRegistry(),
  };
});

vi.mock('../repos/pii-pattern-repo.js', () => ({
  findBuiltinOverride: vi.fn(),
  upsertBuiltinOverride: vi.fn(),
  findByName: vi.fn(),
}));

import {
  normalizePatternConsumerAccess,
  normalizePatternPayloadForStorage,
  testPattern,
} from '../services/pii/pattern-service.js';

describe('testPattern preview render modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistryOverride.mockReset();
    mockRegistryOverride.mockReturnValue(undefined);
  });

  it('renders masked, tokenized, and random previews without leaking the original value', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const result = testPattern(
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
      `Order ${uuid}`,
      undefined,
      {
        type: 'predefined',
        label: '[UUID]',
        maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
        randomConfig: { charset: 'numeric', length: 6 },
      },
      [
        { consumer: 'llm', renderMode: 'tokenized' },
        { consumer: 'ops', renderMode: 'random' },
      ],
      'masked',
      'custom_uuid',
    );

    expect(result.consumerPreviews.default).not.toContain(uuid);
    expect(result.consumerPreviews.default).toContain('4000');
    expect(result.consumerPreviews.default).toMatch(/^Order \*+4000$/);
    expect(result.consumerPreviews.llm).toBe('Order {{PII:custom_uuid:preview-1}}');
    expect(result.consumerPreviews.ops).toMatch(/^Order \d{6}$/);
    expect(result.consumerPreviews.ops).not.toContain(uuid);
  });

  it('reuses the same random replacement across previews within one test run', () => {
    const result = testPattern(
      '\\d{4}',
      'OTP 1234',
      undefined,
      {
        type: 'random',
        randomConfig: { charset: 'numeric', length: 8 },
      },
      [{ consumer: 'auditor', renderMode: 'random' }],
      'random',
      'otp_code',
    );

    expect(result.consumerPreviews.default).toBe(result.consumerPreviews.auditor);
    expect(result.consumerPreviews.default).toMatch(/^OTP \d{8}$/);
  });

  it('supports the legacy plain alias and fails closed for unsupported render modes', () => {
    const result = testPattern(
      'EMP-\\d{4}',
      'Employee EMP-1234',
      undefined,
      {
        type: 'predefined',
        label: '[EMPLOYEE_ID]',
      },
      [
        { consumer: 'legacy', renderMode: 'plain' },
        { consumer: 'unknown', renderMode: 'made-up' },
      ],
      'plain',
      'employee_id',
    );

    expect(result.consumerPreviews.default).toBe('Employee EMP-1234');
    expect(result.consumerPreviews.legacy).toBe('Employee EMP-1234');
    expect(result.consumerPreviews.unknown).toBe('Employee [EMPLOYEE_ID]');
  });

  it('uses built-in pii masking when piiType is known and no mask config is provided', () => {
    const result = testPattern(
      '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
      'Email alice@example.com',
      undefined,
      {
        type: 'predefined',
        label: '[EMAIL]',
      },
      undefined,
      'masked',
      'email',
    );

    expect(result.consumerPreviews.default).toBe('Email a***@example.com');
  });

  it('applies explicit email mask configs to the full detected email value', () => {
    const result = testPattern(
      '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
      'Email alice@example.com',
      undefined,
      {
        type: 'masked',
        maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
      },
      undefined,
      'masked',
      'email',
    );

    expect(result.consumerPreviews.default).toBe('Email *************.com');
  });

  it('renders redacted mode as a redaction label even when the strategy is masked or random', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const regex = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    const maskedStrategy = testPattern(
      regex,
      `Order ${uuid}`,
      undefined,
      {
        type: 'masked',
        maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
      },
      undefined,
      'redacted',
      'custom_uuid',
    );

    const randomStrategy = testPattern(
      regex,
      `Order ${uuid}`,
      undefined,
      {
        type: 'random',
        randomConfig: { charset: 'numeric', length: 6 },
      },
      undefined,
      'redacted',
      'custom_uuid',
    );

    expect(maskedStrategy.consumerPreviews.default).toBe('Order [REDACTED]');
    expect(randomStrategy.consumerPreviews.default).toBe('Order [REDACTED]');
  });

  it('uses built-in recognizer metadata when previewing overrides without a stored regex', () => {
    const result = testPattern(
      undefined,
      'Cards 4111-1111-1111-1111 and 1234-5678-9012-3456',
      undefined,
      {
        type: 'predefined',
        label: '[CARD]',
      },
      undefined,
      'masked',
      'credit_card',
    );

    expect(result.detections.map((d) => d.match)).toEqual(['4111-1111-1111-1111']);
    expect(result.consumerPreviews.default).toBe(
      'Cards ****-****-****-1111 and 1234-5678-9012-3456',
    );
  });

  it('built-in recognizer detections carry confidence and recognizer name (closes GAP-013)', () => {
    const result = testPattern(
      undefined,
      'Email alice@example.com',
      undefined,
      { type: 'predefined', label: '[EMAIL]' },
      undefined,
      'masked',
      'email',
    );

    expect(result.detections).toHaveLength(1);
    const detection = result.detections[0];
    expect(detection.match).toBe('alice@example.com');
    expect(detection.confidence).toBe(1.0);
    expect(detection.recognizer).toMatch(/^(core|builtin)-email$/);
  });

  it('regex previews carry confidence=1.0 and no recognizer name', () => {
    const result = testPattern(
      'EMP-\\d{4}',
      'Employee EMP-1234',
      undefined,
      { type: 'predefined', label: '[EMPLOYEE_ID]' },
      undefined,
      'masked',
      'custom_employee_id',
    );

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].confidence).toBe(1.0);
    expect(result.detections[0].recognizer).toBeUndefined();
  });

  it('returns the original text when a built-in recognizer has no matching detections', () => {
    const result = testPattern(
      undefined,
      'Cards not-a-card and still safe',
      undefined,
      {
        type: 'predefined',
        label: '[CARD]',
      },
      undefined,
      'masked',
      'credit_card',
    );

    expect(result.detections).toEqual([]);
    expect(result.consumerPreviews.default).toBe('Cards not-a-card and still safe');
  });

  it('falls back to the original text when built-in recognizer metadata is unavailable', () => {
    mockRegistryOverride.mockReturnValue({
      listRecognizers: () => [],
      get: () => undefined,
    });

    const result = testPattern(
      undefined,
      'Email alice@example.com',
      undefined,
      {
        type: 'predefined',
        label: '[EMAIL]',
      },
      undefined,
      'masked',
      'email',
    );

    expect(result.detections).toEqual([]);
    expect(result.consumerPreviews.default).toBe('Email alice@example.com');
  });

  it('falls back to the original text when recognizer metadata exists but the recognizer is missing', () => {
    mockRegistryOverride.mockReturnValue({
      listRecognizers: () => [{ name: 'builtin-email', types: ['email'] }],
      get: () => undefined,
    });

    const result = testPattern(
      undefined,
      'Email alice@example.com',
      undefined,
      {
        type: 'predefined',
        label: '[EMAIL]',
      },
      undefined,
      'masked',
      'email',
    );

    expect(result.detections).toEqual([]);
    expect(result.consumerPreviews.default).toBe('Email alice@example.com');
  });

  it('caps regex detections at 100 matches', () => {
    const result = testPattern('a', 'a'.repeat(120));

    expect(result.detections).toHaveLength(100);
  });

  it('handles zero-length regex matches without hanging', () => {
    const result = testPattern('(?=a)', 'aaa');

    expect(result.detections).toHaveLength(3);
    expect(result.detections.map((d) => d.index)).toEqual([0, 1, 2]);
  });
});

describe('PII pattern consumer access normalization', () => {
  it('converts explicit LLM original render mode to tokenized', () => {
    expect(
      normalizePatternConsumerAccess(
        [
          { consumer: 'llm', renderMode: 'original' },
          { consumer: 'tools', renderMode: 'original' },
        ],
        'redacted',
      ),
    ).toEqual([
      { consumer: 'llm', renderMode: 'tokenized' },
      { consumer: 'tools', renderMode: 'original' },
    ]);
  });

  it('adds an explicit LLM tokenized rule when the default render mode is original', () => {
    expect(normalizePatternConsumerAccess([], 'original')).toEqual([
      { consumer: 'llm', renderMode: 'tokenized' },
    ]);
  });

  it('normalizes payloads at the runtime API storage boundary', () => {
    expect(
      normalizePatternPayloadForStorage({
        name: 'Account ID',
        defaultRenderMode: 'original',
        consumerAccess: [{ consumer: ' LLM ', renderMode: 'original' }],
      }),
    ).toMatchObject({
      name: 'Account ID',
      defaultRenderMode: 'original',
      consumerAccess: [{ consumer: 'llm', renderMode: 'tokenized' }],
    });
  });
});
