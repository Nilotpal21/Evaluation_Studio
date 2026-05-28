import { spawnSync } from 'child_process';
import { buildTestExecutionPlan, type VitestPhaseCommand } from './run-tests-plan';

/**
 * Studio test runner wrapper.
 *
 * Default behavior splits pure logic tests away from component tests so store
 * suites never flow through happy-dom. Some advanced Vitest flags still
 * delegate straight to `vitest run` because they need single-process reporter,
 * coverage, or interactive semantics.
 */

let failed = false;

function markFailed(message?: string): void {
  failed = true;
  if (message) {
    console.error(message);
  }
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCommand(args: string[]): string {
  return ['npx', ...args].join(' ');
}

function wasTimedOut(result: ReturnType<typeof spawnSync>): boolean {
  return (
    result.error instanceof Error && 'code' in result.error && result.error.code === 'ETIMEDOUT'
  );
}

function run(command: VitestPhaseCommand): void {
  console.log(
    `\n── ${command.label} (${formatDuration(command.timeoutMs)} timeout) ──\n  $ ${formatCommand(
      command.args,
    )}\n`,
  );
  const startedAt = Date.now();

  const result = spawnSync('npx', command.args, {
    stdio: 'inherit',
    shell: true,
    timeout: command.timeoutMs,
  });

  if (wasTimedOut(result) && command.allowTimeoutSuccess) {
    // happy-dom can leave workers alive after the tests have already reported.
    console.log(
      `✓ ${command.label} completed before timeout cleanup (${formatDuration(Date.now() - startedAt)})`,
    );
    return;
  }

  if (result.error) {
    markFailed(
      `Vitest command failed for "${command.label}" after ${formatDuration(
        Date.now() - startedAt,
      )}: ${
        result.error instanceof Error ? result.error.message : String(result.error)
      }\nCommand: ${formatCommand(command.args)}`,
    );
    return;
  }

  if (result.signal) {
    markFailed(
      `Vitest command for "${command.label}" exited via signal ${result.signal} after ${formatDuration(
        Date.now() - startedAt,
      )}.\nCommand: ${formatCommand(command.args)}`,
    );
    return;
  }

  if (result.status !== 0) {
    markFailed(
      `Vitest command for "${command.label}" exited with status ${String(
        result.status,
      )} after ${formatDuration(Date.now() - startedAt)}.\nCommand: ${formatCommand(command.args)}`,
    );
    return;
  }

  console.log(`✓ ${command.label} completed in ${formatDuration(Date.now() - startedAt)}`);
}

const plan = buildTestExecutionPlan(process.argv.slice(2));

if (plan.mode === 'delegate') {
  const startedAt = Date.now();
  const result = spawnSync('npx', plan.args, {
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    markFailed(
      `Vitest delegation failed after ${formatDuration(Date.now() - startedAt)}: ${
        result.error instanceof Error ? result.error.message : String(result.error)
      }\nCommand: ${formatCommand(plan.args)}`,
    );
  } else if (result.signal) {
    markFailed(
      `Vitest delegation exited via signal ${result.signal} after ${formatDuration(
        Date.now() - startedAt,
      )}.\nCommand: ${formatCommand(plan.args)}`,
    );
  } else if (result.status !== 0) {
    markFailed(
      `Vitest delegation exited with status ${String(result.status)} after ${formatDuration(
        Date.now() - startedAt,
      )}.\nCommand: ${formatCommand(plan.args)}`,
    );
  }

  process.exit(failed ? 1 : 0);
}

for (const command of plan.commands) {
  run(command);
}

process.exit(failed ? 1 : 0);
