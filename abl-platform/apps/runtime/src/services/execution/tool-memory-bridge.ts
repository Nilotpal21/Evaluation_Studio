/**
 * Tool Memory Bridge — Imperative memory API for code tools (sandbox/lambda).
 *
 * Provides get_content/set_content/delete_content matching the legacy product API.
 * Scope is auto-resolved from MEMORY declarations — no scope argument in the API.
 *
 * Path resolution:
 *   session vars  → session.data.values (synchronous read/write)
 *   user persistent → userFactStore (async DB call)
 *   project persistent → projectFactStore (async DB call)
 *
 * Wrapper format preserved for legacy compat:
 *   get_content returns { data: { content: <rawValue> } }
 *   set_content stores value wrapped as { data: { content: value } }
 */

import type { ToolMemoryAPI } from '@abl/compiler/platform/constructs/types.js';
import type { MemoryConfig } from '@abl/compiler/platform/ir/schema.js';
import type { FactStore } from '@abl/compiler/platform/stores/fact-store.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tool-memory-bridge');

interface PathInfo {
  scope: 'session' | 'user' | 'project';
  access: 'read' | 'write' | 'readwrite';
}

export class ToolMemoryBridge implements ToolMemoryAPI {
  private pathMap: Map<string, PathInfo>;
  private sessionValues: Record<string, unknown>;
  private userFactStore: FactStore | undefined;
  private projectFactStore: FactStore | undefined;
  private agentName: string;
  private sessionId: string;

  constructor(opts: {
    memory: MemoryConfig;
    sessionValues: Record<string, unknown>;
    userFactStore?: FactStore;
    projectFactStore?: FactStore;
    agentName: string;
    sessionId: string;
  }) {
    this.sessionValues = opts.sessionValues;
    this.userFactStore = opts.userFactStore;
    this.projectFactStore = opts.projectFactStore;
    this.agentName = opts.agentName;
    this.sessionId = opts.sessionId;

    // Build lookup map from MEMORY declarations
    this.pathMap = new Map();

    // Session vars → scope: session, access: readwrite (always mutable)
    if (opts.memory.session) {
      for (const sv of opts.memory.session) {
        this.pathMap.set(sv.name, { scope: 'session', access: 'readwrite' });
      }
    }

    // Persistent paths → scope from declaration, access from declaration
    if (opts.memory.persistent) {
      for (const pm of opts.memory.persistent) {
        this.pathMap.set(pm.path, {
          scope: pm.scope === 'project' ? 'project' : 'user',
          access: pm.access,
        });
      }
    }
  }

  private lookup(key: string): PathInfo {
    const info = this.pathMap.get(key);
    if (!info) {
      throw new Error(`Key '${key}' not declared in MEMORY section`);
    }
    return info;
  }

  private checkWriteAccess(key: string, info: PathInfo): void {
    if (info.access === 'read') {
      throw new Error(`Key '${key}' is read-only (ACCESS: read)`);
    }
  }

  private getStore(scope: 'user' | 'project'): FactStore {
    const store = scope === 'project' ? this.projectFactStore : this.userFactStore;
    if (!store) {
      throw new Error(`No fact store available for ${scope} scope`);
    }
    return store;
  }

  async get_content(key: string): Promise<{ data: { content: unknown } }> {
    const info = this.lookup(key);

    let rawValue: unknown;

    switch (info.scope) {
      case 'session':
        rawValue = this.sessionValues[key];
        break;
      case 'user':
      case 'project': {
        const store = this.getStore(info.scope);
        const fact = await store.get({ key });
        rawValue = fact?.value ?? null;
        break;
      }
    }

    return { data: { content: rawValue } };
  }

  async set_content(key: string, value: unknown): Promise<void> {
    const info = this.lookup(key);
    this.checkWriteAccess(key, info);

    switch (info.scope) {
      case 'session':
        this.sessionValues[key] = value;
        break;
      case 'user':
      case 'project': {
        const store = this.getStore(info.scope);
        await store.set({
          key,
          value,
          source: {
            type: 'agent',
            agentName: this.agentName,
            sessionId: this.sessionId,
          },
        });
        break;
      }
    }
  }

  async delete_content(key: string): Promise<boolean> {
    const info = this.lookup(key);
    this.checkWriteAccess(key, info);

    switch (info.scope) {
      case 'session': {
        const existed = key in this.sessionValues;
        delete this.sessionValues[key];
        return existed;
      }
      case 'user':
      case 'project': {
        const store = this.getStore(info.scope);
        return await store.delete(key);
      }
    }
  }
}

/** Factory for creating a ToolMemoryBridge from session context */
export function createToolMemoryBridge(opts: {
  memory: MemoryConfig;
  sessionValues: Record<string, unknown>;
  userFactStore?: FactStore;
  projectFactStore?: FactStore;
  agentName: string;
  sessionId: string;
}): ToolMemoryAPI {
  return new ToolMemoryBridge(opts);
}
