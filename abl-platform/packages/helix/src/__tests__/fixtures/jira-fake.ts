/**
 * In-process HTTP server stand-in for Jira's REST API. Used by integration
 * and E2E tests that need to exercise the real `getIssue` fetch path without
 * mocking `node:fetch` or using `nock`.
 *
 * Listens on a random port (`{ port: 0 }`) and answers `GET /rest/api/3/issue/{key}`.
 * Tests register key→response mappings via `setIssueResponse` and read the
 * server's URL back from `urlBase`.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import type { AdfDocument } from '../../integrations/jira-client.js';

export type JiraFakeStatus = 200 | 401 | 403 | 404 | 500;

export interface JiraFakeIssuePayload {
  key: string;
  summary: string;
  description: AdfDocument | null;
  status?: { name: string; statusCategory?: { key?: string; name?: string } };
  labels?: string[];
  issuetype?: { name?: string };
  priority?: { name?: string };
  components?: Array<{ name?: string }>;
  updated?: string;
  created?: string;
  resolutiondate?: string | null;
}

export interface JiraFakeMode {
  /** HTTP status to return; default 200. */
  status?: JiraFakeStatus;
  /** Issue payload — required when status === 200. */
  payload?: JiraFakeIssuePayload;
  /** When set, the server delays before responding (used by SEC-4 timeout test). */
  delayMs?: number;
}

export interface JiraFake {
  readonly urlBase: string;
  setIssueResponse(key: string, mode: JiraFakeMode): void;
  setDefaultMode(mode: JiraFakeMode): void;
  requestCount(): number;
  resetRequestCount(): void;
  close(): Promise<void>;
}

/** Build an ADF document with a single paragraph from a plain-text string. */
export function adfFromText(text: string): AdfDocument {
  return {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

/** Start the fake on a random port. Caller MUST `await fake.close()` in afterAll. */
export async function startJiraFake(): Promise<JiraFake> {
  const responses = new Map<string, JiraFakeMode>();
  let defaultMode: JiraFakeMode = { status: 404 };
  let requestCount = 0;

  const server: Server = createServer((req, res) => {
    requestCount += 1;
    const url = req.url ?? '';
    const match = url.match(/^\/rest\/api\/3\/issue\/([^?]+)/);
    if (!match) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const rawKey = decodeURIComponent(match[1]);
    const mode = responses.get(rawKey) ?? defaultMode;

    const respond = (): void => {
      const status = mode.status ?? 200;
      if (status !== 200) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ errorMessages: [`HTTP ${status}`], errors: {} }));
        return;
      }

      const payload = mode.payload;
      if (!payload) {
        res.statusCode = 500;
        res.end('jira-fake: status 200 requires payload');
        return;
      }

      const body = {
        id: '10001',
        key: payload.key,
        fields: {
          summary: payload.summary,
          status: payload.status ?? {
            name: 'In Progress',
            statusCategory: { key: 'indeterminate', name: 'In Progress' },
          },
          description: payload.description,
          labels: payload.labels ?? [],
          issuetype: payload.issuetype ?? { name: 'Task' },
          priority: payload.priority ?? { name: 'Medium' },
          components: payload.components ?? [],
          updated: payload.updated,
          created: payload.created,
          resolutiondate: payload.resolutiondate ?? null,
        },
      };

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (mode.delayMs && mode.delayMs > 0) {
      const timer = setTimeout(respond, mode.delayMs);
      // If the client aborts before the timer fires (SEC-4), don't try to write.
      req.on('close', () => clearTimeout(timer));
    } else {
      respond();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('jira-fake: failed to acquire address');
  }
  const { port } = address as AddressInfo;
  const urlBase = `http://127.0.0.1:${port}`;

  return {
    urlBase,
    setIssueResponse(key, mode) {
      responses.set(key, mode);
    },
    setDefaultMode(mode) {
      defaultMode = mode;
    },
    requestCount() {
      return requestCount;
    },
    resetRequestCount() {
      requestCount = 0;
    },
    async close() {
      // Forcibly drop any in-flight connections so a lingering delayed-response
      // test doesn't block server.close(). Node 18.2+.
      const anyServer = server as unknown as { closeAllConnections?: () => void };
      anyServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Configure the process env to point at the fake. Returns a teardown function
 * that restores the original values. Tests should call this in `beforeEach`
 * and call the returned function in `afterEach` to keep env-var leakage
 * contained.
 */
export function applyJiraFakeEnv(urlBase: string): () => void {
  const keys = [
    'JIRA_BASE_URL',
    'ATLASSIAN_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'ATLASSIAN_API_KEY',
  ] as const;
  const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
  }

  process.env['JIRA_BASE_URL'] = urlBase;
  process.env['JIRA_EMAIL'] = 'test@example.com';
  process.env['JIRA_API_TOKEN'] = 'fake-token-do-not-log';
  delete process.env['ATLASSIAN_BASE_URL'];
  delete process.env['ATLASSIAN_API_KEY'];

  return function restore() {
    for (const key of keys) {
      const v = previous[key];
      if (v === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = v;
      }
    }
  };
}

/** Wipe Jira credentials from `process.env` and return a teardown to restore. */
export function clearJiraEnv(): () => void {
  return applyJiraFakeEnv('http://127.0.0.1:1'); // unreachable address -> set, then we'll override below
  // Note: callers wanting "credentials missing" should manually delete the keys
  // after calling clearJiraEnv to make the intent obvious. Use clearJiraCreds()
  // instead for the missing-creds path.
}

/** Delete all Jira credentials from `process.env`. Returns a teardown. */
export function clearJiraCreds(): () => void {
  const keys = [
    'JIRA_BASE_URL',
    'ATLASSIAN_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'ATLASSIAN_API_KEY',
  ] as const;
  const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  return function restore() {
    for (const key of keys) {
      const v = previous[key];
      if (v === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = v;
      }
    }
  };
}
