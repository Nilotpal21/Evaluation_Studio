import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { sendGeneratedExport } from '../export-response.js';

function createResponseRecorder(): {
  body: () => Buffer | undefined;
  headers: Map<string, string | number | readonly string[]>;
  res: Response;
  status: () => number | undefined;
} {
  const headers = new Map<string, string | number | readonly string[]>();
  let body: Buffer | undefined;
  let statusCode: number | undefined;

  const res = {
    end(chunk?: unknown) {
      body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      return this;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value : value);
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
  } as Response;

  return {
    body: () => body,
    headers,
    res,
    status: () => statusCode,
  };
}

describe('sendGeneratedExport', () => {
  it('sends generated data as a sanitized attachment', () => {
    const recorder = createResponseRecorder();

    sendGeneratedExport(recorder.res, {
      contentType: 'text/csv',
      data: 'id,name\n1,Ada',
      filename: 'audit"\r\nbad.csv',
    });

    expect(recorder.status()).toBe(200);
    expect(recorder.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(recorder.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(recorder.headers.get('Content-Disposition')).toBe(
      'attachment; filename="audit___bad.csv"',
    );
    expect(recorder.body()?.toString('utf8')).toBe('id,name\n1,Ada');
  });

  it('falls back to octet stream for unexpected content types', () => {
    const recorder = createResponseRecorder();

    sendGeneratedExport(recorder.res, {
      contentType: 'text/html',
      data: '<script>alert(1)</script>',
      filename: 'report.html',
    });

    expect(recorder.headers.get('Content-Type')).toBe('application/octet-stream; charset=utf-8');
  });
});
