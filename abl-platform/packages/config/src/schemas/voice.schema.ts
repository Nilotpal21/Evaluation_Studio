import { z } from 'zod';

/**
 * Voice configuration — absorbs Twilio/Deepgram/ElevenLabs env reads
 * into a single typed schema.
 */
export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['pipeline', 'realtime', 'auto']).default('pipeline'),
  twilio: z
    .object({
      accountSid: z.string().optional(),
      authToken: z.string().optional(),
      phoneNumber: z.string().optional(),
      apiKeySid: z.string().optional(),
      apiKeySecret: z.string().optional(),
      twimlAppSid: z.string().optional(),
      trunkSid: z.string().optional(),
    })
    .default({}),
  deepgram: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('nova-3'),
    })
    .default({}),
  elevenLabs: z
    .object({
      apiKey: z.string().optional(),
      voiceId: z.string().optional(),
      model: z.string().default('eleven_monolingual_v1'),
    })
    .default({}),
  livekit: z
    .object({
      url: z.string().url().optional(),
      apiKey: z.string().min(1).optional(),
      apiSecret: z.string().min(1).optional(),
      tokenTtlSeconds: z.coerce.number().int().positive().default(3600),
      maxConcurrentRooms: z.coerce.number().int().positive().default(50),
    })
    .default({}),
  jambonz: z
    .object({
      baseApiUrl: z.string().url().optional(),
      accountSid: z.string().optional(),
      apiKey: z.string().optional(),
      voipCarrierSid: z.string().optional(),
      serviceProviderId: z.string().optional(),
      serviceProviderApiKey: z.string().optional(),
      sbcAddress: z.string().optional(),
      sbcWsAddress: z.string().optional(),
    })
    .default({}),
  realtime: z
    .object({
      enabled: z.boolean().default(false),
      defaultProvider: z.enum(['openai_realtime', 'gemini_live']).default('openai_realtime'),
      defaultVoice: z.string().default('alloy'),
      turnDetection: z
        .object({
          type: z.enum(['server_vad', 'none']).default('server_vad'),
          threshold: z.number().min(0).max(1).default(0.5),
          silenceDurationMs: z.coerce.number().int().positive().default(500),
        })
        .default({}),
      maxSessionDurationMs: z.coerce
        .number()
        .int()
        .positive()
        .default(30 * 60 * 1000),
      audioFormat: z.enum(['pcm16', 'g711_ulaw', 'g711_alaw']).default('pcm16'),
    })
    .default({}),
  latencyTargetMs: z.coerce.number().int().positive().default(500),
  maxConcurrentCalls: z.coerce.number().int().positive().default(50),
});

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
