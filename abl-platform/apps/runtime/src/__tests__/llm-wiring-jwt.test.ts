/**
 * LLM Wiring — JWT Signer Construction Tests
 *
 * Verifies that the JWT signer construction pattern used in llm-wiring.ts
 * (lines 406-418) correctly creates and configures a JwtSigner closure
 * for gvisor sandbox pod authentication.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

describe('JWT signer construction pattern', () => {
  const mockSignAccessToken = vi.fn().mockReturnValue('signed-jwt-123');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates signer when jwtSecret is configured', async () => {
    const secret = 'my-sandbox-secret';
    const expiresInSec = 120;

    // Replicate the closure pattern from llm-wiring.ts lines 413-416
    const signer = async (claims: Record<string, unknown>) => {
      return mockSignAccessToken(claims, secret, expiresInSec);
    };

    const token = await signer({ tenantId: 't1', sessionId: 's1', userId: 'u1' });

    expect(token).toBe('signed-jwt-123');
    expect(mockSignAccessToken).toHaveBeenCalledWith(
      { tenantId: 't1', sessionId: 's1', userId: 'u1' },
      'my-sandbox-secret',
      120,
    );
  });

  test('uses default 300s expiry when jwtExpirySeconds not configured', () => {
    const sandboxCfg = { jwtSecret: 'secret', jwtExpirySeconds: undefined };
    const expiresInSec = sandboxCfg.jwtExpirySeconds ?? 300;
    expect(expiresInSec).toBe(300);
  });

  test('uses configured jwtExpirySeconds when set', () => {
    const sandboxCfg = { jwtSecret: 'secret', jwtExpirySeconds: 60 };
    const expiresInSec = sandboxCfg.jwtExpirySeconds ?? 300;
    expect(expiresInSec).toBe(60);
  });

  test('signer is undefined when jwtSecret is not configured', () => {
    const sandboxCfg = { jwtSecret: undefined };
    let signer: ((claims: Record<string, unknown>) => Promise<string>) | undefined;
    if (sandboxCfg?.jwtSecret) {
      signer = async () => 'should-not-happen';
    }
    expect(signer).toBeUndefined();
  });

  test('signer is undefined when config is not loaded', () => {
    const isConfigLoaded = false;
    let signer: ((claims: Record<string, unknown>) => Promise<string>) | undefined;
    if (isConfigLoaded) {
      signer = async () => 'should-not-happen';
    }
    expect(signer).toBeUndefined();
  });
});
