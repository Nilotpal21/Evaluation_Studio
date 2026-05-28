import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { sendBinaryResponse, sendXmlResponse } from '../../routes/response-utils.js';

describe('response-utils', () => {
  it('sends binary responses with nosniff and custom headers', async () => {
    const app = express();
    app.get('/audio', (_req, res) => {
      sendBinaryResponse(res, Buffer.from('wav-bytes'), {
        contentType: 'audio/wav',
        status: 202,
        headers: {
          'X-Test-Header': 'audio',
        },
      });
    });

    const response = await request(app).get('/audio').expect(202);

    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength('wav-bytes')));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-test-header']).toBe('audio');
    expect(Buffer.from(response.body).toString('utf8')).toBe('wav-bytes');
  });

  it('sends XML responses as UTF-8 text with nosniff', async () => {
    const app = express();
    app.get('/xml', (_req, res) => {
      sendXmlResponse(res, '<Response><Connect /></Response>');
    });

    const response = await request(app).get('/xml').expect(200);

    expect(response.headers['content-type']).toContain('text/xml; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.text).toBe('<Response><Connect /></Response>');
  });
});
