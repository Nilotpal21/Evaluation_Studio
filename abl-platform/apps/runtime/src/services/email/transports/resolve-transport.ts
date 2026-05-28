/**
 * Resolve which EmailTransport to use for a given channel connection.
 * Caches transport instances per connection ID + config fingerprint to
 * reuse Graph API token cache while invalidating on credential rotation.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { SmtpTransport } from './smtp-transport.js';
import { GraphTransport } from './graph-transport.js';
import type { EmailTransport } from './transport-interface.js';
import type { ResolvedConnection } from '../../../channels/types.js';

const log = createLogger('email-transport-resolver');

const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  transport: EmailTransport;
  createdAt: number;
}

const transportCache = new Map<string, CacheEntry>();

function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of transportCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      transportCache.delete(key);
    }
  }
}

function getCached(key: string, factory: () => EmailTransport): EmailTransport {
  const existing = transportCache.get(key);
  if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS) {
    return existing.transport;
  }

  if (transportCache.size >= MAX_CACHE_SIZE) {
    evictStale();
    if (transportCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = transportCache.keys().next().value!;
      transportCache.delete(oldestKey);
    }
  }

  const transport = factory();
  transportCache.set(key, { transport, createdAt: Date.now() });
  return transport;
}

export function resolveEmailTransport(connection: ResolvedConnection): EmailTransport {
  const outbound = connection.config?.outbound as
    | { transport?: string; graph?: Record<string, string> }
    | undefined;

  const transportType = outbound?.transport ?? 'smtp';

  if (transportType === 'graph') {
    const graphConfig = outbound?.graph;
    if (!graphConfig?.tenantId || !graphConfig?.clientId || !graphConfig?.senderAddress) {
      throw new Error('Graph transport requires tenantId, clientId, and senderAddress in config');
    }

    const clientSecret = (connection.credentials as Record<string, unknown> | null)
      ?.graph_client_secret as string | undefined;
    if (!clientSecret) {
      throw new Error('Graph transport requires graph_client_secret in credentials');
    }

    // Include config fingerprint in cache key so credential/config changes
    // invalidate the cached transport (and its stale token) immediately.
    const fingerprint = createHash('sha256')
      .update(
        `${graphConfig.tenantId}:${graphConfig.clientId}:${graphConfig.senderAddress}:${clientSecret}`,
      )
      .digest('hex')
      .slice(0, 12);

    return getCached(`graph:${connection.id}:${fingerprint}`, () => {
      log.info('Creating Graph transport', { connectionId: connection.id });
      return new GraphTransport({
        tenantId: graphConfig.tenantId,
        clientId: graphConfig.clientId,
        clientSecret,
        senderAddress: graphConfig.senderAddress,
      });
    });
  }

  return getCached('smtp-default', () => {
    log.info('Creating SMTP transport from env');
    return new SmtpTransport({
      host: process.env.SMTP_RELAY_HOST || 'localhost',
      port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
      user: process.env.SMTP_RELAY_USER || '',
      pass: process.env.SMTP_RELAY_PASS || '',
    });
  });
}

/** Clear the transport cache (for testing). */
export function clearTransportCache(): void {
  transportCache.clear();
}
