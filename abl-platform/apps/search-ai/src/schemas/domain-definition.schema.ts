/**
 * Domain Definition Schema
 *
 * Zod validation schema for LLM-generated custom domain definitions.
 * Used in Phase 3: Domain Auto-Generation.
 */

import { z } from 'zod';

/**
 * Category schema
 */
export const CategorySchema = z.object({
  id: z
    .string()
    .min(1, 'Category ID is required')
    .max(100, 'Category ID too long')
    .regex(/^[a-z0-9-]+$/, 'Category ID must be kebab-case')
    .describe('Unique category identifier in kebab-case'),
  name: z.string().min(1, 'Category name is required').max(100, 'Category name too long'),
  department: z.string().min(1, 'Department is required').max(100, 'Department name too long'),
});

/**
 * Sub-product schema
 */
export const SubProductSchema = z.object({
  id: z
    .string()
    .min(1, 'Sub-product ID is required')
    .max(100, 'Sub-product ID too long')
    .regex(/^[a-z0-9-]+$/, 'Sub-product ID must be kebab-case'),
  name: z.string().min(1, 'Sub-product name is required').max(100, 'Sub-product name too long'),
  disambiguationKeywords: z
    .array(z.string().max(50, 'Keyword too long'))
    .min(1, 'At least one disambiguation keyword required')
    .max(10, 'Too many keywords (max 10)'),
});

/**
 * Product schema
 */
export const ProductSchema = z.object({
  id: z
    .string()
    .min(1, 'Product ID is required')
    .max(100, 'Product ID too long')
    .regex(/^[a-z0-9-]+$/, 'Product ID must be kebab-case')
    .describe('Unique product identifier in kebab-case'),
  name: z.string().min(1, 'Product name is required').max(100, 'Product name too long'),
  categoryId: z
    .string()
    .min(1, 'Category ID is required')
    .describe('References a category defined in the domain'),
  department: z.string().min(1, 'Department is required').max(100, 'Department name too long'),
  subDepartment: z
    .string()
    .min(1, 'Sub-department is required')
    .max(100, 'Sub-department name too long'),
  disambiguationKeywords: z
    .array(z.string().max(50, 'Keyword too long'))
    .max(10, 'Too many keywords (max 10)')
    .optional()
    .default([]),
  organizationSpecificNames: z
    .array(z.string().max(100, 'Name too long'))
    .max(10, 'Too many names (max 10)')
    .optional()
    .default([]),
  subProducts: z.array(SubProductSchema).max(10, 'Too many sub-products (max 10)').optional(),
});

/**
 * Attribute extraction schema
 */
/**
 * Validate a regex pattern string: must compile, must not be empty,
 * and must not use greedy unanchored wildcards.
 *
 * H16 fix: reject empty strings
 * H17 fix: length cap moved here (removed conflicting .max(500))
 * H18 fix: escaped-dot-aware greedy check (counts consecutive backslashes)
 */
function isValidRegexPattern(pattern: string): boolean {
  // H16: reject empty patterns
  if (pattern.length === 0) return false;
  // H17: single length check (was 200 here + 500 in Zod — now 200 only)
  if (pattern.length > 200) return false;

  try {
    new RegExp(pattern);
  } catch {
    return false; // Fails to compile
  }

  // H18 fix: Check for greedy .* or .+ that are NOT preceded by an odd number
  // of backslashes (which would mean the dot is escaped: \\.)
  // This avoids false-positiving on patterns like "version\\.\\*"
  for (let i = 0; i < pattern.length - 1; i++) {
    if (pattern[i] === '.' && (pattern[i + 1] === '*' || pattern[i + 1] === '+')) {
      // Check if the dot is escaped by counting preceding backslashes
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === '\\') {
        backslashes++;
        j--;
      }
      // Odd backslashes = dot is escaped (e.g., \\.* means literal dot + star)
      // Even backslashes = dot is NOT escaped (e.g., \\\\.* = escaped backslash + greedy .*)
      if (backslashes % 2 === 0) {
        // Greedy .* or .+ — reject unless lazy (followed by ?)
        if (i + 2 >= pattern.length || pattern[i + 2] !== '?') {
          return false;
        }
      }
    }
  }

  return true;
}

