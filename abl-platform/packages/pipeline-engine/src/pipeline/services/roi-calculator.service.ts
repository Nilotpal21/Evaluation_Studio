import { createLogger } from '@abl/compiler/platform';
import type { IProjectCostConfig } from '../../schemas/project-cost-config.schema.js';

const log = createLogger('roi-calculator');

export interface ROISummary {
  monthlySavings: number;
  annualSavings: number;
  fteEquivalent: number;
  roiPercentage: number;
  budgetStatus: 'under' | 'at' | 'over';
  budgetRemaining: number;
}

export interface SimulationResult {
  currentContainment: number;
  simulatedContainment: number;
  currentMonthlySavings: number;
  simulatedMonthlySavings: number;
  additionalSavings: number;
  additionalFTEFreed: number;
}

export class ROICalculator {
  computeSavings(config: IProjectCostConfig): number {
    const aiHandled = config.totalConversationsPerMonth * config.containmentRate;
    const savings = aiHandled * (config.costPerHumanInteraction - config.costPerAIInteraction);
    return Math.round(savings * 100) / 100;
  }

  computeFTEEquivalent(config: IProjectCostConfig): number {
    const aiHandled = config.totalConversationsPerMonth * config.containmentRate;
    const workingDaysPerMonth = 22;
    return Math.round((aiHandled / (config.fteCapacityPerDay * workingDaysPerMonth)) * 100) / 100;
  }

  computeROI(config: IProjectCostConfig): number {
    const monthlySavings = this.computeSavings(config);
    const monthlyAICost =
      config.totalConversationsPerMonth * config.containmentRate * config.costPerAIInteraction;
    if (monthlyAICost === 0) return 0;
    return Math.round((monthlySavings / monthlyAICost) * 100 * 100) / 100;
  }

  computeBudgetStatus(config: IProjectCostConfig): {
    status: 'under' | 'at' | 'over';
    remaining: number;
  } {
    const totalAICost =
      config.totalConversationsPerMonth * config.containmentRate * config.costPerAIInteraction;
    const remaining = config.monthlyBudget - totalAICost;
    const status = remaining > 0 ? 'under' : remaining === 0 ? 'at' : 'over';
    return { status, remaining: Math.round(remaining * 100) / 100 };
  }

  computeSummary(config: IProjectCostConfig): ROISummary {
    const monthlySavings = this.computeSavings(config);
    const budget = this.computeBudgetStatus(config);
    log.debug('Computed ROI summary', {
      monthlySavings,
      budgetStatus: budget.status,
    });
    return {
      monthlySavings,
      annualSavings: Math.round(monthlySavings * 12 * 100) / 100,
      fteEquivalent: this.computeFTEEquivalent(config),
      roiPercentage: this.computeROI(config),
      budgetStatus: budget.status,
      budgetRemaining: budget.remaining,
    };
  }

  simulateContainmentChange(
    config: IProjectCostConfig,
    newContainmentRate: number,
  ): SimulationResult {
    const currentSavings = this.computeSavings(config);
    const simConfig = { ...config, containmentRate: newContainmentRate };
    const simSavings = this.computeSavings(simConfig as IProjectCostConfig);
    const currentFTE = this.computeFTEEquivalent(config);
    const simFTE = this.computeFTEEquivalent(simConfig as IProjectCostConfig);

    return {
      currentContainment: config.containmentRate,
      simulatedContainment: newContainmentRate,
      currentMonthlySavings: currentSavings,
      simulatedMonthlySavings: simSavings,
      additionalSavings: Math.round((simSavings - currentSavings) * 100) / 100,
      additionalFTEFreed: Math.round((simFTE - currentFTE) * 100) / 100,
    };
  }
}
