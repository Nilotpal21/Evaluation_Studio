/**
 * Studio Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Composes the base config schema with studio-specific extensions.
 *
 * Note: NEXT_PUBLIC_* vars are build-time substitutions and stay as
 * process.env.NEXT_PUBLIC_* in client-side code. This config covers
 * server-side config only.
 */

import { z } from 'zod';
import {
  AuthConfigSchema,
  composeConfigSchema,
  createConfigLoader,
  validateProductionConfig,
  VoiceConfigSchema,
  type BaseAppConfig,
} from '@agent-platform/config';

// =============================================================================
// STUDIO-SPECIFIC EXTENSIONS
// =============================================================================

const StudioExtensionsSchema = z.object({
  runtimeUrl: z.string().url().optional(),
  nextAuthSecret: z.string().optional(),
  nextAuthUrl: z.string().url().optional(),
});

// =============================================================================
// COMPOSED SCHEMA
// =============================================================================

export const StudioConfigSchema = composeConfigSchema({
  auth: AuthConfigSchema.default({}),
  studio: StudioExtensionsSchema.default({}),
  voice: VoiceConfigSchema.default({}),
});

export type StudioConfig = z.infer<typeof StudioConfigSchema>;

// =============================================================================
// CONFIG LOADER
// =============================================================================

const STUDIO_ENV_MAPPING = {
  RUNTIME_URL: 'studio.runtimeUrl',
  NEXTAUTH_SECRET: 'studio.nextAuthSecret',
  NEXTAUTH_URL: 'studio.nextAuthUrl',

  // Voice
  TWILIO_ACCOUNT_SID: 'voice.twilio.accountSid',
  TWILIO_AUTH_TOKEN: 'voice.twilio.authToken',
  TWILIO_PHONE_NUMBER: 'voice.twilio.phoneNumber',
  TWILIO_API_KEY_SID: 'voice.twilio.apiKeySid',
  TWILIO_API_KEY_SECRET: 'voice.twilio.apiKeySecret',
  TWILIO_TWIML_APP_SID: 'voice.twilio.twimlAppSid',
  DEEPGRAM_API_KEY: 'voice.deepgram.apiKey',
  ELEVENLABS_API_KEY: 'voice.elevenLabs.apiKey',
  ELEVENLABS_VOICE_ID: 'voice.elevenLabs.voiceId',
};

const loader = createConfigLoader(StudioConfigSchema, {
  envMapping: STUDIO_ENV_MAPPING,
  productionChecks: (cfg) => validateProductionConfig(cfg as BaseAppConfig).map((w) => w.message),
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
export const reloadConfig = loader.reloadConfig;
export const getConfigMeta = loader.getConfigMeta;

// Re-export vault types for backward compatibility
export type { VaultType, VaultProvider } from '@agent-platform/config';
