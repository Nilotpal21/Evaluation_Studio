import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConnectorRegistry } from '@agent-platform/connectors';
import type { ConnectorAction, DropdownState } from '@agent-platform/connectors';
import type { ConnectionResolver } from '@agent-platform/connectors/auth';
import { createConnectorRouter, type ConnectorRouteDeps } from '../routes/connectors.js';

function makeDeps(): ConnectorRouteDeps {
  const registry = new ConnectorRegistry();
  registry.register({
    name: 'slack',
    displayName: 'Slack',
    version: '1.0.0',
    description: 'Slack integration',
    auth: { type: 'oauth2' },
    triggers: [
      {
        name: 'new_message',
        displayName: 'New Message',
        description: 'Triggers on new message',
        triggerType: 'webhook' as const,
        props: [
          { name: 'channel', type: 'string' as const, displayName: 'Channel', required: true },
        ],
        onEnable: async () => {},
        onDisable: async () => {},
        run: async () => [],
      },
    ],
    actions: [
      {
        name: 'send_message',
        displayName: 'Send Message',
        description: 'Sends a message',
        props: [{ name: 'text', type: 'string' as const, displayName: 'Text', required: true }],
        execute: async () => ({ success: true, data: {} }),
      },
    ],
  });
  registry.register({
    name: 'github',
    displayName: 'GitHub',
    version: '1.0.0',
    description: 'GitHub integration',
    auth: { type: 'oauth2' },
    triggers: [],
    actions: [],
  });
  return { registry };
}

function createApp(deps: ConnectorRouteDeps) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantContext = { tenantId: 't1' };
    next();
  });
  app.use('/api/connectors', createConnectorRouter(deps));
  return app;
}

