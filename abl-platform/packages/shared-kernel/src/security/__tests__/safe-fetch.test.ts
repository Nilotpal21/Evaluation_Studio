import http, { type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import * as safeFetchModule from '../safe-fetch.js';
import * as securityBarrel from '../index.js';
import type { SafeFetchDnsLookup, SafeFetchOptions } from '../safe-fetch.js';

type SafeFetch = (
  url: string | URL,
  init?: RequestInit,
  options?: SafeFetchOptions,
) => Promise<Response>;

const servers: Server[] = [];

function getSafeFetch(): SafeFetch {
  const safeFetch = (safeFetchModule as Record<string, unknown>).safeFetch;
  expect(
    safeFetch,
    'safeFetch must be exported from shared-kernel/security/safe-fetch so callers cannot validate once and then delegate DNS resolution or redirects to native fetch',
  ).toBeTypeOf('function');
  return safeFetch as SafeFetch;
}

async function startRedirectServer(location: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: location });
    res.end();
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test redirect server did not bind to a TCP port');
  }

  return `http://127.0.0.1:${address.port}/redirect`;
}

async function startTextServer(text: string): Promise<{
  url: string;
  requests: Array<{ host?: string }>;
}> {
  const requests: Array<{ host?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(text);
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test text server did not bind to a TCP port');
  }

  return { url: `http://safe-fetch.test:${address.port}/ok`, requests };
}

async function startLoopRedirectServer(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test loop redirect server did not bind to a TCP port');
  }

  return `http://127.0.0.1:${address.port}/loop`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe('safeFetch SSRF wrapper', () => {
  it('is exported from the dedicated safe-fetch subpath', () => {
    getSafeFetch();
  });

  it('is NOT exported from the security barrel (would pull node:dns/promises into client bundles)', () => {
    expect(
      (securityBarrel as Record<string, unknown>).safeFetch,
      'safeFetch must stay out of the security barrel — it imports node:dns/promises at module top level which breaks Studio Turbopack client bundling',
    ).toBeUndefined();
  });

  it('re-validates redirect locations before following them', async () => {
    const safeFetch = getSafeFetch();
    const url = await startRedirectServer('http://169.254.169.254/latest/meta-data/');

    await expect(safeFetch(url, undefined, { allowLocalhost: true })).rejects.toThrow(
      /metadata|ssrf|blocked|redirect/i,
    );
  });

  it('caps redirect depth', async () => {
    const safeFetch = getSafeFetch();
    const url = await startLoopRedirectServer();

    await expect(
      safeFetch(url, undefined, { allowLocalhost: true, maxRedirects: 1 }),
    ).rejects.toThrow(/too many redirects/i);
  });

  it('blocks hostnames that resolve to metadata addresses before connecting', async () => {
    const safeFetch = getSafeFetch();
    const dnsLookup: SafeFetchDnsLookup = async () => [{ address: '169.254.169.254', family: 4 }];

    await expect(safeFetch('http://safe.example.test/', undefined, { dnsLookup })).rejects.toThrow(
      /blocked|metadata|private/i,
    );
  });

  it('pins the validated DNS answer for the socket connection', async () => {
    const safeFetch = getSafeFetch();
    const server = await startTextServer('pinned-ok');
    let lookupCalls = 0;
    const dnsLookup: SafeFetchDnsLookup = async () => {
      lookupCalls += 1;
      return [
        lookupCalls === 1
          ? { address: '127.0.0.1', family: 4 }
          : { address: '10.0.0.1', family: 4 },
      ];
    };

    const response = await safeFetch(server.url, undefined, {
      allowLocalhost: true,
      dnsLookup,
    });

    await expect(response.text()).resolves.toBe('pinned-ok');
    expect(lookupCalls).toBe(1);
    expect(server.requests[0]?.host).toContain('safe-fetch.test');
  });
});
