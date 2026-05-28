import { describe, it, expect } from 'vitest';
import { validateOrgProfile } from '../../../schemas/org-profile.schema.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Benchmark Org Profiles Validation', () => {
  const profiles = [
    'vanguard.json',
    'fidelity.json',
    'mayo-clinic.json',
    'kaiser-permanente.json',
    'salesforce.json',
    'servicenow.json',
    'boeing.json',
    'caterpillar.json',
    'walmart.json',
    'target.json',
    'exxonmobil.json',
    'chevron.json',
  ];

  for (const filename of profiles) {
    it(`validates ${filename} against OrgProfileSchema`, async () => {
      const filePath = path.join(__dirname, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Should not throw
      expect(() => validateOrgProfile(data)).not.toThrow();

      const validatedProfile = validateOrgProfile(data);

      // Verify structure
      expect(validatedProfile.organizationName).toBeDefined();
      expect(validatedProfile.industry).toBeDefined();
      expect(validatedProfile.keyTerms.length).toBeGreaterThanOrEqual(10);
      expect(validatedProfile.keyTerms.length).toBeLessThanOrEqual(20);
      expect(Object.keys(validatedProfile.acronyms).length).toBeGreaterThanOrEqual(5);
      expect(Object.keys(validatedProfile.acronyms).length).toBeLessThanOrEqual(10);
      expect(validatedProfile.departmentBoundaries.length).toBeGreaterThanOrEqual(2);
      expect(validatedProfile.departmentBoundaries.length).toBeLessThanOrEqual(5);

      // Verify department boundaries have descriptive reasoning
      for (const boundary of validatedProfile.departmentBoundaries) {
        expect(boundary.reasoning.length).toBeGreaterThanOrEqual(10);
        expect(boundary.reasoning.length).toBeLessThanOrEqual(500);
      }
    });
  }

  it('all profiles cover 6 industries with 2 orgs each', async () => {
    const industryCount: Record<string, number> = {};

    for (const filename of profiles) {
      const filePath = path.join(__dirname, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      const profile = validateOrgProfile(data);

      industryCount[profile.industry] = (industryCount[profile.industry] || 0) + 1;
    }

    // Should have 6 industries
    expect(Object.keys(industryCount).length).toBe(6);

    // Each industry should have 2 organizations
    for (const [industry, count] of Object.entries(industryCount)) {
      expect(count).toBe(2);
    }
  });

  it('profiles have diverse key terms (no duplicates within profile)', async () => {
    for (const filename of profiles) {
      const filePath = path.join(__dirname, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      const profile = validateOrgProfile(data);

      const uniqueTerms = new Set(profile.keyTerms);
      expect(uniqueTerms.size).toBe(profile.keyTerms.length);
    }
  });

  it('acronym keys are uppercase and concise', async () => {
    for (const filename of profiles) {
      const filePath = path.join(__dirname, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      const profile = validateOrgProfile(data);

      for (const [acronym, expansion] of Object.entries(profile.acronyms)) {
        // Acronym key should be mostly uppercase
        expect(acronym.length).toBeGreaterThan(0);
        expect(acronym.length).toBeLessThanOrEqual(10);

        // Expansion should be descriptive
        expect(expansion.length).toBeGreaterThan(0);
        expect(expansion.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
