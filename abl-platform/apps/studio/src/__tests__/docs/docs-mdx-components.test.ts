import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

describe('MDX components use semantic tokens', () => {
  it('INT-5: Callout uses semantic tokens, no hardcoded palette', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/docs/mdx/Callout.tsx'),
      'utf-8',
    );
    // Must NOT have hardcoded Tailwind palette colors
    expect(source).not.toMatch(/bg-blue-\d+/);
    expect(source).not.toMatch(/bg-amber-\d+/);
    expect(source).not.toMatch(/bg-green-\d+/);
    expect(source).not.toMatch(/text-blue-\d+/);
    expect(source).not.toMatch(/text-amber-\d+/);
    expect(source).not.toMatch(/text-green-\d+/);
    expect(source).not.toMatch(/border-blue-\d+/);
    expect(source).not.toMatch(/border-amber-\d+/);
    expect(source).not.toMatch(/border-green-\d+/);
    // Must HAVE semantic tokens
    expect(source).toContain('bg-info-subtle');
    expect(source).toContain('bg-warning-subtle');
    expect(source).toContain('bg-success-subtle');
    expect(source).toContain('text-info');
    expect(source).toContain('text-warning');
    expect(source).toContain('text-success');
  });

  it('INT-6: CustomPre/CustomCode use semantic tokens', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/docs/mdx/index.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/bg-gray-900/);
    expect(source).not.toMatch(/text-gray-100/);
    expect(source).not.toMatch(/text-pink-600/);
    expect(source).toContain('docs-code-block');
    expect(source).toContain('bg-background-muted');
    expect(source).toContain('text-accent');
  });

  it('INT-7: Milestone uses semantic tokens', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/docs/mdx/Milestone.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/bg-green-\d+/);
    expect(source).not.toMatch(/bg-blue-\d+/);
    expect(source).not.toMatch(/bg-gray-\d+/);
    expect(source).not.toMatch(/text-slate-\d+/);
    expect(source).toContain('bg-success');
    expect(source).toContain('bg-accent');
    expect(source).toContain('text-foreground');
    expect(source).toContain('text-subtle');
    expect(source).toContain('bg-background-muted');
  });

  it('INT-9: Mermaid uses semantic tokens', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/docs/mdx/Mermaid.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/bg-gray-100/);
    expect(source).toContain('bg-background-muted');
  });

  it('INT-11: Mermaid has error handling with fallback', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../components/docs/mdx/Mermaid.tsx'),
      'utf-8',
    );
    expect(source).toContain('.catch(');
    expect(source).toContain('setError(true)');
    expect(source).toContain('<pre');
  });
});
