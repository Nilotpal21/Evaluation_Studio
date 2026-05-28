/**
 * Inbound Channel Worker
 *
 * Processes messages from the channel-inbound queue:
 * 1. Parse job payload
 * 2. Resolve connection
 * 3. Dedup via Redis SET NX
 * 4. Resolve/create session
 * 5. Execute message through runtime
 * 6. Create delivery record
 * 7. Enqueue to webhook-delivery queue
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { extractTrace, injectTrace } from '@agent-platform/shared-observability/tracing';
import { runWithTenantContext } from '@agent-platform/shared-auth/middleware';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getDeliveryQueue } from './channel-queues.js';
import { emitChannelResponseSent, recordSyntheticTraceEvent } from '../channel-trace-utils.js';
import { acquireSessionLock, releaseSessionLock } from './session-lock.js';
import type { InboundJobPayload, DeliveryJobPayload } from '../../channels/types.js';
import { resolveConnectionProviderApiBase } from '../../channels/adapters/provider-api-base.js';
import {
  buildCustomerContinuityStatusPayload,
  type CustomerContinuityKind,
} from '../../channels/customer-continuity.js';
import type { ExecuteMessageOptions } from '../execution/types.js';
import {
  buildAuthRequiredOutcome,
  buildErrorOutcome,
  buildExecutionOutcome,
  buildOutcomeTraceEvent,
  runWithExecutionTimeout,
  ChannelExecutionTimeoutError,
  toPublicChannelOutcome,
} from '../channel/outcome.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
} from '../channel/response-provenance.js';
import { createTokenLookups, evaluateAuthPreflightFromIR } from '../auth-profile/auth-preflight.js';
import { buildProductionSessionLocator } from '../session/execution-scope.js';
import { isSessionMetadataValidationError } from '../session-metadata.js';
import { requireNormalizedActionEvent } from '../channels/action-event-validation.js';

const log = createLogger('inbound-worker');

const EXECUTE_TIMEOUT_MS = parseInt(process.env.CHANNEL_EXECUTE_TIMEOUT_MS || '120000', 10);
const MEDIA_BATCH_TIMEOUT_MS = parseInt(process.env.CHANNEL_MEDIA_BATCH_TIMEOUT_MS || '60000', 10);
const TEAMS_ATTACHMENT_MAX_SIZE_BYTES = parseInt(
  process.env.MSTEAMS_ATTACHMENT_MAX_SIZE_BYTES || '52428800',
  10,
);
const HTTP_ASYNC_STATUS_EVENT = 'agent.status' as const;
const HTTP_ASYNC_LONG_RUNNING_STATUS_DELAY_MS = parseInt(
  process.env.HTTP_ASYNC_LONG_RUNNING_STATUS_DELAY_MS || '4000',
  10,
);
const HTTP_ASYNC_MAX_CONTINUITY_STATUS_EVENTS = 2;
const HTTP_ASYNC_LONG_RUNNING_STATUS_TEXT = 'Still checking that.';

type Worker = any;
let worker: Worker | null = null;

export async function startInboundWorker(): Promise<void> {
  if (worker) return;

  const { isConfigLoaded, getConfig } = await import('../../config/loader.js');
  if (!isConfigLoaded()) return;

  const config = getConfig();
  if (!config.redis.enabled || !config.redis.url) return;

  const bullmq = await import('bullmq');
  const { getRedisHandle } = await import('../redis/redis-client.js');
  const handle = getRedisHandle();
  if (!handle) return; // Redis not initialized — skip worker startup
  const connection = handle.duplicate({ maxRetriesPerRequest: null });

  worker = new bullmq.Worker(
    'channel-inbound',
    async (job: any) => {
      const payload: InboundJobPayload = job.data;

      await runWithTenantContext(
        {
          tenantId: payload.tenantId,
          userId: 'system',
          role: 'system',
          permissions: [],
          authType: 'api_key' as const,
          isSuperAdmin: false,
        },
        async () => {
          log.info('Processing inbound message', {
            jobId: job.id,
            tenantId: payload.tenantId,
            connectionId: payload.connectionId,
            messageId: payload.message.externalMessageId,
          });

          try {
            // Dedup check via Redis on first attempt only.
            // Retries of the same BullMQ job must bypass dedup to avoid message loss.
            if (job.attemptsMade === 0) {
              const deduped = await deduplicateMessage(
                payload.tenantId,
                payload.subscriptionId || '',
                payload.idempotencyKey,
              );
              if (!deduped) {
                log.info('Duplicate message skipped', {
                  tenantId: payload.tenantId,
                  connectionId: payload.connectionId,
                  messageId: payload.message.externalMessageId,
                  idempotencyKey: payload.idempotencyKey,
                });
                return;
              }
            } else {
              log.debug('Skipping dedup for retry attempt', {
                tenantId: payload.tenantId,
                jobId: job.id,
                attemptsMade: job.attemptsMade,
                idempotencyKey: payload.idempotencyKey,
              });
            }

            const deliveryIdempotencyKey = `delivery:${payload.tenantId}:${payload.idempotencyKey}`;

            // HTTP Async retry recovery:
            // If a prior attempt already created a delivery record but failed before queueing,
            // re-enqueue that delivery instead of re-executing the runtime turn.
            if (payload.channelType === 'http_async' && job.attemptsMade > 0) {
              const { WebhookDelivery } = await import('@agent-platform/database/models');
              const existingDelivery = await WebhookDelivery.findOne({
                tenantId: payload.tenantId,
                idempotencyKey: deliveryIdempotencyKey,
              }).lean();

              if (existingDelivery) {
                const deliveryQueue = getDeliveryQueue();
                if (!deliveryQueue) {
                  throw new Error('Delivery queue not available');
                }

                const deliveryJob: DeliveryJobPayload = {
                  deliveryId: existingDelivery._id as string,
                  subscriptionId: existingDelivery.subscriptionId as string,
                  tenantId: payload.tenantId,
                  eventType:
                    (existingDelivery.eventType as DeliveryJobPayload['eventType']) ||
                    'agent.response',
                  payload: existingDelivery.payload as string,
                };

                await deliveryQueue.add('webhook-delivery', deliveryJob, {
                  jobId: `delivery-${existingDelivery._id}`,
                });

                log.info('Recovered existing HTTP Async delivery on retry', {
                  tenantId: payload.tenantId,
                  deliveryId: existingDelivery._id,
                  idempotencyKey: payload.idempotencyKey,
                  attemptsMade: job.attemptsMade,
                });
                return;
              }
            }

            // Resolve connection
            const { resolveConnectionById } = await import('../../channels/connection-resolver.js');
            const resolvedConnection = await resolveConnectionById(
              payload.connectionId,
              payload.tenantId,
            );
            if (!resolvedConnection) {
              throw new Error(`Connection not found: ${payload.connectionId}`);
            }

            const resolveLockKey = `channel:resolve:${payload.connectionId}:${payload.message.externalSessionKey}`;
            const resolveLockOwner = `inbound-resolve-${job.id}`;
            const resolveLockAcquired = await acquireSessionLock(resolveLockKey, resolveLockOwner);
            if (!resolveLockAcquired) {
              throw new Error(
                'Session resolution lock timeout — concurrent first-message processing exceeded wait limit',
              );
            }

            let resolveLockReleased = false;
            try {
              // Resolve session
              const { resolveSession } = await import('../../channels/session-resolver.js');
              const session = await resolveSession(resolvedConnection, payload.message);

              // Acquire per-session lock to prevent concurrent execution on the same session.
              const sessionLockKey = `channel:lock:${session.sessionId}`;
              const lockOwner = `inbound-${job.id}`;
              const lockAcquired = await acquireSessionLock(sessionLockKey, lockOwner);
              if (!lockAcquired) {
                throw new Error(
                  'Session lock timeout — concurrent message processing exceeded wait limit',
                );
              }

              await releaseSessionLock(resolveLockKey, resolveLockOwner);
              resolveLockReleased = true;

              // ── Send typing indicator (best-effort, fire-and-forget) ──────────
              // Fires immediately after session lock — before media processing and
              // LLM execution — so the user sees activity as early as possible.
              // Not awaited: upstream outages must not delay the turn.
              {
                const { getChannelRegistry } = await import('../../channels/registry.js');
                const channelAdapter = getChannelRegistry().get(payload.channelType);
                if (channelAdapter?.sendTypingIndicator) {
                  channelAdapter
                    .sendTypingIndicator(
                      resolvedConnection,
                      payload.message.externalSessionKey,
                      payload.message.metadata,
                    )
                    .catch((err: unknown) => {
                      log.warn('Typing indicator failed (non-blocking)', {
                        channelType: payload.channelType,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    });
                }
              }

              const processingStartTime = Date.now();
              let executionTimedOut = false;
              let traceId: string | undefined;
              let extractedSpanId: string | undefined;
              let runtimeKnownSource: 'production' | 'eval' | 'synthetic' | undefined;
              {
                const extracted = extractTrace(payload as unknown as Record<string, unknown>);
                traceId =
                  extracted?.traceId || payload.traceId || crypto.randomUUID().replace(/-/g, '');
                extractedSpanId = extracted?.spanId;
              }
              const spanId = extractedSpanId || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
              try {
                // Execute message through runtime
                const { getRuntimeExecutor } = await import('../runtime-executor.js');
                const executor = getRuntimeExecutor();

                const chunks: string[] = [];
                let pendingStreamChunk = Promise.resolve();
                const isActionEvent = !!payload.message.actionEvent;

                // Set up Slack streaming if enabled for this connection
                let streamBuffer:
                  | import('../../channels/adapters/slack-stream-buffer.js').SlackStreamBuffer
                  | import('../../channels/adapters/msteams-stream-buffer.js').MSTeamsStreamBuffer
                  | import('../../channels/adapters/telegram-stream-buffer.js').TelegramStreamBuffer
                  | null = null;
                const streamingConfig = resolvedConnection.config?.streaming as
                  | { enabled?: boolean; chunkSize?: number }
                  | undefined;
                const streamingEnabled =
                  (payload.channelType === 'slack' ||
                    payload.channelType === 'msteams' ||
                    payload.channelType === 'telegram') &&
                  !isActionEvent &&
                  streamingConfig?.enabled === true;

                log.info('Slack streaming check', {
                  channelType: payload.channelType,
                  isActionEvent,
                  streamingConfig: JSON.stringify(streamingConfig),
                  streamingEnabled,
                });

                if (streamingEnabled) {
                  const botToken = resolvedConnection.credentials?.bot_token as string;
                  const channelId = payload.message.metadata?.slackChannelId as string;
                  const threadTs = (payload.message.metadata?.slackThreadTs ||
                    payload.message.metadata?.slackTs) as string;
                  const teamId = payload.message.metadata?.slackTeamId as string | undefined;
                  const userId = payload.message.metadata?.slackUserId as string | undefined;
                  const slackApiBase = resolveConnectionProviderApiBase(
                    resolvedConnection,
                    'SLACK_API_BASE_URL',
                    'https://slack.com/api',
                    'slackApiBaseUrl',
                  );
                  log.info('Slack stream buffer params', {
                    hasBotToken: !!botToken,
                    channelId,
                    threadTs,
                    teamId,
                    slackApiBase,
                    chunkSize: streamingConfig?.chunkSize ?? 500,
                  });
                  if (botToken && channelId && threadTs) {
                    const { SlackStreamBuffer } =
                      await import('../../channels/adapters/slack-stream-buffer.js');
                    streamBuffer = new SlackStreamBuffer(botToken, channelId, threadTs, {
                      chunkSize: streamingConfig?.chunkSize ?? 500,
                      teamId,
                      userId,
                      apiBase: slackApiBase,
                    });
                    log.info('Slack stream buffer created');
                  } else {
                    log.warn('Slack stream buffer NOT created — missing params');
                  }
                }

                if (streamingEnabled && payload.channelType === 'msteams') {
                  const conversationType = payload.message.metadata?.conversationType as
                    | string
                    | undefined;
                  if (conversationType?.toLowerCase() === 'personal') {
                    const serviceUrl = payload.message.metadata?.serviceUrl as string;
                    const conversationId = payload.message.metadata?.conversationId as string;
                    const activityId = payload.message.metadata?.activityId as string;
                    const appId =
                      (resolvedConnection.credentials?.app_id as string) ||
                      process.env.MSTEAMS_APP_ID;
                    const clientSecret =
                      (resolvedConnection.credentials?.client_secret as string) ||
                      process.env.MSTEAMS_CLIENT_SECRET;
                    const tenantId =
                      (resolvedConnection.credentials?.tenant_id as string) ||
                      process.env.MSTEAMS_TENANT_ID;

                    if (
                      serviceUrl &&
                      conversationId &&
                      activityId &&
                      appId &&
                      clientSecret &&
                      tenantId
                    ) {
                      try {
                        const { getBotFrameworkToken } =
                          await import('../../channels/adapters/msteams-auth.js');
                        const token = await getBotFrameworkToken(appId, clientSecret, tenantId);

                        const { MSTeamsStreamBuffer } =
                          await import('../../channels/adapters/msteams-stream-buffer.js');
                        streamBuffer = new MSTeamsStreamBuffer(
                          token,
                          serviceUrl,
                          conversationId,
                          activityId,
                          {
                            flushIntervalMs: (streamingConfig as any)?.flushIntervalMs ?? 2000,
                            informativeMessage:
                              (streamingConfig as any)?.informativeMessage ?? undefined,
                          },
                        );
                        log.info('MS Teams stream buffer created', { conversationId });
                      } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        log.warn('Failed to set up MS Teams streaming, will use fallback', {
                          error: errMsg,
                        });
                      }
                    } else {
                      log.warn('MS Teams stream buffer NOT created — missing params', {
                        hasServiceUrl: !!serviceUrl,
                        hasConversationId: !!conversationId,
                        hasActivityId: !!activityId,
                        hasCredentials: !!(appId && clientSecret && tenantId),
                      });
                    }
                  } else {
                    log.debug('MS Teams streaming skipped for non-personal conversation', {
                      conversationType,
                    });
                  }
                }

                if (streamingEnabled && payload.channelType === 'telegram') {
                  const botToken = resolvedConnection.credentials?.bot_token as string;
                  const chatId = payload.message.metadata?.telegramChatId as string | number;
                  const isGroup = payload.message.metadata?.isGroup as boolean | undefined;
                  const telegramApiBase = resolveConnectionProviderApiBase(
                    resolvedConnection,
                    'TELEGRAM_API_BASE_URL',
                    'https://api.telegram.org',
                    'telegramApiBaseUrl',
                  );
                  // sendMessageDraft only works in private chats (Bot API docs: chat_id is Integer for private chat)
                  if (botToken && chatId && !isGroup) {
                    try {
                      const { TelegramStreamBuffer } =
                        await import('../../channels/adapters/telegram-stream-buffer.js');
                      const draftId = Math.floor(Math.random() * 2_147_483_647);
                      streamBuffer = new TelegramStreamBuffer(botToken, chatId, draftId, {
                        apiBase: telegramApiBase,
                        chunkSize: streamingConfig?.chunkSize ?? 300,
                      });
                      log.info('Telegram stream buffer created', { chatId });
                    } catch (err) {
                      const errMsg = err instanceof Error ? err.message : String(err);
                      log.warn('Failed to set up Telegram streaming, will use fallback', {
                        error: errMsg,
                      });
                    }
                  } else {
                    log.warn('Telegram stream buffer NOT created — missing params', {
                      hasBotToken: !!botToken,
                      hasChatId: !!chatId,
                    });
                  }
                }

                // ── Process channel media/file attachments (if present) ─────────────────
                let attachmentIds: string[] | undefined;
                const onAttachmentTraceEvent = (event: {
                  type: string;
                  data: Record<string, unknown>;
                }) => {
                  recordSyntheticTraceEvent({
                    sessionId: session.sessionId,
                    tenantId: payload.tenantId,
                    projectId: payload.projectId,
                    traceId,
                    event,
                  });
                };

                // WhatsApp media attachments
                const whatsappMediaRefs = payload.message.metadata?.whatsappMediaReferences as
                  | import('../../channels/adapters/whatsapp-media-processor.js').WhatsAppMediaReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'whatsapp' &&
                  whatsappMediaRefs &&
                  whatsappMediaRefs.length > 0
                ) {
                  const provider = resolvedConnection.config?.provider as string;

                  // Select download function and token based on provider
                  let downloadFn: (ref: any, token: string) => Promise<any>;
                  let accessToken = '';
                  let skipMedia = false;

                  if (provider === 'infobip') {
                    const { buildInfobipAuthHeader } =
                      await import('../../channels/adapters/whatsapp-providers/infobip-provider.js');
                    const { downloadInfobipMedia } =
                      await import('../../channels/adapters/whatsapp-providers/infobip-media-downloader.js');
                    const authHeader = buildInfobipAuthHeader(resolvedConnection);
                    downloadFn = async (ref, _token) => downloadInfobipMedia(ref, authHeader);
                  } else if (provider === 'gupshup') {
                    const { downloadGupshupMedia } =
                      await import('../../channels/adapters/whatsapp-providers/gupshup-media-downloader.js');
                    downloadFn = async (ref, _token) => downloadGupshupMedia(ref);
                  } else if (provider === 'netcore') {
                    const { downloadNetcoreMedia } =
                      await import('../../channels/adapters/whatsapp-providers/netcore-media-downloader.js');
                    const apiKey = (resolvedConnection.credentials?.api_key as string) || '';
                    if (!apiKey) {
                      log.warn('WhatsApp media present but no api_key available for Netcore', {
                        tenantId: payload.tenantId,
                        connectionId: payload.connectionId,
                      });
                      skipMedia = true;
                    }
                    downloadFn = async (ref, _token) => downloadNetcoreMedia(ref, apiKey);
                    accessToken = ''; // Not used for Netcore, but needed by processWhatsAppMediaReferences signature
                  } else {
                    // Meta Cloud API (default)
                    accessToken = (resolvedConnection.credentials?.access_token as string) || '';
                    if (!accessToken) {
                      log.warn('WhatsApp media present but no access_token available', {
                        tenantId: payload.tenantId,
                        connectionId: payload.connectionId,
                      });
                      skipMedia = true;
                    }
                    const { downloadWhatsAppMedia } =
                      await import('../../channels/adapters/whatsapp-providers/meta-cloud-media-downloader.js');
                    downloadFn = downloadWhatsAppMedia;
                  }

                  if (!skipMedia) {
                    // Shared processing — one copy of timeout + process + error handling
                    try {
                      const { processWhatsAppMediaReferences } =
                        await import('../../channels/adapters/whatsapp-media-processor.js');
                      const { MultimodalServiceClient } =
                        await import('../../attachments/multimodal-service-client.js');
                      const mmClient = new MultimodalServiceClient();

                      let mediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                      try {
                        attachmentIds = await Promise.race([
                          processWhatsAppMediaReferences(whatsappMediaRefs, {
                            accessToken,
                            tenantId: payload.tenantId,
                            projectId: payload.projectId,
                            sessionId: session.sessionId,
                            channel: 'whatsapp',
                            provider: provider || 'meta_cloud',
                            onTraceEvent: onAttachmentTraceEvent,
                            downloadFn,
                            uploadFn: (params) => mmClient.upload(params),
                          }),
                          new Promise<string[]>((_, reject) => {
                            mediaTimeoutHandle = setTimeout(
                              () => reject(new Error('WhatsApp media processing timed out')),
                              MEDIA_BATCH_TIMEOUT_MS,
                            );
                          }),
                        ]);
                      } finally {
                        if (mediaTimeoutHandle) clearTimeout(mediaTimeoutHandle);
                      }

                      if (attachmentIds.length > 0) {
                        log.info('WhatsApp media attachments processed', {
                          tenantId: payload.tenantId,
                          sessionId: session.sessionId,
                          attachmentIds,
                          count: attachmentIds.length,
                          provider: provider || 'meta_cloud',
                        });
                      }
                    } catch (err) {
                      log.error('WhatsApp media processing failed (non-blocking)', {
                        tenantId: payload.tenantId,
                        provider: provider || 'meta_cloud',
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }
                }

                // Slack file attachments
                const slackFileRefs = payload.message.metadata?.slackFileReferences as
                  | import('../../channels/adapters/slack-file-processor.js').SlackFileReferenceMetadata[]
                  | undefined;

                if (payload.channelType === 'slack' && slackFileRefs && slackFileRefs.length > 0) {
                  const botToken = resolvedConnection.credentials?.bot_token as string;
                  if (botToken) {
                    try {
                      const { processSlackFileReferences } =
                        await import('../../channels/adapters/slack-file-processor.js');
                      const { downloadSlackFile } =
                        await import('../../channels/adapters/slack-file-downloader.js');
                      const { MultimodalServiceClient } =
                        await import('../../attachments/multimodal-service-client.js');
                      const mmClient = new MultimodalServiceClient();

                      let slackMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                      try {
                        attachmentIds = await Promise.race([
                          processSlackFileReferences(slackFileRefs, {
                            botToken,
                            tenantId: payload.tenantId,
                            projectId: payload.projectId,
                            sessionId: session.sessionId,
                            channel: 'slack',
                            provider: 'slack',
                            onTraceEvent: onAttachmentTraceEvent,
                            downloadFn: downloadSlackFile,
                            uploadFn: (params) => mmClient.upload(params),
                          }),
                          new Promise<string[]>((_, reject) => {
                            slackMediaTimeoutHandle = setTimeout(
                              () => reject(new Error('Slack file attachment processing timed out')),
                              MEDIA_BATCH_TIMEOUT_MS,
                            );
                          }),
                        ]);
                      } finally {
                        if (slackMediaTimeoutHandle) clearTimeout(slackMediaTimeoutHandle);
                      }

                      if (attachmentIds.length > 0) {
                        log.info('Slack file attachments processed', {
                          tenantId: payload.tenantId,
                          sessionId: session.sessionId,
                          attachmentIds,
                          count: attachmentIds.length,
                        });
                      }
                    } catch (err) {
                      log.error('Slack file attachment processing failed (non-blocking)', {
                        tenantId: payload.tenantId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                      // Continue without attachments — don't block the text message
                    }
                  } else {
                    log.warn('Slack file attachments present but no bot_token available', {
                      tenantId: payload.tenantId,
                      connectionId: payload.connectionId,
                    });
                  }
                }

                // MS Teams file attachments
                const teamsFileRefs = payload.message.metadata?.teamsFileReferences as
                  | import('../../channels/adapters/msteams-file-processor.js').MSTeamsFileReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'msteams' &&
                  teamsFileRefs &&
                  teamsFileRefs.length > 0
                ) {
                  let teamsMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                  try {
                    const appId =
                      (resolvedConnection.credentials?.app_id as string) ||
                      process.env.MSTEAMS_APP_ID;
                    const clientSecret =
                      (resolvedConnection.credentials?.client_secret as string) ||
                      process.env.MSTEAMS_CLIENT_SECRET;
                    const tenantId =
                      (resolvedConnection.credentials?.tenant_id as string) ||
                      process.env.MSTEAMS_TENANT_ID;

                    let botToken: string | undefined;
                    if (appId && clientSecret && tenantId) {
                      try {
                        const { getBotFrameworkToken } =
                          await import('../../channels/adapters/msteams-auth.js');
                        botToken = await getBotFrameworkToken(appId, clientSecret, tenantId);
                      } catch (tokenErr) {
                        log.warn('Failed to get Teams bot token for attachment downloads', {
                          tenantId: payload.tenantId,
                          error: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
                        });
                      }
                    } else {
                      log.warn(
                        'Teams attachment processing running without bot token (partial support)',
                        {
                          tenantId: payload.tenantId,
                          connectionId: payload.connectionId,
                        },
                      );
                    }

                    const { processMSTeamsFileReferences } =
                      await import('../../channels/adapters/msteams-file-processor.js');
                    const { downloadMSTeamsFile } =
                      await import('../../channels/adapters/msteams-file-downloader.js');
                    const { MultimodalServiceClient } =
                      await import('../../attachments/multimodal-service-client.js');
                    const mmClient = new MultimodalServiceClient();

                    attachmentIds = await Promise.race([
                      processMSTeamsFileReferences(teamsFileRefs, {
                        botToken,
                        maxSizeBytes: TEAMS_ATTACHMENT_MAX_SIZE_BYTES,
                        tenantId: payload.tenantId,
                        projectId: payload.projectId,
                        sessionId: session.sessionId,
                        channel: 'msteams',
                        provider: 'msteams',
                        onTraceEvent: onAttachmentTraceEvent,
                        downloadFn: downloadMSTeamsFile,
                        uploadFn: (params) =>
                          mmClient.upload({
                            ...params,
                            maxSizeBytes: TEAMS_ATTACHMENT_MAX_SIZE_BYTES,
                          }),
                      }),
                      new Promise<string[]>((_, reject) => {
                        teamsMediaTimeoutHandle = setTimeout(
                          () => reject(new Error('Teams file processing timed out')),
                          MEDIA_BATCH_TIMEOUT_MS,
                        );
                      }),
                    ]);

                    if (attachmentIds.length > 0) {
                      log.info('Teams file attachments processed', {
                        tenantId: payload.tenantId,
                        sessionId: session.sessionId,
                        attachmentIds,
                        count: attachmentIds.length,
                      });
                    }
                  } catch (err) {
                    log.error('Teams file attachment processing failed (non-blocking)', {
                      tenantId: payload.tenantId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  } finally {
                    if (teamsMediaTimeoutHandle) clearTimeout(teamsMediaTimeoutHandle);
                  }
                }

                // Messenger media attachments
                const messengerMediaRefs = payload.message.metadata?.messengerMediaReferences as
                  | import('../../channels/adapters/messenger-media-processor.js').MessengerMediaReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'messenger' &&
                  messengerMediaRefs &&
                  messengerMediaRefs.length > 0
                ) {
                  try {
                    const { processMessengerMediaReferences } =
                      await import('../../channels/adapters/messenger-media-processor.js');
                    const { downloadMessengerMedia } =
                      await import('../../channels/adapters/messenger-media-downloader.js');
                    const { MultimodalServiceClient } =
                      await import('../../attachments/multimodal-service-client.js');
                    const mmClient = new MultimodalServiceClient();

                    let messengerMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                    try {
                      attachmentIds = await Promise.race([
                        processMessengerMediaReferences(messengerMediaRefs, {
                          tenantId: payload.tenantId,
                          projectId: payload.projectId,
                          sessionId: session.sessionId,
                          channel: 'messenger',
                          provider: 'messenger',
                          onTraceEvent: onAttachmentTraceEvent,
                          downloadFn: downloadMessengerMedia,
                          uploadFn: (params) => mmClient.upload(params),
                        }),
                        new Promise<string[]>((_, reject) => {
                          messengerMediaTimeoutHandle = setTimeout(
                            () => reject(new Error('Messenger media processing timed out')),
                            MEDIA_BATCH_TIMEOUT_MS,
                          );
                        }),
                      ]);
                    } finally {
                      if (messengerMediaTimeoutHandle) clearTimeout(messengerMediaTimeoutHandle);
                    }

                    if (attachmentIds.length > 0) {
                      log.info('Messenger media attachments processed', {
                        tenantId: payload.tenantId,
                        sessionId: session.sessionId,
                        attachmentIds,
                        count: attachmentIds.length,
                      });
                    }
                  } catch (err) {
                    log.error('Messenger media processing failed (non-blocking)', {
                      tenantId: payload.tenantId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                    // Continue without attachments — don't block the text message
                  }
                }

                // Instagram media attachments
                const instagramMediaRefs = payload.message.metadata?.instagramMediaReferences as
                  | import('../../channels/adapters/instagram-media-processor.js').InstagramMediaReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'instagram' &&
                  instagramMediaRefs &&
                  instagramMediaRefs.length > 0
                ) {
                  try {
                    const { processInstagramMediaReferences } =
                      await import('../../channels/adapters/instagram-media-processor.js');
                    const { downloadInstagramMedia } =
                      await import('../../channels/adapters/instagram-media-downloader.js');
                    const { MultimodalServiceClient } =
                      await import('../../attachments/multimodal-service-client.js');
                    const mmClient = new MultimodalServiceClient();

                    let instagramMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                    try {
                      attachmentIds = await Promise.race([
                        processInstagramMediaReferences(instagramMediaRefs, {
                          tenantId: payload.tenantId,
                          projectId: payload.projectId,
                          sessionId: session.sessionId,
                          channel: 'instagram',
                          provider: 'instagram',
                          onTraceEvent: onAttachmentTraceEvent,
                          downloadFn: downloadInstagramMedia,
                          uploadFn: (params) => mmClient.upload(params),
                        }),
                        new Promise<string[]>((_, reject) => {
                          instagramMediaTimeoutHandle = setTimeout(
                            () => reject(new Error('Instagram media processing timed out')),
                            MEDIA_BATCH_TIMEOUT_MS,
                          );
                        }),
                      ]);
                    } finally {
                      if (instagramMediaTimeoutHandle) clearTimeout(instagramMediaTimeoutHandle);
                    }

                    if (attachmentIds.length > 0) {
                      log.info('Instagram media attachments processed', {
                        tenantId: payload.tenantId,
                        sessionId: session.sessionId,
                        attachmentIds,
                        count: attachmentIds.length,
                      });
                    }
                  } catch (err) {
                    log.error('Instagram media processing failed (non-blocking)', {
                      tenantId: payload.tenantId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }

                // Telegram media attachments
                const telegramMediaRefs = payload.message.metadata?.telegramMediaReferences as
                  | import('../../channels/adapters/telegram-media-processor.js').TelegramMediaReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'telegram' &&
                  telegramMediaRefs &&
                  telegramMediaRefs.length > 0
                ) {
                  const botToken = resolvedConnection.credentials?.bot_token as string;
                  if (botToken) {
                    try {
                      const { processTelegramMediaReferences } =
                        await import('../../channels/adapters/telegram-media-processor.js');
                      const { downloadTelegramMedia } =
                        await import('../../channels/adapters/telegram-media-downloader.js');
                      const { MultimodalServiceClient } =
                        await import('../../attachments/multimodal-service-client.js');
                      const telegramApiBase = resolveConnectionProviderApiBase(
                        resolvedConnection,
                        'TELEGRAM_API_BASE_URL',
                        'https://api.telegram.org',
                        'telegramApiBaseUrl',
                      );
                      const mmClient = new MultimodalServiceClient();

                      let telegramMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                      try {
                        attachmentIds = await Promise.race([
                          processTelegramMediaReferences(telegramMediaRefs, {
                            botToken,
                            tenantId: payload.tenantId,
                            projectId: payload.projectId,
                            sessionId: session.sessionId,
                            channel: 'telegram',
                            provider: 'telegram',
                            onTraceEvent: onAttachmentTraceEvent,
                            downloadFn: (ref, innerBotToken) =>
                              downloadTelegramMedia(ref, innerBotToken, {
                                apiBase: telegramApiBase,
                              }),
                            uploadFn: (params) => mmClient.upload(params),
                          }),
                          new Promise<string[]>((_, reject) => {
                            telegramMediaTimeoutHandle = setTimeout(
                              () => reject(new Error('Telegram media processing timed out')),
                              MEDIA_BATCH_TIMEOUT_MS,
                            );
                          }),
                        ]);
                      } finally {
                        if (telegramMediaTimeoutHandle) clearTimeout(telegramMediaTimeoutHandle);
                      }

                      if (attachmentIds.length > 0) {
                        log.info('Telegram media attachments processed', {
                          tenantId: payload.tenantId,
                          sessionId: session.sessionId,
                          attachmentIds,
                          count: attachmentIds.length,
                        });
                      }
                    } catch (err) {
                      log.error('Telegram media processing failed (non-blocking)', {
                        tenantId: payload.tenantId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                      // Continue without attachments — don't block the text message
                    }
                  }
                }

                // LINE media attachments
                const lineMediaRefs = payload.message.metadata?.lineMediaReferences as
                  | import('../../channels/adapters/line-media-processor.js').LineMediaReferenceMetadata[]
                  | undefined;

                if (payload.channelType === 'line' && lineMediaRefs && lineMediaRefs.length > 0) {
                  const accessToken = resolvedConnection.credentials
                    ?.channel_access_token as string;
                  const lineDataApiBase = resolveConnectionProviderApiBase(
                    resolvedConnection,
                    'LINE_DATA_API_BASE_URL',
                    'https://api-data.line.me',
                    'lineDataApiBaseUrl',
                  );
                  if (accessToken) {
                    try {
                      const { processLineMediaReferences } =
                        await import('../../channels/adapters/line-media-processor.js');
                      const { downloadLineMedia } =
                        await import('../../channels/adapters/line-media-downloader.js');
                      const { MultimodalServiceClient } =
                        await import('../../attachments/multimodal-service-client.js');
                      const mmClient = new MultimodalServiceClient();

                      let lineMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                      try {
                        attachmentIds = await Promise.race([
                          processLineMediaReferences(lineMediaRefs, {
                            accessToken,
                            tenantId: payload.tenantId,
                            projectId: payload.projectId,
                            sessionId: session.sessionId,
                            channel: 'line',
                            provider: 'line',
                            onTraceEvent: onAttachmentTraceEvent,
                            downloadFn: (ref, lineAccessToken) =>
                              downloadLineMedia(ref, lineAccessToken, {
                                apiBase: lineDataApiBase,
                              }),
                            uploadFn: (params) => mmClient.upload(params),
                          }),
                          new Promise<string[]>((_, reject) => {
                            lineMediaTimeoutHandle = setTimeout(
                              () => reject(new Error('LINE media processing timed out')),
                              MEDIA_BATCH_TIMEOUT_MS,
                            );
                          }),
                        ]);
                      } finally {
                        if (lineMediaTimeoutHandle) clearTimeout(lineMediaTimeoutHandle);
                      }

                      if (attachmentIds.length > 0) {
                        log.info('LINE media attachments processed', {
                          tenantId: payload.tenantId,
                          sessionId: session.sessionId,
                          attachmentIds,
                          count: attachmentIds.length,
                        });
                      }
                    } catch (err) {
                      log.error('LINE media processing failed (non-blocking)', {
                        tenantId: payload.tenantId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }
                }

                // Twilio SMS/MMS media attachments
                const twilioMediaRefs = payload.message.metadata?.twilioMediaReferences as
                  | import('../../channels/adapters/twilio-sms-media-processor.js').TwilioMediaReferenceMetadata[]
                  | undefined;

                if (
                  payload.channelType === 'twilio_sms' &&
                  twilioMediaRefs &&
                  twilioMediaRefs.length > 0
                ) {
                  const accountSid = resolvedConnection.credentials?.account_sid as string;
                  const authToken = resolvedConnection.credentials?.auth_token as string;
                  const twilioApiBase = resolveConnectionProviderApiBase(
                    resolvedConnection,
                    'TWILIO_API_BASE_URL',
                    'https://api.twilio.com/2010-04-01',
                    'twilioApiBaseUrl',
                  );
                  if (accountSid && authToken) {
                    try {
                      const { processTwilioMediaReferences } =
                        await import('../../channels/adapters/twilio-sms-media-processor.js');
                      const { downloadTwilioMedia } =
                        await import('../../channels/adapters/twilio-sms-media-downloader.js');
                      const { MultimodalServiceClient } =
                        await import('../../attachments/multimodal-service-client.js');
                      const mmClient = new MultimodalServiceClient();

                      let twilioMediaTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                      try {
                        attachmentIds = await Promise.race([
                          processTwilioMediaReferences(twilioMediaRefs, {
                            accountSid,
                            authToken,
                            tenantId: payload.tenantId,
                            projectId: payload.projectId,
                            sessionId: session.sessionId,
                            channel: 'twilio_sms',
                            provider: 'twilio_sms',
                            onTraceEvent: onAttachmentTraceEvent,
                            downloadFn: (ref) =>
                              downloadTwilioMedia(ref, {
                                accountSid,
                                authToken,
                                apiBaseUrl: twilioApiBase,
                              }),
                            uploadFn: (params) => mmClient.upload(params),
                          }),
                          new Promise<string[]>((_, reject) => {
                            twilioMediaTimeoutHandle = setTimeout(
                              () => reject(new Error('Twilio MMS media processing timed out')),
                              MEDIA_BATCH_TIMEOUT_MS,
                            );
                          }),
                        ]);
                      } finally {
                        if (twilioMediaTimeoutHandle) clearTimeout(twilioMediaTimeoutHandle);
                      }

                      if (attachmentIds.length > 0) {
                        log.info('Twilio MMS media attachments processed', {
                          tenantId: payload.tenantId,
                          sessionId: session.sessionId,
                          attachmentIds,
                          count: attachmentIds.length,
                        });
                      }
                    } catch (err) {
                      log.error('Twilio MMS media processing failed (non-blocking)', {
                        tenantId: payload.tenantId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                      // Continue without attachments — don't block the text message
                    }
                  } else {
                    log.warn('Twilio MMS media present but no account_sid/auth_token available', {
                      tenantId: payload.tenantId,
                      connectionId: payload.connectionId,
                    });
                  }
                }

                // ── Read pre-uploaded email attachment IDs (if present) ──────────
                if (payload.channelType === 'email' && !attachmentIds) {
                  const raw = payload.message.metadata?.emailAttachmentIds;
                  const emailAttIds = Array.isArray(raw) ? (raw as string[]) : undefined;
                  if (emailAttIds && emailAttIds.length > 0) {
                    attachmentIds = emailAttIds;
                    log.info('Email attachments found', {
                      tenantId: payload.tenantId,
                      attachmentIds,
                      count: emailAttIds.length,
                    });
                  }
                }

                // Skip execution for reaction messages — they should not trigger bot replies.
                // Reactions are normalized and session-tracked, but not routed to the executor.
                const isReaction = !!payload.message.metadata?.isReaction;
                if (isReaction) {
                  log.info('Skipping execution for reaction message', {
                    tenantId: payload.tenantId,
                    messageId: payload.message.externalMessageId,
                    sessionId: session.sessionId,
                  });
                  return;
                }

                // Build execution options
                const sessionLocator = buildProductionSessionLocator({
                  tenantId: payload.tenantId,
                  projectId: payload.projectId,
                  sessionId: session.sessionId,
                });
                const execOptions: Pick<
                  ExecuteMessageOptions,
                  'attachmentIds' | 'interactionContext' | 'actionEvent' | 'sessionLocator'
                > = {};
                if (attachmentIds && attachmentIds.length > 0) {
                  execOptions.attachmentIds = attachmentIds;
                }
                if (payload.message.interactionContext) {
                  execOptions.interactionContext = payload.message.interactionContext;
                }
                if (isActionEvent && payload.message.actionEvent) {
                  execOptions.actionEvent = requireNormalizedActionEvent(
                    payload.message.actionEvent,
                  );
                }
                if (sessionLocator) {
                  execOptions.sessionLocator = sessionLocator;
                }

                // Establish observability context so downstream code can read getCurrentTraceId().
                // Prefer extracted span context (includes parent spanId) over raw traceId.
                // traceId and spanId already resolved at function entry
                const runtimeSession =
                  executor.getSession(session.sessionId) ??
                  (await executor.rehydrateSession(
                    session.sessionId,
                    sessionLocator ? { locator: sessionLocator } : undefined,
                  ));
                runtimeKnownSource = runtimeSession?.knownSource;
                const environment =
                  resolvedConnection.environment ||
                  runtimeSession?.versionInfo?.environment ||
                  undefined;

                let outcome;
                let pendingHttpAsyncStatusDelivery: Promise<void> = Promise.resolve();
                const httpAsyncQueuedStatusKinds = new Set<CustomerContinuityKind>();
                let httpAsyncStatusDeliveryCount = 0;
                let httpAsyncFirstVisibleChunk: string | null = null;
                let httpAsyncWaitingForPreToolChunk = false;
                let httpAsyncPreToolWindowClosed = false;
                let httpAsyncLongRunningStatusTimer: ReturnType<typeof setTimeout> | undefined;
                let httpAsyncLongRunningStatusTimerArmed = false;
                const queueHttpAsyncStatusDelivery = (
                  chunk: string,
                  kind: CustomerContinuityKind,
                  source: 'agent_authored' | 'runtime_topology',
                ) => {
                  if (
                    payload.channelType !== 'http_async' ||
                    httpAsyncQueuedStatusKinds.has(kind) ||
                    httpAsyncStatusDeliveryCount >= HTTP_ASYNC_MAX_CONTINUITY_STATUS_EVENTS ||
                    !chunk
                  ) {
                    return;
                  }

                  httpAsyncQueuedStatusKinds.add(kind);
                  httpAsyncStatusDeliveryCount += 1;
                  pendingHttpAsyncStatusDelivery = pendingHttpAsyncStatusDelivery.then(() =>
                    enqueueHttpAsyncStatusDelivery({
                      payload,
                      sessionId: session.sessionId,
                      isNewSession: session.isNew,
                      chunk,
                      kind,
                      source,
                      traceId,
                      spanId,
                      deliveryIdempotencyKey,
                    }).catch((err) => {
                      log.warn('HTTP Async status delivery skipped', {
                        tenantId: payload.tenantId,
                        subscriptionId: payload.subscriptionId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }),
                  );
                };
                const maybeQueueHttpAsyncStatusDelivery = () => {
                  if (!httpAsyncWaitingForPreToolChunk || !httpAsyncFirstVisibleChunk) {
                    return;
                  }
                  queueHttpAsyncStatusDelivery(
                    httpAsyncFirstVisibleChunk,
                    'pre_action_bridge',
                    'agent_authored',
                  );
                };
                const armHttpAsyncLongRunningStatus = () => {
                  if (
                    payload.channelType !== 'http_async' ||
                    httpAsyncLongRunningStatusTimerArmed ||
                    httpAsyncQueuedStatusKinds.has('long_running_status')
                  ) {
                    return;
                  }

                  httpAsyncLongRunningStatusTimerArmed = true;
                  httpAsyncLongRunningStatusTimer = setTimeout(() => {
                    httpAsyncLongRunningStatusTimer = undefined;
                    httpAsyncLongRunningStatusTimerArmed = false;
                    queueHttpAsyncStatusDelivery(
                      HTTP_ASYNC_LONG_RUNNING_STATUS_TEXT,
                      'long_running_status',
                      'runtime_topology',
                    );
                  }, HTTP_ASYNC_LONG_RUNNING_STATUS_DELAY_MS);
                };
                const clearPendingHttpAsyncLongRunningStatus = () => {
                  if (!httpAsyncLongRunningStatusTimer) {
                    return;
                  }

                  clearTimeout(httpAsyncLongRunningStatusTimer);
                  httpAsyncLongRunningStatusTimer = undefined;
                  httpAsyncLongRunningStatusTimerArmed = false;
                };
                const responseProvenance = createResponseProvenanceAccumulator();
                if (runtimeSession?.compilationOutput) {
                  try {
                    const preflight = await evaluateAuthPreflightFromIR(
                      runtimeSession.compilationOutput,
                      {
                        userId: runtimeSession.userId,
                        tenantId: payload.tenantId,
                        projectId: payload.projectId,
                        environment,
                      },
                      createTokenLookups(payload.tenantId, payload.projectId, environment),
                      runtimeSession.agentName
                        ? { agentNames: [runtimeSession.agentName] }
                        : undefined,
                    );

                    if (preflight) {
                      outcome = buildAuthRequiredOutcome({
                        channelType: payload.channelType,
                        pending: preflight.pending,
                        satisfied: preflight.satisfied,
                        session: runtimeSession,
                      });
                      recordSyntheticTraceEvent({
                        sessionId: session.sessionId,
                        tenantId: payload.tenantId,
                        projectId: payload.projectId,
                        traceId,
                        session: runtimeSession,
                        event: buildOutcomeTraceEvent(outcome),
                      });
                    }
                  } catch (error) {
                    outcome = buildErrorOutcome({
                      channelType: payload.channelType,
                      error,
                      session: runtimeSession,
                      traceId,
                      ...(runtimeSession?.agentName ? { agentName: runtimeSession.agentName } : {}),
                    });
                    recordSyntheticTraceEvent({
                      sessionId: session.sessionId,
                      tenantId: payload.tenantId,
                      projectId: payload.projectId,
                      traceId,
                      session: runtimeSession,
                      event: buildOutcomeTraceEvent(outcome),
                    });
                  }
                }

                if (!outcome) {
                  try {
                    const execResult = await runWithExecutionTimeout(
                      (signal) =>
                        runWithObservabilityContext({ traceId, spanId }, () =>
                          executor.executeMessage(
                            session.sessionId,
                            payload.message.text,
                            (chunk: string) => {
                              chunks.push(chunk);
                              if (
                                payload.channelType === 'http_async' &&
                                !httpAsyncQueuedStatusKinds.has('pre_action_bridge') &&
                                !httpAsyncPreToolWindowClosed &&
                                chunk.trim().length > 0
                              ) {
                                httpAsyncFirstVisibleChunk ??= chunk;
                                maybeQueueHttpAsyncStatusDelivery();
                              }
                              if (streamBuffer) {
                                pendingStreamChunk = pendingStreamChunk.then(async () => {
                                  try {
                                    await streamBuffer.onChunk(chunk);
                                  } catch (err) {
                                    const errMsg = err instanceof Error ? err.message : String(err);
                                    log.error('Stream onChunk error', {
                                      error: errMsg,
                                      channelType: payload.channelType,
                                    });
                                  }
                                });
                              }
                            },
                            (event) => {
                              accumulateResponseProvenance(responseProvenance, event);
                              if (payload.channelType === 'http_async') {
                                if (
                                  event.type === 'llm_call' &&
                                  event.data.hasToolCalls === true &&
                                  !httpAsyncQueuedStatusKinds.has('pre_action_bridge') &&
                                  !httpAsyncPreToolWindowClosed
                                ) {
                                  httpAsyncWaitingForPreToolChunk = true;
                                  maybeQueueHttpAsyncStatusDelivery();
                                }

                                if (
                                  !httpAsyncQueuedStatusKinds.has('pre_action_bridge') &&
                                  !httpAsyncFirstVisibleChunk &&
                                  (event.type === 'tool_call_start' ||
                                    (event.type === 'tool_call' && event.data.phase === 'complete'))
                                ) {
                                  httpAsyncPreToolWindowClosed = true;
                                  httpAsyncWaitingForPreToolChunk = false;
                                }

                                if (
                                  event.type === 'tool_call_start' ||
                                  (event.type === 'tool_call' &&
                                    event.data.phase !== 'complete' &&
                                    typeof event.data.tool === 'string')
                                ) {
                                  armHttpAsyncLongRunningStatus();
                                }

                                if (
                                  (event.type === 'tool_call' && event.data.phase === 'complete') ||
                                  event.type === 'tool_result' ||
                                  event.type === 'tool_call_error'
                                ) {
                                  clearPendingHttpAsyncLongRunningStatus();
                                }

                                if (event.type === 'handoff' && !httpAsyncPreToolWindowClosed) {
                                  const continuity = event.data.continuity;
                                  if (
                                    continuity &&
                                    typeof continuity === 'object' &&
                                    !Array.isArray(continuity)
                                  ) {
                                    const record = continuity as Record<string, unknown>;
                                    if (
                                      record.kind === 'handoff_transition' &&
                                      typeof record.message === 'string' &&
                                      record.visibility === 'customer_visible'
                                    ) {
                                      queueHttpAsyncStatusDelivery(
                                        record.message,
                                        'handoff_transition',
                                        'runtime_topology',
                                      );
                                    }
                                  }
                                }
                              }
                            },
                            {
                              ...(Object.keys(execOptions).length > 0 ? execOptions : {}),
                              signal,
                            },
                          ),
                        ),
                      EXECUTE_TIMEOUT_MS,
                    );

                    clearPendingHttpAsyncLongRunningStatus();
                    outcome = buildExecutionOutcome({
                      channelType: payload.channelType,
                      result: execResult,
                      streamedText:
                        chunks.length > 0 &&
                        !(payload.channelType === 'http_async' && httpAsyncWaitingForPreToolChunk)
                          ? chunks.join('')
                          : undefined,
                      session:
                        executor.getSession(session.sessionId) ?? runtimeSession ?? undefined,
                    });
                  } catch (error) {
                    clearPendingHttpAsyncLongRunningStatus();
                    if (error instanceof ChannelExecutionTimeoutError) {
                      executionTimedOut = true;
                    }
                    outcome = buildErrorOutcome({
                      channelType: payload.channelType,
                      error,
                      session: runtimeSession ?? undefined,
                      traceId,
                      ...(runtimeSession?.agentName ? { agentName: runtimeSession.agentName } : {}),
                    });
                  }
                }

                const responseText = outcome.responseText;
                const publicOutcome = toPublicChannelOutcome(outcome);
                const responseMetadata =
                  outcome.responseMetadata ??
                  (publicOutcome.status === 'ok'
                    ? buildResponseMessageMetadata(responseProvenance)
                    : buildResponseMessageMetadata(createResponseProvenanceAccumulator()));

                // Wait for any in-flight stream operations (e.g. startStream HTTP call)
                // to complete before checking isStarted. Without this, a race condition
                // causes isStarted to be false while startStream is still in-flight,
                // leading to duplicate messages.
                if (streamBuffer) {
                  await pendingStreamChunk;
                  await streamBuffer.settle();
                }
                await pendingHttpAsyncStatusDelivery;

                // Apply transform: convert plain text + actions into platform-native format
                const { getChannelRegistry } = await import('../../channels/registry.js');
                const channelAdapter = getChannelRegistry().get(payload.channelType);
                const channelOutput = channelAdapter?.transformOutput?.(
                  responseText,
                  outcome.actions,
                  outcome.richContent,
                ) ?? { kind: 'text' as const, text: responseText };

                // Route response based on channel type
                if (payload.channelType === 'http_async') {
                  // HTTP Async: create delivery record and enqueue for webhook delivery
                  const { WebhookDelivery } = await import('@agent-platform/database/models');

                  const deliveryPayload = JSON.stringify({
                    message_id: payload.message.externalMessageId,
                    session_key: payload.message.externalSessionKey,
                    response: responseText,
                    actions: outcome.actions || undefined,
                    channel_output: channelOutput,
                    outcome: publicOutcome,
                    trace_context: {
                      session_id: session.sessionId,
                      delivery: 'correlation_only',
                    },
                    session_id: session.sessionId,
                    is_new_session: session.isNew,
                    response_metadata: responseMetadata,
                    metadata: {},
                  });

                  let delivery = await WebhookDelivery.findOne({
                    tenantId: payload.tenantId,
                    idempotencyKey: deliveryIdempotencyKey,
                  }).lean();
                  if (!delivery) {
                    try {
                      delivery = await WebhookDelivery.create({
                        tenantId: payload.tenantId,
                        subscriptionId: payload.subscriptionId,
                        idempotencyKey: deliveryIdempotencyKey,
                        eventType: 'agent.response',
                        payload: deliveryPayload,
                        status: 'pending',
                      });
                    } catch (err: any) {
                      if (err?.code === 11000) {
                        delivery = await WebhookDelivery.findOne({
                          tenantId: payload.tenantId,
                          idempotencyKey: deliveryIdempotencyKey,
                        }).lean();
                      } else {
                        throw err;
                      }
                    }
                  }

                  if (!delivery) {
                    throw new Error('Failed to create or load delivery record');
                  }

                  const deliveryQueue = getDeliveryQueue();
                  if (!deliveryQueue) {
                    log.error('Delivery queue unavailable — cannot enqueue webhook delivery', {
                      tenantId: payload.tenantId,
                      deliveryId: delivery._id,
                      subscriptionId: payload.subscriptionId,
                    });
                    throw new Error('Delivery queue not available');
                  }

                  const deliveryJob: DeliveryJobPayload = {
                    deliveryId: delivery._id as string,
                    subscriptionId: payload.subscriptionId,
                    tenantId: payload.tenantId,
                    eventType: 'agent.response',
                    payload: deliveryPayload,
                  };

                  // Propagate trace context to delivery worker for trace continuity
                  injectTrace(deliveryJob as unknown as Record<string, unknown>, {
                    traceId,
                    spanId,
                  });

                  await deliveryQueue.add('webhook-delivery', deliveryJob, {
                    jobId: `delivery-${delivery._id}`,
                  });

                  log.info('HTTP Async message processed', {
                    tenantId: payload.tenantId,
                    messageId: payload.message.externalMessageId,
                    deliveryId: delivery._id,
                    sessionId: session.sessionId,
                  });
                } else if (streamBuffer?.isStarted) {
                  // Streaming: close the stream with platform-specific rich content.
                  if (payload.channelType === 'slack') {
                    // Slack: strip text 'section' blocks — text was already delivered via appendStream
                    let blocks =
                      channelOutput?.kind === 'slack_blocks' ? channelOutput.blocks : undefined;
                    if (blocks) {
                      blocks = (blocks as Array<{ type?: string }>).filter(
                        (b) => b.type !== 'section',
                      );
                    }
                    await streamBuffer.close(blocks);
                  } else if (payload.channelType === 'telegram') {
                    // Telegram: close the draft stream, then send final message via adapter
                    // so the complete text + inline keyboard (reply_markup) are delivered.
                    await streamBuffer.close();

                    if (channelAdapter) {
                      const outgoingMessage = {
                        sessionId: session.sessionId,
                        text: responseText,
                        eventType: 'agent.response' as const,
                        metadata: {
                          ...payload.message.metadata,
                          channelOutput,
                          outcome: publicOutcome,
                          responseMetadata,
                        },
                      };
                      await channelAdapter.sendResponse(outgoingMessage, resolvedConnection);
                    }
                  } else if (payload.channelType === 'msteams') {
                    // Teams: pass adaptive card attachments to finalizeStream
                    const attachments =
                      channelOutput?.kind === 'adaptive_card'
                        ? [
                            {
                              contentType: 'application/vnd.microsoft.card.adaptive',
                              content: (channelOutput as any).card,
                            },
                          ]
                        : undefined;
                    await streamBuffer.close(attachments);
                  } else {
                    await streamBuffer.close();
                  }

                  log.info('Streamed message closed', {
                    tenantId: payload.tenantId,
                    channelType: payload.channelType,
                    messageId: payload.message.externalMessageId,
                    sessionId: session.sessionId,
                  });
                } else {
                  // Direct-send channels (Slack, WhatsApp, etc.): use adapter.sendResponse()
                  // Also used as fallback when Slack streaming was enabled but response was
                  // too short to trigger a stream (streamBuffer not started).
                  if (streamBuffer) {
                    // Stream was never opened — ensure buffer is cleaned up
                    await streamBuffer.close();
                  }

                  if (!channelAdapter) {
                    throw new Error(
                      `No adapter registered for channel type: ${payload.channelType}`,
                    );
                  }

                  const outgoingMessage = {
                    sessionId: session.sessionId,
                    text: responseText,
                    eventType: 'agent.response' as const,
                    metadata: {
                      ...payload.message.metadata,
                      channelOutput, // Attach transformed output for adapter's sendResponse
                      outcome: publicOutcome,
                      responseMetadata,
                    },
                  };

                  const sendResult = await channelAdapter.sendResponse(
                    outgoingMessage,
                    resolvedConnection,
                  );

                  if (!sendResult.success) {
                    log.error('Failed to send channel response', {
                      channelType: payload.channelType,
                      error: sendResult.error,
                    });
                    throw new Error(`Send failed: ${sendResult.error}`);
                  }

                  // For email: persist outbound message ID to channel session
                  // so future replies to this agent message can be threaded.
                  if (
                    payload.channelType === 'email' &&
                    sendResult.deliveryId &&
                    session.channelSessionId
                  ) {
                    try {
                      const { ChannelSession } = await import('@agent-platform/database/models');
                      await ChannelSession.updateOne(
                        { _id: session.channelSessionId },
                        { $addToSet: { emailMessageIds: sendResult.deliveryId } },
                      );
                    } catch (err) {
                      log.warn('Failed to persist outbound email message ID', {
                        channelSessionId: session.channelSessionId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }

                  log.info('Channel message processed', {
                    tenantId: payload.tenantId,
                    channelType: payload.channelType,
                    messageId: payload.message.externalMessageId,
                    sessionId: session.sessionId,
                    deliveryId: sendResult.deliveryId,
                  });
                }
              } finally {
                // Always emit channel_response_sent to flush the STR buffer,
                // even if response routing threw an error.
                emitChannelResponseSent(
                  session.sessionId,
                  payload.channelType,
                  Date.now() - processingStartTime,
                  {
                    tenantId: payload.tenantId,
                    projectId: payload.projectId,
                    traceId,
                    knownSource: runtimeKnownSource,
                  },
                );
                // If execution timed out, do not release immediately. Let TTL expire to
                // avoid concurrent processing against a potentially still-running task.
                if (!executionTimedOut) {
                  await releaseSessionLock(sessionLockKey, lockOwner);
                } else {
                  log.warn('Execution timed out; lock release deferred to TTL expiry', {
                    tenantId: payload.tenantId,
                    sessionId: session.sessionId,
                    lockKey: sessionLockKey,
                  });
                }
              }
            } finally {
              if (!resolveLockReleased) {
                await releaseSessionLock(resolveLockKey, resolveLockOwner);
              }
            }
          } catch (error) {
            if (isSessionMetadataValidationError(error)) {
              log.warn('Inbound message rejected due to invalid session metadata', {
                tenantId: payload.tenantId,
                messageId: payload.message.externalMessageId,
                code: error.code,
                statusCode: error.statusCode,
                error: error.message,
              });
              return;
            }

            log.error('Inbound message processing failed', {
              tenantId: payload.tenantId,
              messageId: payload.message.externalMessageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            throw error; // Let BullMQ handle retry
          }
        },
      );
    },
    {
      connection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 5,
    },
  );

  worker.on('failed', (job: any, err: Error) => {
    log.error('Inbound job failed', {
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  log.info('Inbound worker started');
}

export async function stopInboundWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    log.info('Inbound worker stopped');
  }
}

async function enqueueHttpAsyncStatusDelivery(params: {
  payload: InboundJobPayload;
  sessionId: string;
  isNewSession: boolean;
  chunk: string;
  kind: CustomerContinuityKind;
  source: 'agent_authored' | 'runtime_topology';
  traceId: string;
  spanId: string;
  deliveryIdempotencyKey: string;
}): Promise<void> {
  const { WebhookDelivery, WebhookSubscription } = await import('@agent-platform/database/models');
  const subscription = await WebhookSubscription.findOne({
    _id: params.payload.subscriptionId,
    tenantId: params.payload.tenantId,
  })
    .select('events')
    .lean();

  if (!isSubscriptionEventEnabled(subscription?.events, HTTP_ASYNC_STATUS_EVENT)) {
    return;
  }

  const idempotencyKey = `${params.deliveryIdempotencyKey}:${HTTP_ASYNC_STATUS_EVENT}:${params.kind}`;
  const statusPayload = buildCustomerContinuityStatusPayload({
    channelType: params.payload.channelType,
    kind: params.kind,
    rawText: params.chunk,
    messageId: params.payload.message.externalMessageId,
    sessionKey: params.payload.message.externalSessionKey,
    sessionId: params.sessionId,
    isNewSession: params.isNewSession,
    source: params.source,
  });
  if (!statusPayload) return;

  const deliveryPayload = JSON.stringify(statusPayload);

  let delivery = await WebhookDelivery.findOne({
    tenantId: params.payload.tenantId,
    idempotencyKey,
  }).lean();
  if (!delivery) {
    try {
      delivery = await WebhookDelivery.create({
        tenantId: params.payload.tenantId,
        subscriptionId: params.payload.subscriptionId,
        idempotencyKey,
        eventType: HTTP_ASYNC_STATUS_EVENT,
        payload: deliveryPayload,
        status: 'pending',
      });
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        delivery = await WebhookDelivery.findOne({
          tenantId: params.payload.tenantId,
          idempotencyKey,
        }).lean();
      } else {
        throw err;
      }
    }
  }

  if (!delivery) {
    throw new Error('Failed to create or load HTTP Async status delivery record');
  }

  const deliveryQueue = getDeliveryQueue();
  if (!deliveryQueue) {
    throw new Error('Delivery queue not available');
  }

  const deliveryJob: DeliveryJobPayload = {
    deliveryId: delivery._id as string,
    subscriptionId: params.payload.subscriptionId,
    tenantId: params.payload.tenantId,
    eventType: HTTP_ASYNC_STATUS_EVENT,
    payload: deliveryPayload,
  };

  injectTrace(deliveryJob as unknown as Record<string, unknown>, {
    traceId: params.traceId,
    spanId: params.spanId,
  });

  await deliveryQueue.add('webhook-delivery', deliveryJob, {
    jobId: `delivery-${delivery._id}`,
  });
}

function isSubscriptionEventEnabled(events: unknown, eventType: string): boolean {
  if (typeof events !== 'string') return false;
  try {
    const parsed = JSON.parse(events);
    return Array.isArray(parsed) && parsed.includes(eventType);
  } catch {
    return false;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Dedup a message using Redis SET NX with TTL.
 * Returns true if this is the first time seeing this key.
 */
async function deduplicateMessage(
  tenantId: string,
  subscriptionId: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) return true; // No Redis = no dedup, process anyway

    const key = `channel:dedup:${tenantId}:${subscriptionId}:${idempotencyKey}`;
    const result = await redis.set(key, '1', 'EX', 3600, 'NX'); // 1 hour TTL
    return result === 'OK';
  } catch {
    return true; // On error, process the message
  }
}
