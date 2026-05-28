/**
 * Agent Transfer Configuration Schema
 *
 * Zod schemas for all agent transfer behavior: session TTLs,
 * SmartAssist client, provider configs, voice gateway, identity
 * mapping, PII handling, and analytics.
 *
 * Follows packages/config/src/schemas/ pattern.
 */
import { z } from 'zod';

export const TransferSessionConfigSchema = z.object({
  ttl: z
    .object({
      chat: z.number().default(1800),
      email: z.number().default(14400),
      voice: z.number().default(0),
      messaging: z.number().default(1800),
      campaign: z.number().default(3600),
      default: z.number().default(1800),
    })
    .default({}),
  maxConcurrentPerContact: z.number().default(1),
  cleanupBatchSize: z.number().default(100),
});

export const SmartAssistConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  timeoutMs: z.number().default(5000),
  /** HMAC secret for webhook signature verification (optional) */
  webhookSecret: z.string().optional(),
  /** SmartAssist App ID (Bot ID) — used as botId in XO API calls */
  appId: z.string().optional(),
  /** SmartAssist hours ID for business hours pre-check */
  hoursId: z.string().optional(),
  /** Organization ID — maps to orgId in SmartAssist API payloads (falls back to tenantId) */
  orgId: z.string().optional(),
  /** @deprecated Use orgId instead — kept for backward compatibility with .env configs */
  accountId: z.string().optional(),
  /** Kore account ID — maps to accountId field in API payloads (falls back to accountId/orgId) */
  koreAccountId: z.string().optional(),
  /** KoreServer host URL — used for synthetic user creation before transfer (e.g. https://bots.kore.ai) */
  koreHost: z.string().optional(),
  /** Internal API key for KoreServer calls (defaults to apiKey if not set) */
  koreApiKey: z.string().optional(),
  /** Path for transfer initiation POST (default: '/api/v1/conversations') */
  initTransferPath: z.string().optional(),
  /** Path for user→agent event delivery (default: '/api/v1/internal/events/handle/') */
  eventHandlePath: z.string().optional(),
  /** SIP URI SmartAssist should use as the bot side of a voice transfer. */
  botSIPURI: z.string().optional(),
  /** TTS prompt played to caller after agent disconnects to collect CSAT rating */
  csatVoicePrompt: z
    .string()
    .optional()
    .default(
      'Please rate your experience with our agent. Press 1 for poor, 2 for fair, 3 for good, 4 for very good, or 5 for excellent. Press 0 to skip.',
    ),
  /** TTS message played after CSAT rating is collected */
  csatVoiceThankYou: z.string().optional().default('Thank you for your feedback. Goodbye.'),
  /** ABL Platform webhook base URL — when set, a callback object is included in the transfer
   *  payload so AgentAssist dispatches agent events to ABL instead of KoreServer.
   *  Example: 'https://abl-runtime.example.com' */
  ablWebhookBaseUrl: z.string().url().optional(),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().default(5),
      resetTimeoutMs: z.number().default(30000),
      halfOpenMax: z.number().default(3),
    })
    .default({}),
  retry: z
    .object({
      maxAttempts: z.number().default(2),
      backoffMs: z.number().default(500),
      backoffMultiplier: z.number().default(2),
    })
    .default({}),
});

export const RateLimitConfigSchema = z.object({
  maxTransfers: z.number().default(100),
  windowMs: z.number().default(60000),
});

export const ProviderConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  auth: z.record(z.unknown()),
  options: z.record(z.unknown()).default({}),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().default(5),
      resetTimeoutMs: z.number().default(30000),
    })
    .default({}),
  timeoutMs: z.number().default(30000),
  fallback: z.string().optional(),
});

export const VoiceGatewayConfigSchema = z.object({
  type: z.enum(['audiocodes', 'korevg', 'jambonz']).default('korevg'),
  sipDefaults: z
    .object({
      transferMethod: z.enum(['invite', 'refer', 'bye']).default('invite'),
      headerPassthrough: z.boolean().default(true),
    })
    .default({}),
  recording: z
    .object({
      enabled: z.boolean().default(false),
      orgLevelCheck: z.boolean().default(true),
    })
    .default({}),
});

export const AgentTransferConfigSchema = z.object({
  session: TransferSessionConfigSchema.default({}),
  smartassist: SmartAssistConfigSchema.optional(),
  providers: z.array(ProviderConfigSchema).default([]),
  voice: VoiceGatewayConfigSchema.default({}),
  identity: z
    .object({
      mapAgentIdToBotId: z.boolean().default(true),
      mapContactIdToUserId: z.boolean().default(true),
    })
    .default({}),
  pii: z
    .object({
      deTokenizeBeforeTransfer: z.boolean().default(true),
      detectionPattern: z.string().default('\\{\\{pii\\..*?\\}\\}'),
    })
    .default({}),
  analytics: z
    .object({
      emitTraceEvents: z.boolean().default(true),
      trackContainment: z.boolean().default(true),
      trackDialogTone: z.boolean().default(false),
    })
    .default({}),
  rateLimit: RateLimitConfigSchema.optional(),
});

// ── Per-Provider Typed Config Schemas ───────────────────────────────────────

export const KoreProviderConfigSchema = z.object({
  hoursId: z.string().optional(),
  customData: z.record(z.unknown()).optional(),
});

export const GenericProviderConfigSchema = z.record(z.unknown());

export const Five9ProviderConfigSchema = z
  .object({
    tenantName: z.string().min(1),
    campaignName: z.string().min(1),
    host: z
      .string()
      .min(1)
      .default('app.five9.com')
      .transform((h) => {
        // Normalize: strip protocol and trailing path/slash so users can paste full URLs
        let bare = h;
        if (bare.includes('://')) bare = bare.split('://')[1];
        bare = bare.split('/')[0];
        return bare;
      }),
    authMode: z.enum(['anonymous', 'supervisor']),
    username: z.string().optional(),
    password: z.string().optional(),
    callbackUrl: z.string().url().optional(),
  })
  .refine((data) => data.authMode !== 'supervisor' || (data.username && data.password), {
    message: 'username and password required for supervisor auth mode',
  });

export type AgentTransferConfig = z.infer<typeof AgentTransferConfigSchema>;
export type TransferSessionConfig = z.infer<typeof TransferSessionConfigSchema>;
export type SmartAssistConfig = z.infer<typeof SmartAssistConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type VoiceGatewayConfig = z.infer<typeof VoiceGatewayConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type KoreProviderConfig = z.infer<typeof KoreProviderConfigSchema>;
export type GenericProviderConfig = z.infer<typeof GenericProviderConfigSchema>;
export type Five9ProviderConfig = z.infer<typeof Five9ProviderConfigSchema>;
