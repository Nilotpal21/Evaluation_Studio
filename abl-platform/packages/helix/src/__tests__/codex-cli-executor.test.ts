import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexCliExecutor,
  detectCodexTransportFailure,
  isBuildOrTestCommand,
  resolveInactivityStallThresholdMs,
  resolveExecutionTimeoutMs,
} from '../models/codex-cli-executor.js';

describe('CodexCliExecutor', () => {
  let tempDir: string | null = null;
  const originalPath = process.env.PATH;
  const originalHelixCodexPath = process.env.HELIX_CODEX_PATH;
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    process.env.PATH = originalPath;
    restoreEnv('HELIX_CODEX_PATH', originalHelixCodexPath);
    restoreEnv('CODEX_HOME', originalCodexHome);
  });

  it('passes output schemas through codex exec and captures the final message', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const argsFile = join(tempDir, 'argv.json');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: 'extra-high',
        maxTurns: 1,
        env: {
          FAKE_CODEX_ARGS_FILE: argsFile,
        },
      },
      ['Read', 'Grep'],
      undefined,
      { id: 'analysis-report' },
    );

    const argv = JSON.parse(await readFile(argsFile, 'utf-8')) as string[];

    expect(argv).toContain('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--output-schema');
    expect(result.error).toBeUndefined();
    expect(result.model).toBe('gpt-5.5');
    expect(result.output).toContain('"summary":"schema:helix.analysis-report"');
  });

  it('injects configured MCP servers into codex exec via CLI config overrides', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const argsFile = join(tempDir, 'argv.json');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir, {
      helix: {
        command: 'pnpm',
        args: ['exec', 'tsx', 'packages/helix/src/mcp-cli.ts', '--workdir', '.'],
      },
    });
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
        env: {
          FAKE_CODEX_ARGS_FILE: argsFile,
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const argv = JSON.parse(await readFile(argsFile, 'utf-8')) as string[];

    expect(result.error).toBeUndefined();
    expect(argv).toContain('mcp_servers.helix.command="pnpm"');
    expect(argv).toContain(
      'mcp_servers.helix.args=["exec","tsx","packages/helix/src/mcp-cli.ts","--workdir","."]',
    );
  });

  it('disables plugins for replay worktree Codex runs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const argsFile = join(tempDir, 'argv.json');
    const sourceDir = join(tempDir, 'source-checkout');
    const worktreeDir = join(tempDir, 'replay-worktree');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(
      fakeCodexPath,
      worktreeDir,
      {},
      {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
      },
    );

    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
        env: {
          FAKE_CODEX_ARGS_FILE: argsFile,
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const argv = JSON.parse(await readFile(argsFile, 'utf-8')) as string[];

    expect(result.error).toBeUndefined();
    expect(argv).toContain('--disable');
    expect(argv).toContain('plugins');
  });

  it('prefers the explicit output artifact over concatenated streamed turns', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: 'extra-high',
        maxTurns: 2,
        env: {
          FAKE_CODEX_EXTRA_MESSAGE: 'true',
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toBe(
      '{"summary":"schema:helix.analysis-report","findings":[],"decisions":[]}',
    );
    expect(result.output).not.toContain('intermediate reasoning');
  });

  it('prefers explicit deadlines over maxTurns heuristics', () => {
    expect(resolveExecutionTimeoutMs(45_000, 1)).toBe(45_000);
    expect(resolveExecutionTimeoutMs(undefined, 2)).toBe(120_000);
    expect(resolveExecutionTimeoutMs(undefined, undefined)).toBe(30 * 60_000);
  });

  it('caps inactivity stall thresholds at the executor default even when stages allow longer runtimes', () => {
    expect(resolveInactivityStallThresholdMs(undefined)).toBe(10 * 60_000);
    expect(resolveInactivityStallThresholdMs(90 * 60_000)).toBe(10 * 60_000);
    expect(resolveInactivityStallThresholdMs(45_000)).toBe(45_000);
    expect(resolveInactivityStallThresholdMs(undefined, 75_000)).toBe(75_000);
    expect(resolveInactivityStallThresholdMs(90 * 60_000, 75_000)).toBe(75_000);
  });

  it('treats rg no-match completions as progress instead of errors', () => {
    const executor = new CodexCliExecutor('codex', process.cwd()) as unknown as {
      processJsonLine: (
        line: string,
        agentMessages: string[],
        onTurn: () => void,
        onStream?: (event: { type: string; message: string }) => void,
      ) => void;
    };

    const events: Array<{ type: string; message: string }> = [];
    executor.processJsonLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command:
            '/bin/bash -lc \'rg -n "logAuditEvent|AuditActions|audit" apps/studio/src/app/api/projects/[id]/members/route.ts apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts\'',
          exit_code: 1,
          aggregated_output: '',
        },
      }),
      [],
      () => undefined,
      (event) => events.push(event),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        message: expect.stringContaining('Command no matches'),
      }),
    ]);
  });

  it('adds workspace-safe execution guidance to the codex prompt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const promptFile = join(tempDir, 'prompt.txt');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Write a failing test for the scoped bug.',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: 'high',
        permissionMode: 'acceptEdits',
        maxTurns: 1,
        env: {
          FAKE_CODEX_PROMPT_FILE: promptFile,
        },
      },
      ['Read', 'Write', 'Edit', 'Bash'],
      undefined,
      { id: 'analysis-report' },
    );

    const prompt = await readFile(promptFile, 'utf-8');

    expect(result.error).toBeUndefined();
    expect(prompt).toContain('## Workspace Rules');
    expect(prompt).toContain('Edit files directly inside the current workspace');
    expect(prompt).toContain('Do not use heredocs (`<<EOF`)');
    expect(prompt).toContain('Prefer narrow package-local build and test commands');
    expect(prompt).not.toContain('This run is read-only.');
  });

  it('rewrites source-checkout absolute paths to the execution worktree in prompts', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const promptFile = join(tempDir, 'prompt.txt');
    const sourceDir = join(tempDir, 'source-checkout');
    const worktreeDir = join(tempDir, 'replay-worktree');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(
      fakeCodexPath,
      worktreeDir,
      {},
      {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
      },
    );

    const sourcePath = `${sourceDir}/apps/studio/src/app/api/projects/[id]/members/route.ts`;
    const result = await executor.execute(
      `Inspect ${sourcePath} and stay inside the current replay workspace.`,
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: 'high',
        permissionMode: 'acceptEdits',
        maxTurns: 1,
        env: {
          FAKE_CODEX_PROMPT_FILE: promptFile,
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const prompt = await readFile(promptFile, 'utf-8');

    expect(result.error).toBeUndefined();
    expect(prompt).not.toContain(sourcePath);
    expect(prompt).toContain(
      `${worktreeDir}/apps/studio/src/app/api/projects/[id]/members/route.ts`,
    );
  });

  it('blocks Codex shell commands that drift into the source checkout during replay runs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-source-leak.mjs');
    const sourceDir = join(tempDir, 'source-checkout');
    const worktreeDir = join(tempDir, 'replay-worktree');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(fakeCodexPath, buildFakeCodexWithSourceLeakScript(sourceDir), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const streamEvents: Array<{ type: string; message: string }> = [];
    const executor = new CodexCliExecutor(
      fakeCodexPath,
      worktreeDir,
      {},
      {
        mode: 'git-worktree',
        sourceWorkDir: sourceDir,
        worktreeDir,
      },
    );

    const result = await executor.execute(
      'Stay in the replay worktree and synthesize from the seam evidence.',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 2,
      },
      ['Read', 'Bash'],
      (event) => streamEvents.push({ type: event.type, message: event.message }),
      { id: 'analysis-report' },
      8_000,
    );

    expect(result.error).toContain('workspace guard blocked Codex');
    expect(streamEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('workspace guard blocked Codex'),
        }),
      ]),
    );
  });

  it('classifies transport outages after Codex exits without recovering from HTTP fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-transport.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexWithTransportFailureScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
      30_000,
    );

    expect(result.error).toContain('Codex model transport unavailable');
    expect(result.turnsUsed).toBe(0);
  });

  it('allows Codex to recover after websocket lookup noise and HTTP fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-transport-recovering.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexWithRecoveringTransportScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
      30_000,
    );

    expect(result.error).toBeUndefined();
    expect(result.turnsUsed).toBe(1);
    expect(result.output).toContain('recovered after HTTP fallback');
  });

  it('detects DNS-style Codex transport failures from stderr output', () => {
    const error = detectCodexTransportFailure(
      [
        'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: failed to lookup address information: nodename nor servname provided, or not known, url: wss://api.openai.com/v1/responses',
        'WARN codex_core::client: falling back to HTTP',
      ].join('\n'),
    );

    expect(error).toContain('Codex model transport unavailable');
    expect(error).toContain('api.openai.com');
    expect(error).toContain('startup connection');
  });

  it('compacts oversized prompts below the Codex input limit before spawning', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const promptFile = join(tempDir, 'prompt.txt');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const oversizedPrompt = [
      'Audit the scoped files and return a structured report.',
      '',
      '## Repository Instructions',
      'CRITICAL: Follow repo rules first.',
      ...Array.from(
        { length: 50_000 },
        (_, index) => `- instruction ${index + 1}: keep invariants stable`,
      ),
      '',
      '## Scoped Code Map',
      ...Array.from(
        { length: 60_000 },
        (_, index) =>
          `- packages/huge-scope/src/file-${index + 1}.ts | exports: feature${index + 1} | dependents: consumer${index + 1}`,
      ),
      '',
      '## Structured Output Contract',
      'Return ONLY a JSON object.',
    ].join('\n');

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      oversizedPrompt,
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        effort: 'extra-high',
        maxTurns: 1,
        env: {
          FAKE_CODEX_PROMPT_FILE: promptFile,
        },
      },
      ['Read', 'Grep'],
      undefined,
      { id: 'analysis-report' },
    );

    const compactedPrompt = await readFile(promptFile, 'utf-8');

    expect(result.error).toBeUndefined();
    expect(Buffer.byteLength(compactedPrompt, 'utf8')).toBeLessThanOrEqual(900_000);
    expect(compactedPrompt).toContain('HELIX compacted');
    expect(compactedPrompt).toContain('## Structured Output Contract');
  });

  it('resolves codex via HELIX_CODEX_PATH when PATH does not include codex', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    process.env.PATH = '/usr/bin:/bin';
    process.env.HELIX_CODEX_PATH = fakeCodexPath;

    const executor = new CodexCliExecutor('codex', tempDir);
    expect(await executor.isAvailable()).toBe(true);

    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('"summary":"schema:helix.analysis-report"');
  });

  it('runs codex with a writable managed CODEX_HOME seeded from the inherited auth home', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-test-'));
    const fakeCodexPath = join(tempDir, 'fake-codex.mjs');
    const envFile = join(tempDir, 'env.json');
    const sourceCodexHome = join(tempDir, 'source-codex-home');

    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"api_key":"test-key"}\n', 'utf-8');
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf-8');
    await writeFile(join(sourceCodexHome, 'installation_id'), 'installation-test\n', 'utf-8');
    await writeFile(join(sourceCodexHome, '.codex-global-state.json'), '{"threads":[]}\n', 'utf-8');
    process.env.CODEX_HOME = sourceCodexHome;

    await writeFile(fakeCodexPath, buildFakeCodexScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Return a structured analysis report',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 1,
        env: {
          FAKE_CODEX_ENV_FILE: envFile,
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const observedEnv = JSON.parse(await readFile(envFile, 'utf-8')) as {
      codexHome: string;
      hasSessionsDir: boolean;
      hasShellSnapshotsDir: boolean;
      authJson: string | null;
      configToml: string | null;
      installationId: string | null;
      globalState: string | null;
    };

    expect(result.error).toBeUndefined();
    expect(observedEnv.codexHome).not.toBe(sourceCodexHome);
    expect(observedEnv.codexHome).toContain('codex-home');
    expect(observedEnv.hasSessionsDir).toBe(true);
    expect(observedEnv.hasShellSnapshotsDir).toBe(true);
    expect(observedEnv.authJson).toContain('test-key');
    expect(observedEnv.configToml).toContain('gpt-5.5');
    expect(observedEnv.installationId?.trim()).toBe('installation-test');
    expect(observedEnv.globalState).toContain('"threads":[]');
  });
});

