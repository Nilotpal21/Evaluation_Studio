/**
 * Shared Auth Helpers
 *
 * Common utilities used across multiple auth route handlers.
 * Centralizes getFrontendUrl() and getEmailRegex() to avoid duplication.
 */

import { getConfig, isConfigLoaded } from '@/config';

function normalizeConfiguredUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * Get the frontend URL from config, falling back to env var / localhost.
 */
export function getFrontendUrl(): string {
  return resolveFrontendUrl();
}

/**
 * Resolve the frontend origin for browser-consumed links.
 *
 * Prefer explicit configuration when present. If no explicit frontend URL is
 * configured, use the current request origin rather than inventing a localhost
 * destination for generated preview/share links.
 */
export function resolveFrontendUrl(requestOrigin?: string): string {
  if (isConfigLoaded()) {
    const configured = normalizeConfiguredUrl(getConfig().server.frontendUrl);
    if (configured) {
      return configured;
    }
  }

  const envConfigured = normalizeConfiguredUrl(process.env.FRONTEND_URL);
  if (envConfigured) {
    return envConfigured;
  }

  return normalizeConfiguredUrl(requestOrigin) || 'http://localhost:5173';
}

/** Default fallback email regex (RFC 5322 simplified) */
const DEFAULT_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Get the email validation regex from config, falling back to a sensible default.
 */
export function getEmailRegex(): RegExp {
  if (isConfigLoaded()) return new RegExp(getConfig().auth.validation.emailRegex);
  return DEFAULT_EMAIL_REGEX;
}

// ---------------------------------------------------------------------------
// OAuth Config Helpers
// ---------------------------------------------------------------------------

/**
 * Read Microsoft OAuth config from centralized config / env vars.
 * Returns all fields — callers destructure what they need.
 */
export function getMicrosoftConfig() {
  const cfg = isConfigLoaded() ? getConfig() : null;
  const clientId = cfg?.oauth.microsoft.clientId || process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = cfg?.oauth.microsoft.clientSecret || process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = cfg?.oauth.microsoft.tenantId || process.env.MICROSOFT_TENANT_ID || 'common';
  const frontendUrl = getFrontendUrl();
  const redirectUri = `${frontendUrl}/api/auth/microsoft/callback`;
  const authorizeUrl =
    cfg?.oauth.microsoft.authorizeUrl ||
    'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize';
  const tokenUrl =
    cfg?.oauth.microsoft.tokenUrl || 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token';
  const profileUrl = cfg?.oauth.microsoft.profileUrl || 'https://graph.microsoft.com/v1.0/me';
  const scope = cfg?.oauth.microsoft.scope || 'openid email profile User.Read';
  const stateCookieTtlSeconds = cfg?.oauth.microsoft.stateCookieTtlSeconds ?? 600;
  const mfaCookieMaxAge = cfg?.auth.tokens.mfaCookieMaxAgeSeconds ?? 300;

  return {
    clientId,
    clientSecret,
    tenantId,
    redirectUri,
    authorizeUrl,
    tokenUrl,
    profileUrl,
    scope,
    stateCookieTtlSeconds,
    mfaCookieMaxAge,
  };
}

/**
 * Read LinkedIn OAuth config from centralized config / env vars.
 * Returns all fields — callers destructure what they need.
 */
export function getLinkedInConfig() {
  const cfg = isConfigLoaded() ? getConfig() : null;
  const clientId = cfg?.oauth.linkedin.clientId || process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = cfg?.oauth.linkedin.clientSecret || process.env.LINKEDIN_CLIENT_SECRET;
  const frontendUrl = getFrontendUrl();
  const redirectUri = `${frontendUrl}/api/auth/linkedin/callback`;
  const authorizeUrl =
    cfg?.oauth.linkedin.authorizeUrl || 'https://www.linkedin.com/oauth/v2/authorization';
  const tokenUrl = cfg?.oauth.linkedin.tokenUrl || 'https://www.linkedin.com/oauth/v2/accessToken';
  const profileUrl = cfg?.oauth.linkedin.profileUrl || 'https://api.linkedin.com/v2/userinfo';
  const scope = cfg?.oauth.linkedin.scope || 'openid profile email';
  const stateCookieTtlSeconds = cfg?.oauth.linkedin.stateCookieTtlSeconds ?? 600;
  const mfaCookieMaxAge = cfg?.auth.tokens.mfaCookieMaxAgeSeconds ?? 300;

  return {
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl,
    tokenUrl,
    profileUrl,
    scope,
    stateCookieTtlSeconds,
    mfaCookieMaxAge,
  };
}
