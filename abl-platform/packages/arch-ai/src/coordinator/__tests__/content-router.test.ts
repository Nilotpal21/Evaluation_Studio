import { describe, expect, it } from 'vitest';
import { routeByContent } from '../content-router.js';

describe('integration-methodologist routing — extended vocabulary', () => {
  const cases: Array<[string, string]> = [
    ['Hook up Slack', 'integration-methodologist'],
    ['connect to Salesforce please', 'integration-methodologist'],
    ['integrate with Notion', 'integration-methodologist'],
    ['set up integration', 'integration-methodologist'],
    ['add an api key auth profile', 'integration-methodologist'],
  ];
  for (const [input, expected] of cases) {
    it(`routes "${input}" to ${expected}`, () => {
      const decision = routeByContent(input);
      expect(decision.specialist).toBe(expected);
      expect(decision.matchedPattern).toBeTruthy();
    });
  }
});