describe('isBuildOrTestCommand', () => {
  it.each([
    'pnpm build',
    'pnpm test',
    'pnpm run build',
    'pnpm run test',
    'pnpm --filter=@agent-platform/studio build',
    'pnpm --dir apps/studio test',
    'pnpm --filter ./ exec vitest run',
    'npm test',
    'npm run build',
    'yarn build',
    'yarn test',
    'turbo build --filter=@agent-platform/helix',
    'next build',
    'tsc --noEmit',
    'tsc',
    'vitest run src/__tests__/foo.test.ts',
    'npx vitest run --config vitest.node.config.ts src/__tests__/bar.test.ts',
    'jest --ci',
    'prettier --check .',
    'npx prettier --write src/',
    'eslint src/',
    'cargo build',
    'cargo test',
    'go build ./...',
    'go test ./...',
    'make build',
    'make test',
    'playwright test e2e/sdk-chat.spec.ts',
    'npx playwright test --config=e2e-playwright.config.ts',
    'pnpm --dir apps/studio exec playwright test e2e/sdk-preview-share.spec.ts --config=e2e-playwright.config.ts',
    'SDK_BROWSER_E2E_ISOLATED=true SDK_BROWSER_E2E_STRICT=true pnpm --dir apps/studio exec playwright test e2e/sdk-chat.spec.ts',
    'NODE_ENV=test pnpm test',
    'CI=true pnpm build',
  ])('recognizes build/test command: %s', (cmd) => {
    expect(isBuildOrTestCommand(cmd)).toBe(true);
  });

  it.each([
    'pnpm install',
    'pnpm add lodash',
    'npm install',
    'echo "hello"',
    'git status',
    'git diff --name-only HEAD',
    'ls -la',
    'cat package.json',
    'node -e "console.log(1)"',
    'rm -rf dist',
    'mkdir -p out',
    'rg -n "pattern" src/',
    'sed -n "1,10p" file.ts',
    'curl http://localhost:3000',
  ])('rejects non-build command: %s', (cmd) => {
    expect(isBuildOrTestCommand(cmd)).toBe(false);
  });

  it('strips shell wrappers before matching', () => {
    expect(isBuildOrTestCommand('/bin/bash -lc "pnpm build --filter=@agent-platform/studio"')).toBe(
      true,
    );
    expect(isBuildOrTestCommand("/bin/sh -c 'tsc --noEmit'")).toBe(true);
    expect(isBuildOrTestCommand('/bin/bash -lc "git status"')).toBe(false);
  });
});

