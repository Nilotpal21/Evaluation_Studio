/**
 * Slack Interactive Payload Parsing Tests
 *
 * Slack interactive payloads (block_actions, view_submission) are sent as
 * application/x-www-form-urlencoded with a `payload` field containing
 * URL-encoded JSON. These tests verify that the channel-webhooks router:
 *
 * 1. Parses form-urlencoded bodies via the urlencoded middleware
 * 2. Extracts JSON from the `payload` field
 * 3. Passes the parsed payload to the adapter's buildNormalizedMessage
 * 4. Returns appropriate responses for different payload types
 * 5. Returns 400 for malformed JSON in the payload field
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock connection-resolver: dynamic import in handleWebhookPost
vi.mock('../channels/connection-resolver.js', () => ({
  resolveChannelConnection: vi.fn(),
}));

// Mock channel-queues: dynamic import in handleWebhookPost
vi.mock('../services/queues/channel-queues.js', () => ({
  getInboundQueue: vi.fn(),
}));

// Mock the channel registry to return a controlled Slack adapter
vi.mock('../channels/registry.js', () => {
  const mockAdapter = {
    channelType: 'slack',
    capabilities: {
      supportsAsync: true,
      supportsStreaming: true,
      supportsMedia: true,
      supportsThreading: true,
    },
    verifyRequest: vi.fn().mockResolvedValue(true),
    handleVerificationChallenge: vi.fn().mockReturnValue(null),
    shouldProcess: vi.fn().mockReturnValue(true),
    buildNormalizedMessage: vi.fn().mockReturnValue({
      externalMessageId: 'block_action:tr123',
      externalSessionKey: 'slack:T1:C1',
      text: '',
      actionEvent: {
        type: 'action_event',
        actionId: 'confirm_btn',
        value: 'yes',
        source: 'slack',
      },
      metadata: {
        slackTeamId: 'T1',
        slackChannelId: 'C1',
        slackUserId: 'U1',
        slackEventType: 'block_actions',
      },
      timestamp: new Date(),
    }),
    extractEventId: vi.fn().mockReturnValue(null),
    parseIncoming: vi.fn(),
    sendResponse: vi.fn(),
  };

  const mockRegistry = {
    get: vi.fn().mockReturnValue(mockAdapter),
    has: vi.fn().mockReturnValue(true),
  };

  return {
    getChannelRegistry: vi.fn().mockReturnValue(mockRegistry),
    __mockAdapter: mockAdapter,
    __mockRegistry: mockRegistry,
  };
});

import { resolveChannelConnection } from '../channels/connection-resolver.js';
import { getInboundQueue } from '../services/queues/channel-queues.js';
import { getChannelRegistry, __mockAdapter, __mockRegistry } from '../channels/registry.js';
import type { ResolvedConnection } from '../channels/types.js';

// Import the router under test (after mocks are set up)
import channelWebhooksRouter from '../routes/channel-webhooks.js';

// Extend the mock module type so TS knows about the test helpers
declare module '../channels/registry.js' {
  export const __mockAdapter: {
    channelType: string;
    verifyRequest: ReturnType<typeof vi.fn>;
    handleVerificationChallenge: ReturnType<typeof vi.fn>;
    shouldProcess: ReturnType<typeof vi.fn>;
    buildNormalizedMessage: ReturnType<typeof vi.fn>;
    extractEventId: ReturnType<typeof vi.fn>;
  };
  export const __mockRegistry: {
    get: ReturnType<typeof vi.fn>;
    has: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-slack-001',
    tenantId: 'tenant-001',
    projectId: 'project-001',
    agentId: 'agent-001',
    channelType: 'slack',
    externalIdentifier: 'T1:A1',
    credentials: { signing_secret: 'test-secret' },
    config: {},
    status: 'active',
    ...overrides,
  };
}

function createApp() {
  const app = express();
  // Add JSON body parser (same as real server.ts) so non-form-encoded payloads work
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/channels', channelWebhooksRouter);
  return app;
}

const BLOCK_ACTIONS_PAYLOAD = {
  type: 'block_actions',
  trigger_id: 'tr123',
  user: { id: 'U1', team_id: 'T1', name: 'testuser' },
  team: { id: 'T1' },
  channel: { id: 'C1' },
  actions: [
    {
      type: 'button',
      action_id: 'confirm_btn',
      block_id: 'b1',
      value: 'yes',
    },
  ],
};

const VIEW_SUBMISSION_PAYLOAD = {
  type: 'view_submission',
  trigger_id: 'tr456',
  user: { id: 'U1', team_id: 'T1', name: 'testuser' },
  team: { id: 'T1' },
  view: {
    id: 'V1',
    callback_id: 'feedback_form',
    state: {
      values: {
        block1: {
          rating: { value: '5' },
        },
      },
    },
  },
};

describe('Slack interactive payload parsing (form-urlencoded)', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    (resolveChannelConnection as ReturnType<typeof vi.fn>).mockResolvedValue(makeConnection());
    (getInboundQueue as ReturnType<typeof vi.fn>).mockReturnValue({ add: mockQueueAdd });
  });

  // =========================================================================
  // Happy paths
  // =========================================================================

  it('parses form-encoded block_actions payload and calls buildNormalizedMessage with parsed JSON', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .type('form')
      .send({ payload: JSON.stringify(BLOCK_ACTIONS_PAYLOAD) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Verify buildNormalizedMessage was called with the parsed payload (not the form wrapper)
    expect(__mockAdapter.buildNormalizedMessage).toHaveBeenCalledTimes(1);
    const calledWith = __mockAdapter.buildNormalizedMessage.mock.calls[0][0];
    expect(calledWith.type).toBe('block_actions');
    expect(calledWith.trigger_id).toBe('tr123');
    expect(calledWith.actions[0].action_id).toBe('confirm_btn');
  });

  it('parses form-encoded view_submission and returns response_action: clear', async () => {
    // Override buildNormalizedMessage to return view_submission-specific data
    __mockAdapter.buildNormalizedMessage.mockReturnValueOnce({
      externalMessageId: 'view_submit:tr456',
      externalSessionKey: 'slack:T1:U1',
      text: '',
      actionEvent: {
        type: 'action_event',
        actionId: 'feedback_form',
        formData: { rating: '5' },
        source: 'slack',
      },
      metadata: {
        slackTeamId: 'T1',
        slackUserId: 'U1',
        slackEventType: 'view_submission',
      },
      timestamp: new Date(),
    });

    const app = createApp();

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .type('form')
      .send({ payload: JSON.stringify(VIEW_SUBMISSION_PAYLOAD) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ response_action: 'clear' });

    // Verify the parsed payload was passed
    const calledWith = __mockAdapter.buildNormalizedMessage.mock.calls[0][0];
    expect(calledWith.type).toBe('view_submission');
    expect(calledWith.view.callback_id).toBe('feedback_form');
  });

  it('enqueues the parsed message to BullMQ', async () => {
    const app = createApp();

    await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .type('form')
      .send({ payload: JSON.stringify(BLOCK_ACTIONS_PAYLOAD) });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobPayload] = mockQueueAdd.mock.calls[0];
    expect(jobName).toBe('process-message');
    expect(jobPayload.channelType).toBe('slack');
    expect(jobPayload.tenantId).toBe('tenant-001');
    expect(jobPayload.message.actionEvent.actionId).toBe('confirm_btn');
  });

  // =========================================================================
  // Error paths
  // =========================================================================

  it('returns 400 for invalid JSON in the payload field', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .type('form')
      .send({ payload: '{not valid json!!!' });

    expect(res.status).toBe(400);
    expect(res.text).toBe('Invalid payload');

    // buildNormalizedMessage should NOT have been called
    expect(__mockAdapter.buildNormalizedMessage).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Regular JSON body still works
  // =========================================================================

  it('continues to handle standard JSON event_callback payloads', async () => {
    const eventPayload = {
      type: 'event_callback',
      token: 'tok',
      team_id: 'T1',
      api_app_id: 'A1',
      event: {
        type: 'message',
        channel: 'C1',
        user: 'U1',
        text: 'hello',
        ts: '1234567890.123456',
        event_ts: '1234567890.123456',
      },
      event_id: 'Ev123',
      event_time: 1234567890,
    };

    __mockAdapter.buildNormalizedMessage.mockReturnValueOnce({
      externalMessageId: '1234567890.123456',
      externalSessionKey: 'slack:T1:C1',
      text: 'hello',
      metadata: { slackTeamId: 'T1' },
      timestamp: new Date(),
    });
    __mockAdapter.extractEventId.mockReturnValueOnce('Ev123');

    const app = createApp();

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .set('Content-Type', 'application/json')
      .send(eventPayload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The JSON body should have been passed directly (no payload extraction)
    const calledWith = __mockAdapter.buildNormalizedMessage.mock.calls[0][0];
    expect(calledWith.type).toBe('event_callback');
    expect(calledWith.event.text).toBe('hello');
  });

  // =========================================================================
  // Signature verification uses the parsed body
  // =========================================================================

  it('passes the parsed body (not form wrapper) to verifyRequest', async () => {
    const app = createApp();

    await request(app)
      .post('/api/v1/channels/slack/webhook/T1-A1')
      .type('form')
      .send({ payload: JSON.stringify(BLOCK_ACTIONS_PAYLOAD) });

    expect(__mockAdapter.verifyRequest).toHaveBeenCalledTimes(1);
    const [, bodyArg, rawBodyArg] = __mockAdapter.verifyRequest.mock.calls[0];
    // The body passed to verifyRequest should be the parsed block_actions payload
    expect(bodyArg.type).toBe('block_actions');
    // rawBody should contain the original form-encoded bytes (not parsed JSON)
    // Signature verification MUST use rawBody, not body, for HMAC computation
    expect(Buffer.isBuffer(rawBodyArg)).toBe(true);
    expect(rawBodyArg.toString()).toContain('payload=');
  });
});
