/**
 * Proxy Config Zod Schemas
 *
 * Validation schemas for org proxy config API endpoints (G4).
 * Used by both Studio and Runtime routes.
 */

import { z } from 'zod';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_CERT_LENGTH = 65536; // 64KB
export const MAX_PROXY_FIELD_LENGTH = 1024;

// ─── Metadata Schemas ───────────────────────────────────────────────────────

export const ProxyConfigMetadataSchema = z.object({
  id: z.string().describe('Unique proxy config identifier'),
  name: z.string().describe('Configuration name'),
  proxyAuthType: z.enum(['none', 'basic', 'bearer', 'custom']).describe('Authentication type'),
  urlPatterns: z
    .string()
    .describe('URL patterns this config applies to (comma-separated or wildcard)'),
  bypassPatterns: z.string().nullable().describe('Patterns to bypass proxy (comma-separated)'),
  environment: z.string().describe('Environment (dev, staging, prod)'),
  priority: z.number().describe('Priority order for proxy selection'),
  enabled: z.boolean().describe('Whether this config is active'),
  createdAt: z.string().describe('ISO 8601 creation timestamp'),
  updatedAt: z.string().optional().describe('ISO 8601 last update timestamp'),
  createdBy: z.string().optional().describe('User ID who created this config'),
});

export const ProxyConfigMetadataWithCertsSchema = ProxyConfigMetadataSchema.extend({
  hasCaCertificate: z.boolean().describe('Whether CA certificate is present'),
  hasClientCert: z.boolean().describe('Whether client certificate is present'),
});

// ─── Request Schemas ────────────────────────────────────────────────────────

export const CreateProxyConfigSchema = z
  .object({
    name: z.string().max(MAX_PROXY_FIELD_LENGTH).describe('Configuration name'),
    proxyUrl: z.string().url().describe('Proxy server URL'),
    proxyAuthType: z
      .enum(['none', 'basic', 'bearer', 'custom'])
      .optional()
      .describe('Authentication type (default: none)'),
    username: z.string().optional().describe('Proxy username (for basic auth)'),
    password: z.string().optional().describe('Proxy password (for basic auth)'),
    token: z.string().optional().describe('Bearer token (for bearer auth)'),
    caCertificate: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('CA certificate in PEM format'),
    clientCert: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client certificate in PEM format'),
    clientKey: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client private key in PEM format'),
    urlPatterns: z.string().optional().describe('URL patterns this config applies to (default: *)'),
    bypassPatterns: z.string().optional().describe('Patterns to bypass proxy'),
    environment: z.string().optional().describe('Environment (default: dev)'),
    priority: z.number().int().optional().describe('Priority order (default: 0)'),
    enabled: z.boolean().optional().describe('Whether config is active (default: true)'),
  })
  .describe('Create proxy config request');

export const UpdateProxyConfigSchema = z
  .object({
    name: z.string().max(MAX_PROXY_FIELD_LENGTH).optional().describe('Configuration name'),
    proxyUrl: z.string().url().optional().describe('Proxy server URL'),
    proxyAuthType: z
      .enum(['none', 'basic', 'bearer', 'custom'])
      .optional()
      .describe('Authentication type'),
    username: z.string().optional().describe('Proxy username (for basic auth)'),
    password: z.string().optional().describe('Proxy password (for basic auth)'),
    token: z.string().optional().describe('Bearer token (for bearer auth)'),
    caCertificate: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('CA certificate in PEM format'),
    clientCert: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client certificate in PEM format'),
    clientKey: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client private key in PEM format'),
    urlPatterns: z.string().optional().describe('URL patterns this config applies to'),
    bypassPatterns: z.string().optional().describe('Patterns to bypass proxy'),
    priority: z.number().int().optional().describe('Priority order'),
    enabled: z.boolean().optional().describe('Whether config is active'),
  })
  .describe('Update proxy config request');

// ─── Response Schemas ───────────────────────────────────────────────────────

export const CreateProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    config: ProxyConfigMetadataWithCertsSchema.extend({
      proxyUrl: z.string().describe('Proxy server URL'),
    }),
  })
  .describe('Create proxy config response');

export const ListProxyConfigsResponseSchema = z
  .object({
    success: z.boolean(),
    configs: z.array(
      ProxyConfigMetadataWithCertsSchema.extend({
        proxyUrl: z.string().describe('Proxy origin URL (masked for security)'),
      }),
    ),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  })
  .describe('List proxy configs response');

export const UpdateProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    config: ProxyConfigMetadataSchema.extend({
      proxyUrl: z.string().describe('Proxy server URL'),
    }),
  })
  .describe('Update proxy config response');

export const DeleteProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    deleted: z.string().describe('ID of deleted proxy config'),
  })
  .describe('Delete proxy config response');