export const AttributeExtractionSchema = z.object({
  method: z
    .enum(['regex', 'llm', 'hybrid'])
    .describe('Extraction method: regex (pattern-based), llm (language model), or hybrid (both)'),
  patterns: z
    .array(
      z.string().refine(isValidRegexPattern, {
        message:
          'Invalid regex pattern: must compile, non-empty, max 200 chars, no greedy .* or .+',
      }),
    )
    .max(10, 'Too many patterns (max 10)')
    .optional()
    .describe('Regex patterns for extraction (required for regex/hybrid methods)'),
  keywords: z
    .array(z.string().max(50, 'Keyword too long'))
    .max(20, 'Too many keywords (max 20)')
    .optional()
    .describe('Keywords/hints for LLM extraction (required for llm/hybrid methods)'),
});

/**
 * Attribute organization context schema
 */
export const AttributeOrganizationContextSchema = z.object({
  typicalRange: z
    .string()
    .max(100, 'Typical range description too long')
    .optional()
    .describe('Typical range for this attribute in this organization (e.g., "10-25%")'),
  aliases: z
    .array(z.string().max(100, 'Alias too long'))
    .max(10, 'Too many aliases (max 10)')
    .optional()
    .describe('Organization-specific names for this attribute'),
});

/**
 * Attribute schema
 */
export const AttributeSchema = z.object({
  id: z
    .string()
    .min(1, 'Attribute ID is required')
    .max(100, 'Attribute ID too long')
    .regex(/^[a-z0-9-]+$/, 'Attribute ID must be kebab-case')
    .describe('Unique attribute identifier in kebab-case'),
  name: z.string().min(1, 'Attribute name is required').max(100, 'Attribute name too long'),
  dataType: z
    .enum(['percentage', 'currency', 'date', 'duration', 'identifier', 'string', 'number'])
    .describe('Data type of the attribute'),
  applicableTo: z
    .array(z.string().max(100, 'Product ID too long'))
    .max(100, 'Too many applicable products (max 100)')
    .optional()
    .default([])
    .describe('Product IDs this attribute applies to (empty = all products)'),
  notApplicableTo: z
    .array(z.string().max(100, 'Product ID too long'))
    .max(100, 'Too many excluded products (max 100)')
    .optional()
    .default([])
    .describe('Product IDs this attribute does NOT apply to'),
  extraction: AttributeExtractionSchema.describe('How to extract this attribute from documents'),
  organizationContext: AttributeOrganizationContextSchema.optional().describe(
    'Organization-specific context for this attribute',
  ),
});

/**
 * Department boundary schema
 */
export const DomainDepartmentBoundarySchema = z.object({
  product1: z.string().min(1, 'Product 1 is required').max(100, 'Product ID too long'),
  product2: z.string().min(1, 'Product 2 is required').max(100, 'Product ID too long'),
  reasoning: z.string().min(10, 'Reasoning must be descriptive').max(500, 'Reasoning too long'),
});

/**
 * Domain Definition Schema
 * Validates LLM-generated custom domain definitions
 */
export const DomainDefinitionSchema = z.object({
  name: z
    .string()
    .min(1, 'Domain name is required')
    .max(100, 'Domain name too long')
    .describe('Domain name (e.g., "b2b-saas-hr-compliance")'),

  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Version must be semver format (e.g., 1.0.0)')
    .describe('Semantic version (e.g., "1.0.0")'),

  industry: z
    .string()
    .min(1, 'Industry is required')
    .max(100, 'Industry name too long')
    .describe('Target industry for this domain'),

  categories: z
    .array(CategorySchema)
    .min(1, 'At least one category is required')
    .max(20, 'Too many categories (max 20)')
    .describe('Product categories (5-10 recommended)'),

  products: z
    .array(ProductSchema)
    .min(1, 'At least one product is required')
    .max(100, 'Too many products (max 100)')
    .describe('Products within categories (15-30 recommended)'),

  attributes: z
    .array(AttributeSchema)
    .min(1, 'At least one attribute is required')
    .max(200, 'Too many attributes (max 200)')
    .describe('Extractable attributes (50-100 recommended)'),

  departmentBoundaries: z
    .array(DomainDepartmentBoundarySchema)
    .max(50, 'Too many department boundaries (max 50)')
    .optional()
    .default([])
    .describe('Product pairs that are often confused'),
});

