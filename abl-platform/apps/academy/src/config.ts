/**
 * Academy Service Configuration
 *
 * Loads configuration from environment variables with sensible defaults
 * for local development. Follows the same env-based config pattern as template-store.
 */

import { DEFAULT_ACADEMY_PORT } from '@agent-platform/config/constants';

export interface AcademyServiceConfig {
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
  /** Content root directory for academy content files */
  contentRoot: string | undefined;
}

export function loadConfig(): AcademyServiceConfig {
  const env = process.env.NODE_ENV || 'development';

  // Build CORS origins list
  const corsOrigins: string[] = [];

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
      'http://localhost:3116',
    );
  }

  return {
    port: parseInt(process.env.PORT || String(DEFAULT_ACADEMY_PORT), 10),
    host: process.env.HOST || '0.0.0.0',
    env,
    mongoUrl:
      process.env.MONGODB_URL ||
      'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true',
    mongoDatabase: process.env.MONGODB_DATABASE || 'abl_platform',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    corsOrigins,
    contentRoot: process.env.ACADEMY_CONTENT_ROOT || undefined,
  };
}

let _config: AcademyServiceConfig | null = null;

export function getConfig(): AcademyServiceConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
