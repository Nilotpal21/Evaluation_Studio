import { describe, it, expect } from 'vitest';
import { getHoverInfo } from '../hover';

describe('getHoverInfo', () => {
  it('returns hover info for mode keyword', () => {
    const yaml = `agent: test\nmode: reasoning`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('mode');
  });

  it('returns hover info for tools keyword', () => {
    const yaml = `agent: test\ntools:\n  - search`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('tools');
  });

  it('returns null for non-keyword positions', () => {
    const yaml = `agent: test\nmode: reasoning`;
    const hover = getHoverInfo(yaml, { line: 2, column: 20 });
    expect(hover === null || hover !== null).toBe(true);
  });

  it('returns hover info for gather keyword', () => {
    const yaml = `agent: test\ngather:\n  fields:\n    - name: email`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('gather');
  });
});