export type DomainDefinition = z.infer<typeof DomainDefinitionSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Product = z.infer<typeof ProductSchema>;
export type SubProduct = z.infer<typeof SubProductSchema>;
export type Attribute = z.infer<typeof AttributeSchema>;
export type AttributeExtraction = z.infer<typeof AttributeExtractionSchema>;
export type AttributeOrganizationContext = z.infer<typeof AttributeOrganizationContextSchema>;
export type DomainDepartmentBoundary = z.infer<typeof DomainDepartmentBoundarySchema>;

/**
 * Validates a domain definition object
 * @param data - Raw data to validate (typically from LLM)
 * @returns Validated and typed DomainDefinition
 * @throws ZodError with detailed field-level validation errors
 */
export function validateDomainDefinition(data: unknown): DomainDefinition {
  return DomainDefinitionSchema.parse(data);
}

/**
 * Safely validates a domain definition object
 * @param data - Raw data to validate
 * @returns { success: true, data } or { success: false, error }
 */
export function safeValidateDomainDefinition(
  data: unknown,
): z.SafeParseReturnType<unknown, DomainDefinition> {
  return DomainDefinitionSchema.safeParse(data);
}

/**
 * Validates that product references in the domain are consistent
 * - All categoryId references exist in categories array
 * - All applicableTo/notApplicableTo product references exist in products array
 * - No duplicate IDs
 */
export function validateDomainConsistency(domain: DomainDefinition): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Extract all category IDs
  const categoryIds = new Set(domain.categories.map((c) => c.id));

  // Check for duplicate category IDs
  if (categoryIds.size !== domain.categories.length) {
    errors.push('Duplicate category IDs found');
  }

  // Extract all product IDs (including sub-products)
  const productIds = new Set<string>();
  for (const product of domain.products) {
    if (productIds.has(product.id)) {
      errors.push(`Duplicate product ID: ${product.id}`);
    }
    productIds.add(product.id);

    // Check categoryId reference
    if (!categoryIds.has(product.categoryId)) {
      errors.push(`Product ${product.id} references non-existent category: ${product.categoryId}`);
    }

    // Check sub-product IDs
    if (product.subProducts) {
      for (const subProduct of product.subProducts) {
        if (productIds.has(subProduct.id)) {
          errors.push(`Duplicate sub-product ID: ${subProduct.id}`);
        }
        productIds.add(subProduct.id);
      }
    }
  }

  // Validate attribute product references
  for (const attribute of domain.attributes) {
    for (const productId of attribute.applicableTo || []) {
      if (!productIds.has(productId)) {
        errors.push(
          `Attribute ${attribute.id} references non-existent product in applicableTo: ${productId}`,
        );
      }
    }

    for (const productId of attribute.notApplicableTo || []) {
      if (!productIds.has(productId)) {
        errors.push(
          `Attribute ${attribute.id} references non-existent product in notApplicableTo: ${productId}`,
        );
      }
    }

    // Validate extraction method has required fields
    if (
      (attribute.extraction.method === 'regex' || attribute.extraction.method === 'hybrid') &&
      (!attribute.extraction.patterns || attribute.extraction.patterns.length === 0)
    ) {
      errors.push(`Attribute ${attribute.id} uses regex/hybrid but has no patterns`);
    }

    if (
      (attribute.extraction.method === 'llm' || attribute.extraction.method === 'hybrid') &&
      (!attribute.extraction.keywords || attribute.extraction.keywords.length === 0)
    ) {
      errors.push(`Attribute ${attribute.id} uses llm/hybrid but has no keywords`);
    }
  }

  // Validate department boundaries
  for (const boundary of domain.departmentBoundaries || []) {
    if (!productIds.has(boundary.product1)) {
      errors.push(`Department boundary references non-existent product1: ${boundary.product1}`);
    }
    if (!productIds.has(boundary.product2)) {
      errors.push(`Department boundary references non-existent product2: ${boundary.product2}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
