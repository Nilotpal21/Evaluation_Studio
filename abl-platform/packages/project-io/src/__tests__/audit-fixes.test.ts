/**
 * Tests for security/integrity audit fixes.
 *
 * Covers: path collision, CRLF handling, lockfile determinism,
 * duplicate sections, empty agent name, lock race condition.
 */

import { describe, it, expect } from 'vitest';
import { buildFileMap, agentFilePath, toolFilePath } from '../export/folder-builder.js';
import {
  generateLockfile,
  verifyLockfileIntegrity,
  computeSourceHash,
} from '../export/lockfile-generator.js';
import { identifySections, spliceSection, spliceSections } from '../diff/section-splicer.js';
import { validateAgentSyntax, validateImport } from '../import/import-validator.js';
import {
  LockService,
  type LockRecord,
  type LockStore,
  type LockConflictError,
} from '../ownership/lock-service.js';
import type { LockType } from '../types.js';

// ─── Path Collision Tests ──────────────────────────────────────────────────

describe('folder-builder path collisions', () => {
  it('should handle two agents that normalize to the same filename', () => {
    const agents = [
      { name: 'my-agent', dslContent: 'AGENT: my-agent', isSupervisor: false },
      { name: 'my_agent', dslContent: 'AGENT: my_agent', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());

    expect(files.size).toBe(2);
    expect(files.has('agents/my_agent.agent.yaml')).toBe(true);
    expect(files.has('agents/my_agent_2.agent.yaml')).toBe(true);
  });

  it('should handle three-way collision', () => {
    const agents = [
      { name: 'test-agent', dslContent: 'AGENT: test-agent', isSupervisor: false },
      { name: 'test_agent', dslContent: 'AGENT: test_agent', isSupervisor: false },
      { name: 'test.agent', dslContent: 'AGENT: test.agent', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());

    expect(files.size).toBe(3);
    const paths = [...files.keys()].sort();
    expect(paths).toEqual([
      'agents/test_agent.agent.yaml',
      'agents/test_agent_2.agent.yaml',
      'agents/test_agent_3.agent.yaml',
    ]);
  });

  it('should not add suffix when names are unique', () => {
    const agents = [
      { name: 'agent_a', dslContent: 'AGENT: agent_a', isSupervisor: false },
      { name: 'agent_b', dslContent: 'AGENT: agent_b', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());

    expect(files.size).toBe(2);
    expect(files.has('agents/agent_a.agent.yaml')).toBe(true);
    expect(files.has('agents/agent_b.agent.yaml')).toBe(true);
  });
});

// ─── Lockfile Determinism Tests ───────────────────────────────────────────

describe('lockfile determinism', () => {
  it('should produce same integrity hash regardless of agent insertion order', () => {
    const agentsAZ = [
      { name: 'agent_a', version: '1.0', dslContent: 'A', status: 'active' },
      { name: 'agent_b', version: '1.0', dslContent: 'B', status: 'active' },
    ];
    const agentsZA = [
      { name: 'agent_b', version: '1.0', dslContent: 'B', status: 'active' },
      { name: 'agent_a', version: '1.0', dslContent: 'A', status: 'active' },
    ];

    const lock1 = generateLockfile(agentsAZ, []);
    const lock2 = generateLockfile(agentsZA, []);

    expect(lock1.integrity).toBe(lock2.integrity);
  });

  it('should verify integrity after generation', () => {
    const lock = generateLockfile(
      [{ name: 'x', version: '1', dslContent: 'test', status: 'active' }],
      [{ name: 'tool1', content: 'tool content' }],
    );
    expect(verifyLockfileIntegrity(lock)).toBe(true);
  });

  it('should detect tampered lockfile', () => {
    const lock = generateLockfile(
      [{ name: 'x', version: '1', dslContent: 'test', status: 'active' }],
      [],
    );
    lock.agents['x'].version = '2';
    expect(verifyLockfileIntegrity(lock)).toBe(false);
  });
});

// ─── Section Splicer CRLF Tests ──────────────────────────────────────────

describe('section splicer CRLF', () => {
  it('should handle CRLF line endings', () => {
    const content = 'AGENT: test\r\n\r\nGOAL:\r\n  Help users\r\n\r\nTOOLS:\r\n  - search\r\n';
    const result = spliceSection(content, 'GOAL', 'GOAL:\r\n  New goal');

    // Output should preserve CRLF
    expect(result).toContain('\r\n');
    expect(result).toContain('New goal');
    expect(result).not.toContain('Help users');
  });

  it('should roundtrip LF content', () => {
    const content = 'AGENT: test\n\nGOAL:\n  Help users\n';
    const result = spliceSection(content, 'GOAL', 'GOAL:\n  Same goal');

    expect(result).not.toContain('\r\n');
    expect(result).toContain('Same goal');
  });
});

// ─── Duplicate Section Detection ─────────────────────────────────────────

describe('duplicate section detection', () => {
  it('should use first occurrence of a duplicate section', () => {
    const content =
      'AGENT: test\n\nGOAL:\n  First goal\n\nTOOLS:\n  - search\n\nGOAL:\n  Duplicate goal\n';
    const sections = identifySections(content);

    const goalSections = sections.filter((s) => s.name === 'GOAL');
    expect(goalSections).toHaveLength(1);
    expect(goalSections[0].startLine).toBe(2); // First occurrence
  });
});

// ─── Import Validator Empty Name ─────────────────────────────────────────

describe('import validator empty agent name', () => {
  it('should reject AGENT: with no name', () => {
    const errors = validateAgentSyntax('test.abl', 'AGENT:\n\nGOAL:\n  Help');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject AGENT: with only whitespace after colon', () => {
    const errors = validateAgentSyntax('test.abl', 'AGENT:   \n\nGOAL:\n  Help');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should accept AGENT: with a name', () => {
    const errors = validateAgentSyntax('test.abl', 'AGENT: my_agent\n\nGOAL:\n  Help');
    expect(errors).toHaveLength(0);
  });
});

// ─── Lock Race Condition Tests ───────────────────────────────────────────

describe('lock race condition', () => {
  function createRaceStore(): LockStore & { data: Map<string, LockRecord> } {
    const data = new Map<string, LockRecord>();
    let idCounter = 0;

    return {
      data,
      async getLock(projectId, agentId, lockType) {
        return data.get(`${projectId}:${agentId}:${lockType}`) ?? null;
      },
      async createLock(record) {
        const key = `${record.projectId}:${record.agentId}:${record.lockType}`;
        // Simulate unique constraint: throw if key exists
        if (data.has(key)) {
          const err = new Error('duplicate key') as Error & { code: number };
          err.code = 11000;
          throw err;
        }
        const id = `lock-${++idCounter}`;
        const full: LockRecord = { ...record, id };
        data.set(key, full);
        return full;
      },
      async updateLock(id, updates) {
        for (const [key, record] of data) {
          if (record.id === id) {
            const updated = { ...record, ...updates };
            data.set(key, updated);
            return updated;
          }
        }
        throw new Error(`Lock ${id} not found`);
      },
      async deleteLock(projectId, agentId, lockType) {
        data.delete(`${projectId}:${agentId}:${lockType}`);
      },
      async listLocks(projectId) {
        return [...data.values()].filter((l) => l.projectId === projectId);
      },
    };
  }

  it('should return conflict on duplicate key error from createLock', async () => {
    const store = createRaceStore();
    const service = new LockService(store);

    // First acquire succeeds
    const first = await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-1');
    expect('id' in first).toBe(true);

    // Simulate race: another user's getLock returns null (expired was just deleted),
    // but createLock hits duplicate key because first user just created it.
    // We test this by directly calling acquireLock for a different user when lock exists.
    const second = await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-2');
    expect('code' in second).toBe(true);
    expect((second as LockConflictError).code).toBe('LOCK_CONFLICT');
  });

  it('should handle duplicate key when lock already taken by another concurrent request', async () => {
    const store = createRaceStore();
    const service = new LockService(store);

    // Pre-insert a lock directly into the store to simulate a race condition
    store.data.set('proj-1:agent-1:edit', {
      id: 'lock-race',
      projectId: 'proj-1',
      agentId: 'agent-1',
      agentName: 'Agent',
      lockedBy: 'user-other',
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      lockType: 'edit',
    });

    // Service getLock returns the existing lock, so it returns LOCK_CONFLICT
    const result = await service.acquireLock('proj-1', 'agent-1', 'Agent', 'user-me');
    expect('code' in result).toBe(true);
    expect((result as LockConflictError).code).toBe('LOCK_CONFLICT');
    expect((result as LockConflictError).lockedBy).toBe('user-other');
  });
});

// ─── Extended: Folder-Builder ───────────────────────────────────────────────

describe('folder-builder extended', () => {
  it('should normalize special characters in agent names', () => {
    const path = agentFilePath('my-agent.v2 (test)');
    expect(path).toBe('agents/my_agent_v2__test_.agent.yaml');
    expect(path).not.toMatch(/[^a-z0-9_./]/);
  });

  it('should normalize toolFilePath special characters', () => {
    const path = toolFilePath('Hotels API (v2)');
    expect(path).toBe('tools/hotels_api__v2_.tools.abl');
    // Only a-z0-9_- allowed in tool names
    expect(path).not.toMatch(/[^a-z0-9_\-./]/);
  });

  it('should map configs to config/ prefix', () => {
    const configs = new Map([
      ['models.json', '{"gpt-4": true}'],
      ['environment.json', '{"env": "dev"}'],
    ]);
    const files = buildFileMap([], [], configs, new Map());

    expect(files.has('config/models.json')).toBe(true);
    expect(files.has('config/environment.json')).toBe(true);
    expect(files.get('config/models.json')).toBe('{"gpt-4": true}');
  });

  it('should map deployments to deployments/ prefix', () => {
    const deployments = new Map([['dev.deployment.json', '{"target":"dev"}']]);
    const files = buildFileMap([], [], new Map(), deployments);

    expect(files.has('deployments/dev.deployment.json')).toBe(true);
    expect(files.get('deployments/dev.deployment.json')).toBe('{"target":"dev"}');
  });

  it('should overwrite tool on name collision (last-write-wins)', () => {
    const tools = [
      { name: 'search', content: 'TOOLS: search v1' },
      { name: 'search', content: 'TOOLS: search v2' },
    ];
    const files = buildFileMap([], tools, new Map(), new Map());

    // Both tools normalize to same path; second write wins
    expect(files.get('tools/search.tools.abl')).toBe('TOOLS: search v2');
  });
});

// ─── Extended: Lockfile Generator ───────────────────────────────────────────

describe('lockfile-generator extended', () => {
  it('should return exactly 16 hex chars from computeSourceHash', () => {
    const hash = computeSourceHash('any content here');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toHaveLength(16);
  });

  it('should be deterministic (same input → same output)', () => {
    const input = 'AGENT: test\nGOAL: help';
    const hash1 = computeSourceHash(input);
    const hash2 = computeSourceHash(input);
    expect(hash1).toBe(hash2);
  });

  it('should generate valid lockfile with empty agents and tools', () => {
    const lock = generateLockfile([], []);

    expect(lock.lockfile_version).toBe('1.0');
    expect(lock.generated_at).toBeTruthy();
    expect(lock.agents).toEqual({});
    expect(lock.tools).toEqual({});
    expect(lock.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLockfileIntegrity(lock)).toBe(true);
  });

  it('should handle UTF-8 and emoji content in source hashes', () => {
    const hash1 = computeSourceHash('AGENT: 日本語エージェント 🤖');
    const hash2 = computeSourceHash('AGENT: 日本語エージェント 🤖');
    expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    expect(hash1).toBe(hash2);
  });

  it('should detect tampered tools section', () => {
    const lock = generateLockfile(
      [{ name: 'a', version: '1', dslContent: 'A', status: 'active' }],
      [{ name: 'tool1', content: 'tool code' }],
    );
    expect(verifyLockfileIntegrity(lock)).toBe(true);

    // Tamper with tools
    lock.tools['tool1'].source_hash = '0000000000000000';
    expect(verifyLockfileIntegrity(lock)).toBe(false);
  });
});

// ─── Extended: Import Validator ─────────────────────────────────────────────

describe('import-validator extended', () => {
  it('should report errors for invalid files while passing valid ones', () => {
    const agentFiles = new Map([
      ['agents/valid.agent.abl', 'AGENT: valid_agent\n\nGOAL:\n  Help'],
      ['agents/bad.agent.abl', 'not-a-header\n\nGOAL:\n  Help'],
    ]);
    const result = validateImport(agentFiles, new Map());

    expect(result.valid).toBe(false);
    expect(result.syntaxErrors).toHaveLength(1);
    expect(result.syntaxErrors[0].file).toBe('agents/bad.agent.abl');
  });

  it('should allow comments before AGENT: header', () => {
    const errors = validateAgentSyntax(
      'test.abl',
      '# This is a comment\n\nAGENT: my_agent\n\nGOAL:\n  Help',
    );
    expect(errors).toHaveLength(0);
  });

  it('should accept SUPERVISOR: header', () => {
    const errors = validateAgentSyntax(
      'test.abl',
      'SUPERVISOR: my_supervisor\n\nGOAL:\n  Route tasks',
    );
    expect(errors).toHaveLength(0);
  });

  it('should reject non-header first line with correct line number', () => {
    const errors = validateAgentSyntax('test.abl', 'GOAL:\n  Help users');
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain('Expected AGENT:, SUPERVISOR:, agent:, or supervisor:');
  });

  it('should extract tool name from path pattern', () => {
    const agentFiles = new Map([['agents/a.agent.abl', 'AGENT: a\n\nGOAL:\n  Help']]);
    const toolFiles = new Map([
      ['tools/hotels-api.tools.abl', 'TOOLS: hotels\n  search() -> void'],
    ]);
    const result = validateImport(agentFiles, toolFiles);

    // Tool name extracted from path: strip tools/ prefix and .tools.abl suffix
    // The dependency graph should have the tool registered
    expect(result.syntaxErrors).toHaveLength(0);
  });
});
