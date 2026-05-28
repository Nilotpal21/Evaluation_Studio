import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('JWT_SECRET', 'test-secret-for-feedback');

// Mock Redis
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
vi.mock('../../../services/redis/redis-client.js', () => ({
  getRedisClient: () => ({ get: mockRedisGet, set: mockRedisSet }),
  isRedisAvailable: () => true,
  getRedisHandle: () => null,
}));

// Mock TraceStore
const mockAddEvent = vi.fn();
vi.mock('../../../services/trace-store.js', () => ({
  getTraceStore: () => ({ addEvent: mockAddEvent }),
}));

import { signFeedbackToken } from '../../../services/email/feedback-token.js';
import { createFeedbackRouter } from '../../../routes/feedback.js';
import express from 'express';
import request from 'supertest';

function createApp() {
  const app = express();
  app.use('/api/v1/feedback', createFeedbackRouter());
  return app;
}

describe('Feedback Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null); // no duplicate by default
    mockRedisSet.mockResolvedValue('OK');
  });

  it('records feedback and returns thank-you page for valid token', async () => {
    const token = signFeedbackToken({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      messageId: 'm1',
      connectionId: 'c1',
    });

    const res = await request(createApp()).get(`/api/v1/feedback/${token}?rating=4`).expect(200);

    expect(res.text).toContain('Thank you');
    expect(mockAddEvent).toHaveBeenCalledOnce();
    expect(mockRedisSet).toHaveBeenCalledOnce();
  });

  it('returns 404 for invalid/tampered token', async () => {
    const res = await request(createApp())
      .get('/api/v1/feedback/invalid-token?rating=3')
      .expect(404);

    expect(mockAddEvent).not.toHaveBeenCalled();
  });

  it('still returns 404 for invalid tokens even when rating is missing', async () => {
    const res = await request(createApp()).get('/api/v1/feedback/invalid-token').expect(404);

    expect(res.text).toContain('invalid or has expired');
    expect(mockAddEvent).not.toHaveBeenCalled();
  });

  it('returns error for out-of-range rating', async () => {
    const token = signFeedbackToken({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      messageId: 'm1',
      connectionId: 'c1',
    });

    const res = await request(createApp()).get(`/api/v1/feedback/${token}?rating=6`).expect(400);

    expect(res.text).toContain('Invalid Rating');
    expect(mockAddEvent).not.toHaveBeenCalled();
  });

  it('returns error for missing rating', async () => {
    const token = signFeedbackToken({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      messageId: 'm1',
      connectionId: 'c1',
    });

    const res = await request(createApp()).get(`/api/v1/feedback/${token}`).expect(400);

    expect(res.text).toContain('Invalid Rating');
  });

  it('is idempotent — duplicate returns thank-you without re-recording', async () => {
    mockRedisGet.mockResolvedValue('1'); // already submitted

    const token = signFeedbackToken({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      messageId: 'm1',
      connectionId: 'c1',
    });

    const res = await request(createApp()).get(`/api/v1/feedback/${token}?rating=4`).expect(200);

    expect(res.text).toContain('Thank you');
    expect(mockAddEvent).not.toHaveBeenCalled(); // not re-recorded
  });
});
