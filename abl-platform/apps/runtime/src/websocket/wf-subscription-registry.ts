import type { WebSocket } from 'ws';

export interface RegistryEntry {
  tenantId: string;
  projectId: string;
  connections: Set<WebSocket>;
  expiresAt: number | null;
}

export type RegisterResult =
  | { ok: true; firstSubscriberForChannel: boolean }
  | { ok: false; reason: 'limit' };

export class WfSubscriptionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  register(
    executionId: string,
    meta: { tenantId: string; projectId: string },
    ws: WebSocket,
  ): RegisterResult {
    const existing = this.entries.get(executionId);
    if (existing) {
      existing.connections.add(ws);
      return { ok: true, firstSubscriberForChannel: false };
    }
    if (this.entries.size >= this.maxSize) {
      return { ok: false, reason: 'limit' };
    }
    this.entries.set(executionId, {
      tenantId: meta.tenantId,
      projectId: meta.projectId,
      connections: new Set([ws]),
      expiresAt: null,
    });
    return { ok: true, firstSubscriberForChannel: true };
  }

  unregister(executionId: string, ws: WebSocket): { lastSubscriberForChannel: boolean } {
    const entry = this.entries.get(executionId);
    if (!entry) return { lastSubscriberForChannel: false };
    entry.connections.delete(ws);
    if (entry.connections.size === 0) {
      this.entries.delete(executionId);
      return { lastSubscriberForChannel: true };
    }
    return { lastSubscriberForChannel: false };
  }

  get(executionId: string): RegistryEntry | undefined {
    return this.entries.get(executionId);
  }

  markTerminal(executionId: string, graceMs: number): void {
    const entry = this.entries.get(executionId);
    if (entry) {
      entry.expiresAt = Date.now() + graceMs;
    }
  }

  sweep(now: number): { evicted: string[] } {
    const evicted: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(id);
        evicted.push(id);
      }
    }
    return { evicted };
  }

  // O(n) over all registry entries — bounded by maxSize (default 10,000).
  // To make this O(k) per socket, maintain a reverse map: ws → Set<executionId>.
  // Not done now; acceptable at current scale but should be revisited if maxSize grows.
  removeWebSocket(ws: WebSocket): { channelsDropped: string[] } {
    const channelsDropped: string[] = [];
    for (const [id, entry] of this.entries) {
      entry.connections.delete(ws);
      if (entry.connections.size === 0) {
        this.entries.delete(id);
        channelsDropped.push(id);
      }
    }
    return { channelsDropped };
  }

  size(): number {
    return this.entries.size;
  }
}
