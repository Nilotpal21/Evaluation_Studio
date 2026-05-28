import AjvDefault from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

import type { StageOutputSchemaConfig, StageOutputSchemaId } from '../types.js';

type JsonSchemaDocument = Record<string, unknown>;

type JsonSchemaPropertyMap = Record<string, unknown>;

const NON_EMPTY_STRING_SCHEMA: JsonSchemaDocument = {
  type: 'string',
  minLength: 1,
  pattern: '\\S',
};

const NULLABLE_NON_EMPTY_STRING_SCHEMA: JsonSchemaDocument = {
  anyOf: [{ type: 'null' }, NON_EMPTY_STRING_SCHEMA],
};

const Ajv = (AjvDefault as any).default ?? AjvDefault;
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<StageOutputSchemaId, ValidateFunction<unknown>>();

const analysisReportSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.analysis-report',
  title: 'HELIX Analysis Report',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'decisions'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'title', 'description', 'files'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'info'],
          },
          category: {
            type: 'string',
            enum: [
              'redundancy',
              'wiring-gap',
              'inconsistency',
              'bug',
              'missing-test',
              'missing-doc',
              'security',
              'performance',
              'isolation',
              'dead-code',
              'stale-dependency',
            ],
          },
          title: NON_EMPTY_STRING_SCHEMA,
          description: NON_EMPTY_STRING_SCHEMA,
          files: {
            type: 'array',
            items: NON_EMPTY_STRING_SCHEMA,
          },
        },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['classification', 'question', 'context', 'answer'],
        properties: {
          classification: {
            type: 'string',
            enum: ['ANSWERED', 'INFERRED', 'DECIDED', 'AMBIGUOUS'],
          },
          question: NON_EMPTY_STRING_SCHEMA,
          context: NULLABLE_NON_EMPTY_STRING_SCHEMA,
          answer: NULLABLE_NON_EMPTY_STRING_SCHEMA,
        },
      },
    },
  },
};

const analysisReportProperties = analysisReportSchema['properties'] as JsonSchemaPropertyMap;

const reproductionReportSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.reproduction-report',
  title: 'HELIX Reproduction Report',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'testFile', 'reproductionSteps', 'findings', 'decisions'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    testFile: NON_EMPTY_STRING_SCHEMA,
    reproductionSteps: {
      type: 'array',
      minItems: 1,
      items: NON_EMPTY_STRING_SCHEMA,
    },
    findings: analysisReportProperties['findings'],
    decisions: analysisReportProperties['decisions'],
  },
};

const slicePlanSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.slice-plan',
  title: 'HELIX Slice Plan',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'slices'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    slices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'description',
          'findings',
          'files',
          'tests',
          'dependencies',
          'legacyPaths',
        ],
        properties: {
          title: NON_EMPTY_STRING_SCHEMA,
          description: NON_EMPTY_STRING_SCHEMA,
          findings: {
            type: 'array',
            minItems: 0,
            items: NON_EMPTY_STRING_SCHEMA,
          },
          files: {
            type: 'array',
            minItems: 1,
            items: NON_EMPTY_STRING_SCHEMA,
          },
          tests: {
            type: 'array',
            minItems: 1,
            items: NON_EMPTY_STRING_SCHEMA,
          },
          dependencies: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
          },
          legacyPaths: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'reason'],
              properties: {
                path: NON_EMPTY_STRING_SCHEMA,
                reason: NON_EMPTY_STRING_SCHEMA,
              },
            },
          },
        },
      },
    },
  },
};

const planCWithDivergenceSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.plan-c-with-divergence',
  title: 'HELIX Plan C With Divergence',
  type: 'object',
  additionalProperties: false,
  required: [...(slicePlanSchema.required as string[])],
  properties: {
    ...(slicePlanSchema.properties as Record<string, unknown>),
    divergenceNotes: { type: 'string', minLength: 0 },
  },
};

const planReviewSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.plan-review',
  title: 'HELIX Plan Review',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'sliceAssessments', 'deferredFindings', 'decisions'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['disposition', 'severity', 'category', 'title', 'description', 'files'],
        properties: {
          disposition: {
            type: 'string',
            enum: ['blocking', 'advisory'],
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'info'],
          },
          category: {
            type: 'string',
            enum: [
              'redundancy',
              'wiring-gap',
              'inconsistency',
              'bug',
              'missing-test',
              'missing-doc',
              'security',
              'performance',
              'isolation',
              'dead-code',
              'stale-dependency',
            ],
          },
          title: NON_EMPTY_STRING_SCHEMA,
          description: NON_EMPTY_STRING_SCHEMA,
          files: {
            type: 'array',
            items: NON_EMPTY_STRING_SCHEMA,
          },
        },
      },
    },
    sliceAssessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sliceNumber', 'verdict', 'rationale', 'requiredTestAmendments'],
        properties: {
          sliceNumber: { type: 'integer', minimum: 1 },
          verdict: {
            type: 'string',
            enum: ['approved', 'revise'],
          },
          rationale: NON_EMPTY_STRING_SCHEMA,
          requiredTestAmendments: {
            type: 'array',
            items: NON_EMPTY_STRING_SCHEMA,
          },
        },
      },
    },
    deferredFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'reason'],
        properties: {
          findingId: NON_EMPTY_STRING_SCHEMA,
          reason: NON_EMPTY_STRING_SCHEMA,
        },
      },
    },
    decisions: analysisReportProperties['decisions'],
  },
};

const impactAnalysisSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.impact-analysis',
  title: 'HELIX Impact Analysis',
  type: 'object',
  additionalProperties: false,
  required: ['dependentFiles', 'affectedTests', 'riskLevel', 'notes'],
  properties: {
    dependentFiles: {
      type: 'array',
      items: NON_EMPTY_STRING_SCHEMA,
    },
    affectedTests: {
      type: 'array',
      items: NON_EMPTY_STRING_SCHEMA,
    },
    riskLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    notes: NON_EMPTY_STRING_SCHEMA,
  },
};

const oracleReviewSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.oracle-review',
  title: 'HELIX Oracle Review',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'assessments', 'newFindings', 'decisions'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'verdict', 'rationale', 'severity', 'horizon'],
        properties: {
          findingId: NON_EMPTY_STRING_SCHEMA,
          verdict: {
            type: 'string',
            enum: ['confirm', 'challenge', 'reprioritize'],
          },
          rationale: NON_EMPTY_STRING_SCHEMA,
          severity: {
            anyOf: [
              { type: 'null' },
              {
                type: 'string',
                enum: ['critical', 'high', 'medium', 'low', 'info'],
              },
            ],
          },
          horizon: {
            anyOf: [
              { type: 'null' },
              {
                type: 'string',
                enum: ['immediate', 'next', 'near-term', 'long-term'],
              },
            ],
          },
        },
      },
    },
    newFindings: analysisReportProperties['findings'],
    decisions: analysisReportProperties['decisions'],
  },
};

const workspaceReconcileSchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.workspace-reconcile',
  title: 'HELIX Workspace Reconcile',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'assessments'],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'disposition', 'rationale'],
        properties: {
          file: NON_EMPTY_STRING_SCHEMA,
          disposition: {
            type: 'string',
            enum: ['ignore', 'block'],
          },
          rationale: NON_EMPTY_STRING_SCHEMA,
        },
      },
    },
  },
};

const failureAdvisorySchema: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'helix.failure-advisory',
  title: 'HELIX Failure Advisory',
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'suspectedCause',
    'recommendedAction',
    'promptGuidance',
    'operatorActions',
    'budgetRecommendation',
  ],
  properties: {
    summary: NON_EMPTY_STRING_SCHEMA,
    suspectedCause: NON_EMPTY_STRING_SCHEMA,
    recommendedAction: {
      type: 'string',
      enum: [
        'retry-stage',
        'synthesize-stage',
        'switch-model',
        'continue-immediate-only',
        'promote-stage',
        'pause-and-resume',
      ],
    },
    promptGuidance: NULLABLE_NON_EMPTY_STRING_SCHEMA,
    operatorActions: {
      type: 'array',
      minItems: 1,
      items: NON_EMPTY_STRING_SCHEMA,
    },
    budgetRecommendation: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'rationale',
            'targetTurns',
            'explorationTurns',
            'shellWarnFloor',
            'shellAbortFloor',
          ],
          properties: {
            rationale: NON_EMPTY_STRING_SCHEMA,
            targetTurns: {
              anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }],
            },
            explorationTurns: {
              anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }],
            },
            shellWarnFloor: {
              anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }],
            },
            shellAbortFloor: {
              anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }],
            },
          },
        },
      ],
    },
  },
};

