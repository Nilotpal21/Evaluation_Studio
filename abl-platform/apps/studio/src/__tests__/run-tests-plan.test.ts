import { describe, expect, it } from 'vitest';
import {
  buildCoverageExecutionPlan,
  buildTestExecutionPlan,
  COMMAND_TIMEOUT_MS,
  COMPONENT_SHARDS,
  COVERAGE_REPORT_CONFIG,
  COVERAGE_COMMAND_TIMEOUT_MS,
  SPLIT_COVERAGE_ROOT,
  SPLIT_COVERAGE_TEMP_DIR,
} from '../../run-tests-plan';

describe('buildTestExecutionPlan', () => {
  it('splits default runs into light and sharded component phases', () => {
    const plan = buildTestExecutionPlan([]);

    expect(plan.mode).toBe('split');

    if (plan.mode !== 'split') {
      return;
    }

    expect(plan.commands).toHaveLength(COMPONENT_SHARDS + 1);
    expect(plan.commands[0]).toEqual({
      allowTimeoutSuccess: false,
      args: ['vitest', 'run', '--config', 'vitest.light.config.ts', '--passWithNoTests'],
      label: 'Pure logic tests',
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    expect(plan.commands[1]).toEqual({
      allowTimeoutSuccess: false,
      args: [
        'vitest',
        'run',
        '--config',
        'vitest.unit.config.ts',
        '--passWithNoTests',
        '--shard=1/2',
      ],
      label: 'Component shard 1/2',
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    expect(plan.commands[2]).toEqual({
      allowTimeoutSuccess: false,
      args: [
        'vitest',
        'run',
        '--config',
        'vitest.unit.config.ts',
        '--passWithNoTests',
        '--shard=2/2',
      ],
      label: 'Component shard 2/2',
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  });

  it('forwards safe file filters and test-name filters to every phase', () => {
    const plan = buildTestExecutionPlan([
      'src/__tests__/trace-event-adapter.test.ts',
      '-t',
      'prefers canonical fields',
    ]);

    expect(plan.mode).toBe('split');

    if (plan.mode !== 'split') {
      return;
    }

    for (const command of plan.commands) {
      expect(command.args).toContain('src/__tests__/trace-event-adapter.test.ts');
      expect(command.args).toContain('-t');
      expect(command.args).toContain('prefers canonical fields');
    }
  });

  it('normalizes repo-root Studio path filters before splitting commands', () => {
    const plan = buildTestExecutionPlan(['apps/studio/src/__tests__/stores/']);

    expect(plan.mode).toBe('split');

    if (plan.mode !== 'split') {
      return;
    }

    for (const command of plan.commands) {
      expect(command.args).toContain('src/__tests__/stores');
      expect(command.args).not.toContain('apps/studio/src/__tests__/stores/');
    }
  });

  it('does not duplicate --passWithNoTests when the caller already forwards it', () => {
    const plan = buildTestExecutionPlan(['apps/studio/src/__tests__/stores/', '--passWithNoTests']);

    expect(plan.mode).toBe('split');

    if (plan.mode !== 'split') {
      return;
    }

    for (const command of plan.commands) {
      expect(command.args.filter((arg) => arg === '--passWithNoTests')).toHaveLength(1);
    }
  });

  it.each([
    { cliArgs: ['--coverage'] },
    { cliArgs: ['--coverage.enabled=true'] },
    { cliArgs: ['--config', 'vitest.light.config.ts'] },
    { cliArgs: ['--reporter=json'] },
    { cliArgs: ['--outputFile=report.json'] },
    { cliArgs: ['--watch'] },
  ])('delegates split-unsafe args $cliArgs to raw vitest', ({ cliArgs }) => {
    const plan = buildTestExecutionPlan(cliArgs);

    expect(plan).toEqual({
      args: ['vitest', 'run', ...cliArgs],
      mode: 'delegate',
    });
  });

  it('builds split coverage phases and a merge command', () => {
    const plan = buildCoverageExecutionPlan([]);

    expect(plan.mode).toBe('split-coverage');

    if (plan.mode !== 'split-coverage') {
      return;
    }

    expect(plan.cleanupPaths).toEqual([SPLIT_COVERAGE_ROOT, 'coverage']);
    expect(plan.reportConfigPath).toBe(COVERAGE_REPORT_CONFIG);
    expect(plan.commands).toHaveLength(COMPONENT_SHARDS + 1);
    expect(plan.commands[0]).toMatchObject({
      label: 'Pure logic tests',
      reportsDirectory: `${SPLIT_COVERAGE_TEMP_DIR}/1-pure-logic-tests`,
      timeoutMs: COVERAGE_COMMAND_TIMEOUT_MS,
      viteEnvironment: 'ssr',
    });
    expect(plan.commands[0].args).toContain('--coverage.enabled=true');
    expect(plan.commands[0].args).toContain(
      `--coverage.reportsDirectory=${SPLIT_COVERAGE_TEMP_DIR}/1-pure-logic-tests`,
    );
    expect(plan.commands[0].args).toContain('--coverage.reporter=json');
    expect(plan.commands[1]).toMatchObject({
      reportsDirectory: `${SPLIT_COVERAGE_TEMP_DIR}/2-component-shard-1-2`,
      viteEnvironment: 'client',
    });
    expect(plan.commands[1].args).toContain('--no-file-parallelism');
    expect(plan.commands[1].args).toContain('--maxWorkers=1');
  });

  it('normalizes repo-root Studio path filters before building split coverage phases', () => {
    const plan = buildCoverageExecutionPlan(['apps/studio/src/__tests__/stores/']);

    expect(plan.mode).toBe('split-coverage');

    if (plan.mode !== 'split-coverage') {
      return;
    }

    for (const command of plan.commands) {
      expect(command.args).toContain('src/__tests__/stores');
      expect(command.args).not.toContain('apps/studio/src/__tests__/stores/');
    }
  });

  it('delegates split-unsafe coverage combinations to raw vitest', () => {
    const plan = buildCoverageExecutionPlan(['--config', 'vitest.light.config.ts']);

    expect(plan).toEqual({
      args: ['vitest', 'run', '--coverage', '--config', 'vitest.light.config.ts'],
      mode: 'delegate',
    });
  });
});
