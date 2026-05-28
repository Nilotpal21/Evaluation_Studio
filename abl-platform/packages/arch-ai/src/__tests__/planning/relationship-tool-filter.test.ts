import { describe, expect, it } from 'vitest';

import {
  filterRelationshipToolRefs,
  isRelationshipToolRef,
} from '../../planning/relationship-tool-filter.js';

describe('relationship tool filtering', () => {
  it('filters delegation-as-tool names when a real relationship targets the same agent', () => {
    const tools = ['consult_policy_advisor', 'delegate_to_fulfillment', 'get_order'];

    expect(
      filterRelationshipToolRefs(tools, ['PolicyAdvisor', 'FulfillmentSpecialist'], (tool) => tool),
    ).toEqual(['get_order']);
  });

  it('requires a relationship verb before matching target aliases', () => {
    expect(isRelationshipToolRef('get_order', ['OrderSpecialist'])).toBe(false);
    expect(isRelationshipToolRef('consultOrderSpecialist', ['OrderSpecialist'])).toBe(true);
  });
});
