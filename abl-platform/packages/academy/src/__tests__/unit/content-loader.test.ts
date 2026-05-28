import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import {
  loadJson,
  loadMarkdown,
  getContentHash,
  resolveContentRoot,
  clearContentCaches,
} from '../../content/content-loader.js';

const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', 'content');

beforeEach(() => {
  clearContentCaches();
});

describe('loadJson', () => {
  it('loads and parses academy.json', async () => {
    const config = await loadJson<{ title: string; version: string }>(
      join(CONTENT_ROOT, 'academy.json'),
    );
    expect(config.title).toBe('Agent Platform Learning Academy');
    expect(config.version).toBeDefined();
  });

  it('loads a course JSON file', async () => {
    const course = await loadJson<{ id: string; title: string }>(
      join(CONTENT_ROOT, 'courses', 'abl-language.json'),
    );
    expect(course.id).toBe('abl-language');
    expect(course.title).toBeDefined();
  });

  it('loads a module JSON file', async () => {
    const module = await loadJson<{ id: string; title: string }>(
      join(CONTENT_ROOT, 'modules', 'getting-started', 'module.json'),
    );
    expect(module.id).toBe('getting-started');
  });

  it('caches repeated loads (returns same reference)', async () => {
    const path = join(CONTENT_ROOT, 'academy.json');
    const first = await loadJson(path);
    const second = await loadJson(path);
    expect(first).toBe(second);
  });

  it('throws on non-existent file', async () => {
    await expect(loadJson('/nonexistent/file.json')).rejects.toThrow();
  });
});

describe('loadMarkdown', () => {
  it('loads module content.md', async () => {
    const content = await loadMarkdown(
      join(CONTENT_ROOT, 'modules', 'getting-started', 'content.md'),
    );
    expect(content).toContain('#');
    expect(content.length).toBeGreaterThan(100);
  });

  it('caches repeated loads', async () => {
    const path = join(CONTENT_ROOT, 'modules', 'getting-started', 'content.md');
    const first = await loadMarkdown(path);
    const second = await loadMarkdown(path);
    expect(first).toBe(second);
  });
});

describe('getContentHash', () => {
  it('returns a consistent SHA-256 hex string', async () => {
    const hash = await getContentHash(
      join(CONTENT_ROOT, 'modules', 'getting-started', 'quiz.json'),
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns same hash for same file', async () => {
    const path = join(CONTENT_ROOT, 'modules', 'getting-started', 'quiz.json');
    const hash1 = await getContentHash(path);
    clearContentCaches();
    const hash2 = await getContentHash(path);
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different files', async () => {
    const hash1 = await getContentHash(
      join(CONTENT_ROOT, 'modules', 'getting-started', 'quiz.json'),
    );
    const hash2 = await getContentHash(join(CONTENT_ROOT, 'modules', 'abl-basics', 'quiz.json'));
    expect(hash1).not.toBe(hash2);
  });
});

describe('resolveContentRoot', () => {
  it('returns explicit root when provided', () => {
    expect(resolveContentRoot('/custom/path')).toBe('/custom/path');
  });

  it('resolves default root relative to source', () => {
    const root = resolveContentRoot();
    expect(root).toContain('content');
  });
});
