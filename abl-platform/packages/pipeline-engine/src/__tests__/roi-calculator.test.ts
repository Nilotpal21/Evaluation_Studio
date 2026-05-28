import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ROICalculator } = await import('../pipeline/services/roi-calculator.service.js');

import type { IProjectCostConfig } from '../schemas/project-cost-config.schema.js';

function makeConfig(overrides?: Partial<IProjectCostConfig>): IProjectCostConfig {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    costPerHumanInteraction: 5.0,
    costPerAIInteraction: 0.15,
    fteCapacityPerDay: 40,
    fteCostPerYear: 55000,
    monthlyBudget: 50000,
    containmentRate: 0.72,
    totalConversationsPerMonth: 100000,
    createdBy: 'user-1',
    ...overrides,
  } as IProjectCostConfig;
}

describe('ROICalculator', () => {
  const calc = new ROICalculator();

  test('computes correct savings: 100K convos * 0.72 * ($5.00 - $0.15) = $349,272', () => {
    const config = makeConfig();
    const savings = calc.computeSavings(config);
    // 100000 * 0.72 = 72000 AI-handled
    // 72000 * (5.00 - 0.15) = 72000 * 4.85 = 349200
    expect(savings).toBe(349200);
  });

  test('computes FTE equivalent: 72K AI-handled / (40 * 22) = 81.82', () => {
    const config = makeConfig();
    const fte = calc.computeFTEEquivalent(config);
    // 72000 / (40 * 22) = 72000 / 880 = 81.818181...
    expect(fte).toBe(81.82);
  });

  test('computes ROI percentage', () => {
    const config = makeConfig();
    const roi = calc.computeROI(config);
    // monthlySavings = 349200
    // monthlyAICost = 100000 * 0.72 * 0.15 = 10800
    // ROI = (349200 / 10800) * 100 = 3233.33...
    expect(roi).toBe(3233.33);
  });

  test('budget under: within budget', () => {
    const config = makeConfig({ monthlyBudget: 50000 });
    const budget = calc.computeBudgetStatus(config);
    // totalAICost = 100000 * 0.72 * 0.15 = 10800
    // remaining = 50000 - 10800 = 39200
    expect(budget.status).toBe('under');
    expect(budget.remaining).toBe(39200);
  });

  test('budget over: exceeds budget', () => {
    const config = makeConfig({ monthlyBudget: 5000 });
    const budget = calc.computeBudgetStatus(config);
    // totalAICost = 10800
    // remaining = 5000 - 10800 = -5800
    expect(budget.status).toBe('over');
    expect(budget.remaining).toBe(-5800);
  });

  test('simulation: increasing containment from 0.72 to 0.85 yields more savings', () => {
    const config = makeConfig();
    const result = calc.simulateContainmentChange(config, 0.85);

    expect(result.currentContainment).toBe(0.72);
    expect(result.simulatedContainment).toBe(0.85);

    // current: 100000 * 0.72 * 4.85 = 349200
    expect(result.currentMonthlySavings).toBe(349200);

    // simulated: 100000 * 0.85 * 4.85 = 412250
    expect(result.simulatedMonthlySavings).toBe(412250);

    // additional: 412250 - 349200 = 63050
    expect(result.additionalSavings).toBe(63050);

    // additionalFTE: (85000/880) - (72000/880) = 96.59 - 81.82 = 14.77
    expect(result.additionalFTEFreed).toBe(14.77);
  });

  test('computeSummary returns complete ROI summary', () => {
    const config = makeConfig();
    const summary = calc.computeSummary(config);

    expect(summary.monthlySavings).toBe(349200);
    expect(summary.annualSavings).toBe(4190400);
    expect(summary.fteEquivalent).toBe(81.82);
    expect(summary.roiPercentage).toBe(3233.33);
    expect(summary.budgetStatus).toBe('under');
    expect(summary.budgetRemaining).toBe(39200);
  });

  test('computeROI returns 0 when AI cost is zero', () => {
    const config = makeConfig({ containmentRate: 0 });
    const roi = calc.computeROI(config);
    expect(roi).toBe(0);
  });
});
