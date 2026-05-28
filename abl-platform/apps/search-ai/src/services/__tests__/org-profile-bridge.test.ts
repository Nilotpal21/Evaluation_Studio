/**
 * Unit tests for OrgProfile -> OrganizationProfile bridge.
 *
 * Uses the financial-services.json domain definition for realistic test data.
 * Pure function — no mocks required.
 */

import { describe, it, expect } from 'vitest';
import { bridgeOrgProfileToContext } from '../org-profile-bridge.js';
import type { OrgProfile } from '../../schemas/org-profile.schema.js';
import type { DomainDefinition } from '../taxonomy-loader.service.js';

// Load real domain definition for realistic test data
import financialServicesDomain from '../../../data/domains/financial-services.json' with { type: 'json' };

const domain = financialServicesDomain as unknown as DomainDefinition;

function makeOrgProfile(overrides: Partial<OrgProfile> = {}): OrgProfile {
  return {
    organizationName: 'Test Bank',
    industry: 'Financial Services',
    keyTerms: [],
    acronyms: {},
    departmentBoundaries: [],
    productSpecificNames: {},
    ...overrides,
  };
}

describe('bridgeOrgProfileToContext', () => {
  it('AC-1: maps acronym expansion matching attribute name to alias', () => {
    const orgProfile = makeOrgProfile({
      acronyms: { APR: 'Annual Percentage Rate' },
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    // interest_rate attribute has name "Interest Rate"
    // "Annual Percentage Rate" contains "interest rate" (case-insensitive) — match
    // interest_rate is applicable to: savings-account, credit-card, mortgage, personal-loan, auto-loan
    const creditCard = result.products.find((p) => p.productId === 'credit-card');
    expect(creditCard).toBeDefined();
    expect(creditCard!.attributeContext).toBeDefined();
    expect(creditCard!.attributeContext!['interest_rate']).toBeDefined();
    expect(creditCard!.attributeContext!['interest_rate'].aliases).toContain('APR');

    // Also check another product that has interest_rate
    const mortgage = result.products.find((p) => p.productId === 'mortgage');
    expect(mortgage!.attributeContext!['interest_rate'].aliases).toContain('APR');
  });

  it('AC-2: maps productSpecificNames to organizationSpecificNames', () => {
    const orgProfile = makeOrgProfile({
      productSpecificNames: { 'credit-card': ['Sapphire', 'Platinum Card'] },
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    const creditCard = result.products.find((p) => p.productId === 'credit-card');
    expect(creditCard).toBeDefined();
    expect(creditCard!.organizationSpecificNames).toEqual(['Sapphire', 'Platinum Card']);
  });

  it('AC-3: empty OrgProfile produces valid OrganizationProfile with empty contexts', () => {
    const orgProfile = makeOrgProfile();

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    expect(result.organizationName).toBe('Test Bank');
    expect(result.products).toHaveLength(domain.products.length);

    // All products should have empty organizationSpecificNames
    for (const product of result.products) {
      expect(product.organizationSpecificNames).toEqual([]);
    }

    // No attributeContext should be set when there are no acronyms/keyTerms
    for (const product of result.products) {
      expect(product.attributeContext).toBeUndefined();
    }
  });

  it('does not add alias when acronym expansion does not match attribute name', () => {
    const orgProfile = makeOrgProfile({
      acronyms: { CEO: 'Chief Executive Officer' },
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    // No attribute name contains "chief executive officer"
    for (const product of result.products) {
      expect(product.attributeContext).toBeUndefined();
    }
  });

  it('matches keyTerms against attribute extraction keywords', () => {
    const orgProfile = makeOrgProfile({
      // "credit line" is an extraction keyword for credit_limit attribute
      keyTerms: ['credit line'],
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    // credit_limit is applicable to credit-card only
    const creditCard = result.products.find((p) => p.productId === 'credit-card');
    expect(creditCard).toBeDefined();
    expect(creditCard!.attributeContext).toBeDefined();
    expect(creditCard!.attributeContext!['credit_limit']).toBeDefined();
    expect(creditCard!.attributeContext!['credit_limit'].aliases).toContain('credit line');
  });

  it('matches keyTerms against attribute name (bidirectional contains)', () => {
    const orgProfile = makeOrgProfile({
      // "Interest Rate" is the attribute name — partial match
      keyTerms: ['interest rate'],
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    const savingsAccount = result.products.find((p) => p.productId === 'savings-account');
    expect(savingsAccount!.attributeContext!['interest_rate'].aliases).toContain('interest rate');
  });

  it('deduplicates aliases when both acronym and keyTerm match', () => {
    const orgProfile = makeOrgProfile({
      acronyms: { APR: 'Annual Percentage Rate' },
      // "APR" is also an extraction keyword for interest_rate
      keyTerms: ['APR'],
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    const creditCard = result.products.find((p) => p.productId === 'credit-card');
    const aliases = creditCard!.attributeContext!['interest_rate'].aliases;
    expect(aliases).toBeDefined();

    // "APR" appears from both acronym match and keyTerm match — should be deduplicated
    const aprCount = aliases!.filter((a) => a === 'APR').length;
    expect(aprCount).toBe(1);
  });

  it('handles multiple aliases from different sources', () => {
    const orgProfile = makeOrgProfile({
      acronyms: {
        APR: 'Annual Percentage Rate',
        IR: 'Interest Rate',
      },
      keyTerms: ['annual percentage rate'],
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    const creditCard = result.products.find((p) => p.productId === 'credit-card');
    const aliases = creditCard!.attributeContext!['interest_rate'].aliases;

    expect(aliases).toContain('APR');
    expect(aliases).toContain('IR');
    expect(aliases).toContain('annual percentage rate');
  });

  it('does not assign attribute aliases to products where attribute is not applicable', () => {
    const orgProfile = makeOrgProfile({
      acronyms: { APR: 'Annual Percentage Rate' },
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    // interest_rate is NOT applicable to checking-account
    const checking = result.products.find((p) => p.productId === 'checking-account');
    expect(checking!.attributeContext).toBeUndefined();
  });

  it('handles multiple domain definitions', () => {
    // Create a minimal second domain
    const secondDomain: DomainDefinition = {
      id: 'healthcare',
      name: 'Healthcare',
      version: '1.0.0',
      categories: [{ id: 'plans', name: 'Plans', department: 'Health' }],
      products: [
        {
          id: 'health-plan',
          name: 'Health Plan',
          categoryId: 'plans',
          department: 'Health',
          subDepartment: 'Plans',
        },
      ],
      attributes: [
        {
          id: 'copay',
          name: 'Copay',
          dataType: 'currency',
          applicableTo: ['health-plan'],
          extraction: { method: 'regex', keywords: ['copay', 'co-payment'] },
        },
      ],
    };

    const orgProfile = makeOrgProfile({
      productSpecificNames: {
        'credit-card': ['Sapphire'],
        'health-plan': ['BlueCross Gold'],
      },
      keyTerms: ['co-payment'],
    });

    const result = bridgeOrgProfileToContext(orgProfile, [domain, secondDomain]);

    // Products from both domains
    const totalExpected = domain.products.length + secondDomain.products.length;
    expect(result.products).toHaveLength(totalExpected);

    const healthPlan = result.products.find((p) => p.productId === 'health-plan');
    expect(healthPlan!.organizationSpecificNames).toEqual(['BlueCross Gold']);
    expect(healthPlan!.attributeContext!['copay'].aliases).toContain('co-payment');
  });

  it('preserves organizationName from OrgProfile', () => {
    const orgProfile = makeOrgProfile({ organizationName: 'Acme Financial Corp' });

    const result = bridgeOrgProfileToContext(orgProfile, [domain]);

    expect(result.organizationName).toBe('Acme Financial Corp');
  });

  it('returns empty products array when domain definitions have no products', () => {
    const emptyDomain: DomainDefinition = {
      id: 'empty',
      name: 'Empty',
      version: '1.0.0',
      categories: [],
      products: [],
      attributes: [],
    };

    const orgProfile = makeOrgProfile();
    const result = bridgeOrgProfileToContext(orgProfile, [emptyDomain]);

    expect(result.products).toEqual([]);
  });
});
