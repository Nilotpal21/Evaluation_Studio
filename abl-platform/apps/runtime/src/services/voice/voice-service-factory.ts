/**
 * Voice Service Factory
 *
 * Tenant-aware voice service resolution with caching.
 * Resolves TenantServiceInstance records, decrypts credentials,
 * and creates/caches service instances per tenant.
 */

import type { EncryptionService } from '@agent-platform/shared/encryption';
import { DeepgramService } from './deepgram-service.js';
import { ElevenLabsService } from './elevenlabs-service.js';
import { TwilioService } from './twilio-service.js';
import { resolveVoiceMode, type VoiceMode, type VoiceModeContext } from './voice-mode-resolver.js';
import { createLogger } from '@abl/compiler/platform';
import { dualReadCredentials } from '@agent-platform/shared/services/auth-profile';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { isLegacyCiphertextFormatError } from '@agent-platform/shared-encryption';
import { resolveAuthProfileCredentials } from '../auth-profile-resolver.js';
import {
  findActiveVoiceServiceInstanceById,
  findDefaultActiveVoiceServiceInstance,
  type VoiceServiceInstanceRecord,
} from './voice-service-instance-repo.js';

export interface DecryptedCredentials {
  apiKey: string;
  config?: Record<string, unknown>;
  instanceId?: string;
}

export interface VoiceCredentials {
  stt: { apiKey: string; model?: string } | null;
  tts: { apiKey: string; voiceId?: string; model?: string } | null;
}

export interface VoiceCredentialResolutionOptions {
  sttServiceType?: string;
  sttInstanceId?: string;
  ttsServiceType?: string;
  ttsInstanceId?: string;
}

const log = createLogger('voice-service-factory');

