/**
 * Mock HTTP tool server for E2E functional tests.
 * Serves a simple weather API for scenario 7.
 */

import { createServer } from 'node:http';
import type { MockToolServer } from './types.js';

export async function startMockToolServer(): Promise<MockToolServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/weather' && req.method === 'GET') {
      const city = url.searchParams.get('city') ?? '';

      const response =
        city.toLowerCase() === 'paris'
          ? { temp: 22, condition: 'sunny', city: 'Paris' }
          : { temp: 15, condition: 'cloudy', city: city || 'Unknown' };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
