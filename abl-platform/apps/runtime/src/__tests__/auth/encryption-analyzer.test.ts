/**
 * EncryptionAvailabilityAnalyzer Tests
 *
 * Verifies the encryption availability analyzer correctly reports
 * the status of the encryption master key and database connectivity.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DiagnosticContext } from '../../services/diagnostics/types.js';

// =============================================================================
// MOCKS — must be declared before importing the analyzer
// =============================================================================

const mockReadyState = vi.fn();

vi.mock('mongoose', () => ({
  default: {
    connection: {
      get readyState() {
        return mockReadyState();
      },
    },
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { EncryptionAvailabilityAnalyzer } from '../../services/diagnostics/analyzers/encryption-availability.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    tenantId: 'tenant-123',
    projectId: 'project-456',
    depth: 'standard',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('EncryptionAvailabilityAnalyzer', () => {
  let analyzer: EncryptionAvailabilityAnalyzer;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    analyzer = new EncryptionAvailabilityAnalyzer();
    originalEnv = process.env.ENCRYPTION_MASTER_KEY;
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_MASTER_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_MASTER_KEY;
    }
  });

  // ---------------------------------------------------------------------------
  // Happy path — both available
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    test('returns INFRA_OK when master key is set and DB is connected', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'test-key-123';
      mockReadyState.mockReturnValue(1);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('INFRA_OK');
      expect(findings[0].severity).toBe('info');
      expect(findings[0].detail).toContain('Encryption master key is set');
      expect(findings[0].detail).toContain('database is connected');
    });
  });

  // ---------------------------------------------------------------------------
  // Encryption key missing
  // ---------------------------------------------------------------------------

  describe('encryption key missing', () => {
    test('returns ENCRYPTION_UNAVAILABLE warning when master key is not set', async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      mockReadyState.mockReturnValue(1);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('ENCRYPTION_UNAVAILABLE');
      expect(findings[0].severity).toBe('warning');
      expect(findings[0].detail).toContain('Encrypted credentials cannot be decrypted');
    });

    test('returns ENCRYPTION_UNAVAILABLE when master key is empty string', async () => {
      process.env.ENCRYPTION_MASTER_KEY = '';
      mockReadyState.mockReturnValue(1);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('ENCRYPTION_UNAVAILABLE');
      expect(findings[0].severity).toBe('warning');
    });
  });

  // ---------------------------------------------------------------------------
  // Database unavailable
  // ---------------------------------------------------------------------------

  describe('database unavailable', () => {
    test('returns DB_UNAVAILABLE error when mongoose is disconnected (readyState=0)', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'test-key-123';
      mockReadyState.mockReturnValue(0);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('DB_UNAVAILABLE');
      expect(findings[0].severity).toBe('error');
      expect(findings[0].detail).toContain('Database unavailable');
    });

    test('returns DB_UNAVAILABLE error when mongoose is connecting (readyState=2)', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'test-key-123';
      mockReadyState.mockReturnValue(2);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('DB_UNAVAILABLE');
      expect(findings[0].severity).toBe('error');
      expect(findings[0].detail).toContain('readyState: 2');
    });

    test('returns DB_UNAVAILABLE error when mongoose is disconnecting (readyState=3)', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'test-key-123';
      mockReadyState.mockReturnValue(3);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('DB_UNAVAILABLE');
      expect(findings[0].severity).toBe('error');
    });
  });

  // ---------------------------------------------------------------------------
  // Both unavailable
  // ---------------------------------------------------------------------------

  describe('both unavailable', () => {
    test('returns both ENCRYPTION_UNAVAILABLE and DB_UNAVAILABLE when both missing', async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      mockReadyState.mockReturnValue(0);

      const findings = await analyzer.analyze(makeContext());

      expect(findings).toHaveLength(2);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain('ENCRYPTION_UNAVAILABLE');
      expect(codes).toContain('DB_UNAVAILABLE');
    });
  });

  // ---------------------------------------------------------------------------
  // Context independence
  // ---------------------------------------------------------------------------

  describe('context independence', () => {
    test('does not require agentName in context', async () => {
      process.env.ENCRYPTION_MASTER_KEY = 'test-key';
      mockReadyState.mockReturnValue(1);

      const findings = await analyzer.analyze(makeContext({ agentName: undefined }));

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('INFRA_OK');
    });
  });
});
