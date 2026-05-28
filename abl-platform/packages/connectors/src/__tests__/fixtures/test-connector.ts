/**
 * Test connector fixture for integration and E2E tests.
 *
 * Provides two connector variants:
 * - test-connector: api_key auth with echo action and webhook trigger
 * - test-connector-oauth: oauth2 auth with the same action and trigger
 */

import crypto from 'crypto';

import type {
  ActionContext,
  Connector,
  TriggerContext,
  TriggerRunContext,
  WebhookVerifyContext,
} from '../../types.js';
import type { ConnectorRegistry } from '../../registry.js';

// ─── Shared Action ────────────────────────────────────────────────────

function createEchoAction() {
  return {
    name: 'echo',
    displayName: 'Echo',
    description: 'Echoes input and validates auth',
    props: [
      {
        name: 'message',
        displayName: 'Message',
        type: 'string' as const,
        required: true,
      },
    ],
    async run(ctx: ActionContext): Promise<unknown> {
      const providerUrl = ctx.params.providerUrl;
      if (typeof providerUrl === 'string' && providerUrl.length > 0) {
        const response = await fetch(providerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${String(ctx.auth.apiKey ?? '')}`,
          },
          body: JSON.stringify({ message: ctx.params.message }),
        });
        return response.json();
      }
      return { echo: ctx.params.message, auth: 'present' };
    },
  };
}

// ─── Shared Trigger ───────────────────────────────────────────────────

function createOnEventTrigger() {
  return {
    name: 'on_event',
    displayName: 'On Event',
    description: 'Webhook trigger for testing',
    triggerType: 'webhook' as const,
    props: [],
    async onEnable(_ctx: TriggerContext): Promise<void> {
      // No-op for test connector
    },
    async onDisable(_ctx: TriggerContext): Promise<void> {
      // No-op for test connector
    },
    async run(ctx: TriggerRunContext): Promise<unknown[]> {
      return [ctx];
    },
    async verify(ctx: WebhookVerifyContext): Promise<boolean> {
      const signature = ctx.headers['x-signature-256'];
      if (typeof signature !== 'string') {
        return false;
      }
      const secret = String(ctx.auth.apiKey ?? '');
      const hmac = crypto.createHmac('sha256', secret).update(ctx.rawBody).digest();

      // The signature header is expected to be hex-encoded
      const signatureBuffer = Buffer.from(signature, 'hex');
      if (hmac.length !== signatureBuffer.length) {
        return false;
      }
      return crypto.timingSafeEqual(hmac, signatureBuffer);
    },
  };
}

// ─── API Key Test Connector ──────────────────────────────────────────

export const testConnector: Connector = {
  name: 'test-connector',
  displayName: 'Test Connector',
  version: '1.0.0',
  description: 'Test connector for integration and E2E testing',
  auth: {
    type: 'api_key',
    fields: [
      {
        name: 'apiKey',
        displayName: 'API Key',
        required: true,
        sensitive: true,
      },
    ],
  },
  actions: [createEchoAction()],
  triggers: [createOnEventTrigger()],
};

// ─── OAuth2 Test Connector ───────────────────────────────────────────

export const oauth2TestConnector: Connector = {
  name: 'test-connector-oauth',
  displayName: 'Test Connector OAuth',
  version: '1.0.0',
  description: 'OAuth2 test connector for integration and E2E testing',
  auth: {
    type: 'oauth2',
    oauth2: {
      authorizationUrl: 'http://localhost/oauth/authorize',
      tokenUrl: 'http://localhost/oauth/token',
      scopes: ['read', 'write'],
      pkce: false,
    },
    fields: [
      {
        name: 'clientId',
        displayName: 'Client ID',
        required: true,
        sensitive: true,
      },
    ],
  },
  actions: [createEchoAction()],
  triggers: [createOnEventTrigger()],
};

// ─── Registration Helpers ────────────────────────────────────────────

export function registerTestConnector(registry: ConnectorRegistry): void {
  registry.register(testConnector);
}

export function registerOAuth2TestConnector(registry: ConnectorRegistry): void {
  registry.register(oauth2TestConnector);
}
