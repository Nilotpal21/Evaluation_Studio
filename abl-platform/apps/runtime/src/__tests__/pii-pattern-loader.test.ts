/**
 * PII Pattern Loader — Unit Tests
 *
 * Tests the service that loads custom PII patterns from the database
 * at session init and registers them in the recognizer registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIIVault, PIIRecognizerRegistry } from '@abl/compiler/platform';

// ─── Mocks ────────────────────────────────────────────────────────────────

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

const mockFindAll = vi.fn();

vi.mock('../repos/pii-pattern-repo.js', () => ({
  findBuiltinOverride: vi.fn(),
  upsertBuiltinOverride: vi.fn(),
  findAll: (...args: unknown[]) => mockFindAll(...args),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseReady: vi.fn(() => true),
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import { loadProjectPIIPatterns, buildSandboxedValidator } from '../services/pii/pattern-loader.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makePattern(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'pat-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'account-number',
    piiType: 'account_number',
    regex: '\\b\\d{8,12}\\b',
    validate: undefined,
    redaction: { type: 'masked', maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' } },
    consumerAccess: [
      { consumer: 'llm', renderMode: 'tokenized' },
      { consumer: 'user', renderMode: 'masked' },
    ],
    defaultRenderMode: 'redacted',
    enabled: true,
    builtinOverride: false,
    ...overrides,
  };
}

function makeBuiltinOverride(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'pat-2',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'email-override',
    piiType: 'email',
    regex: undefined,
    validate: undefined,
    redaction: { type: 'predefined' },
    consumerAccess: [{ consumer: 'tools', renderMode: 'masked' }],
    defaultRenderMode: 'masked',
    enabled: true,
    builtinOverride: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('loadProjectPIIPatterns', () => {
  let registry: PIIRecognizerRegistry;

  beforeEach(() => {
    registry = new PIIRecognizerRegistry();
    mockFindAll.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads custom patterns from DB and registers recognizers', async () => {
    const pattern = makePattern();
    mockFindAll.mockResolvedValue([pattern]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    // Recognizer registered
    expect(registry.get('custom-account-number')).toBeDefined();
    expect(registry.get('custom-account-number')!.tier).toBe('custom');
    expect(registry.get('custom-account-number')!.supportedTypes).toEqual(['account_number']);

    // Returns config
    expect(configs).toHaveLength(1);
    expect(configs[0].patternName).toBe('account_number');
    expect(configs[0].defaultRenderMode).toBe('redacted');
    expect(configs[0].consumerAccess).toEqual([
      { consumer: 'llm', renderMode: 'tokenized' },
      { consumer: 'user', renderMode: 'masked' },
    ]);
    expect(configs[0].redactionLabel).toBeUndefined();
  });

  it('loads predefined redaction labels for live custom-pattern rendering', async () => {
    const rawContractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';
    const pattern = makePattern({
      name: 'contract-id',
      piiType: 'custom',
      regex: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
      redaction: { type: 'predefined', label: '[REDACTED]' },
      consumerAccess: [],
      defaultRenderMode: 'redacted',
    });
    mockFindAll.mockResolvedValue([pattern]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);
    const vault = new PIIVault({ recognizerRegistry: registry });
    const tokenized = vault.tokenize(`Contract ${rawContractId}`);
    const rendered = vault.renderForConsumer(tokenized.text, 'user', configs);

    expect(tokenized.tokens).toHaveLength(1);
    expect(configs[0].redactionLabel).toBe('[REDACTED]');
    expect(rendered).toBe('Contract [REDACTED]');
    expect(rendered).not.toContain(rawContractId);
  });

  it('keeps multiple custom patterns independently addressable at render time', async () => {
    mockFindAll.mockResolvedValue([
      makePattern({
        _id: 'contract-pattern',
        name: 'contract-id',
        piiType: 'custom',
        regex: 'CID-\\d{4}',
        redaction: { type: 'predefined', label: '[CONTRACT_ID]' },
        consumerAccess: [],
        defaultRenderMode: 'redacted',
      }),
      makePattern({
        _id: 'employee-pattern',
        name: 'employee-id',
        piiType: 'custom',
        regex: 'EMP-\\d{4}',
        redaction: { type: 'predefined', label: '[EMPLOYEE_ID]' },
        consumerAccess: [],
        defaultRenderMode: 'redacted',
      }),
    ]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);
    const vault = new PIIVault({ recognizerRegistry: registry });
    const tokenized = vault.tokenize('Contract CID-1234 and employee EMP-5678');
    const rendered = vault.renderForConsumer(tokenized.text, 'user', configs);

    expect(configs.map((config) => config.patternName)).toEqual([
      'custom_contract-id_contract-pattern',
      'custom_employee-id_employee-pattern',
    ]);
    expect(tokenized.tokens.map((token) => token.type).sort()).toEqual([
      'custom_contract-id_contract-pattern',
      'custom_employee-id_employee-pattern',
    ]);
    expect(rendered).toBe('Contract [CONTRACT_ID] and employee [EMPLOYEE_ID]');
  });

  it('skips built-in override patterns (no regex registration)', async () => {
    const override = makeBuiltinOverride();
    mockFindAll.mockResolvedValue([override]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    // No recognizer registered for built-in overrides
    expect(registry.get('custom-email-override')).toBeUndefined();
    expect(registry.getRecognizerCount()).toBe(0);

    // But config IS returned (for vault rendering)
    expect(configs).toHaveLength(1);
    expect(configs[0].patternName).toBe('email');
  });

  it('returns consumer access configs for all patterns (custom + built-in overrides)', async () => {
    const custom = makePattern();
    const override = makeBuiltinOverride();
    mockFindAll.mockResolvedValue([custom, override]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.patternName)).toEqual(['account_number', 'email']);

    // Only the custom pattern gets a recognizer
    expect(registry.getRecognizerCount()).toBe(1);
  });

  it('handles empty project (no patterns) — returns empty array', async () => {
    mockFindAll.mockResolvedValue([]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toEqual([]);
    expect(registry.getRecognizerCount()).toBe(0);
  });

  it('handles DB errors gracefully (logs error, returns empty array)', async () => {
    mockFindAll.mockRejectedValue(new Error('DB connection timeout'));

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toEqual([]);
    expect(registry.getRecognizerCount()).toBe(0);
  });

  it('registers recognizer with regex validator when validate expression is present', async () => {
    // Validator is now a regex pattern (not arbitrary JS).
    // Use a regex that requires exactly 10+ digits.
    const pattern = makePattern({
      validate: '^\\d{10,}$',
    });
    mockFindAll.mockResolvedValue([pattern]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toHaveLength(1);
    const recognizer = registry.get('custom-account-number');
    expect(recognizer).toBeDefined();

    // 8 digits matches main regex \b\d{8,12}\b but fails validator ^\\d{10,}$
    const detections = recognizer!.detect('12345678');
    expect(detections).toHaveLength(0);

    // A 10-digit value should pass both regex and validator
    const passDetections = recognizer!.detect('1234567890');
    expect(passDetections).toHaveLength(1);
    expect(passDetections[0]).toMatchObject({
      type: 'account_number',
      start: 0,
      end: 10,
      value: '[REDACTED_ACCOUNT_NUMBER]',
    });
  });

  it('includes mask and random config in returned PIIPatternConfig', async () => {
    const pattern = makePattern({
      redaction: {
        type: 'random',
        randomConfig: { charset: 'numeric', length: 10 },
        maskConfig: { showFirst: 2, showLast: 2, maskChar: '#' },
      },
    });
    mockFindAll.mockResolvedValue([pattern]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs[0].randomConfig).toEqual({ charset: 'numeric', length: 10 });
    expect(configs[0].maskConfig).toEqual({ showFirst: 2, showLast: 2, maskChar: '#' });
  });

  it('disables built-in recognizer types when a disabled override exists', async () => {
    const override = makeBuiltinOverride({
      name: 'phone-override',
      piiType: 'phone',
      enabled: false,
    });
    mockFindAll.mockResolvedValue([override]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toEqual([]);
    expect(registry.isTypeDisabled('phone')).toBe(true);
  });

  it('skips disabled custom patterns', async () => {
    mockFindAll.mockResolvedValue([makePattern({ enabled: false })]);

    const configs = await loadProjectPIIPatterns('tenant-1', 'project-1', registry);

    expect(configs).toEqual([]);
    expect(registry.get('custom-account-number')).toBeUndefined();
  });
});

describe('buildSandboxedValidator', () => {
  it('valid regex pattern works', () => {
    const validator = buildSandboxedValidator('^[A-Z]{2}\\d{6}$');

    expect(validator('AB123456')).toBe(true);
    expect(validator('invalid')).toBe(false);
  });

  it('accepts digits-only regex', () => {
    const validator = buildSandboxedValidator('^\\d+$');

    expect(validator('12345')).toBe(true);
    expect(validator('abc')).toBe(false);
  });

  it('rejects invalid regex syntax', () => {
    expect(() => buildSandboxedValidator('[unclosed')).toThrow(
      'Invalid validator expression: must be a valid regex pattern',
    );
  });

  it('treats JS expressions as harmless regex patterns (no code execution)', () => {
    // JS expressions that happen to be valid regex are treated as regex patterns,
    // not executed as code. This is the security guarantee.
    const validator = buildSandboxedValidator('process');
    // As a regex, it simply matches the literal string "process" in the input.
    expect(validator('has process in it')).toBe(true);
    expect(validator('safe text')).toBe(false);
  });

  it('rejects validator with catastrophic backtracking', () => {
    expect(() => buildSandboxedValidator('(a+)+$')).toThrow(
      'Validator regex rejected: potential catastrophic backtracking',
    );
  });
});
