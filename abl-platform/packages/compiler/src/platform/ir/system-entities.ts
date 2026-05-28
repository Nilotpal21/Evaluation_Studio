/**
 * System Entity Definitions
 *
 * Built-in entity definitions for types that have intrinsic format-level
 * validation (email, phone, date, datetime, boolean, currency). These are
 * automatically available without explicit ENTITIES declarations.
 *
 * Each system entity has:
 * - A `__system_` prefixed name to avoid collisions with user-defined entities
 * - An `intrinsic_validation` string describing the format constraint
 * - Source set to 'system' to distinguish from user-defined entities
 */

import type { EntityDefinitionIR, EntityType } from './schema.js';

/**
 * The set of EntityType values that have built-in system definitions.
 */
const SYSTEM_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'email',
  'phone',
  'date',
  'datetime',
  'boolean',
  'currency',
]);

/**
 * Built-in system entity definitions with intrinsic validation.
 *
 * These 6 entity types have format-level validation that can be applied
 * without any user configuration. Non-system types (string, text, enum,
 * pattern, etc.) require explicit definitions to be validated.
 */
export const SYSTEM_ENTITY_DEFINITIONS: ReadonlyArray<EntityDefinitionIR> = [
  {
    name: '__system_email',
    type: 'email',
    intrinsic_validation: 'RFC 5322 compliant email format: local@domain.tld',
    source: 'system',
  },
  {
    name: '__system_phone',
    type: 'phone',
    intrinsic_validation:
      'Valid phone number: minimum 7 digits, optional country code prefix (+1, +44, etc.)',
    source: 'system',
  },
  {
    name: '__system_date',
    type: 'date',
    intrinsic_validation: 'Resolves to a real calendar date (YYYY-MM-DD)',
    source: 'system',
  },
  {
    name: '__system_datetime',
    type: 'datetime',
    intrinsic_validation: 'Resolves to a real calendar date and time (ISO 8601)',
    source: 'system',
  },
  {
    name: '__system_boolean',
    type: 'boolean',
    values: ['true', 'false', 'yes', 'no'],
    intrinsic_validation: 'Resolves to true or false',
    source: 'system',
  },
  {
    name: '__system_currency',
    type: 'currency',
    intrinsic_validation: 'Valid numeric amount with optional currency symbol or ISO 4217 code',
    source: 'system',
  },
];

/**
 * Look up the system entity definition for a given EntityType.
 *
 * @param entityType - The entity type string to look up
 * @returns The system EntityDefinitionIR if the type has built-in validation, or undefined
 */
export function getSystemEntityDefinition(entityType: string): EntityDefinitionIR | undefined {
  return SYSTEM_ENTITY_DEFINITIONS.find((def) => def.type === entityType);
}

/**
 * Check whether a given entity type has a built-in system definition.
 *
 * @param entityType - The entity type string to check
 * @returns true if this type has intrinsic validation (email, phone, date, datetime, boolean, currency)
 */
export function isSystemEntityType(entityType: string): boolean {
  return SYSTEM_ENTITY_TYPES.has(entityType as EntityType);
}
