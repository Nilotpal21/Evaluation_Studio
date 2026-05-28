/**
 * AI4W Channel Types
 *
 * Type definitions, Zod schemas, and utility functions for the AI4W
 * (AIforWork) channel integration. AI4W uses dual-layer auth (HMAC + JWT)
 * with connectionId-based routing.
 */

import crypto from 'node:crypto';
import { z } from 'zod';

// =============================================================================
// CONNECTION CONFIG
// =============================================================================

export interface AI4WConnectionConfig {
  callbackBaseUrl: string;
  notificationUrl?: string;
  responseMode: 'sync' | 'stream' | 'async';
  ai4wAccountId: string | null;
  provisionedBy: 'manual' | 'api';
  lastUsedAt: Date | null;
}

// =============================================================================
// SESSION BINDING
// =============================================================================

export interface AI4WSessionBinding {
  connectionId: string;
  userEmail: string;
  agentContextId: string;
}

// =============================================================================
// JWT CLAIMS
// =============================================================================

export interface AI4WJWTClaims {
  sub: string;
  email: string;
  accountId: string;
  iss: string;
  aud: string;
  scope?: string;
  product?: string;
  iat: number;
  exp: number;
}

// =============================================================================
// PROACTIVE NOTIFICATION
// =============================================================================

export interface AI4WProactiveNotification {
  notificationId: string;
  type: 'human_approval' | 'execution_result' | 'auth_challenge';
  targetEmail: string;
  connectionId: string;
  payload: {
    callbackId: string;
    callbackUrl: string;
    title: string;
    description: string;
    actions?: { label: string; value: string }[];
    authUrl?: string;
    expiresAt: string;
  };
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

export const AI4WMessageSchema = z.object({
  text: z.string().min(1).max(10000),
  agentContextId: z.string().min(1).max(255),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(50000),
        timestamp: z.string().optional(),
      }),
    )
    .max(100)
    .optional(),
  files: z
    .array(
      z.object({
        name: z.string().max(255),
        mimeType: z.string().max(127),
        signedUrl: z.string().url().max(2048),
      }),
    )
    .max(10)
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  sessionMetadata: z.record(z.unknown()).optional(),
});

export type AI4WMessageInput = z.infer<typeof AI4WMessageSchema>;

export const AI4WResponseModeSchema = z.enum(['sync', 'stream', 'async']);

// =============================================================================
// ATTACHMENT METADATA
// =============================================================================

/**
 * Attachment metadata stored in message metadata after files are uploaded
 * to the attachment service. This replaces the raw buffer summaries from
 * downloadedFiles with persistent attachment IDs that agents can access.
 */
export interface AI4WAttachmentMetadata {
  attachmentId: string;
  filename: string;
  status: string; // 'pending_scan' | 'scanning' | 'clean' | 'infected' | 'processing' | 'ready'
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** Connection ID prefix for AI4W connections */
const CONNECTION_ID_PREFIX = 'ai4w_c_';

/** Connection secret prefix */
const CONNECTION_SECRET_PREFIX = 'abl_cs_';

/**
 * Generate a random connectionId for AI4W channel connections.
 * Format: ai4w_c_ + 32 hex chars (16 random bytes)
 */
export function generateConnectionId(): string {
  return CONNECTION_ID_PREFIX + crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a random connectionSecret for AI4W channel connections.
 * Format: abl_cs_ + base64url(32 random bytes)
 */
export function generateConnectionSecret(): string {
  return CONNECTION_SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Build a session key for AI4W channel sessions.
 * Format: ai4w:{connectionId}:{base64url(email)}:{agentContextId}
 */
export function buildAI4WSessionKey(
  connectionId: string,
  email: string,
  agentContextId: string,
): string {
  const encodedEmail = Buffer.from(email).toString('base64url');
  return `ai4w:${connectionId}:${encodedEmail}:${agentContextId}`;
}
