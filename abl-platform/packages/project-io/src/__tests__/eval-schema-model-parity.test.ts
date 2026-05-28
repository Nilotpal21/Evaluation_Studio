/**
 * ABLP-905 regression guard: eval import schemas must accept the shapes that
 * the database models actually store and the exporter serializes.
 */

import type { SchemaType } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { EvalPersona, EvalScenario, EvalSet } from '@agent-platform/database/models';
import {
  ImportedEvalPersonaSchema,
  ImportedEvalScenarioSchema,
  ImportedEvalSetSchema,
  validateStagedRecordBatch,
} from '../import/entity-schemas.js';

type ModelPath = SchemaType & {
  instance?: string;
  options?: {
    default?: unknown;
    type?: unknown;
  };
};

const OWNERSHIP = {
  projectId: 'proj-parity',
  tenantId: 'tenant-parity',
  createdBy: 'user-parity',
};

function modelPath(
  model: { schema: { path(name: string): SchemaType | undefined } },
  field: string,
) {
  const path = model.schema.path(field);
  expect(path, `Expected model schema path for ${field}`).toBeDefined();
  return path as ModelPath;
}

describe('eval schema/model parity', () => {
  it('keeps file-level eval import schemas aligned with Mongoose storage shapes', () => {
    const evalSet = {
      name: 'Regression Suite',
      personaIds: [],
      scenarioIds: [],
      evaluatorIds: [],
      variants: 1,
      maxConcurrency: 1,
      ciEnabled: false,
      personaModel: null,
    };
    const evalScenario = {
      name: 'Happy Path',
      difficulty: 'easy',
      maxTurns: 5,
      tags: [],
      agentPath: [],
      expectedMilestones: ['greeting', 'resolution'],
      version: 1,
    };
    const evalPersona = {
      name: 'Direct User',
      communicationStyle: 'terse',
      domainKnowledge: 'beginner',
      behaviorTraits: [],
      goals: 'Resolve the issue',
      constraints: 'Keep it short',
      source: 'custom',
      version: 1,
      isAdversarial: false,
      isBuiltIn: false,
    };

    expect(modelPath(EvalSet, 'personaModel').options?.default).toBeNull();
    expect(ImportedEvalSetSchema.parse(evalSet).personaModel).toBeNull();

    expect(modelPath(EvalScenario, 'expectedMilestones').instance).toBe('Array');
    expect(ImportedEvalScenarioSchema.parse(evalScenario).expectedMilestones).toEqual([
      'greeting',
      'resolution',
    ]);

    expect(modelPath(EvalScenario, 'version').instance).toBe('Number');
    expect(ImportedEvalScenarioSchema.parse(evalScenario).version).toBe(1);

    expect(modelPath(EvalPersona, 'goals').instance).toBe('String');
    expect(ImportedEvalPersonaSchema.parse(evalPersona).goals).toBe('Resolve the issue');

    expect(modelPath(EvalPersona, 'constraints').instance).toBe('String');
    expect(ImportedEvalPersonaSchema.parse(evalPersona).constraints).toBe('Keep it short');
  });

  it('keeps staged eval record schemas aligned with file-level eval import schemas', () => {
    const records = [
      {
        collection: 'eval_sets',
        data: {
          ...OWNERSHIP,
          name: 'Regression Suite',
          personaIds: [],
          scenarioIds: [],
          evaluatorIds: [],
          variants: 1,
          maxConcurrency: 1,
          ciEnabled: false,
          personaModel: null,
        },
      },
      {
        collection: 'eval_scenarios',
        data: {
          ...OWNERSHIP,
          name: 'Happy Path',
          difficulty: 'easy',
          maxTurns: 5,
          tags: [],
          agentPath: [],
          expectedMilestones: ['greeting', 'resolution'],
          version: 1,
        },
      },
      {
        collection: 'eval_personas',
        data: {
          ...OWNERSHIP,
          name: 'Direct User',
          communicationStyle: 'terse',
          domainKnowledge: 'beginner',
          behaviorTraits: [],
          goals: 'Resolve the issue',
          constraints: 'Keep it short',
          source: 'custom',
          version: 1,
          isAdversarial: false,
          isBuiltIn: false,
        },
      },
    ];

    const { errors, sanitized, warnings } = validateStagedRecordBatch(records);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(sanitized).toHaveLength(records.length);
  });
});
