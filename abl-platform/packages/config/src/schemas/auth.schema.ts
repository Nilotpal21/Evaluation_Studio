import { z } from 'zod';

/**
 * Authentication & Authorization Configuration
 *
 * All auth-related constants that were previously hardcoded across Studio
 * route handlers and services. Centralizing them here makes every value
 * tunable per environment via env vars or config overrides.
 */
export const AuthConfigSchema = z.object({
  password: z
    .object({
      bcryptCost: z.coerce.number().int().min(4).max(31).default(12),
      minLength: z.coerce.number().int().min(6).default(8),
      requireUppercase: z.boolean().default(true),
      requireLowercase: z.boolean().default(true),
      requireDigit: z.boolean().default(true),
      requireSpecialChar: z.boolean().default(false),
      commonPasswords: z
        .array(z.string())
        .default([
          'password',
          'password1',
          'Password1',
          '12345678',
          '123456789',
          'qwerty123',
          'abc12345',
          'iloveyou',
          'admin123',
          'welcome1',
          'monkey123',
          'dragon12',
          'master12',
          'letmein1',
          'football',
          'baseball',
          'trustno1',
          'sunshine',
          'princess',
          'whatever',
        ]),
      historyCount: z.coerce.number().int().min(0).max(24).default(5),
      resetTokenTtlMs: z.coerce
        .number()
        .int()
        .default(60 * 60 * 1000), // 1 hour
      verificationTokenTtlMs: z.coerce
        .number()
        .int()
        .default(24 * 60 * 60 * 1000), // 24 hours
    })
    .default({}),

  lockout: z
    .object({
      maxFailedAttempts: z.coerce.number().int().min(1).default(5),
      lockDurationMs: z.coerce
        .number()
        .int()
        .default(15 * 60 * 1000), // 15 min
    })
    .default({}),

  mfa: z
    .object({
      totpWindow: z.coerce.number().int().min(0).max(5).default(1),
      totpDigits: z.coerce.number().int().min(6).max(8).default(6),
      totpPeriod: z.coerce.number().int().min(15).max(60).default(30),
      recoveryCodeCount: z.coerce.number().int().min(5).max(20).default(10),
      recoveryCodeLength: z.coerce.number().int().min(6).max(16).default(8),
      recoveryCodeBcryptCost: z.coerce.number().int().min(4).max(31).default(10),
      lockThreshold: z.coerce.number().int().min(3).default(10),
      lockDurationMs: z.coerce
        .number()
        .int()
        .default(30 * 60 * 1000), // 30 min
      partialTokenTtlSeconds: z.coerce.number().int().default(300), // 5 min
      issuer: z.string().default('KorePlatform'),
    })
    .default({}),

  tokens: z
    .object({
      sdkSessionTtlSeconds: z.coerce.number().int().default(14400), // 4 hours
      deviceAuthTtlMs: z.coerce
        .number()
        .int()
        .default(15 * 60 * 1000), // 15 min
      refreshCookieMaxAgeSeconds: z.coerce
        .number()
        .int()
        .default(7 * 24 * 60 * 60), // 7 days
      mfaCookieMaxAgeSeconds: z.coerce.number().int().default(300), // 5 min
    })
    .default({}),

  purposeTokens: z
    .object({
      /**
       * Dedicated signing secret for public email feedback links.
       * Must be distinct from JWT_SECRET and SDK session signing secrets.
       */
      feedbackSigningSecret: z.string().min(32).optional(),
      /**
       * Dedicated fallback signing secret for Gupshup webhook JWTs when a
       * connection-specific webhook_secret is not used.
       */
      gupshupWebhookSigningSecret: z.string().min(32).optional(),
    })
    .default({}),

  sdk: z
    .object({
      /**
       * Dedicated Runtime-only signing secret for sdk_session JWTs.
       * Must not be shared with Studio or any other control-plane service.
       */
      sessionSigningSecret: z.string().min(32).optional(),
      /**
       * Shared signing secret for preview/share bootstrap artifacts exchanged
       * from Studio to Runtime. This is intentionally distinct from the
       * Runtime-only sdk_session signing secret.
       */
      bootstrapSigningSecret: z.string().min(32).optional(),
      /**
       * When true, Runtime must fail closed if SDK-authenticated session state
       * cannot use a distributed session store. Defaults to true in production
       * and false elsewhere when unset.
       */
      requireDistributedState: z.boolean().optional(),
      /**
       * Runtime-owned browser SDK JWE envelope capability. Policy still lives on
       * project/channel settings; this only controls whether the environment can
       * encrypt/decrypt when a policy asks for JWE.
       */
      jwe: z
        .object({
          /**
           * undefined = auto-enable when encryption.masterKey is configured.
           * false = operationally disable JWE issue/verify capability.
           */
          enabled: z.boolean().optional(),
          maxEncryptedBootstrapBytes: z.coerce.number().int().min(1024).max(16384).default(4096),
          maxEncryptedSessionBytes: z.coerce.number().int().min(1024).max(16384).default(4096),
        })
        .default({}),
    })
    .default({}),

  sso: z
    .object({
      authCodeTtlSeconds: z.coerce.number().int().default(60),
      oidcStateTtlSeconds: z.coerce.number().int().default(600), // 10 min
      samlAssertionTtlSeconds: z.coerce.number().int().default(3600), // 1 hour
    })
    .default({}),

  rateLimits: z
    .object({
      login: z
        .object({
          maxAttempts: z.coerce.number().int().default(10),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      signup: z
        .object({
          maxAttempts: z.coerce.number().int().default(5),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      forgotPassword: z
        .object({
          maxAttempts: z.coerce.number().int().default(3),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      resetPassword: z
        .object({
          maxAttempts: z.coerce.number().int().default(5),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      createWorkspace: z
        .object({
          maxAttempts: z.coerce.number().int().default(5),
          windowMs: z.coerce
            .number()
            .int()
            .default(60 * 60 * 1000), // 1 hour
        })
        .default({}),
      deviceToken: z
        .object({
          maxAttempts: z.coerce.number().int().default(12),
          windowMs: z.coerce
            .number()
            .int()
            .default(60 * 1000), // 1 min
        })
        .default({}),
      verifyEmail: z
        .object({
          maxAttempts: z.coerce.number().int().default(10),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      refresh: z
        .object({
          maxAttempts: z.coerce.number().int().default(30),
          windowMs: z.coerce
            .number()
            .int()
            .default(60 * 1000), // 1 min
        })
        .default({}),
      mfaRecovery: z
        .object({
          maxAttempts: z.coerce.number().int().default(5),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      resendVerification: z
        .object({
          maxAttempts: z.coerce.number().int().default(3),
          windowMs: z.coerce
            .number()
            .int()
            .default(15 * 60 * 1000),
        })
        .default({}),
      ssoDomains: z
        .object({
          maxAttempts: z.coerce.number().int().default(10),
          windowMs: z.coerce
            .number()
            .int()
            .default(60 * 60 * 1000), // 1 hour
        })
        .default({}),
    })
    .default({}),

  validation: z
    .object({
      maxEmailLength: z.coerce.number().int().default(254),
      maxPasswordLength: z.coerce.number().int().default(128),
      maxNameLength: z.coerce.number().int().default(200),
      emailRegex: z.string().default('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'),
    })
    .default({}),

  workspace: z
    .object({
      maxPerUser: z.coerce.number().int().default(10),
    })
    .default({}),

  timingProtection: z
    .object({
      minResponseMs: z.coerce.number().int().default(200),
    })
    .default({}),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
