/**
 * Channels Layer Disassembler — converts exported channel files back into StagedRecord[].
 *
 * Handles channel connections, webhook subscriptions, and widget config.
 *
 * Cross-reference note: webhook subscriptions set `_channelDisplayName` temp field
 * for resolution in the cross-ref pass. The stale channelConnectionId is removed
 * and will be rebuilt by the cross-ref resolver.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import {
  safeParseJSON,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildImportedSingletonSuperseded,
  buildMatchingSuperseded,
  buildSupersededByImportedValues,
  extractNameFromPath,
} from './disassembler-utils.js';

const log = createLogger('channels-disassembler');

// ─── Collections ──────────────────────────────────────────────────────────

const CHANNEL_CONNECTIONS = 'channel_connections';
const WEBHOOK_SUBSCRIPTIONS = 'webhook_subscriptions';
const WIDGET_CONFIGS = 'widget_configs';

// ─── Path Patterns ────────────────────────────────────────────────────────

const CHANNEL_PATTERN = /^channels\/([^/]+)\.channel\.json$/;
const WEBHOOK_PATTERN = /^channels\/webhooks\/([^/]+)\.webhook\.json$/;
const WIDGET_CONFIG_PATH = 'channels/widgets/widget-config.json';

// ─── Disassembler ─────────────────────────────────────────────────────────

export class ChannelsDisassembler implements LayerDisassembler {
  readonly layer = 'channels' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: DisassembleResult['records'] = [];
    const superseded: DisassembleResult['superseded'] = [];
    const warnings: string[] = [];
    const ownership = {
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };

    // Build channel name map for resolving webhook -> channel references
    const channelNameMap = new Map<string, Record<string, unknown>>();
    // Reverse map: stale originalId -> displayName
    const originalIdToDisplayName = new Map<string, string>();

    // ── PHASE 1: Parse channel connections ──────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(CHANNEL_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      const displayName =
        typeof parsed.displayName === 'string'
          ? parsed.displayName
          : typeof parsed.externalIdentifier === 'string'
            ? parsed.externalIdentifier
            : (extractNameFromPath(filePath, '.channel.json') ?? match[1]);
      // Ensure displayName is on the record for cross-ref resolver (anchorMatchField: 'displayName')
      parsed.displayName = displayName;
      const exportedChannelId = parsed.id ?? parsed._exportedId;
      if (typeof exportedChannelId === 'string' && exportedChannelId.length > 0) {
        parsed._exportedId = exportedChannelId;
      }

      // Strip secrets — defensive (assembler already strips these)
      delete parsed.encryptedCredentials;
      delete parsed.verifyTokenHash;
      const agentName = parsed.agentName;
      if (typeof agentName === 'string' && agentName.length > 0) {
        parsed._channelAgentName = agentName;
      }
      delete parsed.agentName;
      delete parsed.agentId;
      delete parsed.deploymentId;
      if (parsed.status !== 'active' && parsed.status !== 'inactive') {
        delete parsed.status;
      }

      channelNameMap.set(displayName, parsed);

      // Track original _id if available
      if (typeof parsed._exportedId === 'string') {
        originalIdToDisplayName.set(parsed._exportedId, displayName);
      }

      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('channels', CHANNEL_CONNECTIONS, data));
    }

    // ── PHASE 2: Parse webhook subscriptions ────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(WEBHOOK_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      // Strip runtime/secret fields
      delete parsed.encryptedSecret;
      delete parsed.lastDeliveryAt;
      delete parsed.failureCount;

      // Resolve stale channelConnectionId to displayName for cross-ref
      const staleChannelConnectionId = parsed.channelConnectionId;
      const matchingDisplayName = this.findDisplayNameByOriginalId(
        channelNameMap,
        originalIdToDisplayName,
        staleChannelConnectionId,
        parsed,
        warnings,
      );
      parsed._channelDisplayName = matchingDisplayName;
      delete parsed.channelConnectionId; // Will be set in cross-ref pass

      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('channels', WEBHOOK_SUBSCRIPTIONS, data));
    }

    // ── PHASE 3: Parse widget config ────────────────────────────────────

    const widgetContent = ctx.files.get(WIDGET_CONFIG_PATH);
    if (widgetContent) {
      const parsed = safeParseJSON(WIDGET_CONFIG_PATH, widgetContent, warnings);
      if (parsed) {
        const data = injectOwnership(parsed, ownership);
        records.push(buildRecord('channels', WIDGET_CONFIGS, data));
      }
    }

    // ── Superseded records ──────────────────────────────────────────────

    if (ctx.conflictStrategy === 'replace' && ctx.existingRecordIds) {
      superseded.push(
        ...buildSuperseded(
          'channels',
          CHANNEL_CONNECTIONS,
          ctx.existingRecordIds.get(CHANNEL_CONNECTIONS),
        ),
      );
      superseded.push(
        ...buildSuperseded(
          'channels',
          WEBHOOK_SUBSCRIPTIONS,
          ctx.existingRecordIds.get(WEBHOOK_SUBSCRIPTIONS),
        ),
      );
      superseded.push(
        ...buildSuperseded('channels', WIDGET_CONFIGS, ctx.existingRecordIds.get(WIDGET_CONFIGS)),
      );
    } else if (ctx.conflictStrategy === 'merge' && ctx.existingRecordIds) {
      const matchingChannels = buildMatchingSuperseded(
        'channels',
        CHANNEL_CONNECTIONS,
        ctx.existingRecordIds.get(CHANNEL_CONNECTIONS),
        records.filter((record) => record.collection === CHANNEL_CONNECTIONS),
        'displayName',
      );
      superseded.push(...matchingChannels);
      superseded.push(
        ...buildSupersededByImportedValues(
          'channels',
          WEBHOOK_SUBSCRIPTIONS,
          ctx.existingRecordIds.get(WEBHOOK_SUBSCRIPTIONS),
          'channelConnectionId',
          matchingChannels.map((record) => record.recordId),
        ),
      );
      superseded.push(
        ...buildImportedSingletonSuperseded(
          'channels',
          WIDGET_CONFIGS,
          ctx.existingRecordIds.get(WIDGET_CONFIGS),
          records.filter((record) => record.collection === WIDGET_CONFIGS),
        ),
      );
    }

    log.info('Channels layer disassembled', {
      projectId: ctx.projectId,
      channels: channelNameMap.size,
      webhooks: records.filter((r) => r.collection === WEBHOOK_SUBSCRIPTIONS).length,
      hasWidget: !!widgetContent,
    });

    return { records, superseded, warnings };
  }

  /**
   * Resolve a stale channelConnectionId to the corresponding channel displayName.
   *
   * Resolution strategy:
   * 1. Direct lookup by original _id
   * 2. Fallback: if only one channel exists, assume it's the target
   * 3. Last resort: emit warning, return null
   */
  private findDisplayNameByOriginalId(
    channelNameMap: Map<string, Record<string, unknown>>,
    originalIdToDisplayName: Map<string, string>,
    staleId: unknown,
    record: Record<string, unknown>,
    warnings: string[],
  ): string | null {
    // 1. Direct lookup
    if (typeof staleId === 'string' && originalIdToDisplayName.has(staleId)) {
      return originalIdToDisplayName.get(staleId)!;
    }

    // 2. Single-channel fallback
    if (channelNameMap.size === 1) {
      return channelNameMap.keys().next().value ?? null;
    }

    // 3. Unresolvable
    const description =
      typeof record.description === 'string' ? record.description : 'unknown webhook';
    warnings.push(
      `Cannot resolve channelConnectionId "${String(staleId)}" for webhook "${description}"`,
    );
    return null;
  }
}
