import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { AgentRegistryEntry } from './types.js';

const log = createLogger('agent-registry');

const DEFAULT_DETACHED_ENTRY_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_DETACHED_ENTRIES = 500;

interface AgentRegistryStoreOptions {
  detachedEntryTtlMs?: number;
  maxDetachedEntries?: number;
  now?: () => number;
}

export interface AgentRegistryScope {
  tenantId?: string;
  projectId: string;
}

interface StoredRegistryEntry {
  entry: AgentRegistryEntry;
  owners: Set<string>;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * In-memory registry of compiled agent IRs keyed by the composite
 * `(tenantId, projectId, name, version)` tuple.
 *
 * The key is always fully qualified for production callers. There is no
 * name-only lookup, no unversioned entry fallback, and no cross-project
 * access. Legacy string overloads are retained only for dev/test harnesses
 * whose sessions do not carry tenant context.
 *
 * Remote agents are NOT stored here — they are dispatched inline from the
 * active session's HANDOFF config at call time, because their identity lives
 * on the remote endpoint rather than in this process.
 */
export class AgentRegistryStore {
  private readonly entries = new Map<string, StoredRegistryEntry>();
  private readonly ownerIndex = new Map<string, Set<string>>();

  constructor(private readonly options: AgentRegistryStoreOptions = {}) {}

  /**
   * Register a compiled agent IR under its fully qualified identity.
   * Overwrites any prior entry for the same composite key.
   */
  register(
    scopeOrProjectId: AgentRegistryScope | string,
    name: string,
    version: string,
    entry: AgentRegistryEntry,
    registerOptions: { ownerId?: string } = {},
  ): void {
    const scope = normalizeScope(scopeOrProjectId);
    assertScope(scope);
    assertNonEmpty('name', name);
    assertNonEmpty('version', version);

    this.pruneDetachedEntries();

    const key = makeKey(scope, name, version);
    const now = this.getNow();
    const ownerId = registerOptions.ownerId;
    const stored =
      this.entries.get(key) ??
      ({
        entry: { ...entry, version },
        owners: new Set<string>(),
        createdAt: now,
        lastAccessedAt: now,
      } satisfies StoredRegistryEntry);

    stored.entry = { ...entry, version };
    stored.lastAccessedAt = now;
    this.entries.set(key, stored);

    if (ownerId) {
      this.attachOwner(ownerId, key, stored);
    }

    this.pruneDetachedEntries();

    log.debug('Registered agent', {
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
      projectId: scope.projectId,
      name,
      version,
      ...(ownerId ? { ownerId } : {}),
    });
  }

  /**
   * Look up an agent by its fully qualified identity.
   * Returns undefined on miss — callers must handle the undefined case
   * explicitly (there is no fallback to other versions or projects).
   */
  lookup(
    scopeOrProjectId: AgentRegistryScope | string,
    name: string,
    version: string,
  ): AgentRegistryEntry | undefined {
    const stored = this.entries.get(makeKey(normalizeScope(scopeOrProjectId), name, version));
    if (!stored) return undefined;
    stored.lastAccessedAt = this.getNow();
    return stored.entry;
  }

  /**
   * Return just the compiled IR for a registered agent, or null if either
   * the entry is missing or the entry has no IR (e.g., unresolved local).
   */
  getIR(
    scopeOrProjectId: AgentRegistryScope | string,
    name: string,
    version: string,
  ): AgentIR | null {
    return this.lookup(scopeOrProjectId, name, version)?.ir ?? null;
  }

  /** Whether an entry exists for the given composite key. */
  has(scopeOrProjectId: AgentRegistryScope | string, name: string, version: string): boolean {
    return this.entries.has(makeKey(normalizeScope(scopeOrProjectId), name, version));
  }

  /** Remove a single entry. Returns true if an entry was deleted. */
  delete(scopeOrProjectId: AgentRegistryScope | string, name: string, version: string): boolean {
    return this.deleteKey(makeKey(normalizeScope(scopeOrProjectId), name, version));
  }

  /**
   * List every entry registered under the given projectId.
   * Useful for project-scoped audits and lifecycle operations.
   */
  listForProject(scopeOrProjectId: AgentRegistryScope | string): Array<{
    name: string;
    version: string;
    entry: AgentRegistryEntry;
  }> {
    const scope = normalizeScope(scopeOrProjectId);
    const out: Array<{ name: string; version: string; entry: AgentRegistryEntry }> = [];
    for (const [key, stored] of this.entries) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      if (parsed.projectId !== scope.projectId) continue;
      if (scope.tenantId && parsed.tenantId !== scope.tenantId) continue;
      out.push({ name: parsed.name, version: parsed.version, entry: stored.entry });
    }
    return out;
  }

