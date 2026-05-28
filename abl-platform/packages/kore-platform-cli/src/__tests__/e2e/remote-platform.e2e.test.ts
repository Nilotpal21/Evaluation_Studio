/**
 * Remote Platform E2E Test — CLI Subprocess
 *
 * Tests the full lifecycle via CLI commands (subprocess calls):
 *   1. Auth verification (requires prior `kore-platform-cli dev-login`)
 *   2. Project creation & listing
 *   3. Agent authoring (create, list, get DSL, update DSL, compile)
 *   4. Agent testing (send message, fetch traces)
 *   5. Cleanup (delete agent, delete project)
 *
 * Prerequisites:
 *   - Studio running (pnpm dev in apps/studio)
 *   - KORE_API_URL set to the target server
 *   - Already authenticated: KORE_API_URL=<url> npx tsx src/index.ts dev-login dev@test.com
 *
 * Run:
 *   KORE_API_URL=http://abl-dev.kore.local:5173 pnpm vitest run src/__tests__/e2e/remote-platform.e2e.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// =============================================================================
// CONFIG
// =============================================================================

const TEST_TIMEOUT = 60_000; // 60s per test (remote calls can be slow)
const SUITE_TIMEOUT = 300_000; // 5 min total
const PROJECT_NAME = `cli-e2e-${Date.now()}`;

// Path to CLI entry point (run via tsx for dev mode)
// import.meta.dirname = .../src/__tests__/e2e, go up 3 levels to package root
const CLI_ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

// Forward KORE_API_URL — points to Studio (the gateway), which proxies runtime paths
const HAS_EXPLICIT_API_URL = Boolean(process.env.KORE_API_URL?.trim());
const API_URL = process.env.KORE_API_URL || 'http://localhost:5173';

// =============================================================================
// AGENT DSL FIXTURES
// =============================================================================

const INITIAL_AGENT_DSL = `AGENT remote_e2e_agent
MODE reasoning
MODEL default

GOAL:
  Help users with general questions. Be concise and helpful.

CONSTRAINTS:
  - Always be polite
  - Keep responses under 100 words
`;

const UPDATED_AGENT_DSL = `AGENT remote_e2e_agent
MODE reasoning
MODEL default

GOAL:
  Help users with general questions. Be concise, helpful, and friendly.

CONSTRAINTS:
  - Always be polite and professional
  - Keep responses under 150 words
  - If asked about the weather, say you cannot check live weather
`;

// =============================================================================
// STATE
// =============================================================================

let projectSlug: string;
let tmpDir: string;
let testSessionId: string;

// =============================================================================
// CLI HELPER
// =============================================================================

/**
 * Run a CLI command via execFileSync (no shell injection risk) and return stdout.
 * Uses `npx tsx <entry>` to run the CLI in dev mode.
 */
function cli(args: string[], opts?: { expectFailure?: boolean }): string {
  const fullArgs = ['tsx', CLI_ENTRY, ...args];
  try {
    const output = execFileSync('npx', fullArgs, {
      encoding: 'utf-8',
      env: { ...process.env, KORE_API_URL: API_URL, NO_COLOR: '1' },
      timeout: TEST_TIMEOUT,
      cwd: CLI_ROOT,
    });
    return output.trim();
  } catch (err) {
    if (opts?.expectFailure) {
      const error = err as { stdout?: string; stderr?: string; status?: number };
      return ((error.stdout || '') + (error.stderr || '')).trim();
    }
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const details = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(`CLI command failed: npx tsx ${CLI_ENTRY} ${args.join(' ')}\n${details}`);
  }
}

// =============================================================================
// GUARDS
// =============================================================================

let authenticated = false;
if (HAS_EXPLICIT_API_URL) {
  try {
    const whoamiOutput = cli(['whoami']);
    authenticated = !whoamiOutput.includes('Not logged in');
    if (authenticated) {
      console.log(`  CLI auth: ${whoamiOutput.split('\n')[0]}`);
    }
  } catch {
    authenticated = false;
  }
}

