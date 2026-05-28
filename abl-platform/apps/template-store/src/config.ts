/**
 * Template Store Configuration
 *
 * Loads configuration from environment variables with sensible defaults
 * for local development. Follows the same env-based config pattern as runtime.
 */

import { DEFAULT_TEMPLATE_STORE_PORT } from '@agent-platform/config/constants';

export interface TemplateStoreConfig {
  /** HTTP port */
  port: number;
  /** Host to bind to */
  host: string;
  /** Node environment */
  env: string;
  /** MongoDB connection URL */
  mongoUrl: string;
  /** MongoDB database name */
  mongoDatabase: string;
  /** JWT secret for auth token verification */
  jwtSecret: string;
  /** CORS allowed origins */
  corsOrigins: string[];
  /** Marketing site URL (primary external consumer) */
  marketingSiteUrl: string;
  /** Rate limit window in milliseconds */
  rateLimitWindowMs: number;
  /** Maximum requests per rate limit window */
  rateLimitMaxRequests: number;
}

export function loadConfig(): TemplateStoreConfig {
  const env = process.env.NODE_ENV || 'development';

  // Build CORS origins list
  const corsOrigins: string[] = [];

  // Add marketing site URL if configured
  const marketingSiteUrl = process.env.MARKETING_SITE_URL || '';
  if (marketingSiteUrl) {
    corsOrigins.push(marketingSiteUrl);
  }

  // Add explicit CORS_ORIGINS if set
  if (process.env.CORS_ORIGINS) {
    corsOrigins.push(...process.env.CORS_ORIGINS.split(',').map((o) => o.trim()));
  }

  // In development, allow all localhost origins
  if (env !== 'production') {
    corsOrigins.push(
      'http://localhost:5173',
      'http://localhost:3112',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3115',
    );
  }

  return {
    port: parseInt(process.env.PORT || String(DEFAULT_TEMPLATE_STORE_PORT), 10),
    host: process.env.HOST || '0.0.0.0',
    env,
    mongoUrl:
      process.env.MONGODB_URL ||
      'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true',
    mongoDatabase: process.env.MONGODB_DATABASE || 'abl_platform',
    jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
    corsOrigins,
    marketingSiteUrl,
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  };
}

let _config: TemplateStoreConfig | null = null;

export function getConfig(): TemplateStoreConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