describe('build command diagnostics', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('logs build command diagnostics without extending timeout', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-bte-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-build.mjs');

    // This fake codex emits:
    // 1. A build command started event
    // 2. Sleeps 2s (simulating build time)
    // 3. A build command completed event
    // 4. A turn message + output file
    //
    // Stall detection keeps the process alive because stdout events
    // reset lastActivityTime. Build commands are logged diagnostically.
    await writeFile(fakeCodexPath, buildFakeCodexWithBuildScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const streamEvents: Array<{ type: string; message: string }> = [];
    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Run a build and return results',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 2,
      },
      ['Read', 'Bash'],
      (event) => streamEvents.push({ type: event.type, message: event.message }),
      { id: 'analysis-report' },
      6_000,
    );

    expect(result.error).toBeUndefined();
    expect(result.timedOut).not.toBe(true);
    expect(result.output).toContain('"summary"');

    const buildEvent = streamEvents.find((e) => e.message.includes('Build/test completed'));
    expect(buildEvent).toBeDefined();
    expect(buildEvent!.message).toMatch(/\+\d+s for/);
  });

  it('does not extend timeout for non-build commands', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-bte-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-nobuild.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexWithNonBuildScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const streamEvents: Array<{ type: string; message: string }> = [];
    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Run a git status and return results',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 2,
      },
      ['Read', 'Bash'],
      (event) => streamEvents.push({ type: event.type, message: event.message }),
      { id: 'analysis-report' },
      8_000,
    );

    expect(result.error).toBeUndefined();

    const exclusionEvent = streamEvents.find((e) => e.message.includes('Build-time exclusion'));
    expect(exclusionEvent).toBeUndefined();
  });

  it('warns and stops repeated shell exploration once the HELIX target turn budget is exceeded', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-codex-bte-'));
    const fakeCodexPath = join(tempDir, 'fake-codex-repeat.mjs');

    await writeFile(fakeCodexPath, buildFakeCodexWithRepeatedExplorationScript(), 'utf-8');
    await chmod(fakeCodexPath, 0o755);

    const streamEvents: Array<{ type: string; message: string }> = [];
    const executor = new CodexCliExecutor(fakeCodexPath, tempDir);
    const result = await executor.execute(
      'Implement the slice quickly.',
      {
        engine: 'codex-cli',
        model: 'gpt-5.5',
        maxTurns: 20,
        efficiencyBudget: {
          targetTurns: 3,
          explorationTurns: 1,
        },
      },
      ['Read', 'Bash'],
      (event) => streamEvents.push({ type: event.type, message: event.message }),
      { id: 'analysis-report' },
      8_000,
    );

    expect(result.error).toContain('repeated the shell exploration command');
    expect(streamEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('repeated shell exploration command'),
        }),
      ]),
    );
  });
});

