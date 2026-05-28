/**
 * Sizing Benchmark Command Registration Tests
 *
 * Tests that the benchmark commands are properly registered on the
 * Commander program. Does not test execution (that requires real infra).
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerBenchmarkCommands } from '../../commands/sizing-benchmark.js';

function findCommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((c) => c.name() === name);
}

describe('registerBenchmarkCommands', () => {
  it('should register the "benchmark" subcommand', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('saturation');
  });

  it('should register the "benchmark-service" subcommand', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark-service');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('single service');
  });

  it('should register the "calibration-merge" subcommand', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'calibration-merge');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Merge');
  });

  it('benchmark command should have required --tier option', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark')!;
    const tierOpt = cmd.options.find((o) => o.long === '--tier');
    expect(tierOpt).toBeDefined();
    expect(tierOpt!.mandatory).toBe(true);
  });

  it('benchmark command should have required --output-calibration option', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark')!;
    const opt = cmd.options.find((o) => o.long === '--output-calibration');
    expect(opt).toBeDefined();
    expect(opt!.mandatory).toBe(true);
  });

  it('benchmark command should have optional --dry-run flag', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark')!;
    const opt = cmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
  });

  it('benchmark command should have optional --services flag', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark')!;
    const opt = cmd.options.find((o) => o.long === '--services');
    expect(opt).toBeDefined();
  });

  it('benchmark-service command should have required --service option', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'benchmark-service')!;
    const opt = cmd.options.find((o) => o.long === '--service');
    expect(opt).toBeDefined();
    expect(opt!.mandatory).toBe(true);
  });

  it('calibration-merge command should have required --inputs and --output options', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    const cmd = findCommand(sizing, 'calibration-merge')!;
    const inputsOpt = cmd.options.find((o) => o.long === '--inputs');
    const outputOpt = cmd.options.find((o) => o.long === '--output');
    expect(inputsOpt).toBeDefined();
    expect(inputsOpt!.mandatory).toBe(true);
    expect(outputOpt).toBeDefined();
    expect(outputOpt!.mandatory).toBe(true);
  });

  it('should register all 10 subcommands', () => {
    const sizing = new Command('sizing');
    registerBenchmarkCommands(sizing);

    expect(sizing.commands).toHaveLength(10);
  });
});
