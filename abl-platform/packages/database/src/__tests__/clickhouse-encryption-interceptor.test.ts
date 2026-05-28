import { describe, it, expect, vi } from 'vitest';
import {
  ClickHouseEncryptionInterceptor,
  type ClickHouseEncryptionDeps,
  type StoreEncryptionConfig,
} from '../clickhouse-encryption-interceptor.js';

const ENC_VALUE_PREFIX = 'ENC:v3:';

const mockEncService = {
  encryptForTenant: vi.fn((text: string, _tid: string) => `enc_${text}`),
  decryptForTenant: vi.fn((text: string, _tid: string) => text.replace('enc_', '')),
} as any;

/**
 * Inline implementations matching the DI interface — avoids importing
 * from @agent-platform/shared which would create a circular dependency.
 */
async function encryptFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  tenantId: string,
  encryptionService: any,
): Promise<Record<string, unknown>> {
  if (row._enc) throw new Error(`Row already encrypted (_enc=${row._enc})`);
  const result = { ...row };
  for (const field of fields) {
    const value = result[field];
    if (value == null) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.startsWith(ENC_VALUE_PREFIX)) {
      throw new Error(`Field "${field}" already has encryption prefix`);
    }
    result[field] = ENC_VALUE_PREFIX + (await encryptionService.encryptForTenant(str, tenantId));
  }
  result._enc = 'v3';
  return result;
}

async function decryptFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  tenantId: string,
  encryptionService: any,
): Promise<Record<string, unknown>> {
  if (!row._enc) return row;
  const result = { ...row };
  for (const field of fields) {
    const value = result[field];
    if (value == null || typeof value !== 'string') continue;
    if (!value.startsWith(ENC_VALUE_PREFIX)) continue;
    const ciphertext = value.slice(ENC_VALUE_PREFIX.length);
    result[field] = await encryptionService.decryptForTenant(ciphertext, tenantId);
  }
  delete result._enc;
  return result;
}

/** Minimal manifest for testing — mirrors the real manifest structure */
const TEST_MANIFEST: Record<string, StoreEncryptionConfig> = {
  messages: { fieldsToEncrypt: ['content'] },
  llm_metrics: { fieldsToEncrypt: [] },
};

function getManifest(table: string): StoreEncryptionConfig {
  const config = TEST_MANIFEST[table];
  if (!config) {
    throw new Error(`Unregistered ClickHouse table: "${table}". Add to manifest.`);
  }
  return config;
}

const deps: ClickHouseEncryptionDeps = {
  encryptFields,
  decryptFields,
  getManifest,
  encryptionService: mockEncService,
};

const interceptor = new ClickHouseEncryptionInterceptor(deps);

describe('ClickHouseEncryptionInterceptor', () => {
  describe('beforeInsert', () => {
    it('encrypts sensitive fields for registered table', async () => {
      const rows = [{ tenant_id: 't1', content: 'hello', timestamp: 123 }];
      const result = await interceptor.beforeInsert('messages', rows);
      expect(result[0].content).toMatch(/^ENC:v3:/);
      expect(result[0]._enc).toBe('v3');
      expect(result[0].timestamp).toBe(123);
    });

    it('passes through non-sensitive table', async () => {
      const rows = [{ tenant_id: 't1', tokens: 100 }];
      const result = await interceptor.beforeInsert('llm_metrics', rows);
      expect(result[0]).toEqual(rows[0]);
    });

    it('throws for unregistered table', async () => {
      await expect(interceptor.beforeInsert('unknown', [{}])).rejects.toThrow(
        'Unregistered ClickHouse table',
      );
    });

    it('throws when tenant_id is missing on sensitive table', async () => {
      const rows = [{ content: 'hello' }];
      await expect(interceptor.beforeInsert('messages', rows)).rejects.toThrow(
        'tenant_id required',
      );
    });
  });

  describe('afterQuery', () => {
    it('decrypts rows with _enc marker', async () => {
      const rows = [{ tenant_id: 't1', content: 'ENC:v3:enc_hello', _enc: 'v3' }];
      const result = await interceptor.afterQuery('messages', rows);
      expect(result[0].content).toBe('hello');
      expect(result[0]._enc).toBeUndefined();
    });

    it('passes through plaintext rows (no _enc)', async () => {
      const rows = [{ tenant_id: 't1', content: 'plaintext' }];
      const result = await interceptor.afterQuery('messages', rows);
      expect(result[0].content).toBe('plaintext');
    });

    it('nulls encrypted fields on decrypt failure instead of crashing', async () => {
      // Create an interceptor with a decryptFields that throws
      const failingDeps: ClickHouseEncryptionDeps = {
        ...deps,
        decryptFields: async () => {
          throw new Error('KMS unavailable');
        },
      };
      const failingInterceptor = new ClickHouseEncryptionInterceptor(failingDeps);

      const rows = [
        { tenant_id: 't1', content: 'ENC:v3:corrupted', _enc: 'v3' },
        { tenant_id: 't1', content: 'plaintext' }, // no _enc — passes through
      ];
      const result = await failingInterceptor.afterQuery('messages', rows);

      // First row: encrypted field nulled, _decryptionFailed set
      expect(result[0].content).toBeNull();
      expect(result[0]._decryptionFailed).toBe(true);
      expect(result[0]._enc).toBeUndefined();

      // Second row: untouched
      expect(result[1].content).toBe('plaintext');
    });
  });
});
