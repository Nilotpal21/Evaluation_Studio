/**
 * RuntimeSecretsProvider Integration Tests
 *
 * Tests environment variable resolution through the pluggable interfaces
 * WITHOUT mocking — uses real RuntimeSecretsProvider with fake store/decryptor.
 *
 * Covers:
 *   INT-1:  Env-specific resolution
 *   INT-2:  Base fallback contract (provider delegates to store)
 *   INT-11: Cache sentinel — cached "not found" prevents redundant store calls
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeSecretsProvider,
  type EnvVarStore,
  type SecretDecryptor,
} from '../services/secrets-provider.js';

// ---------------------------------------------------------------------------
// Fake implementations (no vi.mock)
// ---------------------------------------------------------------------------

/** In-memory EnvVarStore backed by a simple Map keyed by `${env}:${key}` */
class FakeEnvVarStore implements EnvVarStore {
  private data = new Map<string, { encryptedValue: string }>();
  callCount = 0;

  /** Seed a variable. Use `null` as environment for base variables. */
  seed(
    tenantId: string,
    projectId: string,
    environment: string | null,
    key: string,
    value: string,
  ) {
    const envKey = `${tenantId}:${projectId}:${environment}:${key}`;
    this.data.set(envKey, { encryptedValue: value });
  }

  async findEnvVar(params: {
    tenantId: string;
    projectId: string;
    environment: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ encryptedValue: string } | null> {
    this.callCount++;
    const envKey = `${params.tenantId}:${params.projectId}:${params.environment}:${params.key}`;
    return this.data.get(envKey) ?? null;
  }
}

/** Trivial decryptor that reverses a prefix — sufficient for testing the call chain. */
class FakeDecryptor implements SecretDecryptor {
  decryptForTenant(encryptedData: string, _tenantId: string): string {
    // Simulates decryption by stripping "enc:" prefix
    return encryptedData.startsWith('enc:') ? encryptedData.slice(4) : encryptedData;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeSecretsProvider — Integration', () => {
  let store: FakeEnvVarStore;
  let decryptor: FakeDecryptor;

  beforeEach(() => {
    store = new FakeEnvVarStore();
    decryptor = new FakeDecryptor();
  });

  // INT-1: Env-specific resolution
  describe('INT-1: Env-specific resolution', () => {
    test('getEnvVar returns decrypted value when env-specific record exists', async () => {
      store.seed('t1', 'p1', 'staging', 'API_KEY', 'enc:sk-test-123');

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'staging',
        envVarStore: store,
        decryptor,
      });

      const value = await provider.getEnvVar('API_KEY');
      expect(value).toBe('sk-test-123');
      expect(store.callCount).toBe(1);
    });

    test('second call returns cached value without hitting store', async () => {
      store.seed('t1', 'p1', 'dev', 'DB_URL', 'enc:mongodb://localhost');

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: store,
        decryptor,
      });

      await provider.getEnvVar('DB_URL');
      await provider.getEnvVar('DB_URL');
      expect(store.callCount).toBe(1); // only one DB hit
    });
  });

  // INT-2: Base fallback contract
  describe('INT-2: Base fallback contract', () => {
    test('getEnvVar returns undefined when env-specific record is missing (provider does not implement fallback)', async () => {
      // Only a base variable exists — but the provider queries with configured environment
      store.seed('t1', 'p1', 'null', 'BASE_ONLY', 'enc:base-value');

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'staging',
        envVarStore: store,
        decryptor,
      });

      // Provider queries store with environment='staging', which has no match
      const value = await provider.getEnvVar('BASE_ONLY');
      expect(value).toBeUndefined();
    });

    test('getEnvVar works when store implements base fallback internally', async () => {
      // Simulate a store that does base fallback (like the real EnvVarStore in llm-wiring.ts)
      const fallbackStore: EnvVarStore = {
        async findEnvVar(params: {
          tenantId: string;
          projectId: string;
          environment: string;
          key: string;
        }) {
          // First try exact match
          const key = `${params.tenantId}:${params.projectId}:${params.environment}:${params.key}`;
          if (key === 't1:p1:staging:SHARED_KEY') return null;
          // Fallback to base
          if (key === 't1:p1:dev:SHARED_KEY') return { encryptedValue: 'enc:base-shared' };
          return null;
        },
      };

      // Seed the store to return the base value for environment='dev'
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: fallbackStore,
        decryptor,
      });

      const value = await provider.getEnvVar('SHARED_KEY');
      expect(value).toBe('base-shared');
    });
  });

  // INT-11: Cache sentinel
  describe('INT-11: Cache sentinel — cached "not found"', () => {
    test('second call for missing key does NOT hit store again', async () => {
      // No variables seeded — everything is "not found"
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: store,
        decryptor,
      });

      const first = await provider.getEnvVar('MISSING_KEY');
      expect(first).toBeUndefined();
      expect(store.callCount).toBe(1);

      const second = await provider.getEnvVar('MISSING_KEY');
      expect(second).toBeUndefined();
      expect(store.callCount).toBe(1); // NOT 2 — cached "not found"
    });

    test('fresh provider re-queries store for previously missing key', async () => {
      const provider1 = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: store,
        decryptor,
      });

      await provider1.getEnvVar('LATE_KEY');
      expect(store.callCount).toBe(1);

      // Simulate another process adding the variable
      store.seed('t1', 'p1', 'dev', 'LATE_KEY', 'enc:appeared');

      // New provider has fresh cache
      const provider2 = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: store,
        decryptor,
      });

      const value = await provider2.getEnvVar('LATE_KEY');
      expect(value).toBe('appeared');
      expect(store.callCount).toBe(2); // second provider hit the store
    });
  });

  // Edge cases
  describe('Edge cases', () => {
    test('getEnvVar returns undefined when store/decryptor/tenantId/projectId missing', async () => {
      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        // no projectId, no store, no decryptor
        environment: 'dev',
      });

      const value = await provider.getEnvVar('ANY_KEY');
      expect(value).toBeUndefined();
    });

    test('clearSessionCache allows re-query', async () => {
      store.seed('t1', 'p1', 'dev', 'CACHED_KEY', 'enc:value1');

      const provider = new RuntimeSecretsProvider({
        tenantId: 't1',
        projectId: 'p1',
        environment: 'dev',
        envVarStore: store,
        decryptor,
      });

      await provider.getEnvVar('CACHED_KEY');
      expect(store.callCount).toBe(1);

      provider.clearSessionCache();

      await provider.getEnvVar('CACHED_KEY');
      expect(store.callCount).toBe(2); // re-queried after cache clear
    });
  });
});