  /**
   * Remove every entry for the given projectId.
   * Returns the number of entries removed. Safe to call during project
   * deletion or cache invalidation.
   */
  clearProject(scopeOrProjectId: AgentRegistryScope | string): number {
    const scope = normalizeScope(scopeOrProjectId);
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      if (parsed.projectId !== scope.projectId) continue;
      if (scope.tenantId && parsed.tenantId !== scope.tenantId) continue;
      if (this.deleteKey(key)) {
        removed++;
      }
    }
    if (removed > 0) {
      log.info('Cleared project from registry', {
        ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
        projectId: scope.projectId,
        removed,
      });
    }
    return removed;
  }

  /**
   * Release every registry entry owned by the given session/runtime owner.
   * Entries are deleted when their final owner detaches.
   */
  releaseOwner(ownerId: string): number {
    if (!ownerId) return 0;

    const ownedKeys = this.ownerIndex.get(ownerId);
    if (!ownedKeys || ownedKeys.size === 0) {
      return 0;
    }

    let removed = 0;
    for (const key of ownedKeys) {
      const stored = this.entries.get(key);
      if (!stored) continue;
      stored.owners.delete(ownerId);
      if (stored.owners.size === 0 && this.deleteKey(key)) {
        removed++;
      }
    }

    this.ownerIndex.delete(ownerId);

    if (removed > 0) {
      log.info('Released owner registry entries', { ownerId, removed });
    }

    return removed;
  }

  /** Total number of entries across all projects. For metrics/tests. */
  size(): number {
    return this.entries.size;
  }

  /** Remove every entry. For test teardown only — not for production paths. */
  clearAll(): void {
    this.entries.clear();
    this.ownerIndex.clear();
  }

  private getNow(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private attachOwner(ownerId: string, key: string, stored: StoredRegistryEntry): void {
    stored.owners.add(ownerId);
    const ownerKeys = this.ownerIndex.get(ownerId) ?? new Set<string>();
    ownerKeys.add(key);
    this.ownerIndex.set(ownerId, ownerKeys);
  }

  private deleteKey(key: string): boolean {
    const stored = this.entries.get(key);
    if (!stored) return false;

    for (const ownerId of stored.owners) {
      const ownerKeys = this.ownerIndex.get(ownerId);
      if (!ownerKeys) continue;
      ownerKeys.delete(key);
      if (ownerKeys.size === 0) {
        this.ownerIndex.delete(ownerId);
      }
    }

    this.entries.delete(key);
    return true;
  }

  private pruneDetachedEntries(): void {
    const now = this.getNow();
    const detachedEntryTtlMs = this.options.detachedEntryTtlMs ?? DEFAULT_DETACHED_ENTRY_TTL_MS;
    const maxDetachedEntries = this.options.maxDetachedEntries ?? DEFAULT_MAX_DETACHED_ENTRIES;

    let pruned = 0;
    const detached: Array<{ key: string; lastAccessedAt: number }> = [];

    for (const [key, stored] of this.entries) {
      if (stored.owners.size > 0) continue;

      if (now - stored.lastAccessedAt > detachedEntryTtlMs) {
        if (this.deleteKey(key)) {
          pruned++;
        }
        continue;
      }

      detached.push({ key, lastAccessedAt: stored.lastAccessedAt });
    }

    if (detached.length > maxDetachedEntries) {
      detached.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
      for (const candidate of detached.slice(0, detached.length - maxDetachedEntries)) {
        if (this.deleteKey(candidate.key)) {
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      log.info('Pruned detached registry entries', { pruned });
    }
  }
}

const KEY_SEPARATOR = '/';
const VERSION_SEPARATOR = '@';
const LEGACY_TENANT_KEY = '~legacy';

function makeKey(scope: AgentRegistryScope, name: string, version: string): string {
  return `${scope.tenantId ?? LEGACY_TENANT_KEY}${KEY_SEPARATOR}${scope.projectId}${KEY_SEPARATOR}${name}${VERSION_SEPARATOR}${version}`;
}

function parseKey(
  key: string,
): { tenantId?: string; projectId: string; name: string; version: string } | null {
  const firstSep = key.indexOf(KEY_SEPARATOR);
  if (firstSep < 0) return null;
  const secondSep = key.indexOf(KEY_SEPARATOR, firstSep + 1);
  if (secondSep < 0) return null;
  const lastAt = key.lastIndexOf(VERSION_SEPARATOR);
  if (lastAt < secondSep) return null;
  const tenantKey = key.slice(0, firstSep);
  return {
    ...(tenantKey !== LEGACY_TENANT_KEY ? { tenantId: tenantKey } : {}),
    projectId: key.slice(firstSep + 1, secondSep),
    name: key.slice(secondSep + 1, lastAt),
    version: key.slice(lastAt + 1),
  };
}

function normalizeScope(scopeOrProjectId: AgentRegistryScope | string): AgentRegistryScope {
  if (typeof scopeOrProjectId === 'string') {
    return { projectId: scopeOrProjectId };
  }
  return scopeOrProjectId;
}

function assertScope(scope: AgentRegistryScope): void {
  assertNonEmpty('projectId', scope.projectId);
  if (scope.tenantId !== undefined) {
    assertNonEmpty('tenantId', scope.tenantId);
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`AgentRegistryStore: ${field} must be a non-empty string`);
  }
}
