import { describe, it, expect } from 'vitest';
import type { ExtractedTool } from '../import/tool-extractor.js';
import { computeToolApplyOperations } from '../import/import-applier.js';

function makeTool(overrides: Partial<ExtractedTool> & { name: string }): ExtractedTool {
  return {
    toolType: 'http',
    description: null,
    dslContent: `tool ${overrides.name} {}`,
    sourceFile: `tools/${overrides.name}.tools.abl`,
    sourceHash: 'abc123',
    ...overrides,
  };
}

describe('computeToolApplyOperations', () => {
  it('creates operations for new tools', () => {
    const ops = computeToolApplyOperations({
      existingTools: new Map(),
      importedTools: [makeTool({ name: 'search', toolType: 'http', description: 'Search tool' })],
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'create',
      toolName: 'search',
      toolType: 'http',
      description: 'Search tool',
    });
  });

  it('creates update operations for changed tools', () => {
    const ops = computeToolApplyOperations({
      existingTools: new Map([['search', { name: 'search', dslContent: 'old content' }]]),
      importedTools: [makeTool({ name: 'search', dslContent: 'new content' })],
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'update',
      toolName: 'search',
      dslContent: 'new content',
    });
  });

  it('creates delete operations for removed tools', () => {
    const ops = computeToolApplyOperations({
      existingTools: new Map([['old-tool', { name: 'old-tool', dslContent: 'content' }]]),
      importedTools: [],
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: 'delete',
      toolName: 'old-tool',
      dslContent: null,
      toolType: null,
    });
  });

  it('skips unchanged tools', () => {
    const dslContent = 'tool search {}';
    const ops = computeToolApplyOperations({
      existingTools: new Map([['search', { name: 'search', dslContent }]]),
      importedTools: [makeTool({ name: 'search', dslContent })],
    });

    expect(ops).toHaveLength(0);
  });

  it('handles mixed create, update, and delete in one pass', () => {
    const ops = computeToolApplyOperations({
      existingTools: new Map([
        ['keep-same', { name: 'keep-same', dslContent: 'unchanged' }],
        ['to-update', { name: 'to-update', dslContent: 'old' }],
        ['to-delete', { name: 'to-delete', dslContent: 'remove me' }],
      ]),
      importedTools: [
        makeTool({ name: 'keep-same', dslContent: 'unchanged' }),
        makeTool({ name: 'to-update', dslContent: 'new' }),
        makeTool({ name: 'brand-new' }),
      ],
    });

    const types = ops.map((op) => `${op.type}:${op.toolName}`).sort();
    expect(types).toEqual(['create:brand-new', 'delete:to-delete', 'update:to-update']);
  });
});
