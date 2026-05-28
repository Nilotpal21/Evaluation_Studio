import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_CATALOG } from '../platform/contracts/knowledge/catalog.generated.js';
import { CROSS_CONSTRUCT_MANDATORIES } from '../platform/contracts/knowledge/cross-construct-mandatories.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

describe('Knowledge catalog shape', () => {
  it('round-trips every mandatory seed rule into the generated catalog', () => {
    const generatedRules = new Map(
      KNOWLEDGE_CATALOG.crossConstructMandatories.map((rule) => [rule.ruleId, rule]),
    );

    for (const seedRule of CROSS_CONSTRUCT_MANDATORIES) {
      expect(generatedRules.get(seedRule.ruleId)).toEqual(seedRule);
    }
  });

  it('includes categorized metadata for every compiler validation code', () => {
    for (const code of Object.values(VALIDATION_CODES)) {
      const metadata = KNOWLEDGE_CATALOG.validationCodes[code];

      expect(metadata, `Missing validation code metadata for ${code}`).toBeDefined();
      expect(metadata.category, `Missing validation category for ${code}`).toBeTruthy();
      expect(metadata.meaning, `Missing validation meaning for ${code}`).toBeTruthy();
      expect(metadata.remediation, `Missing validation remediation for ${code}`).toBeTruthy();
      expect(['error', 'warning', 'info']).toContain(metadata.severity);
    }
  });
});
