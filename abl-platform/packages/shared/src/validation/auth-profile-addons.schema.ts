/**
 * Auth Profile Addon Schemas
 *
 * Validation for signing, webhook verification, and proxy addons.
 * Also includes invalid combination matrix and addon secrets validation.
 */

import { z } from 'zod';

// ── Signing Addon ──────────────────────────────────────────────────────

export const SigningAddonSchema = z
  .object({
    algorithm: z.enum(['hmac-sha256', 'hmac-sha512', 'aws-sig-v4', 'rsa-sha256']),
    signedComponents: z.array(z.enum(['body', 'timestamp', 'url', 'headers'])).min(1),
    timestampHeader: z.string().optional(),
    signatureHeader: z.string().optional(),
  })
  .strict();

// ── Webhook Verification Addon ─────────────────────────────────────────

export const WebhookVerificationAddonSchema = z
  .object({
    method: z.enum(['hmac-sha256', 'hmac-sha1', 'svix', 'rsa-sha256']),
    signatureHeader: z.string().min(1),
    timestampHeader: z.string().optional(),
    toleranceSeconds: z.number().int().positive().optional(),
  })
  .strict();

// ── Proxy Addon ────────────────────────────────────────────────────────

// SSRF blocklist for proxy URLs
// Covers: loopback, RFC1918 private, link-local (169.254.x.x / AWS metadata),
// IPv6 loopback, IPv6 link-local (fe80::), IPv6 unique-local (fc00::/fd00::)
const BLOCKED_HOSTS =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[0+:0+:0+:0+:0+:0+:0+:0*1?\]|\[fe80:.*\]|\[fc00:.*\]|\[fd[0-9a-f]{2}:.*\])$/i;

export const ProxyAddonSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), {
        message: 'Proxy URL must use HTTPS',
      })
      .refine(
        (u) => {
          try {
            const hostname = new URL(u).hostname;
            return !BLOCKED_HOSTS.test(hostname);
          } catch {
            return false;
          }
        },
        { message: 'Proxy URL must not target internal/private networks (SSRF protection)' },
      ),
    proxyAuthProfileId: z.string().optional(),
  })
  .strict();

// ── Certificate Pinning Addon ─────────────────────────────────────────

export const CertificatePinningAddonSchema = z
  .object({
    pins: z
      .array(
        z.object({
          fingerprint: z.string().min(1),
          algorithm: z.enum(['sha256', 'sha1']),
        }),
      )
      .min(1),
    rejectUnpinned: z.boolean(),
  })
  .strict();

// ── JWT Wrapping Addon ───────────────────────────────────────────────

export const JwtWrappingAddonSchema = z
  .object({
    algorithm: z.enum(['RS256', 'ES256', 'HS256']),
    audience: z.string().min(1),
    issuer: z.string().min(1),
    expiresInSeconds: z.number().int().positive(),
    claims: z.record(z.unknown()).optional(),
  })
  .strict();

// ── Invalid Combination Matrix ─────────────────────────────────────────

interface AddonInput {
  signing?: unknown;
  webhookVerification?: unknown;
  proxy?: unknown;
  certificatePinning?: unknown;
  jwtWrapping?: unknown;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

const INVALID_COMBINATIONS: Array<{
  authType?: string;
  addon: string;
  addon2?: string;
  reason: string;
}> = [
  {
    authType: 'aws_iam',
    addon: 'signing',
    reason: 'aws_iam + signing: AWS SigV4 is itself a signing mechanism',
  },
  {
    authType: 'ssh_key',
    addon: 'signing',
    reason: 'ssh_key + signing: SSH key is not used in HTTP requests',
  },
  {
    authType: 'ssh_key',
    addon: 'proxy',
    reason: 'ssh_key + proxy: SSH key is not used in HTTP requests',
  },
  {
    addon: 'webhookVerification',
    addon2: 'signing',
    reason: 'webhookVerification + signing: opposite directions',
  },
  { authType: 'mtls', addon: 'proxy', reason: 'mtls + proxy: mTLS is terminated at the proxy' },
  // Phase 3: certificatePinning invalid combos
  {
    authType: 'ssh_key',
    addon: 'certificatePinning',
    reason: 'ssh_key + certificatePinning: SSH key is not used in HTTP requests',
  },
  {
    authType: 'aws_iam',
    addon: 'certificatePinning',
    reason: 'aws_iam + certificatePinning: AWS SigV4 manages its own TLS verification',
  },
  // Phase 3: jwtWrapping invalid combos
  {
    authType: 'ssh_key',
    addon: 'jwtWrapping',
    reason: 'ssh_key + jwtWrapping: SSH key is not used in HTTP requests',
  },
  {
    authType: 'aws_iam',
    addon: 'jwtWrapping',
    reason: 'aws_iam + jwtWrapping: AWS SigV4 has its own signing mechanism',
  },
  {
    authType: 'mtls',
    addon: 'jwtWrapping',
    reason: 'mtls + jwtWrapping: mTLS uses certificate-based auth, not token wrapping',
  },
  {
    authType: 'azure_ad',
    addon: 'jwtWrapping',
    reason: 'azure_ad + jwtWrapping: Azure AD already issues JWTs',
  },
  {
    authType: 'oauth2_app',
    addon: 'jwtWrapping',
    reason: 'oauth2_app + jwtWrapping: oauth2_app is a Layer 1 config, not directly applied',
  },
  {
    authType: 'oauth2_token',
    addon: 'jwtWrapping',
    reason: 'oauth2_token + jwtWrapping: OAuth2 tokens already use JWT format',
  },
  {
    authType: 'custom_header',
    addon: 'jwtWrapping',
    reason: 'custom_header + jwtWrapping: custom headers have no standard token to wrap',
  },
  {
    authType: 'none',
    addon: 'jwtWrapping',
    reason: 'none + jwtWrapping: no credentials to wrap in a JWT',
  },
  {
    authType: 'none',
    addon: 'certificatePinning',
    reason: 'none + certificatePinning: no auth to protect with certificate pinning',
  },
];

export function validateAddonCombination(authType: string, addons: AddonInput): ValidationResult {
  for (const rule of INVALID_COMBINATIONS) {
    if (rule.addon2) {
      // Cross-addon rule (any auth type)
      if (addons[rule.addon as keyof AddonInput] && addons[rule.addon2 as keyof AddonInput]) {
        return { valid: false, reason: rule.reason };
      }
    } else if (rule.authType) {
      // Auth-type-specific rule
      if (rule.authType === authType && addons[rule.addon as keyof AddonInput]) {
        return { valid: false, reason: rule.reason };
      }
    }
  }
  return { valid: true };
}

// ── Addon Secrets Validation ───────────────────────────────────────────

export function validateAddonSecrets(
  addons: {
    signing?: unknown;
    webhookVerification?: unknown;
    jwtWrapping?: unknown;
  },
  secrets: Record<string, unknown>,
): ValidationResult {
  if (addons.signing && !secrets.signingSecret) {
    return { valid: false, reason: 'signingSecret is required when signing addon is configured' };
  }
  if (addons.webhookVerification && !secrets.webhookSecret) {
    return {
      valid: false,
      reason: 'webhookSecret is required when webhookVerification addon is configured',
    };
  }
  if (addons.jwtWrapping && !secrets.jwtPrivateKey) {
    return {
      valid: false,
      reason: 'jwtPrivateKey is required when jwtWrapping addon is configured',
    };
  }
  return { valid: true };
}