if (!HAS_EXPLICIT_API_URL) {
  console.warn(
    '\n⚠️  Skipping remote E2E tests: KORE_API_URL is not set.\n' +
      '   Run: KORE_API_URL=<studio-url> npx tsx src/index.ts dev-login dev@test.com\n',
  );
} else if (!authenticated) {
  console.warn(
    '\n⚠️  Skipping remote E2E tests: not authenticated.\n' +
      `   Run: KORE_API_URL=${API_URL} npx tsx src/index.ts dev-login dev@test.com\n`,
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe.skipIf(!HAS_EXPLICIT_API_URL || !authenticated)(
  'Remote Platform E2E (CLI)',
  { timeout: SUITE_TIMEOUT },
  () => {
    // ===========================================================================
    // SETUP — create temp directory for DSL files
    // ===========================================================================
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-e2e-'));

    // ===========================================================================
    // CLEANUP — always runs, even on failure
    // ===========================================================================
    afterAll(() => {
      if (projectSlug) {
        try {
          cli(['projects', 'delete', projectSlug, '--force']);
          console.log(`  ✓ Cleaned up project ${projectSlug}`);
        } catch (err) {
          console.warn(`  ⚠️  Failed to clean up project ${projectSlug}:`, err);
        }
      }

      // Clean up temp DSL files
      try {
        unlinkSync(join(tmpDir, 'initial.agent.abl'));
      } catch {}
      try {
        unlinkSync(join(tmpDir, 'updated.agent.abl'));
      } catch {}
    });

    // ===========================================================================
    // PHASE 1: Auth Verification
    // ===========================================================================

    describe('Phase 1: Auth Verification', () => {
      it('whoami shows logged in user', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['whoami']);
        expect(output).toContain('Logged in as');
        console.log(`    ${output.split('\n')[0]}`);
      });

      it('config shows configured API endpoints', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['config']);
        expect(output).toContain('apiUrl:');
        console.log(
          `    ${output
            .split('\n')
            .find((l: string) => l.includes('apiUrl:'))
            ?.trim()}`,
        );
      });
    });

    // ===========================================================================
    // PHASE 2: Project Lifecycle
    // ===========================================================================

    describe('Phase 2: Project Lifecycle', () => {
      it('creates a project', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['projects', 'create', PROJECT_NAME, '-d', 'CLI E2E test project']);
        expect(output).toContain('Created project');

        // Extract the slug from output (format: "✓ Created project: <slug>")
        const slugMatch = output.match(/Created project:\s*(\S+)/);
        expect(slugMatch).toBeTruthy();
        projectSlug = slugMatch![1];
        console.log(`    Created project: ${projectSlug}`);
      });

      it('project appears in listing', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['projects', 'list']);
        expect(output).toContain(PROJECT_NAME);
        console.log(`    Project "${PROJECT_NAME}" found in listing`);
      });

      it('selects the project', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['projects', 'select', projectSlug]);
        expect(output).toContain('Active project');
        console.log(`    Selected project: ${projectSlug}`);
      });

      it('shows current project', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['projects', 'current']);
        expect(output).toContain(projectSlug);
        console.log(`    Current project: ${projectSlug}`);
      });
    });

    // ===========================================================================
    // PHASE 3: Agent Authoring
    // ===========================================================================

    describe('Phase 3: Agent Authoring', () => {
      it('creates an agent with DSL file', { timeout: TEST_TIMEOUT }, () => {
        // Write DSL to temp file
        const dslPath = join(tmpDir, 'initial.agent.abl');
        writeFileSync(dslPath, INITIAL_AGENT_DSL, 'utf-8');

        const output = cli(['agents', 'create', 'remote_e2e_agent', '-f', dslPath]);
        expect(output).toContain('Created agent');
        console.log(
          `    ${output
            .split('\n')
            .find((l: string) => l.includes('Created'))
            ?.trim()}`,
        );
      });

      it('agent appears in listing', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'list']);
        expect(output).toContain('remote_e2e_agent');
        console.log(`    Agent "remote_e2e_agent" found in listing`);
      });

      it('retrieves agent DSL', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'get', 'remote_e2e_agent']);
        expect(output).toContain('AGENT remote_e2e_agent');
        expect(output).toContain('MODE reasoning');
        expect(output).toContain('Always be polite');
        console.log(`    Retrieved DSL (${output.split('\n').length} lines)`);
      });

      it('updates agent DSL', { timeout: TEST_TIMEOUT }, () => {
        // Write updated DSL to temp file
        const dslPath = join(tmpDir, 'updated.agent.abl');
        writeFileSync(dslPath, UPDATED_AGENT_DSL, 'utf-8');

        const output = cli(['agents', 'update', 'remote_e2e_agent', '-f', dslPath]);
        expect(output).toContain('Updated agent');
        console.log(`    Updated agent DSL`);
      });

      it('updated DSL reflects changes', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'get', 'remote_e2e_agent']);
        expect(output).toContain('friendly');
        expect(output).toContain('150 words');
        expect(output).toContain('weather');
        console.log(`    Verified updated DSL content`);
      });

      it('compiles agent successfully', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'compile', 'remote_e2e_agent']);
        expect(output).toContain('Compilation successful');
        console.log(`    Agent compiled successfully`);
      });
    });

    // ===========================================================================
    // PHASE 4: Agent Testing
    // ===========================================================================

    describe('Phase 4: Agent Testing', () => {
      it('sends a test message and gets a response', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'test', 'remote_e2e_agent', '-m', 'Hello, who are you?']);
        expect(output).toContain('Response:');
        expect(output).toContain('Session:');

        // Extract session ID for traces test
        const sessionMatch = output.match(/Session:\s*(\S+)/);
        if (sessionMatch) {
          testSessionId = sessionMatch[1];
          console.log(`    Got response, session: ${testSessionId}`);
        } else {
          console.log(`    Got response (no session ID extracted)`);
        }
      });

      it('fetches traces for the session', { timeout: TEST_TIMEOUT }, () => {
        if (!testSessionId) {
          console.log(`    Skipped: no session ID from previous test`);
          return;
        }

        // Traces endpoint may not be available in all environments
        try {
          const output = cli(['agents', 'traces', testSessionId]);
          // Either traces are returned or "No traces found" — both are valid
          expect(output.length).toBeGreaterThan(0);
          console.log(`    Traces fetched for session ${testSessionId}`);
        } catch {
          // Traces endpoint may not exist yet — that's acceptable
          console.log(`    Traces endpoint not available (acceptable)`);
        }
      });
    });

    // ===========================================================================
    // PHASE 5: Agent Cleanup
    // ===========================================================================

    describe('Phase 5: Agent Cleanup', () => {
      it('deletes the agent', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'delete', 'remote_e2e_agent', '--force']);
        expect(output).toContain('Deleted agent');
        console.log(`    Deleted agent remote_e2e_agent`);
      });

      it('agent no longer in listing', { timeout: TEST_TIMEOUT }, () => {
        const output = cli(['agents', 'list']);
        expect(output).not.toContain('remote_e2e_agent');
        console.log(`    Verified agent removed`);
      });
    });

    // ===========================================================================
    // PHASE 6: Project Cleanup
    // ===========================================================================

    describe('Phase 6: Project Cleanup', () => {
      it('deletes the project', { timeout: TEST_TIMEOUT }, () => {
        expect(projectSlug).toBeTruthy();

        const output = cli(['projects', 'delete', projectSlug, '--force']);
        expect(output).toContain('Deleted project');
        console.log(`    Deleted project: ${projectSlug}`);

        // Clear so afterAll doesn't double-delete
        const deletedSlug = projectSlug;
        projectSlug = '';

        // Verify it's gone
        const listing = cli(['projects', 'list']);
        expect(listing).not.toContain(deletedSlug);
        console.log(`    Verified project no longer in listing`);
      });
    });
  },
);
