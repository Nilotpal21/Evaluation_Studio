import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createExpressErrorHandler } from '@agent-platform/shared/middleware';
import { AppError, ErrorCodes, ValidationError } from '@agent-platform/shared-kernel';

function createApp(logError = vi.fn()) {
  const app = express();
  const schema = z.object({ projectId: z.string().uuid() });

  app.get('/app-error', () => {
    throw new AppError('Project not found', { ...ErrorCodes.NOT_FOUND });
  });

  app.get('/validation-error', () => {
    throw new ValidationError('Request invalid');
  });

  app.get('/zod-error', () => {
    schema.parse({ projectId: 'not-a-uuid' });
  });

  app.get('/unknown-error', () => {
    throw new Error('boom');
  });

  app.use(createExpressErrorHandler({ logError }));

  return { app, logError };
}

describe('runtime shared error middleware', () => {
  let logError: ReturnType<typeof vi.fn>;
  let app: express.Express;

  beforeEach(() => {
    const setup = createApp();
    app = setup.app;
    logError = setup.logError;
  });

  it('preserves the runtime envelope for AppError responses', async () => {
    const response = await request(app).get('/app-error').expect(404);

    expect(response.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Project not found' },
    });
  });

  it('maps ValidationError to a 400 runtime envelope', async () => {
    const response = await request(app).get('/validation-error').expect(400);

    expect(response.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Request invalid' },
    });
  });

  it('maps ZodError to a 400 runtime envelope', async () => {
    const response = await request(app).get('/zod-error').expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('projectId');
  });

  it('preserves the runtime envelope for unknown errors', async () => {
    const response = await request(app).get('/unknown-error').expect(500);

    expect(response.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('logs normalized error metadata for handled errors', async () => {
    await request(app).get('/app-error').expect(404);

    expect(logError).toHaveBeenCalledWith(
      expect.any(AppError),
      expect.objectContaining({ path: '/app-error', method: 'GET' }),
      expect.objectContaining({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Project not found',
      }),
    );
  });
});
