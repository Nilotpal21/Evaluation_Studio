/**
 * Org Profile Generator Benchmark Tests
 *
 * Tests the OrgProfileGenerator against the benchmark dataset to measure:
 * 1. Accuracy: How well the generator extracts organization details
 * 2. Performance: Latency and cost per mode
 * 3. Reliability: Success rate by mode
 *
 * Task #18: RFC-001 Phase 2
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createOrgProfileGenerator } from '../services/org-profile-generator.service.js';
import type { OrgProfile } from '../schemas/org-profile.schema.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const BENCHMARK_DIR = path.join(__dirname, 'fixtures', 'benchmark-org-profiles');
const TENANT_ID = 'benchmark-test-tenant';
const INDEX_ID = 'benchmark-test-index';

// Skip if no LLM credentials (CI environment) or no MONGODB_URI (needs real DB for credential lookup)
const SKIP_LLM_TESTS =
  (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) || !process.env.MONGODB_URI;

interface BenchmarkResult {
  profileName: string;
  mode: 'url' | 'name-industry' | 'paragraph';
  success: boolean;
  durationMs: number;
  cost: number;
  generated?: OrgProfile;
  expected: OrgProfile;
  error?: string;
  qualityMetrics?: {
    orgNameMatch: boolean;
    industryMatch: boolean;
    keyTermsOverlap: number; // % of expected terms found
    acronymsOverlap: number; // % of expected acronyms found
  };
}

interface BenchmarkSummary {
  totalTests: number;
  successCount: number;
  successRate: number;
  avgDurationMs: number;
  avgCost: number;
  totalCost: number;
  byMode: {
    [mode: string]: {
      total: number;
      success: number;
      successRate: number;
      avgDuration: number;
      avgCost: number;
    };
  };
  qualityAverages: {
    orgNameAccuracy: number;
    industryAccuracy: number;
    avgKeyTermsOverlap: number;
    avgAcronymsOverlap: number;
  };
}

/**
 * Load all benchmark profiles from fixtures
 */
async function loadBenchmarkProfiles(): Promise<Record<string, OrgProfile>> {
  const files = await fs.readdir(BENCHMARK_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  const profiles: Record<string, OrgProfile> = {};

  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(BENCHMARK_DIR, file), 'utf-8');
    const profile = JSON.parse(content) as OrgProfile;
    const name = file.replace('.json', '');
    profiles[name] = profile;
  }

  return profiles;
}

/**
 * Create description paragraph from profile (for paragraph mode testing)
 */
function createDescriptionParagraph(profile: OrgProfile): string {
  const keyTermsStr = profile.keyTerms.slice(0, 5).join(', ');
  return `${profile.organizationName} is a leading company in the ${profile.industry} industry. They specialize in ${keyTermsStr}. The organization is known for their expertise in these areas and serves customers nationwide.`;
}

/**
 * Calculate quality metrics by comparing generated vs expected profile
 */
function calculateQualityMetrics(generated: OrgProfile, expected: OrgProfile) {
  // Org name match (case-insensitive, allow partial match)
  const orgNameMatch =
    generated.organizationName.toLowerCase().includes(expected.organizationName.toLowerCase()) ||
    expected.organizationName.toLowerCase().includes(generated.organizationName.toLowerCase());

  // Industry match (case-insensitive, allow fuzzy match)
  const industryMatch =
    generated.industry.toLowerCase().includes(expected.industry.toLowerCase()) ||
    expected.industry.toLowerCase().includes(generated.industry.toLowerCase());

  // Key terms overlap (how many expected terms appear in generated?)
  const expectedTermsLower = expected.keyTerms.map((t) => t.toLowerCase());
  const generatedTermsLower = generated.keyTerms.map((t) => t.toLowerCase());
  const matchingTerms = expectedTermsLower.filter((term) =>
    generatedTermsLower.some((gTerm) => gTerm.includes(term) || term.includes(gTerm)),
  );
  const keyTermsOverlap = (matchingTerms.length / expected.keyTerms.length) * 100;

  // Acronyms overlap
  const expectedAcronyms = Object.keys(expected.acronyms);
  const generatedAcronyms = Object.keys(generated.acronyms);
  const matchingAcronyms = expectedAcronyms.filter((acr) => generatedAcronyms.includes(acr));
  const acronymsOverlap = (matchingAcronyms.length / expectedAcronyms.length) * 100;

  return {
    orgNameMatch,
    industryMatch,
    keyTermsOverlap,
    acronymsOverlap,
  };
}

