import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock transports so we don't need real SMTP/Graph connections
vi.mock('../../../services/email/transports/smtp-transport.js', () => {
  const SmtpTransport = vi.fn(function (this: Record<string, unknown>) {
    this.sendReply = vi.fn();
  });
  return { SmtpTransport };
});

vi.mock('../../../services/email/transports/graph-transport.js', () => {
  const GraphTransport = vi.fn(function (this: Record<string, unknown>) {
    this.sendReply = vi.fn();
  });
  return { GraphTransport };
});

import {
  resolveEmailTransport,
  clearTransportCache,
} from '../../../services/email/transports/resolve-transport.js';
import { SmtpTransport } from '../../../services/email/transports/smtp-transport.js';
import { GraphTransport } from '../../../services/email/transports/graph-transport.js';
import type { ResolvedConnection } from '../../../channels/types.js';

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType: 'email',
    externalIdentifier: 'agent@company.com',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  };
}

describe('resolveEmailTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTransportCache();
  });

  it('defaults to SMTP when no outbound config', () => {
    const transport = resolveEmailTransport(makeConnection());
    expect(SmtpTransport).toHaveBeenCalled();
    expect(GraphTransport).not.toHaveBeenCalled();
    expect(transport).toBeDefined();
  });

  it('selects Graph when config.outbound.transport is graph', () => {
    const transport = resolveEmailTransport(
      makeConnection({
        config: {
          outbound: {
            transport: 'graph',
            graph: {
              tenantId: 'azure-tenant',
              clientId: 'app-id',
              senderAddress: 'agent@company.com',
            },
          },
        },
        credentials: { graph_client_secret: 'secret-123' },
      }),
    );
    expect(GraphTransport).toHaveBeenCalled();
    expect(transport).toBeDefined();
  });

  it('throws when Graph config is missing tenantId', () => {
    expect(() =>
      resolveEmailTransport(
        makeConnection({
          config: {
            outbound: {
              transport: 'graph',
              graph: { clientId: 'app-id', senderAddress: 'a@b.com' },
            },
          },
          credentials: { graph_client_secret: 'secret' },
        }),
      ),
    ).toThrow('Graph transport requires tenantId, clientId, and senderAddress in config');
  });

  it('throws when Graph config is missing clientId', () => {
    expect(() =>
      resolveEmailTransport(
        makeConnection({
          config: {
            outbound: {
              transport: 'graph',
              graph: { tenantId: 'tenant', senderAddress: 'a@b.com' },
            },
          },
          credentials: { graph_client_secret: 'secret' },
        }),
      ),
    ).toThrow('Graph transport requires tenantId, clientId, and senderAddress in config');
  });

  it('throws when Graph config is missing senderAddress', () => {
    expect(() =>
      resolveEmailTransport(
        makeConnection({
          config: {
            outbound: {
              transport: 'graph',
              graph: { tenantId: 'tenant', clientId: 'app-id' },
            },
          },
          credentials: { graph_client_secret: 'secret' },
        }),
      ),
    ).toThrow('Graph transport requires tenantId, clientId, and senderAddress in config');
  });

  it('throws when graph_client_secret is missing from credentials', () => {
    expect(() =>
      resolveEmailTransport(
        makeConnection({
          config: {
            outbound: {
              transport: 'graph',
              graph: {
                tenantId: 'tenant',
                clientId: 'app-id',
                senderAddress: 'a@b.com',
              },
            },
          },
          credentials: {},
        }),
      ),
    ).toThrow('Graph transport requires graph_client_secret in credentials');
  });

  it('caches transport instance for the same connection', () => {
    const conn = makeConnection();
    const t1 = resolveEmailTransport(conn);
    const t2 = resolveEmailTransport(conn);
    expect(t1).toBe(t2);
    // SmtpTransport constructor called only once
    expect(SmtpTransport).toHaveBeenCalledTimes(1);
  });

  it('returns different instances for different Graph connections', () => {
    const graphConfig = {
      outbound: {
        transport: 'graph',
        graph: {
          tenantId: 'tenant',
          clientId: 'app-id',
          senderAddress: 'a@b.com',
        },
      },
    };
    const conn1 = makeConnection({
      id: 'conn-1',
      config: graphConfig,
      credentials: { graph_client_secret: 'secret' },
    });
    const conn2 = makeConnection({
      id: 'conn-2',
      config: graphConfig,
      credentials: { graph_client_secret: 'secret' },
    });

    const t1 = resolveEmailTransport(conn1);
    const t2 = resolveEmailTransport(conn2);
    expect(t1).not.toBe(t2);
    expect(GraphTransport).toHaveBeenCalledTimes(2);
  });

  it('evicts stale cache entries after TTL', () => {
    vi.useFakeTimers();
    try {
      const conn = makeConnection();
      const t1 = resolveEmailTransport(conn);

      // Advance past 30-minute TTL
      vi.advanceTimersByTime(31 * 60 * 1000);

      const t2 = resolveEmailTransport(conn);
      expect(t1).not.toBe(t2);
      expect(SmtpTransport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearTransportCache empties the cache', () => {
    const conn = makeConnection();
    const t1 = resolveEmailTransport(conn);
    clearTransportCache();
    const t2 = resolveEmailTransport(conn);
    expect(t1).not.toBe(t2);
    expect(SmtpTransport).toHaveBeenCalledTimes(2);
  });
});
