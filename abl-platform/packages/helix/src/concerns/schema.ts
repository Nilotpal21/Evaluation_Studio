import { z } from 'zod';

/**
 * Zod schemas for concern YAML files. Field names use the YAML's snake_case
 * convention; the loader maps these to camelCase TypeScript types.
 */

const severitySchema = z.enum(['critical', 'high', 'medium', 'low']);
const enforcementSchema = z.enum(['blocking', 'advisory']);

const detectorKindSchema = z.enum([
  'grep',
  'ast',
  'symbol-ref',
  'route',
  'schema',
  'impacted-test',
  'script',
  'model-review',
]);

const stageTypeSchema = z.enum([
  'bootstrap',
  'deep-scan',
  'oracle-analysis',
  'plan-generation',
  'manifest-compilation',
  'user-checkpoint',
  'implementation',
  'testing',
  'review',
  'bulk-review',
  'commit-checkpoint',
  'regression',
  'doc-sync',
  'reproduce',
  'root-cause',
  'security-audit',
  'ux-design-audit',
  'custom',
]);

const scopeSchema = z.object({
  globs: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).optional(),
});

const referencesSchema = z
  .object({
    docs: z.array(z.string().min(1)).optional(),
    tests: z.array(z.string().min(1)).optional(),
    related_concerns: z.array(z.string().min(1)).optional(),
  })
  .optional();

/**
 * Rubric alignment. Each Helix concern should reference the canonical
 * `docs/sdlc/change-review-rubric.md` concern it implements (1–16). The
 * narrative fields (protects / review_when / review_questions / proof_expected)
 * mirror the rubric's structure so model-review detectors and reviewers can
 * consume the same rubric language at audit time.
 */
const rubricConcernRefSchema = z.number().int().min(1).max(16);

const rubricFieldsSchema = {
  rubric_concern: rubricConcernRefSchema.optional(),
  protects: z.array(z.string().min(1)).optional(),
  review_when: z.array(z.string().min(1)).optional(),
  review_questions: z.array(z.string().min(1)).optional(),
  proof_expected: z.array(z.string().min(1)).optional(),
};

const outputSchemaSchema = z.object({
  rule_id: z.string().min(1),
  severity: z.string().min(1),
  location: z.object({
    file: z.string().min(1),
    line: z.union([z.string(), z.number()]),
  }),
  claim: z.string().min(1),
  reality: z.string().min(1),
  options: z.record(z.string()),
});

const detectorBaseSchema = {
  id: z.string().min(1),
  kind: detectorKindSchema,
  severity: severitySchema.optional(),
  message: z.string().min(1),
  fix_hint: z.string().optional(),
};

const detectorSchema = z.discriminatedUnion('kind', [
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('grep'),
    pattern: z.string().min(1),
    glob: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('ast'),
    query: z.string().min(1),
    assertion: z.string().optional(),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('symbol-ref'),
    symbol: z.string().min(1),
    assertion: z.string().optional(),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('route'),
    route_pattern: z.string().min(1),
    assertion: z.string().optional(),
    glob: z.string().optional(),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('schema'),
    schema_name: z.string().min(1),
    assertion: z.string().optional(),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('impacted-test'),
    assertion: z.string().min(1),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('script'),
    script: z.string().min(1),
  }),
  z.object({
    ...detectorBaseSchema,
    kind: z.literal('model-review'),
    guidance_ref: z.string().min(1),
    output_schema: outputSchemaSchema,
  }),
]);

const stageHookSchema = z.object({
  stage: stageTypeSchema,
  inject_checklist: z.boolean().optional(),
  as_review_lens: z.boolean().optional(),
});

const acceptanceSchema = z.object({
  when: z.string().min(1),
  requires: z.string().min(1),
});

export const concernFileSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'id must be kebab-case'),
  title: z.string().min(1),
  enforcement: enforcementSchema,
  severity_default: severitySchema,
  ...rubricFieldsSchema,
  scope: scopeSchema,
  references: referencesSchema,
  detectors: z.array(detectorSchema).min(1),
  stage_hooks: z.array(stageHookSchema).optional(),
  acceptance: z.array(acceptanceSchema).optional(),
});

export type ConcernFileRaw = z.infer<typeof concernFileSchema>;
export type ConcernDetectorRaw = ConcernFileRaw['detectors'][number];
