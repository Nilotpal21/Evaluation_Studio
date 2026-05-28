/**
 * Organization Profile Schema
 *
 * Zod validation schema for LLM-generated organization profiles.
 * Used in Phase 2: LLM-Assisted Org Profile Generation.
 */

import { z } from 'zod';

/**
 * Department boundary schema
 * Describes products that users often confuse and why
 */
export const DepartmentBoundarySchema = z.object({
  product1: z
    .string()
    .min(1, 'Product 1 is required')
    .max(100, 'Product 1 name too long')
    .describe('First product ID'),
  product2: z
    .string()
    .min(1, 'Product 2 is required')
    .max(100, 'Product 2 name too long')
    .describe('Second product ID'),
  reasoning: z
    .string()
    .min(10, 'Reasoning must be descriptive')
    .max(500, 'Reasoning too long')
    .describe('Explanation of why these products are often confused'),
});

/**
 * Organization Profile Schema
 * Validates LLM-generated organization profiles
 */
export const OrgProfileSchema = z.object({
  organizationName: z
    .string()
    .min(1, 'Organization name is required')
    .max(200, 'Organization name too long')
    .describe('Full organization name'),

  industry: z
    .string()
    .min(1, 'Industry is required')
    .max(100, 'Industry name too long')
    .describe('Primary industry (e.g., Financial Services, Healthcare)'),

  keyTerms: z
    .array(z.string().max(50, 'Key term too long'))
    .min(1, 'At least one key term is required')
    .max(20, 'Too many key terms (max 20)')
    .describe('Organization-specific terminology (10-15 recommended)'),

  acronyms: z
    .record(
      z.string().min(1).max(10, 'Acronym too long'),
      z.string().min(1).max(100, 'Acronym expansion too long'),
    )
    .describe('Acronym → full expansion mapping (e.g., {"APR": "Annual Percentage Rate"})')
    .refine((acronyms) => Object.keys(acronyms).length <= 50, {
      message: 'Too many acronyms (max 50)',
    }),

  departmentBoundaries: z
    .array(DepartmentBoundarySchema)
    .max(50, 'Too many department boundaries (max 50)')
    .describe('Product pairs that users often confuse (2-3 recommended)')
    .optional()
    .default([]),

  productSpecificNames: z
    .record(
      z.string().min(1).max(100, 'Product ID too long'),
      z
        .array(z.string().max(100, 'Product-specific name too long'))
        .max(10, 'Too many names per product'),
    )
    .describe(
      'Product ID → organization-specific names (e.g., {"credit-cards": ["Charge Cards", "Plastics"]})',
    )
    .refine((names) => Object.keys(names).length <= 100, {
      message: 'Too many products (max 100)',
    })
    .optional()
    .default({}),
});

export type OrgProfile = z.infer<typeof OrgProfileSchema>;
export type DepartmentBoundary = z.infer<typeof DepartmentBoundarySchema>;

/**
 * Validates an organization profile object
 * @param data - Raw data to validate (typically from LLM)
 * @returns Validated and typed OrgProfile
 * @throws ZodError with detailed field-level validation errors
 */
export function validateOrgProfile(data: unknown): OrgProfile {
  return OrgProfileSchema.parse(data);
}

/**
 * Safely validates an organization profile object
 * @param data - Raw data to validate
 * @returns { success: true, data } or { success: false, error }
 */
export function safeValidateOrgProfile(data: unknown): z.SafeParseReturnType<unknown, OrgProfile> {
  return OrgProfileSchema.safeParse(data);
}
