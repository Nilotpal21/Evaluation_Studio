/**
 * Auth/Audit event schemas.
 *
 * Events related to authentication and authorization.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── auth.login ────────────────────────────────────────────────────────────

export const AuthLoginDataSchema = z
  .object({
    auth_type: z.enum(['dev_login', 'oauth', 'api_key']).optional(),
    authType: z.enum(['dev_login', 'oauth', 'api_key']).optional(),
    role: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('auth.login', AuthLoginDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AUDIT,
  containsPII: true, // Login events contain user identity
  description: 'User authenticated',
});

// ─── auth.token.created ────────────────────────────────────────────────────

export const AuthTokenCreatedDataSchema = z
  .object({
    token_type: z.enum(['access', 'sdk']).optional(),
    tokenType: z.enum(['access', 'sdk']).optional(),
    expires_in: z.number().optional(),
    expiresIn: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('auth.token.created', AuthTokenCreatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AUDIT,
  containsPII: false,
  description: 'Auth token generated',
});