function buildFakeCodexWithBuildScript(): string {
  return `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
const schemaIndex = args.indexOf('--output-schema');
const schemaFile = schemaIndex >= 0 ? args[schemaIndex + 1] : null;

// Emit a build command started
process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: {
    type: 'command_execution',
    command: '/bin/bash -lc "pnpm build --filter=@agent-platform/studio"',
  },
}) + '\\n');

// Simulate build taking 2 seconds
await new Promise((r) => setTimeout(r, 2000));

// Emit build command completed
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: '/bin/bash -lc "pnpm build --filter=@agent-platform/studio"',
    exit_code: 0,
    aggregated_output: 'Build succeeded',
  },
}) + '\\n');

const payload = JSON.stringify({
  summary: 'build completed',
  findings: [],
  decisions: [],
});

if (outputFile) writeFileSync(outputFile, payload);
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: payload },
}) + '\\n');
`;
}

function buildFakeCodexWithNonBuildScript(): string {
  return `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
const schemaIndex = args.indexOf('--output-schema');
const schemaFile = schemaIndex >= 0 ? args[schemaIndex + 1] : null;

// Emit a non-build command
process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: {
    type: 'command_execution',
    command: 'git status --short',
  },
}) + '\\n');

await new Promise((r) => setTimeout(r, 100));

process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: 'git status --short',
    exit_code: 0,
    aggregated_output: 'M file.ts',
  },
}) + '\\n');

const payload = JSON.stringify({
  summary: 'done',
  findings: [],
  decisions: [],
});

if (outputFile) writeFileSync(outputFile, payload);
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: payload },
}) + '\\n');
`;
}

