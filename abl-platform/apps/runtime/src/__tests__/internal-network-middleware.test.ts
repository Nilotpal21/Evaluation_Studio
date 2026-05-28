import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireInternalNetworkAccess } from '../middleware/internal-network.js';

function createApp() {
  const app = express();
  app.get('/internal-only', requireInternalNetworkAccess, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireInternalNetworkAccess', () => {
  it('allows local requests without proxy headers', async () => {
    await request(createApp()).get('/internal-only').expect(200, { ok: true });
  });

  it('blocks requests forwarded from public IPs', async () => {
    const response = await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '203.0.113.10');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Forbidden: internal network access required',
    });
  });

  it('blocks requests whose forwarded chain contains a public hop', async () => {
    const response = await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '198.51.100.8, 10.0.0.5');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Forbidden: internal network access required',
    });
  });

  it('allows requests from an internal proxy chain', async () => {
    await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '10.0.0.5, 10.0.0.6')
      .expect(200, { ok: true });
  });
});

describe('requireInternalNetworkAccess with INTERNAL_NETWORK_EXTRA_CIDRS', () => {
  const original = process.env.INTERNAL_NETWORK_EXTRA_CIDRS;

  beforeEach(() => {
    delete process.env.INTERNAL_NETWORK_EXTRA_CIDRS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INTERNAL_NETWORK_EXTRA_CIDRS;
    } else {
      process.env.INTERNAL_NETWORK_EXTRA_CIDRS = original;
    }
  });

  it('blocks requests forwarded from a VPC public range when env is unset', async () => {
    const response = await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '160.83.1.5');

    expect(response.status).toBe(403);
  });

  it('allows requests forwarded from a VPC public range when env covers it', async () => {
    process.env.INTERNAL_NETWORK_EXTRA_CIDRS = '160.83.0.0/16';

    await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '160.83.1.5')
      .expect(200, { ok: true });
  });

  it('still rejects forwarded chains containing IPs outside all allowlists', async () => {
    process.env.INTERNAL_NETWORK_EXTRA_CIDRS = '160.83.0.0/16';

    const response = await request(createApp())
      .get('/internal-only')
      .set('x-forwarded-for', '203.0.113.10, 160.83.1.5');

    expect(response.status).toBe(403);
  });
});
