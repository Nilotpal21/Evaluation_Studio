/**
 * AdapterRegistry
 *
 * Discovers, loads, and manages agent desktop adapters.
 */
import { createLogger } from '@abl/compiler/platform';
import type { AgentDesktopAdapter } from './interface.js';

const log = createLogger('adapter-registry');

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentDesktopAdapter>();

  register(name: string, adapter: AgentDesktopAdapter): void {
    if (this.adapters.has(name)) {
      throw new Error(`Adapter '${name}' is already registered`);
    }
    this.adapters.set(name, adapter);
    log.info('Adapter registered', { name, transport: adapter.capabilities.transportType });
  }

  get(name: string): AgentDesktopAdapter | undefined {
    return this.adapters.get(name);
  }

  getOrThrow(name: string): AgentDesktopAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Adapter '${name}' not found. Available: ${this.listNames().join(', ')}`);
    }
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  listNames(): string[] {
    return Array.from(this.adapters.keys());
  }

  unregister(name: string): boolean {
    const removed = this.adapters.delete(name);
    if (removed) {
      log.info('Adapter unregistered', { name });
    }
    return removed;
  }

  invalidateAuth(providerName: string, tenantId: string): void {
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      log.warn('Cannot invalidate auth: adapter not found', { providerName });
      return;
    }
    if (adapter.invalidateAuth) {
      adapter.invalidateAuth(tenantId);
    }
  }
}
