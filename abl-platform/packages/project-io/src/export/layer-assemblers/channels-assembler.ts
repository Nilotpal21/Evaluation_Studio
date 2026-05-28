import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ChannelConnection,
  ProjectAgent,
  WebhookSubscription,
  WidgetConfig,
} from '@agent-platform/database/models';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('channels-assembler');

export class ChannelsAssembler implements LayerAssembler {
  readonly layer = 'channels' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    const [channels, widgetConfig] = await Promise.all([
      ChannelConnection.find({ projectId, tenantId })
        .lean()
        .select(
          'channelType externalIdentifier displayName agentId deploymentId environment config status',
        ),
      WidgetConfig.findOne({ projectId, tenantId }),
    ]);

    // Gather channel IDs for webhook lookup
    const channelIds = channels.map((ch: Record<string, unknown>) => String(ch._id));
    const channelAgentIdCandidates: Array<string | null> = channels.map(
      (ch: Record<string, unknown>) =>
        typeof ch.agentId === 'string' && ch.agentId.length > 0 ? ch.agentId : null,
    );
    const channelAgentIds = [
      ...new Set(channelAgentIdCandidates.filter((agentId): agentId is string => agentId !== null)),
    ];

    const [webhooks, channelAgents] =
      channelIds.length > 0
        ? await Promise.all([
            WebhookSubscription.find({ tenantId, channelConnectionId: { $in: channelIds } })
              .lean()
              .select('channelConnectionId callbackUrl events status description'),
            channelAgentIds.length > 0
              ? ProjectAgent.find({ projectId, tenantId, _id: { $in: channelAgentIds } })
                  .lean()
                  .select('name')
              : Promise.resolve([]),
          ])
        : [[], []];
    const agentNameById = new Map(
      (channelAgents as Array<Record<string, unknown>>)
        .filter((agent) => typeof agent._id === 'string' && typeof agent.name === 'string')
        .map((agent) => [String(agent._id), String(agent.name)]),
    );

    // Channel connections — strip encrypted credentials
    for (const channel of channels) {
      const name = sanitizeName(channel.displayName || channel.externalIdentifier);
      const originalId = String((channel as Record<string, unknown>)._id);
      const agentName =
        typeof (channel as Record<string, unknown>).agentId === 'string'
          ? agentNameById.get((channel as Record<string, unknown>).agentId as string)
          : undefined;
      const clean = stripInternalFields(channel as unknown as Record<string, unknown>);
      delete clean.encryptedCredentials;
      delete clean.verifyTokenHash;
      delete clean.agentId;
      delete clean.deploymentId;
      if (agentName) {
        clean.agentName = agentName;
      }
      // Preserve original _id as _exportedId so the import disassembler can
      // resolve stale channelConnectionId foreign keys on webhook subscriptions.
      clean._exportedId = originalId;
      const path = assignCollisionSafePath(`channels/${name}.channel.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Webhook subscriptions — strip encrypted secrets
    for (const webhook of webhooks) {
      const clean = stripInternalFields(webhook as unknown as Record<string, unknown>);
      delete clean.encryptedSecret;
      delete clean.lastDeliveryAt;
      delete clean.failureCount;
      const webhookName = sanitizeName(webhook.description || String(webhook._id));
      const path = assignCollisionSafePath(`channels/webhooks/${webhookName}.webhook.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Widget config
    if (widgetConfig) {
      const obj = widgetConfig.toObject ? widgetConfig.toObject() : widgetConfig;
      const clean = stripInternalFields(obj as unknown as Record<string, unknown>);
      files.set('channels/widgets/widget-config.json', JSON.stringify(clean, null, 2));
      entityCount++;
    }

    log.info('Channels layer assembled', {
      projectId,
      channels: channels.length,
      webhooks: webhooks.length,
      hasWidget: !!widgetConfig,
    });

    return { layer: 'channels', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const { projectId, tenantId } = ctx;
    const channels = await ChannelConnection.find({ projectId, tenantId }).lean().select('_id');
    const channelIds = channels.map((ch: Record<string, unknown>) => String(ch._id));

    const [webhookCount, widgetCount] = await Promise.all([
      channelIds.length > 0
        ? WebhookSubscription.countDocuments({
            tenantId,
            channelConnectionId: { $in: channelIds },
          })
        : 0,
      WidgetConfig.countDocuments({ projectId, tenantId }),
    ]);

    return channels.length + webhookCount + widgetCount;
  }
}
