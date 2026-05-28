import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { validateHostnameForSSRF } from '@agent-platform/shared-kernel/security';

const log = createLogger('workflow-engine:webhook-source-guard');

export function rejectBlockedWebhookSource(req: Request, res: Response): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }

  const sourceIp = extractSourceIp(req);
  if (!sourceIp) {
    return false;
  }

  const result = validateHostnameForSSRF(sourceIp);
  if (result.safe) {
    return false;
  }

  log.warn('Webhook rejected from blocked source IP', {
    sourceIp,
    reason: result.reason,
  });
  res.status(403).json({ error: 'Forbidden' });
  return true;
}

function extractSourceIp(req: Request): string | undefined {
  const forwardedFor = req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwardedFor) return forwardedFor;

  const realIp = req.header('x-real-ip')?.trim();
  if (realIp) return realIp;

  return req.socket.remoteAddress;
}
