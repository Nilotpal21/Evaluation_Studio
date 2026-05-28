import { createHash } from 'node:crypto';
import { execFile, type ExecFileException } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recomputeAblLockfile, registerLockfileCommands } from '../../commands/lockfile.js';

type LayerName =
  | 'core'
  | 'connections'
  | 'prompts'
  | 'guardrails'
  | 'workflows'
  | 'evals'
  | 'search'
  | 'channels'
  | 'vocabulary';

interface TestLockfileV2 {
  lockfile_version: '2.0';
  generated_at: string;
  agents: Record<string, { version: string; source_hash: string; status: string }>;
  tools: Record<string, { source_hash: string }>;
  configs: Record<string, { source_hash: string }>;
  connections: Record<string, { source_hash: string }>;
  guardrails: Record<string, { source_hash: string }>;
  workflows: Record<string, { source_hash: string; version?: string; status?: string }>;
  evals: Record<string, { source_hash: string }>;
  search: Record<string, { source_hash: string }>;
  channels: Record<string, { source_hash: string }>;
  vocabulary: Record<string, { source_hash: string }>;
  layer_hashes: Partial<Record<LayerName, string>>;
  integrity: string;
}

const EMPTY_LAYER_HASH = createHash('sha256').update('', 'utf8').digest('hex');
const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('lockfile recompute command helpers', () => {
  it('recomputes v2 source hashes, layer hashes, and root integrity in place', async () => {
    const projectDir = await makeExportedProject();

    const result = await recomputeAblLockfile(projectDir);
    const lockfile = await readLockfile(projectDir);

    expect(result.changed).toBe(true);
    expect(result.sourceHashesUpdated).toBe(3);
    expect(lockfile.agents.Support.source_hash).toBe(
      computeAgentSourceHash('AGENT: Support', {
        promptId: 'prompt-support',
        versionId: 'version-support',
        resolvedHash: 'prompt-hash-support',
      }),
    );
    expect(lockfile.tools['tools/order.tools.abl'].source_hash).toBe(
      computeSourceHash('TOOL: OrderLookup'),
    );
    expect(lockfile.channels['channels/web-chat.channel.json'].source_hash).toBe(
      computeSourceHash('{"type":"web"}'),
    );
    expect(lockfile.layer_hashes.core).toBe(
      computeLayerHash(
        new Map([
          ['agents/support.agent.abl', 'AGENT: Support'],
          ['tools/order.tools.abl', 'TOOL: OrderLookup'],
        ]),
      ),
    );
    expect(lockfile.layer_hashes.channels).toBe(
      computeLayerHash(new Map([['channels/web-chat.channel.json', '{"type":"web"}']])),
    );
    expect(lockfile.layer_hashes.prompts).toBe(
      computeLayerHash(
        new Map([['prompts/support_prompt.prompt.json', '{"name":"Support Prompt"}']]),
      ),
    );
    expect(lockfile.layer_hashes.evals).toBe(EMPTY_LAYER_HASH);
    expect(lockfile.integrity).toBe(computeIntegrity(lockfile));
  });

  it('reports stale lockfile state in check mode without writing', async () => {
    const projectDir = await makeExportedProject();
    const before = await readFile(join(projectDir, 'abl.lock'), 'utf8');

    const result = await recomputeAblLockfile(projectDir, { check: true });
    const after = await readFile(join(projectDir, 'abl.lock'), 'utf8');

    expect(result.changed).toBe(true);
    expect(after).toBe(before);
  });

  it('wires the registered --check command to fail stale lockfiles without writing', async () => {
    const projectDir = await makeExportedProject();
    const before = await readFile(join(projectDir, 'abl.lock'), 'utf8');
    const output = captureProcessWrites();
    const program = new Command();
    program.exitOverride();
    registerLockfileCommands(program);

    await program.parseAsync(['node', 'test', 'lockfile', 'recompute', projectDir, '--check'], {
      from: 'node',
    });

    const after = await readFile(join(projectDir, 'abl.lock'), 'utf8');
    expect(after).toBe(before);
    expect(process.exitCode).toBe(1);
    expect(output.stderr()).toContain('abl.lock is stale:');
    expect(output.stderr()).toContain(join(projectDir, 'abl.lock'));
    expect(output.stdout()).toBe('');
  });

  it('runs the built CLI --check command against a stale exported project without writing', async () => {
    const projectDir = await makeExportedProject();
    const before = await readFile(join(projectDir, 'abl.lock'), 'utf8');
    const cliEntry = join(process.cwd(), 'dist/index.js');
    await expect(readFile(cliEntry, 'utf8')).resolves.toContain('Kore Platform CLI');

    const failure = await runCliExpectingFailure(['lockfile', 'recompute', projectDir, '--check']);
    const after = await readFile(join(projectDir, 'abl.lock'), 'utf8');

    expect(after).toBe(before);
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('abl.lock is stale:');
    expect(failure.stderr).toContain(join(projectDir, 'abl.lock'));
    expect(failure.stdout).toBe('');
  });

  it('fails closed when a lockfile entry has no source file on disk', async () => {
    const projectDir = await makeExportedProject();
    await rm(join(projectDir, 'tools/order.tools.abl'));

    await expect(recomputeAblLockfile(projectDir)).rejects.toThrow(
      'Cannot find source file for tools entry "tools/order.tools.abl"',
    );
  });

  it('repairs a null integrity field from hand-edited lockfiles', async () => {
    const projectDir = await makeExportedProject();
    const lockfile = await readLockfile(projectDir);
    await writeFile(
      join(projectDir, 'abl.lock'),
      JSON.stringify({ ...lockfile, integrity: null }, null, 2) + '\n',
    );

    await recomputeAblLockfile(projectDir);
    const repaired = await readLockfile(projectDir);

    expect(repaired.integrity).toBe(computeIntegrity(repaired));
  });

  it('repairs null source_hash fields without requiring manual hash edits', async () => {
    const projectDir = await makeExportedProject();
    const lockfile = await readLockfile(projectDir);
    await writeFile(
      join(projectDir, 'abl.lock'),
      JSON.stringify(
        {
          ...lockfile,
          agents: {
            Support: {
              ...lockfile.agents.Support,
              source_hash: null,
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    await recomputeAblLockfile(projectDir);
    const repaired = await readLockfile(projectDir);

    expect(repaired.agents.Support.source_hash).toBe(
      computeAgentSourceHash('AGENT: Support', {
        promptId: 'prompt-support',
        versionId: 'version-support',
        resolvedHash: 'prompt-hash-support',
      }),
    );
    expect(repaired.integrity).toBe(computeIntegrity(repaired));
  });

  it('falls back to plain agent content hashes when no prompt companion metadata exists', async () => {
    const projectDir = await makeExportedProject({ includePromptRef: false });

    await recomputeAblLockfile(projectDir);
    const lockfile = await readLockfile(projectDir);

    expect(lockfile.agents.Support.source_hash).toBe(computeSourceHash('AGENT: Support'));
  });

  it('rejects unsupported lockfile versions', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'abl-lockfile-recompute-'));
    tempRoots.push(projectDir);
    await writeFile(join(projectDir, 'abl.lock'), JSON.stringify({ lockfile_version: '1.0' }));

    await expect(recomputeAblLockfile(projectDir)).rejects.toThrow(
      'Only abl.lock version 2.0 is supported',
    );
  });
});

async function makeExportedProject(options: { includePromptRef?: boolean } = {}): Promise<string> {
  const includePromptRef = options.includePromptRef ?? true;
  const projectDir = await mkdtemp(join(tmpdir(), 'abl-lockfile-recompute-'));
  tempRoots.push(projectDir);
  await mkdir(join(projectDir, 'agents'), { recursive: true });
  await mkdir(join(projectDir, 'tools'), { recursive: true });
  await mkdir(join(projectDir, 'channels'), { recursive: true });
  await mkdir(join(projectDir, 'prompts'), { recursive: true });
  await writeFile(join(projectDir, 'agents/support.agent.abl'), 'AGENT: Support');
  await writeFile(join(projectDir, 'tools/order.tools.abl'), 'TOOL: OrderLookup');
  await writeFile(join(projectDir, 'channels/web-chat.channel.json'), '{"type":"web"}');
  await writeFile(
    join(projectDir, 'prompts/support_prompt.prompt.json'),
    '{"name":"Support Prompt"}',
  );
  await writeFile(
    join(projectDir, 'project.json'),
    JSON.stringify({
      layers_included: ['core', 'prompts', 'channels', 'evals'],
      agents: {
        Support: {
          path: 'agents/support.agent.abl',
          ...(includePromptRef
            ? {
                systemPromptLibraryRef: {
                  promptId: 'prompt-support',
                  versionId: 'version-support',
                  resolvedHash: 'prompt-hash-support',
                  ignoredField: 'must-not-affect-hash',
                },
              }
            : {}),
        },
      },
    }),
  );
  await writeFile(
    join(projectDir, 'abl.lock'),
    JSON.stringify(makeStaleLockfile(), null, 2) + '\n',
  );
  return projectDir;
}

async function readLockfile(projectDir: string): Promise<TestLockfileV2> {
  return JSON.parse(await readFile(join(projectDir, 'abl.lock'), 'utf8')) as TestLockfileV2;
}

function makeStaleLockfile(): TestLockfileV2 {
  return {
    lockfile_version: '2.0',
    generated_at: '2026-05-16T00:00:00.000Z',
    agents: {
      Support: {
        version: '1.0',
        source_hash: 'stale-agent',
        status: 'active',
      },
    },
    tools: {
      'tools/order.tools.abl': {
        source_hash: 'stale-tool',
      },
    },
    configs: {},
    connections: {},
    guardrails: {},
    workflows: {},
    evals: {},
    search: {},
    channels: {
      'channels/web-chat.channel.json': {
        source_hash: 'stale-channel',
      },
    },
    vocabulary: {},
    layer_hashes: {
      core: 'stale-core',
    },
    integrity: 'stale-integrity',
  };
}

function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function computeAgentSourceHash(
  dslContent: string,
  systemPromptLibraryRef: { promptId: string; versionId: string; resolvedHash?: string },
): string {
  const hashContent = stableStringifyHashPayload({
    dslContent,
    companion: {
      systemPromptLibraryRef,
      resolvedSystemPrompt: null,
    },
  });
  return computeSourceHash(hashContent);
}

function computeLayerHash(files: Map<string, string>): string {
  const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const content = sorted.map(([path, data]) => `${path}:${computeSourceHash(data)}`).join('\n');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function computeIntegrity(lockfile: TestLockfileV2): string {
  const integrityPayload = JSON.stringify({
    agents: sortedRecord(lockfile.agents),
    tools: sortedRecord(lockfile.tools),
    configs: sortedRecord(lockfile.configs),
    connections: sortedRecord(lockfile.connections),
    guardrails: sortedRecord(lockfile.guardrails),
    workflows: sortedRecord(lockfile.workflows),
    evals: sortedRecord(lockfile.evals),
    search: sortedRecord(lockfile.search),
    channels: sortedRecord(lockfile.channels),
    vocabulary: sortedRecord(lockfile.vocabulary),
    layer_hashes: sortedRecord(lockfile.layer_hashes as Record<string, string>),
  });
  return createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function stableStringifyHashPayload(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, currentValue) =>
    currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
      ? Object.fromEntries(Object.entries(currentValue as Record<string, unknown>).sort())
      : currentValue,
  );
}

function captureProcessWrites(): { stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function runCliExpectingFailure(args: string[]): Promise<{
  code: number | undefined;
  stdout: string;
  stderr: string;
}> {
  const cliEntry = join(process.cwd(), 'dist/index.js');
  try {
    await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      timeout: 5_000,
    });
  } catch (error) {
    const execError = error as ExecFileException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: typeof execError.code === 'number' ? execError.code : undefined,
      stdout: execError.stdout?.toString() ?? '',
      stderr: execError.stderr?.toString() ?? '',
    };
  }

  throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
}
