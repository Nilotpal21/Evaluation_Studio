/**
 * Kore Platform Entity Type Mapping
 *
 * Maps Kore.ai's 25+ platform entity types to ABL's composable type + semantics pairs.
 * Used for migration from the legacy intent-based platform to ABL.
 *
 * ABL uses 6 base storage types (string, number, date, email, phone, boolean)
 * plus an optional `semantics` field that tells the LLM what the value represents.
 */

import type { GatherFieldSemantics } from '../ir/schema.js';

export interface KoreEntityMapping {
  /** ABL base storage type */
  type: string;
  /** Semantic metadata for LLM extraction */
  semantics: GatherFieldSemantics;
}

/**
 * Complete mapping of Kore platform entity types to ABL type + semantics.
 * Key is the Kore entity type name (e.g. 'LOC_AIRPORT').
 */
export const KORE_ENTITY_MAP: Record<string, KoreEntityMapping> = {
  // --- Location entities ---
  LOC_AIRPORT: {
    type: 'string',
    semantics: { format: 'airport_code', lookup: 'iata_codes', kore_entity_type: 'LOC_AIRPORT' },
  },
  LOC_CITY: {
    type: 'string',
    semantics: { format: 'city_name', kore_entity_type: 'LOC_CITY' },
  },
  LOC_COUNTRY: {
    type: 'string',
    semantics: { format: 'country_name', kore_entity_type: 'LOC_COUNTRY' },
  },
  LOC_STATE: {
    type: 'string',
    semantics: { format: 'state_name', kore_entity_type: 'LOC_STATE' },
  },
  LOC_ZIPCODE: {
    type: 'string',
    semantics: { format: 'zip_code', kore_entity_type: 'LOC_ZIPCODE' },
  },
  LOC_ADDRESS: {
    type: 'string',
    semantics: {
      format: 'address',
      components: ['street', 'city', 'state', 'zip', 'country'],
      kore_entity_type: 'LOC_ADDRESS',
    },
  },

  // --- Date/Time entities ---
  DATE: {
    type: 'date',
    semantics: { format: 'date', kore_entity_type: 'DATE' },
  },
  TIME: {
    type: 'string',
    semantics: { format: 'time', kore_entity_type: 'TIME' },
  },
  DATETIME: {
    type: 'string',
    semantics: { format: 'datetime', kore_entity_type: 'DATETIME' },
  },
  DATE_PERIOD: {
    type: 'string',
    semantics: {
      format: 'date_range',
      components: ['start', 'end'],
      kore_entity_type: 'DATE_PERIOD',
    },
  },

  // --- Numeric entities ---
  NUMBER: {
    type: 'number',
    semantics: { kore_entity_type: 'NUMBER' },
  },
  CURRENCY: {
    type: 'number',
    semantics: { unit: 'currency', format: 'currency_amount', kore_entity_type: 'CURRENCY' },
  },
  PERCENTAGE: {
    type: 'number',
    semantics: { unit: 'percent', format: 'percentage', kore_entity_type: 'PERCENTAGE' },
  },
  QUANTITY: {
    type: 'number',
    semantics: { format: 'quantity', kore_entity_type: 'QUANTITY' },
  },

  // --- Contact entities ---
  EMAIL: {
    type: 'email',
    semantics: { kore_entity_type: 'EMAIL' },
  },
  PHONE: {
    type: 'phone',
    semantics: { kore_entity_type: 'PHONE' },
  },
  URL: {
    type: 'string',
    semantics: { format: 'url', kore_entity_type: 'URL' },
  },

  // --- Person entities ---
  PERSON_NAME: {
    type: 'string',
    semantics: {
      format: 'person_name',
      components: ['first', 'middle', 'last', 'title'],
      kore_entity_type: 'PERSON_NAME',
    },
  },

  // --- Organization entities ---
  COMPANY: {
    type: 'string',
    semantics: { format: 'company_name', kore_entity_type: 'COMPANY' },
  },

  // --- Measurement entities ---
  TEMPERATURE: {
    type: 'number',
    semantics: { unit: 'temperature', format: 'temperature', kore_entity_type: 'TEMPERATURE' },
  },
  DISTANCE: {
    type: 'number',
    semantics: { unit: 'distance', format: 'distance', kore_entity_type: 'DISTANCE' },
  },
  WEIGHT: {
    type: 'number',
    semantics: { unit: 'weight', format: 'weight', kore_entity_type: 'WEIGHT' },
  },
  AREA: {
    type: 'number',
    semantics: { unit: 'area', format: 'area', kore_entity_type: 'AREA' },
  },
  VOLUME: {
    type: 'number',
    semantics: { unit: 'volume', format: 'volume', kore_entity_type: 'VOLUME' },
  },
  SPEED: {
    type: 'number',
    semantics: { unit: 'speed', format: 'speed', kore_entity_type: 'SPEED' },
  },
  DURATION: {
    type: 'string',
    semantics: { format: 'duration', kore_entity_type: 'DURATION' },
  },

  // --- Other ---
  COLOR: {
    type: 'string',
    semantics: { format: 'color', kore_entity_type: 'COLOR' },
  },
  LANGUAGE: {
    type: 'string',
    semantics: { format: 'language', lookup: 'iso_639', kore_entity_type: 'LANGUAGE' },
  },
};

/**
 * Look up the ABL type + semantics pair for a Kore platform entity type.
 * Returns undefined if the entity type is not mapped.
 */
export function resolveKoreEntity(koreType: string): KoreEntityMapping | undefined {
  return KORE_ENTITY_MAP[koreType];
}

/**
 * Get all known Kore entity type names.
 */
export function getKoreEntityTypes(): string[] {
  return Object.keys(KORE_ENTITY_MAP);
}
