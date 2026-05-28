import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { AgentRegistryStore } from '../agent-registry.js';
import type { AgentRegistryEntry } from '../types.js';

function makeEntry(
  agentName: string,
  overrides: Partial<AgentRegistryEntry> = {},
): AgentRegistryEntry {
  const ir = {
    metadata: { name: agentName },
    execution: {},
  } as unknown as AgentIR;
  return { dsl: '', ir, ...overrides };
}

describe('AgentRegistryStore', () => {
  let store: AgentRegistryStore;

  beforeEach(() => {
    store = new AgentRegistryStore();
  });

  describe('composite-key isolation', () => {
    it('keeps different versions of the same agent distinct', () => {
      store.register('proj-a', 'Supervisor', '1.0.0', makeEntry('Supervisor'));
      store.register('proj-a', 'Supervisor', '2.0.0', makeEntry('Supervisor'));

      expect(store.has('proj-a', 'Supervisor', '1.0.0')).toBe(true);
      expect(store.has('proj-a', 'Supervisor', '2.0.0')).toBe(true);
      expect(store.size()).toBe(2);
    });

    it('keeps same-name agents from different projects distinct', () => {
      const entryA = makeEntry('Supervisor');
      const entryB = makeEntry('Supervisor');
      store.register('proj-a', 'Supervisor', '1.0.0', entryA);
      store.register('proj-b', 'Supervisor', '1.0.0', entryB);

      expect(store.lookup('proj-a', 'Supervisor', '1.0.0')?.ir).toBe(entryA.ir);
      expect(store.lookup('proj-b', 'Supervisor', '1.0.0')?.ir).toBe(entryB.ir);
      expect(store.size()).toBe(2);
    });

    it('does not cross-match between projects on lookup', () => {
      store.register('proj-a', 'Supervisor', '1.0.0', makeEntry('Supervisor'));
      expect(store.lookup('proj-b', 'Supervisor', '1.0.0')).toBeUndefined();
      expect(store.has('proj-b', 'Supervisor', '1.0.0')).toBe(false);
    });

    it('does not cross-match between versions on lookup', () => {
      store.register('proj-a', 'Supervisor', '1.0.0', makeEntry('Supervisor'));
      expect(store.lookup('proj-a', 'Supervisor', '2.0.0')).toBeUndefined();
    });

    it('returns undefined on miss (no fallback)', () => {
      expect(store.lookup('proj-a', 'Missing', '1.0.0')).toBeUndefined();
      expect(store.getIR('proj-a', 'Missing', '1.0.0')).toBeNull();
    });
  });

  describe('register', () => {
    it('stamps version onto the stored entry', () => {
      store.register('proj-a', 'A', '1.2.3', makeEntry('A'));
      expect(store.lookup('proj-a', 'A', '1.2.3')?.version).toBe('1.2.3');
    });

    it('overwrites prior entry under the same composite key', () => {
      const first = makeEntry('A');
      const second = makeEntry('A');
      store.register('proj-a', 'A', '1.0.0', first);
      store.register('proj-a', 'A', '1.0.0', second);
      expect(store.lookup('proj-a', 'A', '1.0.0')?.ir).toBe(second.ir);
      expect(store.size()).toBe(1);
    });

    it.each([
      ['', 'Agent', '1.0.0'],
      ['proj', '', '1.0.0'],
      ['proj', 'Agent', ''],
    ])('rejects empty identifier (projectId=%o, name=%o, version=%o)', (p, n, v) => {
      expect(() => store.register(p, n, v, makeEntry('A'))).toThrow(/must be a non-empty string/);
    });
  });

  describe('getIR', () => {
    it('returns null when the entry has no IR', () => {
      store.register('proj-a', 'A', '1.0.0', { dsl: '', ir: null });
      expect(store.getIR('proj-a', 'A', '1.0.0')).toBeNull();
    });

    it('returns the IR when present', () => {
      const entry = makeEntry('A');
      store.register('proj-a', 'A', '1.0.0', entry);
      expect(store.getIR('proj-a', 'A', '1.0.0')).toBe(entry.ir);
    });
  });

  describe('delete', () => {
    it('removes a single entry and returns true', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      expect(store.delete('proj-a', 'A', '1.0.0')).toBe(true);
      expect(store.has('proj-a', 'A', '1.0.0')).toBe(false);
    });

    it('returns false when the entry did not exist', () => {
      expect(store.delete('proj-a', 'A', '1.0.0')).toBe(false);
    });
  });

  describe('listForProject', () => {
    it('returns every entry under the project', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      store.register('proj-a', 'B', '1.0.0', makeEntry('B'));
      store.register('proj-b', 'A', '1.0.0', makeEntry('A'));

      const listed = store.listForProject('proj-a');
      expect(listed).toHaveLength(2);
      expect(listed.map((x) => x.name).sort()).toEqual(['A', 'B']);
    });

    it('returns an empty array when the project has no entries', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      expect(store.listForProject('proj-b')).toEqual([]);
    });

    it('does not match projectIds that share a prefix', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      store.register('proj-ab', 'B', '1.0.0', makeEntry('B'));
      const listed = store.listForProject('proj-a');
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe('A');
    });
  });

  describe('clearProject', () => {
    it('removes every entry under the given project and returns the count', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      store.register('proj-a', 'B', '1.0.0', makeEntry('B'));
      store.register('proj-b', 'A', '1.0.0', makeEntry('A'));

      expect(store.clearProject('proj-a')).toBe(2);
      expect(store.size()).toBe(1);
      expect(store.has('proj-b', 'A', '1.0.0')).toBe(true);
    });

    it('returns 0 when the project has no entries', () => {
      expect(store.clearProject('proj-missing')).toBe(0);
    });
  });

  describe('owner lifecycle', () => {
    it('removes owned entries when their owner is released', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'), { ownerId: 'session-1' });

      expect(store.releaseOwner('session-1')).toBe(1);
      expect(store.has('proj-a', 'A', '1.0.0')).toBe(false);
    });

    it('keeps a shared entry until the final owner is released', () => {
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'), { ownerId: 'session-1' });
      store.register('proj-a', 'A', '1.0.0', makeEntry('A'), { ownerId: 'session-2' });

      expect(store.releaseOwner('session-1')).toBe(0);
      expect(store.has('proj-a', 'A', '1.0.0')).toBe(true);
      expect(store.releaseOwner('session-2')).toBe(1);
      expect(store.has('proj-a', 'A', '1.0.0')).toBe(false);
    });
  });

  describe('detached entry pruning', () => {
    it('prunes detached entries once they exceed the TTL on a later registration', () => {
      let now = 1_000;
      store = new AgentRegistryStore({
        now: () => now,
        detachedEntryTtlMs: 50,
        maxDetachedEntries: 10,
      });

      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      now += 60;
      store.register('proj-a', 'B', '1.0.0', makeEntry('B'));

      expect(store.has('proj-a', 'A', '1.0.0')).toBe(false);
      expect(store.has('proj-a', 'B', '1.0.0')).toBe(true);
    });

    it('enforces the detached-entry cap exactly after each registration', () => {
      let now = 1_000;
      store = new AgentRegistryStore({
        now: () => now,
        detachedEntryTtlMs: 1_000,
        maxDetachedEntries: 1,
      });

      store.register('proj-a', 'A', '1.0.0', makeEntry('A'));
      now += 1;
      store.register('proj-a', 'B', '1.0.0', makeEntry('B'));

      expect(store.size()).toBe(1);
      expect(store.has('proj-a', 'A', '1.0.0')).toBe(false);
      expect(store.has('proj-a', 'B', '1.0.0')).toBe(true);
    });
  });

  describe('key edge cases', () => {
    it('handles names that contain the @ separator', () => {
      store.register('proj-a', 'Weird@Name', '1.0.0', makeEntry('Weird@Name'));
      expect(store.has('proj-a', 'Weird@Name', '1.0.0')).toBe(true);
      const listed = store.listForProject('proj-a');
      expect(listed[0].name).toBe('Weird@Name');
      expect(listed[0].version).toBe('1.0.0');
    });

    it('handles versions with pre-release suffixes', () => {
      store.register('proj-a', 'A', '1.0.0-beta.1', makeEntry('A'));
      expect(store.lookup('proj-a', 'A', '1.0.0-beta.1')).toBeDefined();
      expect(store.lookup('proj-a', 'A', '1.0.0')).toBeUndefined();
    });
  });
});