/**
 * Run benchmark for a single profile and mode
 */
async function runBenchmark(
  generator: any,
  profileName: string,
  expected: OrgProfile,
  mode: 'url' | 'name-industry' | 'paragraph',
): Promise<BenchmarkResult> {
  const startTime = Date.now();

  try {
    let generated: OrgProfile;

    if (mode === 'name-industry') {
      generated = await generator.generateFromNameAndIndustry(
        expected.organizationName,
        expected.industry,
      );
    } else if (mode === 'paragraph') {
      const description = createDescriptionParagraph(expected);
      generated = await generator.generateFromParagraph(description);
    } else {
      // URL mode - skip for now (requires actual URLs or mocks)
      throw new Error('URL mode not implemented in benchmark (requires real URLs)');
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Estimate cost (Claude Sonnet 4.5 pricing)
    const estimatedInputTokens = 3000;
    const estimatedOutputTokens = 500;
    const cost = (estimatedInputTokens * 3) / 1_000_000 + (estimatedOutputTokens * 15) / 1_000_000;

    const qualityMetrics = calculateQualityMetrics(generated, expected);

    return {
      profileName,
      mode,
      success: true,
      durationMs,
      cost,
      generated,
      expected,
      qualityMetrics,
    };
  } catch (error) {
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    return {
      profileName,
      mode,
      success: false,
      durationMs,
      cost: 0,
      expected,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate summary statistics from benchmark results
 */
function generateSummary(results: BenchmarkResult[]): BenchmarkSummary {
  const totalTests = results.length;
  const successCount = results.filter((r) => r.success).length;
  const successRate = (successCount / totalTests) * 100;

  const successResults = results.filter((r) => r.success);

  const avgDurationMs =
    successResults.reduce((sum, r) => sum + r.durationMs, 0) / successResults.length || 0;
  const avgCost = successResults.reduce((sum, r) => sum + r.cost, 0) / successResults.length || 0;
  const totalCost = successResults.reduce((sum, r) => sum + r.cost, 0);

  // By mode breakdown
  const byMode: BenchmarkSummary['byMode'] = {};
  const modes = ['name-industry', 'paragraph'] as const;

  for (const mode of modes) {
    const modeResults = results.filter((r) => r.mode === mode);
    const modeSuccess = modeResults.filter((r) => r.success);

    byMode[mode] = {
      total: modeResults.length,
      success: modeSuccess.length,
      successRate: (modeSuccess.length / modeResults.length) * 100 || 0,
      avgDuration: modeSuccess.reduce((sum, r) => sum + r.durationMs, 0) / modeSuccess.length || 0,
      avgCost: modeSuccess.reduce((sum, r) => sum + r.cost, 0) / modeSuccess.length || 0,
    };
  }

  // Quality averages
  const withQuality = successResults.filter((r) => r.qualityMetrics);
  const qualityAverages = {
    orgNameAccuracy:
      (withQuality.filter((r) => r.qualityMetrics!.orgNameMatch).length / withQuality.length) *
        100 || 0,
    industryAccuracy:
      (withQuality.filter((r) => r.qualityMetrics!.industryMatch).length / withQuality.length) *
        100 || 0,
    avgKeyTermsOverlap:
      withQuality.reduce((sum, r) => sum + r.qualityMetrics!.keyTermsOverlap, 0) /
        withQuality.length || 0,
    avgAcronymsOverlap:
      withQuality.reduce((sum, r) => sum + r.qualityMetrics!.acronymsOverlap, 0) /
        withQuality.length || 0,
  };

  return {
    totalTests,
    successCount,
    successRate,
    avgDurationMs,
    avgCost,
    totalCost,
    byMode,
    qualityAverages,
  };
}

describe.skipIf(SKIP_LLM_TESTS)('Org Profile Generator Benchmark', () => {
  let profiles: Record<string, OrgProfile>;
  let generator: any;

  beforeAll(async () => {
    profiles = await loadBenchmarkProfiles();
    generator = await createOrgProfileGenerator(TENANT_ID, INDEX_ID);

    if (!generator) {
      throw new Error('Failed to create OrgProfileGenerator - no LLM credentials available');
    }
  });

  describe('Name-Industry Mode', () => {
    it('generates profiles from organization name and industry', async () => {
      const results: BenchmarkResult[] = [];

      for (const [name, expected] of Object.entries(profiles)) {
        const result = await runBenchmark(generator, name, expected, 'name-industry');
        results.push(result);

        // Log individual result
        if (result.success) {
          console.log(
            `✓ ${name}: ${result.durationMs}ms, $${result.cost.toFixed(4)}, Quality: ${result.qualityMetrics!.keyTermsOverlap.toFixed(1)}% key terms`,
          );
        } else {
          console.log(`✗ ${name}: ${result.error}`);
        }
      }

      const summary = generateSummary(results);

      // Log summary
      console.log('\n=== Name-Industry Mode Summary ===');
      console.log(`Success Rate: ${summary.successRate.toFixed(1)}%`);
      console.log(`Avg Duration: ${summary.avgDurationMs.toFixed(0)}ms`);
      console.log(`Avg Cost: $${summary.avgCost.toFixed(4)}`);
      console.log(`Total Cost: $${summary.totalCost.toFixed(4)}`);
      console.log(`Org Name Accuracy: ${summary.qualityAverages.orgNameAccuracy.toFixed(1)}%`);
      console.log(`Industry Accuracy: ${summary.qualityAverages.industryAccuracy.toFixed(1)}%`);
      console.log(`Key Terms Overlap: ${summary.qualityAverages.avgKeyTermsOverlap.toFixed(1)}%`);
      console.log(`Acronyms Overlap: ${summary.qualityAverages.avgAcronymsOverlap.toFixed(1)}%`);

      // Assertions
      expect(summary.successRate).toBeGreaterThan(80); // At least 80% success
      expect(summary.avgDurationMs).toBeLessThan(10000); // < 10 seconds
      expect(summary.avgCost).toBeLessThan(0.03); // < 3 cents per profile
      expect(summary.qualityAverages.orgNameAccuracy).toBeGreaterThan(90); // > 90% org name accuracy
    }, 180000); // 3 minutes timeout (12 profiles * ~10s each)
  });

  describe('Paragraph Mode', () => {
    it('generates profiles from description paragraph', async () => {
      const results: BenchmarkResult[] = [];

      for (const [name, expected] of Object.entries(profiles)) {
        const result = await runBenchmark(generator, name, expected, 'paragraph');
        results.push(result);

        // Log individual result
        if (result.success) {
          console.log(
            `✓ ${name}: ${result.durationMs}ms, $${result.cost.toFixed(4)}, Quality: ${result.qualityMetrics!.keyTermsOverlap.toFixed(1)}% key terms`,
          );
        } else {
          console.log(`✗ ${name}: ${result.error}`);
        }
      }

      const summary = generateSummary(results);

      // Log summary
      console.log('\n=== Paragraph Mode Summary ===');
      console.log(`Success Rate: ${summary.successRate.toFixed(1)}%`);
      console.log(`Avg Duration: ${summary.avgDurationMs.toFixed(0)}ms`);
      console.log(`Avg Cost: $${summary.avgCost.toFixed(4)}`);
      console.log(`Total Cost: $${summary.totalCost.toFixed(4)}`);
      console.log(`Org Name Accuracy: ${summary.qualityAverages.orgNameAccuracy.toFixed(1)}%`);
      console.log(`Industry Accuracy: ${summary.qualityAverages.industryAccuracy.toFixed(1)}%`);
      console.log(`Key Terms Overlap: ${summary.qualityAverages.avgKeyTermsOverlap.toFixed(1)}%`);
      console.log(`Acronyms Overlap: ${summary.qualityAverages.avgAcronymsOverlap.toFixed(1)}%`);

      // Assertions
      expect(summary.successRate).toBeGreaterThan(80); // At least 80% success
      expect(summary.avgDurationMs).toBeLessThan(10000); // < 10 seconds
      expect(summary.avgCost).toBeLessThan(0.03); // < 3 cents per profile
      expect(summary.qualityAverages.orgNameAccuracy).toBeGreaterThan(90); // > 90% org name accuracy
    }, 180000); // 3 minutes timeout
  });

  describe('Mode Comparison', () => {
    it('compares all modes and identifies optimal mode', async () => {
      const allResults: BenchmarkResult[] = [];

      // Run both modes
      for (const [name, expected] of Object.entries(profiles)) {
        allResults.push(await runBenchmark(generator, name, expected, 'name-industry'));
        allResults.push(await runBenchmark(generator, name, expected, 'paragraph'));
      }

      const summary = generateSummary(allResults);

      console.log('\n=== Overall Benchmark Summary ===');
      console.log(`Total Tests: ${summary.totalTests}`);
      console.log(`Success Rate: ${summary.successRate.toFixed(1)}%`);
      console.log(`Avg Duration: ${summary.avgDurationMs.toFixed(0)}ms`);
      console.log(`Avg Cost: $${summary.avgCost.toFixed(4)}`);
      console.log(`Total Cost: $${summary.totalCost.toFixed(4)}`);

      console.log('\n=== By Mode Comparison ===');
      for (const [mode, stats] of Object.entries(summary.byMode)) {
        console.log(`\n${mode}:`);
        console.log(`  Success Rate: ${stats.successRate.toFixed(1)}%`);
        console.log(`  Avg Duration: ${stats.avgDuration.toFixed(0)}ms`);
        console.log(`  Avg Cost: $${stats.avgCost.toFixed(4)}`);
      }

      console.log('\n=== Quality Averages ===');
      console.log(`Org Name Accuracy: ${summary.qualityAverages.orgNameAccuracy.toFixed(1)}%`);
      console.log(`Industry Accuracy: ${summary.qualityAverages.industryAccuracy.toFixed(1)}%`);
      console.log(`Key Terms Overlap: ${summary.qualityAverages.avgKeyTermsOverlap.toFixed(1)}%`);
      console.log(`Acronyms Overlap: ${summary.qualityAverages.avgAcronymsOverlap.toFixed(1)}%`);

      // Identify optimal mode
      const modesBySuccessRate = Object.entries(summary.byMode).sort(
        (a, b) => b[1].successRate - a[1].successRate,
      );
      const modesByCost = Object.entries(summary.byMode).sort(
        (a, b) => a[1].avgCost - b[1].avgCost,
      );
      const modesBySpeed = Object.entries(summary.byMode).sort(
        (a, b) => a[1].avgDuration - b[1].avgDuration,
      );

      console.log('\n=== Recommendations ===');
      console.log(
        `Most Reliable: ${modesBySuccessRate[0][0]} (${modesBySuccessRate[0][1].successRate.toFixed(1)}% success)`,
      );
      console.log(
        `Most Cost-Effective: ${modesByCost[0][0]} ($${modesByCost[0][1].avgCost.toFixed(4)} per profile)`,
      );
      console.log(
        `Fastest: ${modesBySpeed[0][0]} (${modesBySpeed[0][1].avgDuration.toFixed(0)}ms)`,
      );

      // Overall success
      expect(summary.successRate).toBeGreaterThan(75); // At least 75% overall success
    }, 360000); // 6 minutes timeout (24 tests total)
  });
});
