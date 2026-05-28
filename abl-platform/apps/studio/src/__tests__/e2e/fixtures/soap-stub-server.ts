/**
 * SOAP Stub Server Fixture
 *
 * Two Express servers on random ports:
 * - SOAP 1.1 (text/xml; charset=utf-8)
 * - SOAP 1.2 (application/soap+xml; charset=utf-8)
 *
 * Each server records inbound requests for test assertion.
 */

import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SoapStubRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

export interface SoapStubServer {
  server11: Server; // SOAP 1.1
  server12: Server; // SOAP 1.2
  port11: number;
  port12: number;
  capturedRequests: SoapStubRequest[];
  stop: () => Promise<void>;
}

// ─── SOAP Response Templates ───────────────────────────────────────────────

function soap11SuccessEnvelope(operationName: string, content: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap:Header/>',
    '  <soap:Body>',
    `    <${operationName}Response><${operationName}Result>${content}</${operationName}Result></${operationName}Response>`,
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

function soap11FaultEnvelope(faultCode: string, faultString: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap:Body>',
    '    <soap:Fault>',
    `      <faultcode>${faultCode}</faultcode>`,
    `      <faultstring>${faultString}</faultstring>`,
    '    </soap:Fault>',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

function soap12SuccessEnvelope(operationName: string, content: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">',
    '  <env:Header/>',
    '  <env:Body>',
    `    <${operationName}Response><Result>${content}</Result></${operationName}Response>`,
    '  </env:Body>',
    '</env:Envelope>',
  ].join('\n');
}

function soap12FaultEnvelope(code: string, reason: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">',
    '  <env:Body>',
    '    <env:Fault>',
    '      <env:Code><env:Value>env:Receiver</env:Value></env:Code>',
    `      <env:Reason><env:Text xml:lang="en">${reason}</env:Text></env:Reason>`,
    '    </env:Fault>',
    '  </env:Body>',
    '</env:Envelope>',
  ].join('\n');
}

function soap11PolicyResponse(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap:Header/>',
    '  <soap:Body>',
    '    <LookupPolicyResponse>',
    '      <PolicyResult>',
    '        <PolicyNumber>P-12345</PolicyNumber>',
    '        <Status>active</Status>',
    '        <Holder>Jane Doe</Holder>',
    '      </PolicyResult>',
    '    </LookupPolicyResponse>',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function normalizeHeaders(headers: ExpressRequest['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return [[key.toLowerCase(), value.join(', ')]];
      }
      if (typeof value === 'undefined') {
        return [];
      }
      return [[key.toLowerCase(), String(value)]];
    }),
  );
}

function captureRequest(captured: SoapStubRequest[], req: ExpressRequest, rawBody: string): void {
  captured.push({
    method: req.method,
    path: req.path,
    headers: normalizeHeaders(req.headers),
    body: rawBody,
    timestamp: Date.now(),
  });
}

// ─── Factory ────────────────────────────────────────────────────────────────

export async function createSoapStubServer(): Promise<SoapStubServer> {
  const capturedRequests: SoapStubRequest[] = [];

  // --- SOAP 1.1 server ---
  const app11 = express();
  // Use raw text parser for XML bodies
  app11.use(
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }),
  );
  // Fallback for any content type — ensure body is a string
  app11.use(express.text({ type: '*/*', limit: '1mb' }));

  app11.post('/Echo', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    // Extract the inner content between <Message> tags if present
    const messageMatch = rawBody.match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
    const echoData = messageMatch ? messageMatch[1] : 'echo-default';

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(soap11SuccessEnvelope('Echo', echoData));
  });

  app11.post('/PolicyService/LookupPolicy', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(soap11PolicyResponse());
  });

  app11.post('/Fault', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.status(200).send(soap11FaultEnvelope('soap:Server', 'Policy not found'));
  });

  app11.post('/FaultHttp500', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.status(500).send(soap11FaultEnvelope('soap:Server', 'Internal server error'));
  });

  app11.get('/captured-requests', (_req: ExpressRequest, res: ExpressResponse) => {
    res.json(capturedRequests);
  });

  // --- SOAP 1.2 server ---
  const app12 = express();
  app12.use(
    express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }),
  );
  app12.use(express.text({ type: '*/*', limit: '1mb' }));

  app12.post('/Echo12', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    const messageMatch = rawBody.match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
    const echoData = messageMatch ? messageMatch[1] : 'echo-12-default';

    res.set('Content-Type', 'application/soap+xml; charset=utf-8');
    res.send(soap12SuccessEnvelope('Echo12', echoData));
  });

  app12.post('/Fault12', (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    captureRequest(capturedRequests, req, rawBody);

    res.set('Content-Type', 'application/soap+xml; charset=utf-8');
    res.status(200).send(soap12FaultEnvelope('env:Receiver', 'Service unavailable'));
  });

  app12.get('/captured-requests', (_req: ExpressRequest, res: ExpressResponse) => {
    res.json(capturedRequests);
  });

  // --- Start both servers on random ports ---
  const server11 = await listenOnRandomPort(app11);
  const server12 = await listenOnRandomPort(app12);

  const port11 = (server11.address() as AddressInfo).port;
  const port12 = (server12.address() as AddressInfo).port;

  return {
    server11,
    server12,
    port11,
    port12,
    capturedRequests,
    stop: () =>
      stopSoapStubServer({
        server11,
        server12,
        port11,
        port12,
        capturedRequests,
        stop: async () => {},
      }),
  };
}

export async function stopSoapStubServer(s: SoapStubServer): Promise<void> {
  await Promise.all([closeServer(s.server11), closeServer(s.server12)]);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function listenOnRandomPort(app: express.Express): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