const schemaById: Record<StageOutputSchemaId, JsonSchemaDocument> = {
  'analysis-report': analysisReportSchema,
  'failure-advisory': failureAdvisorySchema,
  'impact-analysis': impactAnalysisSchema,
  'oracle-review': oracleReviewSchema,
  'plan-c-with-divergence': planCWithDivergenceSchema,
  'plan-review': planReviewSchema,
  'reproduction-report': reproductionReportSchema,
  'slice-plan': slicePlanSchema,
  'workspace-reconcile': workspaceReconcileSchema,
};

export function getStageOutputSchemaDocument(config: StageOutputSchemaConfig): JsonSchemaDocument {
  return schemaById[config.id];
}

export function validateStageOutputData(
  config: StageOutputSchemaConfig,
  data: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const validator = getStageOutputValidator(config.id);
  const isValid = validator(data);

  if (isValid) {
    return { ok: true };
  }

  return {
    ok: false,
    errors: (validator.errors ?? []).map((error) => formatValidationError(error)),
  };
}

export function serializeStageOutputSchema(config: StageOutputSchemaConfig): string {
  return `${JSON.stringify(getStageOutputSchemaDocument(config), null, 2)}\n`;
}

export function buildStageOutputInstructions(config: StageOutputSchemaConfig): string {
  switch (config.id) {
    case 'analysis-report':
      return [
        '## Structured Output Contract',
        'Ignore any earlier instruction that asks for line-based FINDING or DECISION output.',
        'Return ONLY a JSON object. Do not use markdown fences or explanatory prose.',
        'Shape:',
        '{',
        '  "summary": "short summary",',
        '  "findings": [',
        '    {',
        '      "severity": "critical|high|medium|low|info",',
        '      "category": "redundancy|wiring-gap|inconsistency|bug|missing-test|missing-doc|security|performance|isolation|dead-code|stale-dependency",',
        '      "title": "short finding title",',
        '      "description": "clear finding description",',
        '      "files": ["path/to/file.ts"]',
        '    }',
        '  ],',
        '  "decisions": [',
        '    {',
        '      "classification": "ANSWERED|INFERRED|DECIDED|AMBIGUOUS",',
        '      "question": "question text",',
        '      "context": "context text or null",',
        '      "answer": "answer text or null"',
        '    }',
        '  ]',
        '}',
        'Use empty arrays when there are no findings or decisions. Use null for decision context or answer when not applicable.',
      ].join('\n');
    case 'reproduction-report':
      return [
        '## Structured Output Contract',
        'Ignore any earlier instruction that asks for line-based FINDING output.',
        'Return ONLY a JSON object. Do not use markdown fences or explanatory prose.',
        'This stage is not complete unless `testFile` names the exact regression test file you changed in the workspace.',
        'Shape:',
        '{',
        '  "summary": "short summary",',
        '  "testFile": "path/to/regression.test.ts",',
        '  "reproductionSteps": [',
        '    "step 1",',
        '    "step 2"',
        '  ],',
        '  "findings": [',
        '    {',
        '      "severity": "critical|high|medium|low|info",',
        '      "category": "redundancy|wiring-gap|inconsistency|bug|missing-test|missing-doc|security|performance|isolation|dead-code|stale-dependency",',
        '      "title": "short finding title",',
        '      "description": "clear finding description",',
        '      "files": ["path/to/file.ts"]',
        '    }',
        '  ],',
        '  "decisions": [',
        '    {',
        '      "classification": "ANSWERED|INFERRED|DECIDED|AMBIGUOUS",',
        '      "question": "question text",',
        '      "context": "context text or null",',
        '      "answer": "answer text or null"',
        '    }',
        '  ]',
        '}',
        'Use empty arrays when there are no findings or decisions.',
      ].join('\n');
    case 'slice-plan':
      return [
        '## Structured Output Contract',
        'Ignore any earlier instruction that asks for SLICE/TEXT line formatting.',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Shape:',
        '{',
        '  "summary": "short planning summary",',
        '  "slices": [',
        '    {',
        '      "title": "slice title",',
        '      "description": "what the slice accomplishes",',
        '      "findings": ["existing-finding-id-1"],',
        '      "files": ["path/to/file.ts"],',
        '      "tests": ["path/to/test.test.ts"],',
        '      "dependencies": [1],',
        '      "legacyPaths": [',
        '        { "path": "path/to/old.ts", "reason": "why it becomes removable" }',
        '      ]',
        '    }',
        '  ]',
        '}',
        'Each entry in "findings" must be an exact HELIX finding ID copied from the Findings to Address section (for example "a9fc9fd5").',
        'Do not use slugified titles, paraphrases, or newly invented IDs.',
        'Dependencies should be 1-based slice numbers and [] when there are no dependencies.',
        'Every slice must include at least one required test in "tests".',
      ].join('\n');
    case 'plan-c-with-divergence':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'This is a convergent plan synthesized from two candidate plans.',
        'Shape:',
        '{',
        '  "summary": "short planning summary",',
        '  "slices": [',
        '    {',
        '      "title": "slice title",',
        '      "description": "what the slice accomplishes",',
        '      "findings": ["existing-finding-id-1"],',
        '      "files": ["path/to/file.ts"],',
        '      "tests": ["path/to/test.test.ts"],',
        '      "dependencies": [1],',
        '      "legacyPaths": [',
        '        { "path": "path/to/old.ts", "reason": "why it becomes removable" }',
        '      ]',
        '    }',
        '  ],',
        '  "divergenceNotes": "optional — markdown summarizing key divergences between the two candidate plans"',
        '}',
        'Each entry in "findings" must be an exact HELIX finding ID copied from the Findings to Address section.',
        'Dependencies should be 1-based slice numbers and [] when there are no dependencies.',
        'Every slice must include at least one required test in "tests".',
        'The "divergenceNotes" field is optional. Include it when the two candidate plans disagreed on approach, ordering, or scope.',
      ].join('\n');
    case 'plan-review':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Review EVERY slice in the proposed plan and emit one sliceAssessments entry per slice.',
        'Use "approved" for slices that should remain intact.',
        'Use "revise" only when that slice still needs a blocking change before the plan can pass.',
        'Use advisory findings for non-blocking polish or later follow-up only.',
        'Use deferredFindings only for HELIX finding IDs that are explicitly safe to backlog without weakening dependency order, seam stability, security/isolation, or required regression coverage.',
        'Shape:',
        '{',
        '  "summary": "short review summary",',
        '  "findings": [',
        '    {',
        '      "disposition": "blocking|advisory",',
        '      "severity": "critical|high|medium|low|info",',
        '      "category": "redundancy|wiring-gap|inconsistency|bug|missing-test|missing-doc|security|performance|isolation|dead-code|stale-dependency",',
        '      "title": "short finding title",',
        '      "description": "clear finding description",',
        '      "files": ["path/to/file.ts"]',
        '    }',
        '  ],',
        '  "sliceAssessments": [',
        '    {',
        '      "sliceNumber": 1,',
        '      "verdict": "approved|revise",',
        '      "rationale": "why this slice is approved or what must change",',
        '      "requiredTestAmendments": ["path/to/test.ts - why stronger coverage is required"]',
        '    }',
        '  ],',
        '  "deferredFindings": [',
        '    {',
        '      "findingId": "existing-finding-id-1",',
        '      "reason": "why this can safely move to backlog"',
        '    }',
        '  ],',
        '  "decisions": [',
        '    {',
        '      "classification": "ANSWERED|INFERRED|DECIDED|AMBIGUOUS",',
        '      "question": "question text",',
        '      "context": "context text or null",',
        '      "answer": "answer text or null"',
        '    }',
        '  ]',
        '}',
        'Use empty arrays when there are no findings, deferred findings, required test amendments, or decisions.',
      ].join('\n');
    case 'impact-analysis':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Shape:',
        '{',
        '  "dependentFiles": ["path/to/dependent.ts"],',
        '  "affectedTests": ["path/to/test.test.ts"],',
        '  "riskLevel": "low|medium|high",',
        '  "notes": "brief impact summary"',
        '}',
      ].join('\n');
    case 'oracle-review':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Shape:',
        '{',
        '  "summary": "short oracle summary",',
        '  "assessments": [',
        '    {',
        '      "findingId": "existing-finding-id",',
        '      "verdict": "confirm|challenge|reprioritize",',
        '      "rationale": "why you voted this way",',
        '      "severity": null,',
        '      "horizon": "immediate|next|near-term|long-term|null"',
        '    }',
        '  ],',
        '  "newFindings": [',
        '    {',
        '      "severity": "critical|high|medium|low|info",',
        '      "category": "redundancy|wiring-gap|inconsistency|bug|missing-test|missing-doc|security|performance|isolation|dead-code|stale-dependency",',
        '      "title": "short finding title",',
        '      "description": "clear finding description",',
        '      "files": ["path/to/file.ts"]',
        '    }',
        '  ],',
        '  "decisions": [',
        '    {',
        '      "classification": "ANSWERED|INFERRED|DECIDED|AMBIGUOUS",',
        '      "question": "question text",',
        '      "context": "context text or null",',
        '      "answer": "answer text or null"',
        '    }',
        '  ]',
        '}',
        'Use empty arrays when there are no assessments, new findings, or decisions.',
        'Use null for severity when verdict is not reprioritize. Use one of "critical", "high", "medium", "low", or "info" only when you are changing severity.',
        'Use "horizon" to classify when the finding should be addressed: "immediate" or "next" stay in the current implementation plan; "near-term" and "long-term" become explicit follow-up work for later.',
      ].join('\n');
    case 'workspace-reconcile':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Emit one assessment for EVERY out-of-scope file listed in the prompt.',
        'Use "ignore" only when the file is clearly local tool state, generated scratch/cache output, or otherwise irrelevant to the current slice and safe to leave unstaged.',
        'Use "block" for any substantive code, tests, docs, configs, or anything uncertain. When in doubt, choose "block".',
        'Shape:',
        '{',
        '  "summary": "short reconciliation summary",',
        '  "assessments": [',
        '    {',
        '      "file": "path/to/file",',
        '      "disposition": "ignore|block",',
        '      "rationale": "why this file is safe to ignore or must block"',
        '    }',
        '  ]',
        '}',
        'Use an empty array only when there are no out-of-scope files to classify.',
      ].join('\n');
    case 'failure-advisory':
      return [
        '## Structured Output Contract',
        'Return ONLY a JSON object. Do not use markdown fences or commentary.',
        'Do not default to narrowing scope. Prefer guidance that helps the existing stage converge unless a human truly needs to intervene first.',
        'Recommend "retry-stage" only when the next attempt can likely succeed without narrowing scope or taking unsafe shortcuts.',
        'Recommend "promote-stage" when the current stage already gathered enough evidence to produce a safe minimal structured result without another model pass.',
        'Recommend "pause-and-resume" when manual intervention, environment changes, or repeated failure makes an immediate retry unlikely to help.',
        'Set "promptGuidance" to a concise imperative instruction block only when retrying the stage is worthwhile. Use null when the operator should act first.',
        'Emit at least one concrete operator action.',
        'If the stage failed because HELIX stopped it for efficiency reasons (turn cap, shell exploration budget, repeated lookup block, or similar), set "budgetRecommendation" to explicit one-retry ceilings only when more budget is justified. Otherwise set it to null.',
        'Shape:',
        '{',
        '  "summary": "short failure summary",',
        '  "suspectedCause": "most likely blocker",',
        '  "recommendedAction": "retry-stage|synthesize-stage|switch-model|continue-immediate-only|promote-stage|pause-and-resume",',
        '  "promptGuidance": "concise retry instructions or null",',
        '  "operatorActions": ["manual step 1"],',
        '  "budgetRecommendation": {',
        '    "rationale": "why extra budget is justified",',
        '    "targetTurns": 24,',
        '    "explorationTurns": 8,',
        '    "shellWarnFloor": null,',
        '    "shellAbortFloor": 26',
        '  } | null',
        '}',
      ].join('\n');
  }
}

function getStageOutputValidator(schemaId: StageOutputSchemaId): ValidateFunction<unknown> {
  const cached = validatorCache.get(schemaId);
  if (cached) {
    return cached;
  }

  const validator = ajv.compile(stripSchemaDialectKeywords(schemaById[schemaId]));
  validatorCache.set(schemaId, validator);
  return validator;
}

function stripSchemaDialectKeywords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSchemaDialectKeywords(entry));
  }

  if (value == null || typeof value !== 'object') {
    return value;
  }

  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$schema') {
      continue;
    }
    clone[key] = stripSchemaDialectKeywords(entry);
  }
  return clone;
}

function formatValidationError(error: ErrorObject): string {
  const path = error.instancePath || '/';

  if (
    error.keyword === 'additionalProperties' &&
    typeof error.params === 'object' &&
    error.params != null &&
    'additionalProperty' in error.params
  ) {
    return `${path}: unexpected property "${String(error.params.additionalProperty)}"`;
  }

  if (
    error.keyword === 'required' &&
    typeof error.params === 'object' &&
    error.params != null &&
    'missingProperty' in error.params
  ) {
    return `${path}: missing required property "${String(error.params.missingProperty)}"`;
  }

  return `${path}: ${error.message ?? 'invalid value'}`;
}
