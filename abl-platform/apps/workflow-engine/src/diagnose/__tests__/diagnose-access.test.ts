import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createDiagnoseRateLimit,
  createRequireDiagnoseKey,
  _resetDiagnoseRateLimitForTests,
} from '../diagnose-access.js';

describe('createRequireDiagnoseKey', () => {
  test('no env key ⇒ gate is a passthrough', async () => {
    const app = express();
    app.get('/protected', createRequireDiagnoseKey({}), (_req, res) => res.json({ ok: true }));
    await request(app).get('/protected').expect(200, { ok: true });
  });

  test('env key set + no header ⇒ 401', async () => {
    const app = express();
    app.get('/protected', createRequireDiagnoseKey({ DIAGNOSE_API_KEY: 'secret' }), (_req, res) =>
      res.json({ ok: true }),
    );
    const res = await request(app).get('/protected').expect(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  test('env key set + correct header ⇒ passthrough', async () => {
    const app = express();
    app.get('/protected', createRequireDiagnoseKey({ DIAGNOSE_API_KEY: 'secret' }), (_req, res) =>
      res.json({ ok: true }),
    );
    await request(app).get('/protected').set('X-Diagnose-Key', 'secret').expect(200, { ok: true });
  });

  test('env key set + wrong header ⇒ 401', async () => {
    const app = express();
    app.get('/protected', createRequireDiagnoseKey({ DIAGNOSE_API_KEY: 'secret' }), (_req, res) =>
      res.json({ ok: true }),
    );
    await request(app).get('/protected').set('X-Diagnose-Key', 'wrong').expect(401);
  });

  test('env key set + header of different length ⇒ 401 (timing-safe compare)', async () => {
    const app = express();
    app.get('/protected', createRequireDiagnoseKey({ DIAGNOSE_API_KEY: 'secret' }), (_req, res) =>
      res.json({ ok: true }),
    );
    await request(app).get('/protected').set('X-Diagnose-Key', 'x').expect(401);
  });
});

describe('createDiagnoseRateLimit', () => {
  beforeEach(() => _resetDiagnoseRateLimitForTests());

  test('requests under the limit are passed through', async () => {
    const app = express();
    app.get('/rl', createDiagnoseRateLimit({ windowMs: 60_000, max: 3 }), (_req, res) =>
      res.json({ ok: true }),
    );
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/rl').expect(200);
    }
  });

  test('requests past the limit get 429', async () => {
    const app = express();
    app.get('/rl', createDiagnoseRateLimit({ windowMs: 60_000, max: 2 }), (_req, res) =>
      res.json({ ok: true }),
    );
    await request(app).get('/rl').expect(200);
    await request(app).get('/rl').expect(200);
    const res = await request(app).get('/rl').expect(429);
    expect(res.body).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  test('window rolls over after elapsed time', async () => {
    const app = express();
    // 200ms window — wide enough to be robust on loaded CI runners.
    app.get('/rl', createDiagnoseRateLimit({ windowMs: 200, max: 1 }), (_req, res) =>
      res.json({ ok: true }),
    );
    await request(app).get('/rl').expect(200);
    await request(app).get('/rl').expect(429);
    await new Promise((r) => setTimeout(r, 300));
    await request(app).get('/rl').expect(200);
  });
});
