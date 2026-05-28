import { describe, it, expect } from 'vitest';
import { checkConflict, checkConflicts, autoResolveConflicts } from '../git/conflict-resolver.js';

describe('checkConflict', () => {
  it('should accept theirs when no local changes', () => {
    const result = checkConflict({
      file: 'agents/test.agent.abl',
      agentName: 'Test',
      base: 'original content',
      ours: 'original content',
      theirs: 'updated content',
    });

    expect(result.conflict).toBe(false);
    if (!result.conflict) {
      expect(result.resolution).toBe('accept_theirs');
      expect(result.content).toBe('updated content');
    }
  });

  it('should keep ours when no remote changes', () => {
    const result = checkConflict({
      file: 'agents/test.agent.abl',
      agentName: 'Test',
      base: 'original content',
      ours: 'locally modified',
      theirs: 'original content',
    });

    expect(result.conflict).toBe(false);
    if (!result.conflict) {
      expect(result.resolution).toBe('keep_ours');
      expect(result.content).toBe('locally modified');
    }
  });

  it('should detect identical changes', () => {
    const result = checkConflict({
      file: 'agents/test.agent.abl',
      agentName: 'Test',
      base: 'original content',
      ours: 'same changes',
      theirs: 'same changes',
    });

    expect(result.conflict).toBe(false);
    if (!result.conflict) {
      expect(result.resolution).toBe('identical');
    }
  });

  it('should detect true conflict when both differ from base', () => {
    const result = checkConflict({
      file: 'agents/test.agent.abl',
      agentName: 'Test',
      base: 'original content',
      ours: 'local changes',
      theirs: 'remote changes',
    });

    expect(result.conflict).toBe(true);
    if (result.conflict) {
      expect(result.detail.localContent).toBe('local changes');
      expect(result.detail.remoteContent).toBe('remote changes');
    }
  });

  it('should detect conflict when no base (new file both sides)', () => {
    const result = checkConflict({
      file: 'agents/new.agent.abl',
      agentName: 'New',
      base: null,
      ours: 'local version',
      theirs: 'remote version',
    });

    expect(result.conflict).toBe(true);
  });
});

describe('checkConflicts', () => {
  it('should separate resolved and conflicting files', () => {
    const result = checkConflicts([
      {
        file: 'agents/a.agent.abl',
        agentName: 'A',
        base: 'base',
        ours: 'base',
        theirs: 'updated',
      },
      {
        file: 'agents/b.agent.abl',
        agentName: 'B',
        base: 'base',
        ours: 'local',
        theirs: 'remote',
      },
    ]);

    expect(result.resolved).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.resolved[0].agentName).toBe('A');
    expect(result.conflicts[0].agentName).toBe('B');
  });
});

describe('autoResolveConflicts', () => {
  it('should return empty for manual strategy', () => {
    const conflicts = [
      {
        agentName: 'A',
        file: 'a.abl',
        baseContent: null,
        localContent: 'local',
        remoteContent: 'remote',
      },
    ];
    const resolutions = autoResolveConflicts(conflicts, 'manual');
    expect(resolutions).toHaveLength(0);
  });

  it('should prefer local for local_wins strategy', () => {
    const conflicts = [
      {
        agentName: 'A',
        file: 'a.abl',
        baseContent: null,
        localContent: 'local',
        remoteContent: 'remote',
      },
    ];
    const resolutions = autoResolveConflicts(conflicts, 'local_wins');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].resolution).toBe('local');
    expect(resolutions[0].mergedContent).toBe('local');
  });

  it('should prefer remote for remote_wins strategy', () => {
    const conflicts = [
      {
        agentName: 'A',
        file: 'a.abl',
        baseContent: null,
        localContent: 'local',
        remoteContent: 'remote',
      },
    ];
    const resolutions = autoResolveConflicts(conflicts, 'remote_wins');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].resolution).toBe('remote');
    expect(resolutions[0].mergedContent).toBe('remote');
  });
});

describe('autoResolveConflicts strategies (multi-file)', () => {
  const conflicts = [
    {
      file: 'agents/a.agent.abl',
      agentName: 'a',
      baseContent: 'base content',
      localContent: 'local content',
      remoteContent: 'remote content',
    },
    {
      file: 'agents/b.agent.abl',
      agentName: 'b',
      baseContent: 'base',
      localContent: 'ours',
      remoteContent: 'theirs',
    },
  ];

  it('manual strategy should return all conflicts unresolved', () => {
    const result = autoResolveConflicts(conflicts, 'manual');
    expect(result).toHaveLength(0);
  });

  it('local_wins should resolve all with local content', () => {
    const result = autoResolveConflicts(conflicts, 'local_wins');
    expect(result).toHaveLength(2);
    expect(result[0].mergedContent).toBe('local content');
    expect(result[0].resolution).toBe('local');
    expect(result[1].mergedContent).toBe('ours');
  });

  it('remote_wins should resolve all with remote content', () => {
    const result = autoResolveConflicts(conflicts, 'remote_wins');
    expect(result).toHaveLength(2);
    expect(result[0].mergedContent).toBe('remote content');
    expect(result[0].resolution).toBe('remote');
    expect(result[1].mergedContent).toBe('theirs');
  });
});