function readVoiceModel(config: Record<string, unknown> | undefined): string | undefined {
  const value = config?.model ?? config?.modelId ?? config?.sttModelId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

interface CachedService {
  service: DeepgramService | ElevenLabsService | TwilioService;
  instanceId: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 100;

export class VoiceServiceFactory {
  private cache: Map<string, CachedService> = new Map();

  constructor(_encryption: EncryptionService | null = null) {}

  /**
   * Get a Deepgram STT service for the given tenant.
   */
  async getSTTService(tenantId: string): Promise<DeepgramService | null> {
    return this.getService(tenantId, 'deepgram') as Promise<DeepgramService | null>;
  }

  /**
   * Get an ElevenLabs TTS service for the given tenant.
   */
  async getTTSService(tenantId: string): Promise<ElevenLabsService | null> {
    return this.getService(tenantId, 'elevenlabs') as Promise<ElevenLabsService | null>;
  }

  /**
   * Get a Twilio service for the given tenant.
   */
  async getTwilioService(tenantId: string): Promise<TwilioService | null> {
    return this.getService(tenantId, 'twilio') as Promise<TwilioService | null>;
  }

  /**
   * Invalidate cached services for a tenant (e.g., after credential rotation).
   */
  invalidate(tenantId: string, serviceType?: string): void {
    if (serviceType) {
      this.cache.delete(`${tenantId}:${serviceType}`);
    } else {
      // Invalidate all service types for this tenant
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${tenantId}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Resolve voice mode for the given context.
   * Delegates to voice-mode-resolver with tenant capability check.
   */
  async resolveVoiceMode(
    ctx: Omit<VoiceModeContext, 'tenantHasRealtimeModel'>,
  ): Promise<VoiceMode> {
    let tenantHasRealtimeModel = false;

    if (ctx.tenantId) {
      try {
        const { findDefaultTenantModelForVoice } =
          await import('../../repos/llm-resolution-repo.js');
        const voiceModel = await findDefaultTenantModelForVoice(ctx.tenantId);
        tenantHasRealtimeModel = voiceModel != null;
        log.debug('[VOICE_MODE] Tenant realtime model check', {
          tenantId: ctx.tenantId,
          hasRealtimeModel: tenantHasRealtimeModel,
          voiceModel: voiceModel ? 'found' : 'not found',
        });
      } catch (err) {
        log.warn('Failed to check tenant realtime model availability', {
          tenantId: ctx.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return resolveVoiceMode({ ...ctx, tenantHasRealtimeModel });
  }

  /**
   * Resolve voice credentials (STT + TTS) for a given tenant.
   * Used by the LiveKit agent-worker to get Deepgram/ElevenLabs API keys
   * without creating full service instances.
   */
  async resolveVoiceCredentials(
    tenantId: string,
    options: VoiceCredentialResolutionOptions = {},
  ): Promise<VoiceCredentials> {
    const [sttCreds, ttsCreds] = await Promise.all([
      this.resolveAndDecrypt(tenantId, options.sttServiceType ?? 'deepgram', options.sttInstanceId),
      this.resolveAndDecrypt(
        tenantId,
        options.ttsServiceType ?? 'elevenlabs',
        options.ttsInstanceId,
      ),
    ]);
    return {
      stt: sttCreds ? { apiKey: sttCreds.apiKey, model: readVoiceModel(sttCreds.config) } : null,
      tts: ttsCreds
        ? {
            apiKey: ttsCreds.apiKey,
            voiceId: ttsCreds.config?.voiceId as string | undefined,
            model: readVoiceModel(ttsCreds.config),
          }
        : null,
    };
  }

  /**
   * Resolve S2S (Speech-to-Speech) provider credentials for realtime voice.
   * Used by Korevg S2SSessionBridge to get API keys for OpenAI Realtime,
   * ElevenLabs Conversational AI, Google Gemini Live, etc.
   */
  async resolveS2SCredentials(
    tenantId: string,
    provider: string,
  ): Promise<{ credentials: { apiKey: string; config?: Record<string, unknown> } } | null> {
    const creds = await this.resolveAndDecrypt(tenantId, provider);
    if (!creds) {
      log.warn('Failed to resolve S2S credentials', { tenantId, provider });
      return null;
    }
    return {
      credentials: {
        apiKey: creds.apiKey,
        config: creds.config,
      },
    };
  }

  /**
   * Subscribe to Auth Profile update events via Redis pub/sub.
   * When an auth profile with category 'voice' is updated, invalidates
   * cached voice services for the affected tenant.
   *
   * @param redisSub - A Redis client in subscriber mode
   * @returns Cleanup function to unsubscribe
   */
  subscribeToAuthProfileEvents(redisSub: {
    subscribe(channel: string, callback: (message: string) => void): void;
    unsubscribe(channel: string): void;
  }): () => void {
    const channel = 'auth-profile:updated';
    const handler = (message: string) => {
      try {
        const { tenantId, category } = JSON.parse(message) as {
          tenantId?: string;
          category?: string;
        };
        if (!tenantId) return;

        // Invalidate voice caches when voice-related auth profiles change
        if (category === 'voice') {
          this.invalidate(tenantId);
          log.info('Voice service cache invalidated via auth profile event', {
            tenantId,
            category,
          });
        }
      } catch (err) {
        log.warn('Failed to process auth-profile:updated event', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    redisSub.subscribe(channel, handler);
    return () => redisSub.unsubscribe(channel);
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  async resolveServiceCredentials(
    tenantId: string,
    serviceType: string,
    options: { instanceId?: string } = {},
  ): Promise<DecryptedCredentials | null> {
    return this.resolveAndDecrypt(tenantId, serviceType, options.instanceId);
  }

  /**
   * Resolve a TenantServiceInstance from DB and decrypt its credentials.
   * Shared by getService() and resolveVoiceCredentials().
   */
  private async resolveAndDecrypt(
    tenantId: string,
    serviceType: string,
    instanceId?: string,
  ): Promise<DecryptedCredentials | null> {
    const instance = await this.resolveInstance(tenantId, serviceType, instanceId);
    if (!instance) return null;

    // ── Auth Profile dual-read: try auth profile first, fall back to legacy ──
    const { credentials } = await dualReadCredentials<DecryptedCredentials | null>({
      authProfileId: instance.authProfileId,
      tenantId,
      consumer: 'TenantServiceInstance',
      resolve: async () => {
        const profile = await resolveAuthProfileCredentials(instance.authProfileId!, tenantId);
        if (!profile) return null;
        const apiKey =
          (profile.secrets.apiKey as string) ?? (profile.secrets.accessToken as string) ?? '';
        if (!apiKey) return null;
        return {
          apiKey,
          config: profile.config,
          instanceId: instance.id ?? instance._id,
        };
      },
      legacyFallback: async () => {
        try {
          const decryptionFailed = Boolean(
            (instance as VoiceServiceInstanceRecord & { _decryptionFailed?: boolean })
              ._decryptionFailed,
          );
          const apiKey = await resolveTenantPlaintextValue(
            instance.encryptedApiKey ?? null,
            tenantId,
            { decryptionFailed },
          );
          if (!apiKey) {
            log.warn('No API key available after legacy voice credential resolution', {
              instanceId: instance.id ?? instance._id,
              serviceType,
            });
            return null;
          }
          let config: Record<string, unknown> | undefined;
          const rawConfig = instance.encryptedConfig;
          if (rawConfig && typeof rawConfig === 'object') {
            config = rawConfig as Record<string, unknown>;
          } else if (typeof rawConfig === 'string') {
            const decryptedConfig = await resolveTenantPlaintextValue(rawConfig, tenantId, {
              decryptionFailed,
            });
            try {
              config = decryptedConfig
                ? (JSON.parse(decryptedConfig) as Record<string, unknown>)
                : undefined;
            } catch {
              log.debug('encryptedConfig is not parseable JSON', {
                instanceId: instance.id ?? instance._id,
                serviceType,
              });
            }
          }
          return { apiKey, config, instanceId: instance.id ?? instance._id };
        } catch (err) {
          if (isLegacyCiphertextFormatError(err)) {
            log.warn(
              'Voice service instance has pre-DEK ciphertext; needs backfill before it can be used',
              {
                instanceId: instance.id ?? instance._id,
                serviceType,
              },
            );
            return null;
          }
          log.error('Failed to read service instance credentials', {
            instanceId: instance.id ?? instance._id,
            serviceType,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      },
    });

    return credentials;
  }

  private async getService(
    tenantId: string,
    serviceType: string,
  ): Promise<DeepgramService | ElevenLabsService | TwilioService | null> {
    const cacheKey = `${tenantId}:${serviceType}`;

    // Check cache (re-insert to mark as recently used for LRU)
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.service;
    }

    const creds = await this.resolveAndDecrypt(tenantId, serviceType);
    if (!creds) return null;

    // Create service instance
    let service: DeepgramService | ElevenLabsService | TwilioService;

    switch (serviceType) {
      case 'deepgram':
        service = DeepgramService.fromCredentials(creds.apiKey, creds.config);
        break;
      case 'elevenlabs':
        service = ElevenLabsService.fromCredentials(creds.apiKey, creds.config);
        break;
      case 'twilio':
        service = TwilioService.fromCredentials(creds.apiKey, creds.config);
        break;
      default:
        log.warn('Unknown service type', { serviceType });
        return null;
    }

    // Evict least-recently-used entry if at capacity
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    // Cache with instanceId from resolveAndDecrypt (no extra DB query)
    this.cache.set(cacheKey, {
      service,
      instanceId: creds.instanceId ?? 'unknown',
      cachedAt: Date.now(),
    });

    return service;
  }

  private async resolveInstance(
    tenantId: string,
    serviceType: string,
    instanceId?: string,
  ): Promise<VoiceServiceInstanceRecord | null> {
    if (instanceId) {
      return findActiveVoiceServiceInstanceById(tenantId, instanceId, serviceType);
    }

    return findDefaultActiveVoiceServiceInstance(tenantId, serviceType);
  }
}
