import { describe, it, expect } from 'vitest';
import { detectStaleTools } from '../useStaleToolCheck';
import type { StaleToolInfo, DeletedToolInfo, NewToolInfo } from '../useStaleToolCheck';
import type { ToolSnapshotEntry } from '../../api/versions';

describe('detectStaleTools', () => {
  it('should detect stale tools (hash changed)', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'get_weather',
        projectToolId: 'tool-1',
        sourceHash: 'abc123',
        toolType: 'http',
        description: 'Get weather',
        dslContent: 'get_weather() -> object\n  type: http',
      },
    ];

    const currentTools = [{ id: 'tool-1', name: 'get_weather', sourceHash: 'def456' }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toEqual({
      name: 'get_weather',
      projectToolId: 'tool-1',
      snapshotHash: 'abc123',
      currentHash: 'def456',
      toolType: 'http',
    });
  });

  it('should detect stale tools when runtime metadata hash changes but DSL source hash is unchanged', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'get_weather',
        projectToolId: 'tool-1',
        sourceHash: 'abc123',
        runtimeMetadataHash: 'runtime-old',
        toolType: 'http',
        description: 'Get weather',
        dslContent: 'get_weather() -> object\n  type: http',
      },
    ];

    const currentTools = [
      {
        id: 'tool-1',
        name: 'get_weather',
        sourceHash: 'abc123',
        runtimeMetadataHash: 'runtime-new',
      },
    ];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toEqual({
      name: 'get_weather',
      projectToolId: 'tool-1',
      snapshotHash: 'abc123',
      currentHash: 'abc123',
      snapshotRuntimeMetadataHash: 'runtime-old',
      currentRuntimeMetadataHash: 'runtime-new',
      toolType: 'http',
    });
  });

  it('should detect deleted tools (not in current)', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'old_tool',
        projectToolId: 'tool-1',
        sourceHash: 'abc123',
        toolType: 'sandbox',
        description: null,
        dslContent: 'old_tool() -> string\n  type: sandbox',
      },
    ];

    const currentTools: Array<{ id: string; name: string; sourceHash?: string }> = [];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toEqual({
      name: 'old_tool',
      projectToolId: 'tool-1',
    });
  });

  it('should detect new tools (in current but not in snapshot)', () => {
    const snapshot: ToolSnapshotEntry[] = [];

    const currentTools = [{ id: 'tool-1', name: 'new_tool', sourceHash: 'xyz789' }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.new).toHaveLength(1);
    expect(result.new[0]).toEqual({
      name: 'new_tool',
      projectToolId: 'tool-1',
    });
  });

  it('should not detect new tools without sourceHash', () => {
    const snapshot: ToolSnapshotEntry[] = [];

    const currentTools = [{ id: 'tool-1', name: 'draft_tool', sourceHash: undefined }];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.new).toHaveLength(0);
  });

  it('should handle mixed scenarios', () => {
    const snapshot: ToolSnapshotEntry[] = [
      {
        name: 'unchanged',
        projectToolId: 'tool-1',
        sourceHash: 'aaa',
        toolType: 'http',
        description: null,
        dslContent: 'unchanged() -> void\n  type: http',
      },
      {
        name: 'updated',
        projectToolId: 'tool-2',
        sourceHash: 'bbb',
        toolType: 'mcp',
        description: null,
        dslContent: 'updated() -> void\n  type: mcp',
      },
      {
        name: 'deleted',
        projectToolId: 'tool-3',
        sourceHash: 'ccc',
        toolType: 'sandbox',
        description: null,
        dslContent: 'deleted() -> void\n  type: sandbox',
      },
    ];

    const currentTools = [
      { id: 'tool-1', name: 'unchanged', sourceHash: 'aaa' }, // same hash
      { id: 'tool-2', name: 'updated', sourceHash: 'bbb-new' }, // different hash
      { id: 'tool-4', name: 'new_tool', sourceHash: 'ddd' }, // not in snapshot
      // tool-3 'deleted' is missing from current
    ];

    const result = detectStaleTools(snapshot, currentTools);

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].name).toBe('updated');

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].name).toBe('deleted');

    expect(result.new).toHaveLength(1);
    expect(result.new[0].name).toBe('new_tool');
  });
});

describe('useStaleToolCheck integration', () => {
  it('should return all three detection categories', () => {
    // This test verifies the hook return type includes all three categories
    // In a real integration test, we'd mock fetchVersions and fetchTools

    const snapshot = [
      {
        name: 'stale_tool',
        projectToolId: 'tool-1',
        sourceHash: 'old-hash',
        toolType: 'http' as const,
        description: null,
        dslContent: 'stale_tool() -> void\n  type: http',
      },
      {
        name: 'deleted_tool',
        projectToolId: 'tool-2',
        sourceHash: 'hash',
        toolType: 'sandbox' as const,
        description: null,
        dslContent: 'deleted_tool() -> void\n  type: sandbox',
      },
    ];

    const currentTools = [
      { id: 'tool-1', name: 'stale_tool', sourceHash: 'new-hash' },
      { id: 'tool-3', name: 'new_tool', sourceHash: 'hash' },
    ];

    const result = detectStaleTools(snapshot, currentTools);

    // Verify hook would return all three arrays
    expect(result).toHaveProperty('stale');
    expect(result).toHaveProperty('deleted');
    expect(result).toHaveProperty('new');

    expect(result.stale.length).toBe(1);
    expect(result.deleted.length).toBe(1);
    expect(result.new.length).toBe(1);
  });
});
