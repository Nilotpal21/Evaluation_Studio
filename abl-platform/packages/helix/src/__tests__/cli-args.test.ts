import { describe, expect, it } from 'vitest';

import { parseFlags } from '../cli-args.js';

describe('parseFlags', () => {
  it('treats known boolean flags as standalone before positional arguments', () => {
    const parsed = parseFlags(['--interactive', 'a44b46b5']);

    expect(parsed).toEqual({
      positional: ['a44b46b5'],
      flags: {
        '--interactive': 'true',
      },
    });
  });

  it('preserves the resume session id when boolean flags surround it', () => {
    const parsed = parseFlags(['--interactive', 'a44b46b5', '--auto-approve', '--verbose']);

    expect(parsed).toEqual({
      positional: ['a44b46b5'],
      flags: {
        '--interactive': 'true',
        '--auto-approve': 'true',
        '--verbose': 'true',
      },
    });
  });

  it('keeps existing resume forms working when the session id comes first', () => {
    const parsed = parseFlags([
      'a44b46b5',
      '--interactive',
      '--auto-approve',
      '--auto-commit',
      '--verbose',
      '--codex-path',
      '/Applications/Codex.app/Contents/Resources/codex',
    ]);

    expect(parsed).toEqual({
      positional: ['a44b46b5'],
      flags: {
        '--interactive': 'true',
        '--auto-approve': 'true',
        '--auto-commit': 'true',
        '--verbose': 'true',
        '--codex-path': '/Applications/Codex.app/Contents/Resources/codex',
      },
    });
  });

  it('still consumes values for non-boolean flags', () => {
    const parsed = parseFlags([
      '--codex-path',
      '/Applications/Codex.app/Contents/Resources/codex',
      '--report=report.json',
      '--workdir',
      '/tmp/helix-workspace',
    ]);

    expect(parsed).toEqual({
      positional: [],
      flags: {
        '--codex-path': '/Applications/Codex.app/Contents/Resources/codex',
        '--report': 'report.json',
        '--workdir': '/tmp/helix-workspace',
      },
    });
  });

  it('keeps worktree toggles boolean while still allowing explicit worktree paths', () => {
    const parsed = parseFlags([
      '--worktree',
      '--skip-worktree-install',
      '--worktree-path',
      '../abl-platform-wt-slice8',
      'a44b46b5',
    ]);

    expect(parsed).toEqual({
      positional: ['a44b46b5'],
      flags: {
        '--worktree': 'true',
        '--skip-worktree-install': 'true',
        '--worktree-path': '../abl-platform-wt-slice8',
      },
    });
  });

  it('keeps the embeddings feature flag standalone before a Jira key positional', () => {
    const parsed = parseFlags(['--enable-embeddings', 'ABLP-778']);

    expect(parsed).toEqual({
      positional: ['ABLP-778'],
      flags: {
        '--enable-embeddings': 'true',
      },
    });
  });

  it('treats --dry-run as a standalone boolean for helix index rebuild', () => {
    const parsed = parseFlags(['--enable-embeddings', '--dry-run']);

    expect(parsed).toEqual({
      positional: [],
      flags: {
        '--enable-embeddings': 'true',
        '--dry-run': 'true',
      },
    });
  });

  it('treats --all as a standalone boolean for helix index rebuild', () => {
    const parsed = parseFlags(['--enable-embeddings', '--all']);

    expect(parsed).toEqual({
      positional: [],
      flags: {
        '--enable-embeddings': 'true',
        '--all': 'true',
      },
    });
  });

  it('consumes a value for --session in helix index rebuild', () => {
    const parsed = parseFlags(['--enable-embeddings', '--session', 'abc12345']);

    expect(parsed).toEqual({
      positional: [],
      flags: {
        '--enable-embeddings': 'true',
        '--session': 'abc12345',
      },
    });
  });

  it('parses helix index rebuild with all supported flags', () => {
    const parsed = parseFlags([
      '--enable-embeddings',
      '--dry-run',
      '--all',
      '--session',
      'abc12345',
    ]);

    expect(parsed).toEqual({
      positional: [],
      flags: {
        '--enable-embeddings': 'true',
        '--dry-run': 'true',
        '--all': 'true',
        '--session': 'abc12345',
      },
    });
  });
});
