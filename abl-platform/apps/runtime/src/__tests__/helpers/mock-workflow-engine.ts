/**
 * Mock Workflow Engine Server
 *
 * A small Express server that mimics the workflow-engine HTTP API for E2E tests.
 * Used as the target for runtime's workflow-engine-proxy.ts when testing proxy
 * routes end-to-end with a real runtime server and real MongoDB.
 *
 * This is NOT a vi.mock — it is a real HTTP server started on a random port,
 * injected via the WORKFLOW_ENGINE_URL env var before the runtime server loads.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import type { Request, Response } from 'express';

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface MockWorkflowEngine {
  app: express.Express;
  server: http.Server;
  baseUrl: string;
  /** All recorded requests, newest last. */
  requests: RecordedRequest[];
  /** Last request received (shorthand for requests[requests.length - 1]). */
  lastRequest: RecordedRequest | null;
  /** Clear recorded requests. */
  reset: () => void;
  /** Start the server on a random port. */
  start: () => Promise<void>;
  /** Stop the server. */
  close: () => Promise<void>;
}

/**
 * Create a mock workflow engine that records all incoming requests and
 * returns configurable responses. All endpoints return 200 with
 * `{ success: true, data: ... }` by default.
 */
export function createMockWorkflowEngine(): MockWorkflowEngine {
  const engineApp = express();
  engineApp.use(express.json());

  const state: MockWorkflowEngine = {
    app: engineApp,
    server: null as unknown as http.Server,
    baseUrl: '',
    requests: [],
    lastRequest: null,
    reset: () => {
      state.requests = [];
      state.lastRequest = null;
    },
    start: async () => {
      await new Promise<void>((resolve) => {
        state.server = http.createServer(engineApp);
        state.server.listen(0, '127.0.0.1', () => {
          const addr = state.server.address() as AddressInfo;
          state.baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        state.server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };

  /** Record every request for assertion. */
  function record(req: Request): void {
    const entry: RecordedRequest = {
      method: req.method,
      path: req.path,
      params: { ...req.params },
      query: req.query as Record<string, string>,
      body: req.body,
      headers: req.headers as Record<string, string | string[] | undefined>,
    };
    state.requests.push(entry);
    state.lastRequest = entry;
  }

  // ─── Execution Routes ─────────────────────────────────────────────────────

  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/execute',
    (req: Request, res: Response) => {
      record(req);
      const executionId = req.body?.executionId ?? 'mock-exec-id';
      res.json({ success: true, data: { executionId } });
    },
  );

  engineApp.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: [] });
    },
  );

  engineApp.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId',
    (req: Request, res: Response) => {
      record(req);
      res.json({
        success: true,
        data: {
          _id: req.params.executionId,
          workflowId: req.params.workflowId,
          status: 'completed',
          steps: [],
        },
      });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, message: 'Execution cancelled' });
    },
  );

  // ─── Approval Routes ──────────────────────────────────────────────────────

  engineApp.get('/api/v1/projects/:projectId/approvals', (req: Request, res: Response) => {
    record(req);
    res.json({ success: true, data: [] });
  });

  engineApp.post(
    '/api/v1/projects/:projectId/approvals/:workflowId/executions/:executionId/steps/:stepId/approve',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  // ─── Trigger Routes ───────────────────────────────────────────────────────

  engineApp.get('/api/v1/projects/:projectId/triggers', (req: Request, res: Response) => {
    record(req);
    res.json({ success: true, data: [] });
  });

  engineApp.post('/api/v1/projects/:projectId/triggers', (req: Request, res: Response) => {
    record(req);
    res.json({ success: true, data: { _id: 'mock-trigger-id', ...req.body } });
  });

  engineApp.delete(
    '/api/v1/projects/:projectId/triggers/:registrationId',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/triggers/:registrationId/pause',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/triggers/:registrationId/resume',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/triggers/:registrationId/fire',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: { executionId: 'mock-fired-exec-id' } });
    },
  );

  // ─── Connector Routes ─────────────────────────────────────────────────────

  engineApp.get('/api/v1/connectors', (req: Request, res: Response) => {
    record(req);
    res.json({
      success: true,
      data: [
        { name: 'slack', displayName: 'Slack', description: 'Slack integration' },
        { name: 'github', displayName: 'GitHub', description: 'GitHub integration' },
      ],
    });
  });

  engineApp.get('/api/v1/connectors/:connectorName', (req: Request, res: Response) => {
    record(req);
    res.json({
      success: true,
      data: {
        name: req.params.connectorName,
        displayName: req.params.connectorName,
        actions: [],
      },
    });
  });

  engineApp.get('/api/v1/connectors/:connectorName/actions', (req: Request, res: Response) => {
    record(req);
    res.json({
      success: true,
      data: [
        { name: 'send_message', displayName: 'Send Message' },
        { name: 'list_channels', displayName: 'List Channels' },
      ],
    });
  });

  // ─── Notification Rule Routes ─────────────────────────────────────────────

  engineApp.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/notifications',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: [] });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/notifications',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: { _id: 'mock-rule-id', ...req.body } });
    },
  );

  engineApp.put(
    '/api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: { _id: req.params.ruleId, ...req.body } });
    },
  );

  engineApp.delete(
    '/api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/notifications/:ruleId/test',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true, data: { delivered: true } });
    },
  );

  // ─── Human Task Resolution Routes (engine-side) ───────────────────────────

  engineApp.post(
    '/api/v1/projects/:projectId/human-tasks/executions/:executionId/steps/:stepId/resolve',
    (req: Request, res: Response) => {
      record(req);
      res.json({ success: true });
    },
  );

  // ─── Trigger Catalog ──────────────────────────────────────────────────────
  // Real engine path: /api/v1/connectors/triggers/catalog (mounted from
  // `createTriggerCatalogRouter` before /api/v1/connectors).
  engineApp.get('/api/v1/connectors/triggers/catalog', (req: Request, res: Response) => {
    record(req);
    res.json({
      success: true,
      data: [
        {
          name: 'slack',
          displayName: 'Slack',
          description: 'Slack integration',
          auth: { type: 'oauth2' },
          triggers: [
            {
              name: 'new_message',
              displayName: 'New Message',
              description: 'Triggered when a new message arrives',
              strategy: 'webhook',
            },
          ],
        },
        {
          name: 'github',
          displayName: 'GitHub',
          description: 'GitHub integration',
          auth: { type: 'oauth2' },
          triggers: [
            {
              name: 'new_issue',
              displayName: 'New Issue',
              description: 'Triggered when an issue is opened',
              strategy: 'webhook',
            },
          ],
        },
      ],
    });
  });

  // Legacy stale path kept for any test that still references it.
  engineApp.get('/api/v1/trigger-catalog', (req: Request, res: Response) => {
    record(req);
    res.json({
      success: true,
      data: [
        { type: 'webhook', displayName: 'Webhook' },
        { type: 'cron', displayName: 'Cron Schedule' },
        { type: 'event', displayName: 'Event' },
      ],
    });
  });

  return state;
}