function buildFakeCodexWithRepeatedExplorationScript(): string {
  return `#!${process.execPath}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({
    summary: 'partial output before HELIX efficiency stop',
    findings: [],
    decisions: [],
  }));
}

for (let turn = 1; turn <= 3; turn += 1) {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: \`turn \${turn}\`,
    },
  }) + '\\n');

  process.stdout.write(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'git status --short',
    },
  }) + '\\n');

  await new Promise((resolve) => setTimeout(resolve, 25));

  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'git status --short',
      exit_code: 0,
      aggregated_output: ' M packages/helix/src/pipeline/pipeline-engine.ts',
    },
  }) + '\\n');
}

await new Promise((resolve) => setTimeout(resolve, 500));
`;
}

function buildFakeCodexWithSourceLeakScript(sourceDir: string): string {
  const sourcePath = `${sourceDir}/apps/studio/src/repos/project-repo.ts`;

  return `#!${process.execPath}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({
    summary: 'partial output before workspace guard stop',
    findings: [],
    decisions: [],
  }));
}

process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: {
    type: 'command_execution',
    command: ${JSON.stringify(`/bin/bash -lc "test -f ${sourcePath}"`)},
  },
}) + '\\n');

await new Promise((resolve) => setTimeout(resolve, 250));
`;
}

