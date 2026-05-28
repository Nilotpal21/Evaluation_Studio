import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import modelCapabilitiesRouter from '../../routes/model-capabilities.js';

function createApp() {
  const app = express();
  app.use('/api/model-capabilities', modelCapabilitiesRouter);
  return app;
}

describe('model-capabilities route', () => {
  it('resolves slash-containing model IDs through the query route', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/model-capabilities')
      .query({ modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      provider: 'togetherai',
      supportsTools: true,
    });
    expect(response.body.hyperParameters.length).toBeGreaterThan(0);
  });

  it('rejects query route calls without a modelId', async () => {
    const app = createApp();

    await request(app).get('/api/model-capabilities').expect(400, {
      success: false,
      error: 'modelId query parameter is required',
    });
  });
});
