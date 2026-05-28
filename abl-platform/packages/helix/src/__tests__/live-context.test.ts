import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveContext } from '../interactive/live-context.js';

describe('LiveContext', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('starts empty with zero size and pending count', () => {
    const ctx = new LiveContext();
    expect(ctx.size).toBe(0);
    expect(ctx.pendingCount).toBe(0);
    expect(ctx.getAll()).toEqual([]);
    expect(ctx.getPending()).toEqual([]);
  });

  it('adds entries and returns them as pending', async () => {
    const ctx = new LiveContext();
    const id = await ctx.add('focus on auth middleware');

    expect(id).toBeTruthy();
    expect(ctx.size).toBe(1);
    expect(ctx.pendingCount).toBe(1);

    const pending = ctx.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('focus on auth middleware');
    expect(pending[0].consumedByStage).toBeNull();
    expect(pending[0].consumedAt).toBeNull();
  });

  it('marks pending entries as consumed', async () => {
    const ctx = new LiveContext();
    await ctx.add('first context');
    await ctx.add('second context');

    expect(ctx.pendingCount).toBe(2);

    await ctx.markConsumed('Deep Scan');

    expect(ctx.pendingCount).toBe(0);
    expect(ctx.size).toBe(2);

    const all = ctx.getAll();
    expect(all[0].consumedByStage).toBe('Deep Scan');
    expect(all[0].consumedAt).toBeTruthy();
    expect(all[1].consumedByStage).toBe('Deep Scan');
  });

  it('only marks unconsumed entries on subsequent markConsumed calls', async () => {
    const ctx = new LiveContext();
    await ctx.add('first');
    await ctx.markConsumed('Stage A');

    await ctx.add('second');
    await ctx.markConsumed('Stage B');

    const all = ctx.getAll();
    expect(all[0].consumedByStage).toBe('Stage A');
    expect(all[1].consumedByStage).toBe('Stage B');
  });

  it('renderForPrompt returns empty string when no pending entries', async () => {
    const ctx = new LiveContext();
    expect(ctx.renderForPrompt()).toBe('');

    await ctx.add('something');
    await ctx.markConsumed('stage');
    expect(ctx.renderForPrompt()).toBe('');
  });

  it('renderForPrompt includes all pending entries', async () => {
    const ctx = new LiveContext();
    await ctx.add('focus on auth');
    await ctx.add('check token expiry');

    const rendered = ctx.renderForPrompt();
    expect(rendered).toContain('## Live Context (User Guidance)');
    expect(rendered).toContain('focus on auth');
    expect(rendered).toContain('check token expiry');
  });

  it('renderForPrompt prioritizes failure advisory entries ahead of other guidance', async () => {
    const ctx = new LiveContext();
    await ctx.add('general guidance');
    await ctx.add('Failure advisory for Deep Scan (sig-123)\nSummary: synthesize now');

    const rendered = ctx.renderForPrompt();
    const advisoryIndex = rendered.indexOf('Failure advisory for Deep Scan');
    const generalIndex = rendered.indexOf('general guidance');

    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(generalIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryIndex).toBeLessThan(generalIndex);
  });

  it('persists and loads from file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-live-ctx-'));
    const sessionDir = join(tempDir, 'sessions');
    const sessionId = 'test-session';

    // Write context
    const ctx1 = new LiveContext();
    ctx1.bindToSession(sessionDir, sessionId);
    await ctx1.add('persisted guidance');
    await ctx1.add('more guidance');
    await ctx1.markConsumed('Stage A');
    await ctx1.add('pending guidance');

    // Verify file exists
    const filePath = join(sessionDir, sessionId, 'live-context.json');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(3);

    // Load into a new instance
    const ctx2 = new LiveContext();
    await ctx2.loadFromFile(sessionDir, sessionId);

    expect(ctx2.size).toBe(3);
    expect(ctx2.pendingCount).toBe(1);
    expect(ctx2.getPending()[0].content).toBe('pending guidance');
  });

  it('loadFromFile handles missing file gracefully', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-live-ctx-'));
    const ctx = new LiveContext();
    await ctx.loadFromFile(tempDir, 'nonexistent');

    expect(ctx.size).toBe(0);
    expect(ctx.pendingCount).toBe(0);
  });
});
