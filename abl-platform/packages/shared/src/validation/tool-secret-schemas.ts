/**
 * Tool Secret Zod Schemas
 *
 * Validation schemas for tool secrets API endpoints (G4).
 * Used by both Studio and Runtime routes.
 */

import { z } from 'zod';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_SECRET_VALUE_LENGTH = 16384; // 16KB
export const MAX_SECRET_FIELD_LENGTH = 256;

// ─── Request Schemas ────────────────────────────────────────────────────────

export const CreateToolSecretSchema = z.object({
  projectId: z.string().describe('Project ID'),
  toolName: z.string().max(MAX_SECRET_FIELD_LENGTH).describe('Tool name'),
  secretKey: z.string().max(MAX_SECRET_FIELD_LENGTH).describe('Secret key/name'),
  value: z.string().max(MAX_SECRET_VALUE_LENGTH).describe('Secret value'),
  environment: z.string().optional().describe('Environment (default: dev)'),
  expiresAt: z.string().optional().describe('ISO 8601 expiration timestamp'),
});

export const RotateToolSecretSchema = z.object({
  value: z.string().max(MAX_SECRET_VALUE_LENGTH).describe('New secret value'),
  expiresAt: z.string().optional().describe('ISO 8601 expiration timestamp'),
});

// ─── Response Schemas ───────────────────────────────────────────────────────

export const ToolSecretMetadataSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  secretKey: z.string(),
  environment: z.string(),
  version: z.number(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateToolSecretResponseSchema = z.object({
  success: z.boolean(),
  secret: ToolSecretMetadataSchema,
});

export const ListToolSecretsResponseSchema = z.object({
  success: z.boolean(),
  secrets: z.array(
    ToolSecretMetadataSchema.extend({
      rotatedAt: z.string().nullable(),
      createdBy: z.string(),
      updatedAt: z.string(),
      expiryWarning: z.enum(['expired', 'expiring_soon']).optional(),
    }),
  ),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export const RotateToolSecretResponseSchema = z.object({
  success: z.boolean(),
  secret: z.object({
    id: z.string(),
    toolName: z.string(),
    secretKey: z.string(),
    environment: z.string(),
    version: z.number(),
    rotatedAt: z.string().nullable(),
  }),
});

export const DeleteToolSecretResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.string(),
});
