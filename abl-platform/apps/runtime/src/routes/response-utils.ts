import type { Response } from 'express';

interface ResponseOptions {
  contentType: string;
  status?: number;
  headers?: Record<string, string>;
}

function applyHeaders(res: Response, headers?: Record<string, string>): void {
  if (!headers) {
    return;
  }

  for (const [header, value] of Object.entries(headers)) {
    res.setHeader(header, value);
  }
}

export function sendBinaryResponse(
  res: Response,
  body: Buffer,
  { contentType, status = 200, headers }: ResponseOptions,
): void {
  res.status(status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  applyHeaders(res, headers);
  res.end(body);
}

export function sendTextResponse(res: Response, body: string, options: ResponseOptions): void {
  sendBinaryResponse(res, Buffer.from(body, 'utf8'), options);
}

export function sendXmlResponse(
  res: Response,
  xml: string,
  status = 200,
  headers?: Record<string, string>,
): void {
  sendTextResponse(res, xml, {
    contentType: 'text/xml; charset=utf-8',
    status,
    headers,
  });
}
