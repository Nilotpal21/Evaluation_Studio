import { afterEach, describe, it, expect, vi } from 'vitest';

vi.stubEnv('JWT_SECRET', 'test-secret-for-feedback');

const { signFeedbackToken, verifyFeedbackToken } =
  await import('../../../services/email/feedback-token.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('JWT_SECRET', 'test-secret-for-feedback');
});

describe('Feedback Token', () => {
  describe('signFeedbackToken', () => {
    it('returns a non-empty string token', () => {
      const token = signFeedbackToken({
        tenantId: 't1',
        projectId: 'p1',
        sessionId: 's1',
        messageId: 'm1',
        connectionId: 'c1',
      });
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });
  });

  describe('verifyFeedbackToken', () => {
    it('returns payload for a valid token', () => {
      const token = signFeedbackToken({
        tenantId: 't1',
        projectId: 'p1',
        sessionId: 's1',
        messageId: 'm1',
        connectionId: 'c1',
      });
      const result = verifyFeedbackToken(token);
      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('t1');
      expect(result!.projectId).toBe('p1');
      expect(result!.sessionId).toBe('s1');
      expect(result!.messageId).toBe('m1');
      expect(result!.connectionId).toBe('c1');
    });

    it('returns null for a tampered token', () => {
      const token = signFeedbackToken({
        tenantId: 't1',
        projectId: 'p1',
        sessionId: 's1',
        messageId: 'm1',
        connectionId: 'c1',
      });
      const result = verifyFeedbackToken(token + 'tampered');
      expect(result).toBeNull();
    });

    it('returns null for an expired token', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        {
          purpose: 'email_csat',
          tenantId: 't1',
          projectId: 'p1',
          sessionId: 's1',
          messageId: 'm1',
          connectionId: 'c1',
        },
        'test-secret-for-feedback',
        { expiresIn: 0 },
      );
      await new Promise((r) => setTimeout(r, 50));
      const result = verifyFeedbackToken(token);
      expect(result).toBeNull();
    });

    it('returns null for a token with wrong purpose', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        { purpose: 'auth', tenantId: 't1' },
        'test-secret-for-feedback',
        { expiresIn: 3600 },
      );
      const result = verifyFeedbackToken(token);
      expect(result).toBeNull();
    });

    it('rejects tokens signed with the generic app JWT secret when a feedback signing secret is configured', async () => {
      vi.stubEnv('JWT_SECRET', 'generic-app-secret');
      vi.stubEnv('FEEDBACK_JWT_SECRET', 'feedback-purpose-secret');

      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        {
          purpose: 'email_csat',
          tenantId: 't1',
          projectId: 'p1',
          sessionId: 's1',
          messageId: 'm1',
          connectionId: 'c1',
        },
        'generic-app-secret',
        {
          expiresIn: 3600,
          issuer: 'agent-platform',
          audience: 'feedback',
        },
      );

      const result = verifyFeedbackToken(token);
      expect(result).toBeNull();
    });

    it('rejects feedback tokens missing the feedback audience and platform issuer claims', async () => {
      const jwt = await import('jsonwebtoken');
      const token = jwt.default.sign(
        {
          purpose: 'email_csat',
          tenantId: 't1',
          projectId: 'p1',
          sessionId: 's1',
          messageId: 'm1',
          connectionId: 'c1',
        },
        'test-secret-for-feedback',
        { expiresIn: 3600 },
      );

      const result = verifyFeedbackToken(token);
      expect(result).toBeNull();
    });
  });
});
