/**
 * Webhook Delivery Worker
 *
 * Processes jobs from the webhook-delivery queue:
 * 1. Load subscription and decrypt HMAC secret
 * 2. SSRF check on callback URL
 * 3. POST to callback with HMAC signature headers
 * 4. Update delivery status
 *
 * Retry behavior:
 * - 410 Gone → deactivate subscription, no retry
 * - 4xx → mark failed, no retry
 * - 5xx → retry with exponential backoff
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { runWithTenantContext } from '@agent-platform/shared-auth/middleware';
import { dualReadCredentials } from '@agent-platform/shared/services/auth-profile';
import type { DeliveryJobPayload } from '../../channels/types.js';

const log = createLogger('delivery-worker');

type Worker = any;
let worker: Worker | null = null;

async function resolveStoredWebhookSecret(
  storedSecret: unknown,
  tenantId: string,
): Promise<string> {
  if (typeof storedSecret !== 'string' || storedSecret.length === 0) {
    throw new Error('Webhook subscription secret is missing or invalid');
  }

  const { decryptForTenantAuto, isAlreadyEncrypted } =
    await import('@agent-platform/shared/encryption');

  if (isAlreadyEncrypted(storedSecret)) {
    return decryptForTenantAuto(storedSecret, tenantId);
  }

  // Normal read path returns plugin-decrypted plaintext; preserve it as-is.
  return storedSecret;
}

async function resolveWebhookSecret(
  authProfileId: string | null | undefined,
  storedSecret: unknown,
  tenantId: string,
): Promise<string> {
  const { credentials } = await dualReadCredentials<string>({
    authProfileId,
    tenantId,
    consumer: 'WebhookSubscription',
    resolve: async () => {
      const { resolveAuthProfileCredentials } =
        await import('../../services/auth-profile-resolver.js');
      const profile = await resolveAuthProfileCredentials(authProfileId!, tenantId);
      if (!profile) {
        throw new Error(
          `Auth profile ${authProfileId} not found or expired — cannot resolve webhook secret`,
        );
      }

      const secret =
        (profile.secrets.webhookSecret as string | undefined) ??
        (profile.secrets.secret as string | undefined) ??
        '';
      if (!secret) {
        throw new Error(`Auth profile ${authProfileId} has no webhook secret`);
      }

      return secret;
    },
    legacyFallback: async () => await resolveStoredWebhookSecret(storedSecret, tenantId),
  });

  return credentials;
}

export async function startDeliveryWorker(injectedHandle?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  duplicate: (opts: Record<string, unknown>) => any;
}): Promise<void> {
  if (worker) return;

  const { isConfigLoaded, getConfig } = await import('../../config/loader.js');
  if (!isConfigLoaded()) return;

  const config = getConfig();
  if (!config.redis.enabled || !config.redis.url) return;

  const bullmq = await import('bullmq');
  let handle = injectedHandle;
  if (!handle) {
    const { getRedisHandle } = await import('../redis/redis-client.js');
    handle = getRedisHandle() ?? undefined;
  }
  if (!handle) return; // Redis not initialized — skip worker startup
  const connection = handle.duplicate({ maxRetriesPerRequest: null });

  worker = new bullmq.Worker(
    'webhook-delivery',
    async (job: any) => {
      const payload: DeliveryJobPayload = job.data;

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
          log.info('Processing webhook delivery', {
            jobId: job.id,
            tenantId: payload.tenantId,
            deliveryId: payload.deliveryId,
            subscriptionId: payload.subscriptionId,
          });

          const { WebhookSubscription, WebhookDelivery } =
            await import('@agent-platform/database/models');

          try {
            // Load subscription with tenant filter
            const subscription = await WebhookSubscription.findOne({
              _id: payload.subscriptionId,
              tenantId: payload.tenantId,
            }).lean();

            if (!subscription || subscription.status !== 'active') {
              log.info('Subscription not active, skipping delivery', {
                tenantId: payload.tenantId,
                subscriptionId: payload.subscriptionId,
                status: subscription?.status,
              });
              await updateDeliveryStatus(
                payload.deliveryId,
                payload.tenantId,
                'failed',
                null,
                'Subscription not active',
              );
              return;
            }

            // SSRF check on callback URL
            const { assertAllowedCallbackUrl } =
              await import('../../channels/security/callback-url-policy.js');
            const isProduction = process.env.NODE_ENV === 'production';
            await assertAllowedCallbackUrl(subscription.callbackUrl, isProduction);

            // ── Auth Profile dual-read for webhook HMAC secret ──
            const subAuthProfileId = (subscription as Record<string, unknown>).authProfileId as
              | string
              | null
              | undefined;
            const secret = await resolveWebhookSecret(
              subAuthProfileId,
              subscription.encryptedSecret,
              payload.tenantId,
            );

            // Build signature headers
            const { buildSignatureHeaders } =
              await import('@agent-platform/shared-kernel/security');
            const signatureHeaders = buildSignatureHeaders(secret, payload.payload);

            // POST to callback URL (redirect: manual prevents SSRF via redirects)
            const response = await fetch(subscription.callbackUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'ABL-Platform-Webhook/1.0',
                ...signatureHeaders,
              },
              body: payload.payload,
              redirect: 'manual',
              signal: AbortSignal.timeout(30_000), // 30s timeout
            });

            const httpStatus = response.status;
            let responseBody: string | null = null;
            try {
              responseBody = await response.text();
              // Truncate for storage
              if (responseBody.length > 1000) {
                responseBody = responseBody.slice(0, 1000) + '...(truncated)';
              }
            } catch {
              // Ignore response body read errors
            }

            if (httpStatus === 410) {
              // 410 Gone — deactivate subscription
              log.info('Callback returned 410, deactivating subscription', {
                tenantId: payload.tenantId,
                subscriptionId: payload.subscriptionId,
              });
              await WebhookSubscription.updateOne(
                { _id: payload.subscriptionId, tenantId: payload.tenantId },
                { $set: { status: 'deactivated' } },
              );
              await updateDeliveryStatus(
                payload.deliveryId,
                payload.tenantId,
                'failed',
                httpStatus,
                responseBody,
              );
              return;
            }

            if (httpStatus >= 200 && httpStatus < 300) {
              // Success
              await updateDeliveryStatus(
                payload.deliveryId,
                payload.tenantId,
                'delivered',
                httpStatus,
                responseBody,
              );
              await WebhookSubscription.updateOne(
                { _id: payload.subscriptionId, tenantId: payload.tenantId },
                { $set: { lastDeliveryAt: new Date(), failureCount: 0 } },
              );
              log.info('Webhook delivered successfully', {
                tenantId: payload.tenantId,
                deliveryId: payload.deliveryId,
                httpStatus,
              });
              return;
            }

            if (httpStatus >= 400 && httpStatus < 500) {
              // 4xx — client error, no retry
              log.warn('Webhook delivery client error', {
                tenantId: payload.tenantId,
                deliveryId: payload.deliveryId,
                httpStatus,
              });
              await updateDeliveryStatus(
                payload.deliveryId,
                payload.tenantId,
                'failed',
                httpStatus,
                responseBody,
              );
              await incrementFailureCount(payload.subscriptionId, payload.tenantId);
              return;
            }

            // 5xx — server error, retry via BullMQ
            log.warn('Webhook delivery server error, will retry', {
              tenantId: payload.tenantId,
              deliveryId: payload.deliveryId,
              httpStatus,
              attempt: job.attemptsMade + 1,
            });
            await updateDeliveryAttempt(
              payload.deliveryId,
              payload.tenantId,
              httpStatus,
              responseBody,
              job.attemptsMade + 1,
            );
            await incrementFailureCount(payload.subscriptionId, payload.tenantId);
            throw new Error(`Webhook delivery failed with status ${httpStatus}`);
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('Webhook delivery failed')) {
              throw error; // Let BullMQ retry
            }

            log.error('Webhook delivery error', {
              tenantId: payload.tenantId,
              deliveryId: payload.deliveryId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            await updateDeliveryAttempt(
              payload.deliveryId,
              payload.tenantId,
              null,
              error instanceof Error ? error.message : 'Unknown error',
              job.attemptsMade + 1,
            );
            throw error; // Let BullMQ retry
          }
        },
      );
    },
    {
      connection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 10,
    },
  );

  worker.on('failed', async (job: any, err: Error) => {
    const attemptsMade = typeof job?.attemptsMade === 'number' ? job.attemptsMade : 0;
    const maxAttempts = typeof job?.opts?.attempts === 'number' ? job.opts.attempts : 1;
    const isTerminalFailure = attemptsMade >= maxAttempts;

    log.error('Delivery job failed', {
      jobId: job?.id,
      tenantId: job?.data?.tenantId,
      error: err.message,
      attempts: attemptsMade,
      maxAttempts,
      isTerminalFailure,
    });

    // Mark terminal failed status only after all retries are exhausted.
    if (isTerminalFailure && job?.data?.deliveryId && job?.data?.tenantId) {
      try {
        await runWithTenantContext(
          {
            tenantId: job.data.tenantId,
            userId: 'system',
            role: 'system',
            permissions: [],
            authType: 'api_key' as const,
            isSuperAdmin: false,
          },
          async () => {
            await markDeliveryTerminalFailed(job.data.deliveryId, job.data.tenantId, err.message);
          },
        );
      } catch (updateErr) {
        log.error('Failed to update delivery terminal status', {
          deliveryId: job.data.deliveryId,
          tenantId: job.data.tenantId,
          error: updateErr instanceof Error ? updateErr.message : 'Unknown error',
        });
      }
    }
  });

  log.info('Delivery worker started');
}

export async function stopDeliveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    log.info('Delivery worker stopped');
  }
}

// =============================================================================
// HELPERS
// =============================================================================

async function updateDeliveryStatus(
  deliveryId: string,
  tenantId: string,
  status: string,
  httpStatus: number | null,
  responseBody: string | null,
): Promise<void> {
  const { WebhookDelivery } = await import('@agent-platform/database/models');
  await WebhookDelivery.updateOne(
    { _id: deliveryId, tenantId },
    {
      $set: {
        status,
        httpStatus,
        responseBody,
        lastAttemptAt: new Date(),
        ...(status === 'delivered' ? { deliveredAt: new Date() } : {}),
      },
      $inc: { attempts: 1 },
    },
  );
}

async function updateDeliveryAttempt(
  deliveryId: string,
  tenantId: string,
  httpStatus: number | null,
  responseBody: string | null,
  attempts: number,
): Promise<void> {
  const { WebhookDelivery } = await import('@agent-platform/database/models');
  await WebhookDelivery.updateOne(
    { _id: deliveryId, tenantId },
    {
      $set: {
        httpStatus,
        responseBody,
        lastAttemptAt: new Date(),
        attempts,
      },
    },
  );
}

async function incrementFailureCount(subscriptionId: string, tenantId: string): Promise<void> {
  const { WebhookSubscription } = await import('@agent-platform/database/models');
  await WebhookSubscription.updateOne(
    { _id: subscriptionId, tenantId },
    { $inc: { failureCount: 1 } },
  );
}

async function markDeliveryTerminalFailed(
  deliveryId: string,
  tenantId: string,
  responseBody: string,
): Promise<void> {
  const { WebhookDelivery } = await import('@agent-platform/database/models');
  const result = await WebhookDelivery.updateOne(
    { _id: deliveryId, tenantId },
    {
      $set: {
        status: 'failed',
        responseBody,
        lastAttemptAt: new Date(),
      },
    },
  );

  if (result.modifiedCount === 0) {
    throw new Error(`Delivery record not found for tenant-scoped terminal update: ${deliveryId}`);
  }
}
