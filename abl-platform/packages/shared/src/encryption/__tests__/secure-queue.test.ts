import { describe, it, expect, vi } from 'vitest';
import { wrapJobDataForEncrypt, unwrapJobDataForDecrypt } from '../index.js';

const mockEncService = {
  encryptForTenant: vi.fn((text: string, _tid: string) => `enc_${text}`),
  decryptForTenant: vi.fn((text: string, _tid: string) => text.replace('enc_', '')),
} as any;

describe('wrapJobDataForEncrypt', () => {
  it('encrypts sensitive fields per manifest', async () => {
    const data = { tenantId: 't1', message: 'hello', jobId: 'j1' };
    const result = await wrapJobDataForEncrypt('llm-requests', data, mockEncService);
    expect(result.message).toMatch(/^ENC:v3:/);
    expect(result.tenantId).toBe('t1');
    expect(result.jobId).toBe('j1');
  });

  it('passes through non-sensitive queue data', async () => {
    const data = { tenantId: 't1', documentId: 'd1' };
    const result = await wrapJobDataForEncrypt('search-ingestion', data, mockEncService);
    expect(result).toEqual(data);
  });

  it('throws for unregistered queue', async () => {
    await expect(wrapJobDataForEncrypt('unknown', {}, mockEncService)).rejects.toThrow(
      'Unregistered Redis queue',
    );
  });

  it('throws when tenantId missing for sensitive queue', async () => {
    const data = { message: 'hello' };
    await expect(wrapJobDataForEncrypt('llm-requests', data, mockEncService)).rejects.toThrow(
      'tenantId required',
    );
  });
});

describe('unwrapJobDataForDecrypt', () => {
  it('decrypts sensitive fields per manifest', async () => {
    const data = { tenantId: 't1', message: 'ENC:v3:enc_hello', _enc: 'v3' };
    const result = await unwrapJobDataForDecrypt('llm-requests', data, mockEncService);
    expect(result.message).toBe('hello');
  });

  it('passes through unencrypted data (migration compat)', async () => {
    const data = { tenantId: 't1', message: 'plaintext' };
    const result = await unwrapJobDataForDecrypt('llm-requests', data, mockEncService);
    expect(result.message).toBe('plaintext');
  });

  it('throws when tenantId missing for sensitive queue', async () => {
    const data = { message: 'ENC:v3:enc_hello', _enc: 'v3' };
    await expect(unwrapJobDataForDecrypt('llm-requests', data, mockEncService)).rejects.toThrow(
      'tenantId required',
    );
  });

  it('passes through non-sensitive queue data without decryption', async () => {
    const data = { tenantId: 't1', documentId: 'd1' };
    const result = await unwrapJobDataForDecrypt('search-ingestion', data, mockEncService);
    expect(result).toEqual(data);
  });
});
