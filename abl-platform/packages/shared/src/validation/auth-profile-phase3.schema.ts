/**
 * Auth Profile Phase 3 Zod Schemas
 *
 * Validation schemas for 5 enterprise auth types:
 * digest, kerberos, saml, hawk, ws_security.
 */

import { z } from 'zod';

// ── digest ────────────────────────────────────────────────────────────
export const DigestConfigSchema = z
  .object({
    realm: z.string().min(1),
  })
  .strict();

export const DigestSecretsSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

// ── kerberos ──────────────────────────────────────────────────────────
export const KerberosConfigSchema = z
  .object({
    realm: z.string().min(1),
    kdc: z.string().min(1),
    servicePrincipal: z.string().min(1),
  })
  .strict();

export const KerberosSecretsSchema = z
  .object({
    principal: z.string().min(1),
    password: z.string().min(1).optional(),
    keytab: z.string().min(1).optional(),
  })
  .strict()
  .refine((data) => data.password !== undefined || data.keytab !== undefined, {
    message: 'Either password or keytab must be provided',
  });

// ── saml ──────────────────────────────────────────────────────────────
export const SamlConfigSchema = z
  .object({
    idpMetadataUrl: z.string().url(),
    entityId: z.string().min(1),
    assertionConsumerServiceUrl: z.string().url(),
  })
  .strict();

export const SamlSecretsSchema = z
  .object({
    privateKey: z.string().min(1),
    certificate: z.string().min(1),
  })
  .strict();

// ── hawk ──────────────────────────────────────────────────────────────
export const HawkConfigSchema = z
  .object({
    algorithm: z.enum(['sha256', 'sha1']),
  })
  .strict();

export const HawkSecretsSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();

// ── ws_security ───────────────────────────────────────────────────────
export const WsSecurityConfigSchema = z
  .object({
    mustUnderstand: z.boolean(),
  })
  .strict();

export const WsSecuritySecretsSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
    certificate: z.string().min(1).optional(),
  })
  .strict();
