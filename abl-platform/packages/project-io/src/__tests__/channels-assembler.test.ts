import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelsAssembler } from '../export/layer-assemblers/channels-assembler.js';

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: { find: vi.fn(), countDocuments: vi.fn() },
  ProjectAgent: { find: vi.fn() },
  WebhookSubscription: { find: vi.fn(), countDocuments: vi.fn() },
  WidgetConfig: { findOne: vi.fn(), countDocuments: vi.fn() },
}));

import {
  ChannelConnection,
  ProjectAgent,
  WebhookSubscription,
  WidgetConfig,
} from '@agent-platform/database/models';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  return { lean: () => ({ select: () => Promise.resolve(data) }) };
}

describe('ChannelsAssembler', () => {
  let assembler: ChannelsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new ChannelsAssembler();
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
  });

  it('should have layer name "channels"', () => {
    expect(assembler.layer).toBe('channels');
  });

  it('should assemble channels and strip encrypted credentials', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'ch-1',
          channelType: 'slack',
          externalIdentifier: 'T12345',
          displayName: 'Slack Main',
          agentId: 'agent-1',
          deploymentId: null,
          environment: 'production',
          encryptedCredentials: 'encrypted-secret-data',
          verifyTokenHash: 'hash-abc',
          config: { botName: 'Support Bot' },
          status: 'active',
        },
      ]),
    );
    (WebhookSubscription.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([{ _id: 'agent-1', name: 'SupportAgent' }]),
    );
    (WidgetConfig.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await assembler.assemble(CTX);

    expect(result.files.has('channels/slack_main.channel.json')).toBe(true);
    const channelJson = JSON.parse(result.files.get('channels/slack_main.channel.json')!);

    expect(channelJson.channelType).toBe('slack');
    expect(channelJson.config.botName).toBe('Support Bot');
    expect(channelJson.agentName).toBe('SupportAgent');
    expect(channelJson).not.toHaveProperty('agentId');
    expect(channelJson).not.toHaveProperty('deploymentId');
    expect(channelJson).not.toHaveProperty('encryptedCredentials');
    expect(channelJson).not.toHaveProperty('verifyTokenHash');
    expect(channelJson).not.toHaveProperty('_id');
    expect(channelJson).not.toHaveProperty('projectId');
    expect(channelJson).not.toHaveProperty('tenantId');
  });

  it('should strip encryptedSecret from webhooks', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'ch-1',
          channelType: 'http_async',
          externalIdentifier: 'api-endpoint',
          displayName: 'API Channel',
          config: {},
          status: 'active',
        },
      ]),
    );
    (ProjectAgent.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (WebhookSubscription.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'wh-1',
          channelConnectionId: 'ch-1',
          callbackUrl: 'https://example.com/webhook',
          encryptedSecret: 'super-secret-key',
          events: '["agent.response"]',
          status: 'active',
          description: 'Main Webhook',
          lastDeliveryAt: new Date(),
          failureCount: 0,
        },
      ]),
    );
    (WidgetConfig.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await assembler.assemble(CTX);

    expect(result.files.has('channels/webhooks/main_webhook.webhook.json')).toBe(true);
    const webhookJson = JSON.parse(
      result.files.get('channels/webhooks/main_webhook.webhook.json')!,
    );

    expect(webhookJson.callbackUrl).toBe('https://example.com/webhook');
    expect(webhookJson).not.toHaveProperty('encryptedSecret');
    expect(webhookJson).not.toHaveProperty('lastDeliveryAt');
    expect(webhookJson).not.toHaveProperty('failureCount');
  });

  it('should export widget config', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (WidgetConfig.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      toObject: () => ({
        _id: 'widget-1',
        projectId: 'proj-1',
        mode: 'embedded',
        position: 'bottom-right',
        theme: { primaryColor: '#007bff' },
        welcomeMessage: 'Hello!',
        voiceEnabled: true,
        chatEnabled: true,
        __v: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });

    const result = await assembler.assemble(CTX);

    expect(result.files.has('channels/widgets/widget-config.json')).toBe(true);
    const widgetJson = JSON.parse(result.files.get('channels/widgets/widget-config.json')!);

    expect(widgetJson.mode).toBe('embedded');
    expect(widgetJson.theme.primaryColor).toBe('#007bff');
    expect(widgetJson).not.toHaveProperty('_id');
    expect(widgetJson).not.toHaveProperty('projectId');
    expect(widgetJson).not.toHaveProperty('__v');
  });

  it('should handle empty project', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (WidgetConfig.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await assembler.assemble(CTX);

    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
    expect(ProjectAgent.find).not.toHaveBeenCalled();
  });

  it('should count entities correctly', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => ({
        select: () =>
          Promise.resolve([
            { _id: 'ch-1' },
            { _id: 'ch-2' },
            { _id: 'ch-3' },
            { _id: 'ch-4' },
            { _id: 'ch-5' },
          ]),
      }),
    });
    (WebhookSubscription.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (WidgetConfig.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(5);
  });

  it('should count entities including webhooks and widget configs', async () => {
    // countEntities queries channels, then webhooks and widgets separately
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => ({
        select: () => Promise.resolve([{ _id: 'ch-1' }, { _id: 'ch-2' }, { _id: 'ch-3' }]),
      }),
    });
    (WebhookSubscription.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (WidgetConfig.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const count = await assembler.countEntities(CTX);

    // 3 channels + 2 webhooks + 1 widget = 6
    expect(count).toBe(6);
  });

  it('should count entities with zero webhooks when no channels exist', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => ({
        select: () => Promise.resolve([]),
      }),
    });
    // When channelIds is empty, webhooks are skipped (returns 0)
    (WidgetConfig.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const count = await assembler.countEntities(CTX);

    // 0 channels + 0 webhooks (skipped) + 1 widget = 1
    expect(count).toBe(1);
  });

  it('should count entities with only webhooks and no widget', async () => {
    (ChannelConnection.find as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => ({
        select: () => Promise.resolve([{ _id: 'ch-1' }]),
      }),
    });
    (WebhookSubscription.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(4);
    (WidgetConfig.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const count = await assembler.countEntities(CTX);

    // 1 channel + 4 webhooks + 0 widgets = 5
    expect(count).toBe(5);
  });
});
