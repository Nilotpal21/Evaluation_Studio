/**
 * Production Configuration Validation
 *
 * Cross-field checks that validate config is safe for production deployment.
 * Returns warnings (non-blocking) and errors (blocking).
 */

import type { BaseAppConfig } from '../schemas/base-app.schema.js';
import { validateUrlSafety } from './url-safety.js';

export interface ProductionWarning {
  level: 'error' | 'warning';
  message: string;
  field: string;
}

/**
 * Validate an encryption master key meets security requirements.
 * Key must be exactly 64 hex characters (32 bytes for AES-256).
 */
export function validateEncryptionKey(key: string): {
  valid: boolean;
  reason?: string;
} {
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    return { valid: false, reason: 'Must be exactly 64 hex characters' };
  }

  // Reject all-same-character keys
  if (/^(.)\1+$/.test(key)) {
    return { valid: false, reason: 'Key is a single repeated character' };
  }

  // Reject sequential hex pattern
  if (/^(0123456789abcdef)+$/i.test(key)) {
    return {
      valid: false,
      reason: 'Key is a sequential pattern',
    };
  }

  // Basic entropy: count unique characters
  const uniqueChars = new Set(key.toLowerCase()).size;
  if (uniqueChars < 16) {
    return {
      valid: false,
      reason: `Key has low entropy (only ${uniqueChars} unique characters)`,
    };
  }

  return { valid: true };
}

/**
 * Validate that a config is production-ready.
 * Returns a list of warnings and errors.
 */
export function validateProductionConfig(config: BaseAppConfig): ProductionWarning[] {
  const issues: ProductionWarning[] = [];

  if (config.env !== 'production') return issues;

  // JWT checks
  if (config.jwt.secret === 'development-secret-change-in-production') {
    issues.push({
      level: 'error',
      field: 'jwt.secret',
      message: 'JWT_SECRET is using default value — this is insecure for production',
    });
  }

  if (config.jwt.secret.length < 64) {
    issues.push({
      level: 'warning',
      field: 'jwt.secret',
      message: 'JWT_SECRET should be at least 64 characters for production',
    });
  }

  // Database
  if (!config.database.url) {
    issues.push({
      level: 'error',
      field: 'database.url',
      message: 'DATABASE_URL is not configured',
    });
  }

  // LLM
  if (!config.llm.anthropicApiKey && !config.llm.openaiApiKey) {
    issues.push({
      level: 'warning',
      field: 'llm',
      message: 'No LLM API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)',
    });
  }

  // Encryption
  if (!config.encryption.masterKey) {
    issues.push({
      level: 'warning',
      field: 'encryption.masterKey',
      message: 'ENCRYPTION_MASTER_KEY not configured — credential encryption unavailable',
    });
  }

  // Encryption — validate key quality when present
  if (config.encryption.masterKey) {
    const keyCheck = validateEncryptionKey(config.encryption.masterKey);
    if (!keyCheck.valid) {
      issues.push({
        level: 'error',
        field: 'encryption.masterKey',
        message: `ENCRYPTION_MASTER_KEY is invalid: ${keyCheck.reason}`,
      });
    }
  }

  // Encryption — enabled explicitly but no master key
  if (config.encryption.enabled === true && !config.encryption.masterKey) {
    issues.push({
      level: 'error',
      field: 'encryption.enabled',
      message:
        'ENCRYPTION_ENABLED is true but ENCRYPTION_MASTER_KEY is not set — encryption cannot function without a key',
    });
  }

  // CORS — reject wildcard origins
  if (config.cors.origins.some((o: string) => o === '*')) {
    issues.push({
      level: 'error',
      field: 'cors.origins',
      message: 'CORS_ORIGINS contains wildcard "*" — this is insecure for production',
    });
  }

  // CORS — reject localhost origins in production
  if (config.cors.origins.some((o: string) => o.includes('localhost') || o.includes('127.0.0.1'))) {
    issues.push({
      level: 'warning',
      field: 'cors.origins',
      message: 'CORS_ORIGINS contains localhost URLs in production',
    });
  }

  // Redis — validate URL when enabled
  if (config.redis.enabled && !config.redis.url) {
    issues.push({
      level: 'error',
      field: 'redis.url',
      message: 'Redis is enabled but REDIS_URL is not configured',
    });
  }

  // Server URLs
  if (!config.server.apiUrl) {
    issues.push({
      level: 'warning',
      field: 'server.apiUrl',
      message: 'API_URL not configured — may cause incorrect URL generation',
    });
  }

  if (!config.server.frontendUrl) {
    issues.push({
      level: 'warning',
      field: 'server.frontendUrl',
      message: 'FRONTEND_URL not configured — may cause incorrect CORS/redirect behavior',
    });
  }

  // Server URL SSRF checks
  if (config.server.apiUrl) {
    const apiUrlCheck = validateUrlSafety(config.server.apiUrl);
    if (!apiUrlCheck.valid) {
      issues.push({
        level: 'error',
        field: 'server.apiUrl',
        message: `API_URL is unsafe: ${apiUrlCheck.reason}`,
      });
    }
  }

  if (config.server.frontendUrl) {
    const frontendUrlCheck = validateUrlSafety(config.server.frontendUrl);
    if (!frontendUrlCheck.valid) {
      issues.push({
        level: 'error',
        field: 'server.frontendUrl',
        message: `FRONTEND_URL is unsafe: ${frontendUrlCheck.reason}`,
      });
    }
  }

  // OAuth
  if (!config.oauth.google.clientId || !config.oauth.google.clientSecret) {
    issues.push({
      level: 'warning',
      field: 'oauth.google',
      message: 'Google OAuth not fully configured',
    });
  }

  // Redis (recommended for prod)
  if (!config.redis.enabled) {
    issues.push({
      level: 'warning',
      field: 'redis.enabled',
      message:
        'Redis is disabled — session store and caching will use memory (not suitable for multi-replica)',
    });
  }

  // Observability
  if (!config.observability.enabled) {
    issues.push({
      level: 'warning',
      field: 'observability.enabled',
      message: 'Observability is disabled in production',
    });
  }

  return issues;
}
