import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../channels/connection-resolver.js', () => ({
  resolveChannelConnection: vi.fn(),
}));

vi.mock('../services/queues/channel-queues.js', () => ({
  getInboundQueue: vi.fn(),
}));

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
    shouldProcess: vi.fn().mockReturnValue(true),
    buildNormalizedMessage: vi.fn((body: Record<string, unknown>) => ({
      externalMessageId: `slash:${body.trigger_id as string}:${body.channel_id as string}:${body.user_id as string}`,
      externalSessionKey: `slack:${body.team_id as string}:${body.channel_id as string}`,
      text: body.text
        ? `${body.command as string} ${body.text as string}`
        : (body.command as string),
      metadata: {
        isSlashCommand: true,
        slashCommand: body.command,
        slashArgs: body.text ?? '',
        slackTeamId: body.team_id,
        slackChannelId: body.channel_id,
        slackUserId: body.user_id,
        responseUrl: body.response_url,
        slackEventType: 'slash_command',
      },
      timestamp: new Date(),
    })),
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
import channelWebhooksRouter from '../routes/channel-webhooks.js';
import type { ResolvedConnection } from '../channels/types.js';
import { __mockAdapter } from '../channels/registry.js';

declare module '../channels/registry.js' {
  export const __mockAdapter: {
    verifyRequest: ReturnType<typeof vi.fn>;
    shouldProcess: ReturnType<typeof vi.fn>;
    buildNormalizedMessage: ReturnType<typeof vi.fn>;
  };
}

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
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/channels', channelWebhooksRouter);
  return app;
}

describe('Slack slash command route', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    (resolveChannelConnection as ReturnType<typeof vi.fn>).mockResolvedValue(makeConnection());
    (getInboundQueue as ReturnType<typeof vi.fn>).mockReturnValue({ add: mockQueueAdd });
    __mockAdapter.verifyRequest.mockResolvedValue(true);
    __mockAdapter.shouldProcess.mockReturnValue(true);
  });

  it('accepts a valid slash command payload and enqueues a normalized job', async () => {
    const app = createApp();

    const res = await request(app).post('/api/v1/channels/slack/slash/T1%3AA1').type('form').send({
      command: '/ask-bot',
      text: 'status please',
      team_id: 'T1',
      channel_id: 'C1',
      channel_name: 'support',
      user_id: 'U1',
      user_name: 'alice',
      trigger_id: 'tr-1',
      response_url: 'https://hooks.slack.com/commands/1',
      api_app_id: 'A1',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(__mockAdapter.buildNormalizedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/ask-bot',
        text: 'status please',
        team_id: 'T1',
        channel_id: 'C1',
        user_id: 'U1',
      }),
      expect.anything(),
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobPayload] = mockQueueAdd.mock.calls[0];
    expect(jobName).toBe('process-message');
    expect(jobPayload.message.text).toBe('/ask-bot status please');
    expect(jobPayload.message.metadata.isSlashCommand).toBe(true);
    expect(jobPayload.message.metadata.slashCommand).toBe('/ask-bot');
    expect(jobPayload.message.metadata.slashArgs).toBe('status please');
  });

  it('preserves empty slash args when no trailing text is provided', async () => {
    const app = createApp();

    const res = await request(app).post('/api/v1/channels/slack/slash/T1%3AA1').type('form').send({
      command: '/ask-bot',
      text: '',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr-2',
    });

    expect(res.status).toBe(200);
    const [, jobPayload] = mockQueueAdd.mock.calls[0];
    expect(jobPayload.message.text).toBe('/ask-bot');
    expect(jobPayload.message.metadata.slashArgs).toBe('');
  });

  it('rejects invalid signatures using the raw form body', async () => {
    __mockAdapter.verifyRequest.mockResolvedValueOnce(false);
    const app = createApp();

    const res = await request(app).post('/api/v1/channels/slack/slash/T1%3AA1').type('form').send({
      command: '/ask-bot',
      text: 'status please',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr-3',
    });

    expect(res.status).toBe(401);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    const [, , rawBodyArg] = __mockAdapter.verifyRequest.mock.calls[0];
    expect(rawBodyArg.toString()).toContain('command=%2Fask-bot');
    expect(rawBodyArg.toString()).toContain('trigger_id=tr-3');
  });

  it('returns 404 when the connection identifier is not configured', async () => {
    (resolveChannelConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const app = createApp();

    const res = await request(app).post('/api/v1/channels/slack/slash/T1%3AA1').type('form').send({
      command: '/ask-bot',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr-4',
    });

    expect(res.status).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 503 when queueing fails', async () => {
    (getInboundQueue as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const app = createApp();

    const res = await request(app).post('/api/v1/channels/slack/slash/T1%3AA1').type('form').send({
      command: '/ask-bot',
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'tr-5',
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Queue unavailable' });
  });
});