describe('Connector Routes', () => {
  let deps: ConnectorRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  describe('GET /connectors', () => {
    it('lists all registered connectors', async () => {
      const res = await request(app).get('/api/connectors');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('includes connector metadata', async () => {
      const res = await request(app).get('/api/connectors');
      const slack = res.body.data.find((c: any) => c.name === 'slack');
      expect(slack.displayName).toBe('Slack');
      expect(slack.auth.type).toBe('oauth2');
      expect(slack.triggers).toHaveLength(1);
      expect(slack.actions).toHaveLength(1);
    });

    it('includes trigger details', async () => {
      const res = await request(app).get('/api/connectors');
      const slack = res.body.data.find((c: any) => c.name === 'slack');
      expect(slack.triggers[0]).toMatchObject({
        name: 'new_message',
        triggerType: 'webhook',
      });
    });

    it('includes action details', async () => {
      const res = await request(app).get('/api/connectors');
      const slack = res.body.data.find((c: any) => c.name === 'slack');
      expect(slack.actions[0]).toMatchObject({
        name: 'send_message',
        displayName: 'Send Message',
      });
    });
  });

  describe('GET /connectors/:connectorName', () => {
    it('returns a specific connector', async () => {
      const res = await request(app).get('/api/connectors/slack');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('slack');
    });

    it('returns 404 for unknown connector', async () => {
      const res = await request(app).get('/api/connectors/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /connectors/:connectorName/actions/:actionName/props/:propName/options', () => {
    function makeDepsWithDropdownAction(resolveOptions?: ConnectorAction['resolveOptions']) {
      const registry = new ConnectorRegistry();
      registry.register({
        name: 'google-sheets',
        displayName: 'Google Sheets',
        version: '1.0.0',
        description: '',
        auth: { type: 'oauth2' },
        triggers: [],
        actions: [
          {
            name: 'add_row',
            displayName: 'Add Row',
            description: '',
            props: [
              {
                name: 'sheetId',
                displayName: 'Sheet',
                type: 'dropdown',
                required: true,
                refreshers: ['spreadsheetId'],
              },
            ],
            async run() {
              return null;
            },
            resolveOptions,
          },
        ],
      });

      const connectionResolver: ConnectionResolver = {
        resolve: vi.fn(async () => ({
          connection: {
            _id: 'conn-1',
            tenantId: 't1',
            projectId: 'p1',
            connectorName: 'google-sheets',
            authProfileId: 'ap-1',
            scope: 'tenant',
            status: 'active',
          },
          scope: 'tenant' as const,
        })),
        resolveAuth: vi.fn(async () => ({ access_token: 'tok' })),
      } as unknown as ConnectionResolver;

      return { registry, connectionResolver };
    }

    it('returns 400 when body is missing projectId or connectionId', async () => {
      const depsLocal = makeDepsWithDropdownAction(async () => ({
        disabled: false,
        options: [],
      }));
      const appLocal = createApp(depsLocal);
      const res = await request(appLocal)
        .post('/api/connectors/google-sheets/actions/add_row/props/sheetId/options')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns the resolved dropdown state on success', async () => {
      const options: DropdownState = {
        disabled: false,
        options: [{ label: 'Sheet1', value: 'sheet-1' }],
      };
      const resolveOptions = vi.fn(async () => options);
      const depsLocal = makeDepsWithDropdownAction(resolveOptions);
      const appLocal = createApp(depsLocal);

      const res = await request(appLocal)
        .post('/api/connectors/google-sheets/actions/add_row/props/sheetId/options')
        .send({
          projectId: 'p1',
          connectionId: 'conn-1',
          propsValue: { spreadsheetId: 'sheet-abc' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(options);
      expect(resolveOptions).toHaveBeenCalledWith(
        'sheetId',
        expect.objectContaining({
          auth: { access_token: 'tok' },
          propsValue: { spreadsheetId: 'sheet-abc' },
        }),
      );
    });

    it('returns 404 when the prop is not dynamic', async () => {
      // Registered action has no resolveOptions → PROP_NOT_DYNAMIC
      const depsLocal = makeDepsWithDropdownAction(undefined);
      const appLocal = createApp(depsLocal);

      const res = await request(appLocal)
        .post('/api/connectors/google-sheets/actions/add_row/props/sheetId/options')
        .send({ projectId: 'p1', connectionId: 'conn-1' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROP_NOT_DYNAMIC');
    });

    it('returns 502 when the underlying resolver throws', async () => {
      const depsLocal = makeDepsWithDropdownAction(async () => {
        throw new Error('upstream 401');
      });
      const appLocal = createApp(depsLocal);

      const res = await request(appLocal)
        .post('/api/connectors/google-sheets/actions/add_row/props/sheetId/options')
        .send({ projectId: 'p1', connectionId: 'conn-1' });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('RESOLVE_FAILED');
    });

    it('returns 501 when connectionResolver is not configured', async () => {
      const registryOnly: ConnectorRouteDeps = { registry: new ConnectorRegistry() };
      registryOnly.registry.register({
        name: 'google-sheets',
        displayName: 'Google Sheets',
        version: '1.0.0',
        description: '',
        auth: { type: 'oauth2' },
        triggers: [],
        actions: [],
      });
      const appLocal = createApp(registryOnly);

      const res = await request(appLocal)
        .post('/api/connectors/google-sheets/actions/add_row/props/sheetId/options')
        .send({ projectId: 'p1', connectionId: 'conn-1' });

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    });
  });

  describe('GET /connectors/:connectorName/actions', () => {
    it('returns the connector actions (with props) and nothing else', async () => {
      const res = await request(app).get('/api/connectors/slack/actions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        name: 'send_message',
        displayName: 'Send Message',
      });
      expect(res.body.data[0].props).toEqual([
        { name: 'text', type: 'string', displayName: 'Text', required: true },
      ]);
    });

    it('returns an empty array for connectors with no actions', async () => {
      const res = await request(app).get('/api/connectors/github/actions');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns 404 CONNECTOR_NOT_FOUND for an unknown connector', async () => {
      const res = await request(app).get('/api/connectors/nonexistent/actions');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONNECTOR_NOT_FOUND');
    });
  });
});
