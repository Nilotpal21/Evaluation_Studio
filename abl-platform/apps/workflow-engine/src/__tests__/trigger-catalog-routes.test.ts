/**
 * Unit tests for trigger-catalog route.
 *
 * The route exposes connectors (from the live ConnectorRegistry) that have
 * at least one workflow trigger, along with a trimmed trigger summary. The
 * tests seed a registry with known connectors and assert the shape/contract
 * via supertest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConnectorRegistry } from '@agent-platform/connectors';
import {
  createTriggerCatalogRouter,
  type TriggerCatalogRouteDeps,
} from '../routes/trigger-catalog.js';

function makeDeps(): TriggerCatalogRouteDeps {
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
    actions: [],
  });
  // Intentionally register a connector with NO triggers — it must be filtered out.
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

function createApp(deps: TriggerCatalogRouteDeps) {
  const app = express();
  app.use(express.json());
  app.use('/api/trigger-catalog', createTriggerCatalogRouter(deps));
  return app;
}

describe('Trigger Catalog Route', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp(makeDeps());
  });

  it('GET / returns 200 with success envelope', async () => {
    const res = await request(app).get('/api/trigger-catalog');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('only includes connectors that have at least one trigger', async () => {
    const res = await request(app).get('/api/trigger-catalog');
    const names: string[] = res.body.data.map((c: { name: string }) => c.name);
    expect(names).toContain('slack');
    expect(names).not.toContain('github');
  });

  it('each connector exposes name, displayName, description, auth, triggers', async () => {
    const res = await request(app).get('/api/trigger-catalog');
    for (const connector of res.body.data) {
      expect(typeof connector.name).toBe('string');
      expect(typeof connector.displayName).toBe('string');
      expect(typeof connector.description).toBe('string');
      expect(connector.auth).toBeTruthy();
      expect(Array.isArray(connector.triggers)).toBe(true);
    }
  });

  it('each trigger exposes name, displayName, description, triggerType', async () => {
    const res = await request(app).get('/api/trigger-catalog');
    for (const connector of res.body.data) {
      for (const trigger of connector.triggers) {
        expect(typeof trigger.name).toBe('string');
        expect(typeof trigger.displayName).toBe('string');
        expect(typeof trigger.description).toBe('string');
        expect(['webhook', 'cron', 'event']).toContain(trigger.triggerType);
      }
    }
  });

  it('catalog contents are stable across calls (idempotent)', async () => {
    const a = await request(app).get('/api/trigger-catalog');
    const b = await request(app).get('/api/trigger-catalog');
    expect(a.body).toEqual(b.body);
  });
});
