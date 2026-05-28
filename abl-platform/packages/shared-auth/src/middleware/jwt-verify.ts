/**
 * JWT Verification Middleware Factory
 *
 * Extracts JWT verification logic from the monolithic auth middleware.
 * Uses dependency injection for JWT secret and user lookup so both
 * Studio and Runtime can use it with their own configuration.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { JWTPayload, AuthUser } from '../types/index.js';
import {
  signPlatformAccessToken,
  verifyPlatformAccessToken,
  PLATFORM_JWT_ISSUER,
} from '../purpose-jwt.js';

/**
 * Configuration for the auth middleware factory.
 */
export interface AuthMiddlewareConfig {
  /** Returns the JWT secret for verification */
  getJwtSecret(): string;
  /** Looks up a user by ID (from JWT sub claim) */
  getUserById(id: string): Promise<AuthUser | null>;
}

/**
 * Verify a JWT access token and return the payload.
 */
export function verifyToken(token: string, secret: string): JWTPayload | null {
  try {
    const payload = verifyPlatformAccessToken(token, secret);
    if (payload.type !== 'access' && payload.type !== 'mfa_pending') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Create an Express auth middleware with injected dependencies.
 *
 * Usage:
 *   const authMiddleware = createAuthMiddleware({
 *     getJwtSecret: () => config.jwt.secret,
 *     getUserById: (id) => User.findById(id),
 *   });
 */
export function createAuthMiddleware(config: AuthMiddlewareConfig) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const secret = config.getJwtSecret();
    const payload = verifyToken(token, secret);

    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (payload.type === 'mfa_pending') {
      try {
        const user = await config.getUserById(payload.sub);
        if (!user) {
          res.status(401).json({ error: 'User not found' });
          return;
        }
        req.user = user;
        (req as any).mfaPending = true;
        next();
      } catch (error) {
        console.error('[Auth] Error fetching user:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
      return;
    }

    try {
      const user = await config.getUserById(payload.sub);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      req.user = user;
      next();
    } catch (error) {
      console.error('[Auth] Error fetching user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Create an optional auth middleware.
 * Attaches user if valid JWT present, but doesn't reject if missing.
 */
export function createOptionalAuthMiddleware(config: AuthMiddlewareConfig) {
  return async function optionalAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const secret = config.getJwtSecret();
      const payload = verifyToken(token, secret);

      if (payload && payload.type === 'access') {
        try {
          const user = await config.getUserById(payload.sub);
          if (user) {
            req.user = user;
          }
        } catch (error) {
          console.error('[Auth] Error fetching user:', error);
        }
      }
    }

    next();
  };
}

/**
 * Extract user ID from token without full user lookup.
 * Useful for WebSocket connections.
 */
export function extractUserIdFromToken(token: string, secret: string): string | null {
  const payload = verifyToken(token, secret);
  return payload?.sub ?? null;
}

/** Payload shape for service-to-service tokens */
export interface ServiceTokenPayload {
  sub: string;
  email: string;
  type: 'service';
  tenantId: string;
  projectId?: string;
  serviceName: string;
}

/**
 * Create a short-lived service-to-service JWT for internal API calls.
 * Used when one internal service (e.g., workflow-engine) needs to call
 * another authenticated service (e.g., runtime chat API).
 *
 * The token is valid for 5 minutes and uses a synthetic service identity.
 */
export function createServiceToken(
  secret: string,
  opts: { tenantId: string; projectId?: string; serviceName?: string },
): string {
  const serviceName = opts.serviceName ?? 'workflow-engine';
  const payload: ServiceTokenPayload = {
    sub: `service:${serviceName}`,
    email: `${serviceName}@internal.service`,
    type: 'service',
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    serviceName,
  };
  return jwt.sign(payload, secret, {
    expiresIn: '5m',
    audience: 'agent-platform-internal',
    issuer: PLATFORM_JWT_ISSUER,
  });
}

/**
 * Create a short-lived internal "user-shaped" JWT that downstream services
 * whose auth layer requires `type: 'access'` can accept.
 *
 * Unlike `createServiceToken`, this mints a token of `type: 'access'` with
 * `internal: true` so receivers (e.g., SearchAI runtime) can recognize the
 * call as internal without requiring a matching User record.
 *
 * Scope: runtime ↔ SearchAI runtime internal hops (KB tool executor,
 * internal tools execute route). Do NOT use from user-facing code paths —
 * prefer `createServiceToken` when the receiver supports service tokens.
 */
export function createInternalUserToken(
  secret: string,
  opts: { tenantId: string; projectId?: string; role?: string; serviceName?: string },
): string {
  const serviceName = opts.serviceName ?? 'runtime';
  return signPlatformAccessToken(
    {
      sub: `service:${serviceName}`,
      email: `${serviceName}-internal@service.local`,
      type: 'access',
      tokenClass: 'user',
      tenantId: opts.tenantId,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      role: opts.role ?? 'OWNER',
      internal: true,
    },
    secret,
    { expiresIn: '1h' },
  );
}

/**
 * Verify a service-to-service JWT and return the payload.
 * Returns null if the token is invalid, expired, or not a service token.
 */
export function verifyServiceToken(
  token: string,
  secret: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): ServiceTokenPayload | null {
  try {
    const payload = jwt.verify(token, secret, {
      audience: 'agent-platform-internal',
      issuer: PLATFORM_JWT_ISSUER,
    }) as ServiceTokenPayload;
    // Service tokens must have a service: prefixed subject and type
    if (!payload.sub?.startsWith('service:')) return null;
    if (payload.type !== 'service') return null;
    if (!payload.tenantId) return null;
    return payload;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (logger) {
      logger.warn('Service token verification failed', { error: message });
    }
    return null;
  }
}