function buildFakeCodexWithTransportFailureScript(): string {
  return `#!${process.execPath}
console.error('2026-04-17T18:21:25.833736Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: failed to lookup address information: nodename nor servname provided, or not known, url: wss://api.openai.com/v1/responses');
console.error('2026-04-17T18:21:31.727678Z  WARN codex_core::client: falling back to HTTP');
process.exit(1);
`;
}

function buildFakeCodexWithRecoveringTransportScript(): string {
  return `#!${process.execPath}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

console.error('2026-04-17T18:21:25.833736Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: failed to lookup address information: nodename nor servname provided, or not known, url: wss://api.openai.com/v1/responses');
console.error('2026-04-17T18:21:31.727678Z  WARN codex_core::client: falling back to HTTP');

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({
    summary: 'recovered after HTTP fallback',
    findings: [],
    decisions: [],
  }));
}

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-transport-recovered' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'agent_message',
    text: JSON.stringify({
      summary: 'recovered after HTTP fallback',
      findings: [],
      decisions: [],
    }),
  },
}) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`;
}

function buildFakeCodexScript(): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argsFile = process.env.FAKE_CODEX_ARGS_FILE;
if (argsFile) {
  writeFileSync(argsFile, JSON.stringify(args, null, 2));
}
const promptFile = process.env.FAKE_CODEX_PROMPT_FILE;
if (promptFile) {
  const lastArg = args.at(-1) ?? '';
  const prompt = lastArg === '-' ? readFileSync(0, 'utf-8') : lastArg;
  writeFileSync(promptFile, prompt);
}
const envFile = process.env.FAKE_CODEX_ENV_FILE;
if (envFile) {
  const codexHome = process.env.CODEX_HOME ?? '';
  const readOptional = (path) => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  };
  writeFileSync(
    envFile,
    JSON.stringify(
      {
        codexHome,
        hasSessionsDir: codexHome ? existsSync(join(codexHome, 'sessions')) : false,
        hasShellSnapshotsDir: codexHome ? existsSync(join(codexHome, 'shell_snapshots')) : false,
        authJson: codexHome ? readOptional(join(codexHome, 'auth.json')) : null,
        configToml: codexHome ? readOptional(join(codexHome, 'config.toml')) : null,
        installationId: codexHome ? readOptional(join(codexHome, 'installation_id')) : null,
        globalState: codexHome ? readOptional(join(codexHome, '.codex-global-state.json')) : null,
      },
      null,
      2,
    ),
  );
}

const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
const schemaIndex = args.indexOf('--output-schema');
const schemaFile = schemaIndex >= 0 ? args[schemaIndex + 1] : null;

if (!outputFile || !schemaFile) {
  console.error('missing output-schema arguments');
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaFile, 'utf-8'));
const payload = JSON.stringify({
  summary: \`schema:\${schema.$id}\`,
  findings: [],
  decisions: [],
});

writeFileSync(outputFile, payload);
if (process.env.FAKE_CODEX_EXTRA_MESSAGE === 'true') {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'intermediate reasoning that should not replace the final artifact',
    },
  }) + '\\n');
}
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: payload,
  },
}) + '\\n');
`;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
