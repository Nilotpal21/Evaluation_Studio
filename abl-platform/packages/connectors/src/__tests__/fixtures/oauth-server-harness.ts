/**
 * OAuth2 Token Server Harness for Testing
 *
 * An HTTP server that mimics an OAuth2 token endpoint. Uses Node's built-in
 * http module (no Express dependency in this package). Listens on a random
 * port and allows tests to configure token responses, inject errors, and
 * inspect recorded token requests.
 */

import http from 'http';

export interface OAuthServerHarness {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  setTokenResponse(response: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }): void;
  setTokenError(error: { error: string; error_description: string }, statusCode?: number): void;
  getTokenRequests(): Array<{
    grant_type: string;
    code?: string;
    refresh_token?: string;
  }>;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_TOKEN_RESPONSE = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
};

export async function startOAuthServerHarness(): Promise<OAuthServerHarness> {
  let tokenResponse: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  } = { ...DEFAULT_TOKEN_RESPONSE };
  let tokenError: {
    error: string;
    error_description: string;
  } | null = null;
  let errorStatusCode = 400;
  let tokenRequests: Array<{
    grant_type: string;
    code?: string;
    refresh_token?: string;
  }> = [];

  const server = http.createServer((req, res) => {
    // Only handle POST /oauth/token
    if (req.method === 'POST' && req.url === '/oauth/token') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        // Parse form-encoded or JSON body
        let parsed: Record<string, string> = {};
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          try {
            parsed = JSON.parse(body) as Record<string, string>;
          } catch {
            parsed = {};
          }
        } else {
          // application/x-www-form-urlencoded
          const params = new URLSearchParams(body);
          for (const [key, value] of params.entries()) {
            parsed[key] = value;
          }
        }

        // Record the request
        tokenRequests.push({
          grant_type: parsed.grant_type ?? '',
          ...(parsed.code !== undefined ? { code: parsed.code } : {}),
          ...(parsed.refresh_token !== undefined ? { refresh_token: parsed.refresh_token } : {}),
        });

        // Respond with error or success
        if (tokenError !== null) {
          res.writeHead(errorStatusCode, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify(tokenError));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tokenResponse));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  // Start listening on a random port
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://localhost:${port}`;

  return {
    get baseUrl() {
      return baseUrl;
    },
    get tokenUrl() {
      return `${baseUrl}/oauth/token`;
    },

    setTokenResponse(response) {
      tokenResponse = response;
      tokenError = null;
    },

    setTokenError(error, statusCode) {
      tokenError = error;
      errorStatusCode = statusCode ?? 400;
    },

    getTokenRequests() {
      return [...tokenRequests];
    },

    reset() {
      tokenRequests = [];
      tokenResponse = { ...DEFAULT_TOKEN_RESPONSE };
      tokenError = null;
      errorStatusCode = 400;
    },

    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
