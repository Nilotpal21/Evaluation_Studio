import type { RequestHandler } from 'express';
import { isInternalNetworkRequest } from '@agent-platform/shared-kernel/security';

/**
 * Restricts a route to loopback / private cluster IPs. Mirrors the runtime
 * middleware so diagnostic endpoints behave identically across services.
 */
export const requireInternalNetworkAccess: RequestHandler = (req, res, next) => {
  const allowed = isInternalNetworkRequest({
    forwardedFor: req.header('x-forwarded-for'),
    realIp: req.header('x-real-ip'),
    remoteAddress: req.socket.remoteAddress,
    host: req.header('host'),
  });

  if (!allowed) {
    res.status(403).json({ error: 'Forbidden: internal network access required' });
    return;
  }

  next();
};
