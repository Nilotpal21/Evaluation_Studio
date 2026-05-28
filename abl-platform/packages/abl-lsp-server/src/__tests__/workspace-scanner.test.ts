import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorkspaceScanner } from '../workspace-scanner.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('workspace scanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abl-lsp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds agent names from .agent.yaml files', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(
      path.join(agentsDir, 'booking.agent.yaml'),
      'agent: booking_agent\nmode: reasoning\ngoal: Help with bookings\n',
    );

    const scanner = createWorkspaceScanner();
    const ctx = scanner.scan([tmpDir]);

    expect(ctx.availableAgents).toEqual([{ name: 'booking_agent' }]);
  });

  it('finds tool names from files', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test.agent.yaml'),
      'agent: test_agent\ntools:\n  - search_api\n  - name: booking_api\n',
    );

    const scanner = createWorkspaceScanner();
    const ctx = scanner.scan([tmpDir]);

    expect(ctx.availableTools).toContainEqual({ name: 'search_api' });
    expect(ctx.availableTools).toContainEqual({ name: 'booking_api' });
  });

  it('deduplicates names across files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.agent.yaml'), 'agent: shared\ntools:\n  - api\n');
    fs.writeFileSync(path.join(tmpDir, 'b.agent.yaml'), 'agent: shared\ntools:\n  - api\n');

    const scanner = createWorkspaceScanner();
    const ctx = scanner.scan([tmpDir]);

    expect(ctx.availableAgents).toHaveLength(1);
    expect(ctx.availableTools).toHaveLength(1);
  });

  it('uses cached results on second scan', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.agent.yaml'), 'agent: test\n');

    const scanner = createWorkspaceScanner();
    const ctx1 = scanner.scan([tmpDir]);

    // Remove the file
    fs.unlinkSync(path.join(tmpDir, 'test.agent.yaml'));

    // Should still return cached results
    const ctx2 = scanner.scan([tmpDir]);
    expect(ctx2).toEqual(ctx1);
  });

  it('invalidates cache', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.agent.yaml'), 'agent: test\n');

    const scanner = createWorkspaceScanner();
    scanner.scan([tmpDir]);

    // Remove file and invalidate
    fs.unlinkSync(path.join(tmpDir, 'test.agent.yaml'));
    scanner.invalidate();

    const ctx = scanner.scan([tmpDir]);
    expect(ctx.availableAgents).toHaveLength(0);
  });

  it('skips node_modules and .git directories', () => {
    const nmDir = path.join(tmpDir, 'node_modules', 'pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'test.agent.yaml'), 'agent: hidden\n');

    const scanner = createWorkspaceScanner();
    const ctx = scanner.scan([tmpDir]);

    expect(ctx.availableAgents).toHaveLength(0);
  });

  it('returns empty context for non-existent directories', () => {
    const scanner = createWorkspaceScanner();
    const ctx = scanner.scan(['/non/existent/path']);
    expect(ctx.availableAgents).toEqual([]);
    expect(ctx.availableTools).toEqual([]);
  });
});
