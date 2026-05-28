/**
 * Entity Observations — Types and pure-function store.
 *
 * Entities are utterance-scoped: extracted from every user message and
 * replaced each turn.  This module defines the observation types and
 * pure helper functions for managing observation sets immutably.
 *
 * All functions return NEW objects — no mutation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entity value extracted from one utterance. */
export interface EntityObservation {
  entityName: string;
  entityType: string;
  value: unknown;
  confidence: number;
  /** The raw text span in the user message that produced this observation. */
  span?: string;
  /** Whether the value passed intrinsic (type-level) validation. */
  intrinsicValid?: boolean;
  /** If intrinsic validation failed, the human-readable reason. */
  intrinsicError?: string;
  /** Whether this entity carries PII and should be masked in traces/logs. */
  sensitive?: boolean;
}

/**
 * A set of observations for a single turn.
 *
 * `entities` is keyed by entity name; each key maps to an array of
 * observations (supporting multi-value entities such as multiple
 * phone numbers in one utterance).
 */
export interface ObservationSet {
  entities: Record<string, EntityObservation[]>;
  turn: number;
}

/**
 * Serialization-safe alias for ObservationSet.
 *
 * ObservationSet already uses only plain objects and arrays (no Set/Map),
 * so this alias exists purely for documentary clarity at serialization
 * boundaries.
 */
export type SerializedObservationSet = ObservationSet;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Create an empty observation set. */
export function createObservationSet(turn: number = 0): ObservationSet {
  return { entities: {}, turn };
}

/**
 * Return a new ObservationSet with the given observation appended.
 * Does NOT mutate the original set.
 */
export function addObservation(
  set: ObservationSet,
  observation: EntityObservation,
): ObservationSet {
  const key = observation.entityName;
  const existing = set.entities[key] ?? [];
  return {
    ...set,
    entities: {
      ...set.entities,
      [key]: [...existing, observation],
    },
  };
}

/** Return all observations for a given entity name, or an empty array. */
export function getObservationsForEntity(
  set: ObservationSet,
  entityName: string,
): EntityObservation[] {
  return set.entities[entityName] ?? [];
}

/**
 * Return all observations whose `entityType` matches, collected across
 * every entity name in the set.
 */
export function getObservationsForType(
  set: ObservationSet,
  entityType: string,
): EntityObservation[] {
  const result: EntityObservation[] = [];
  for (const observations of Object.values(set.entities)) {
    for (const obs of observations) {
      if (obs.entityType === entityType) {
        result.push(obs);
      }
    }
  }
  return result;
}

/**
 * Return a fresh empty observation set with the given turn number.
 * Used at the start of each new user utterance (utterance-scoped reset).
 */
export function clearObservations(_set: ObservationSet, newTurn: number): ObservationSet {
  return createObservationSet(newTurn);
}

// ---------------------------------------------------------------------------
// PII masking
// ---------------------------------------------------------------------------

/**
 * Mask a sensitive value for safe inclusion in traces and logs.
 *
 * Masking strategy by type:
 *   email: "j***@example.com" (first char + mask + domain)
 *   phone: "+1***4567" (country code + mask + last 4 digits)
 *   default: "****" (full redaction)
 */
export function maskSensitiveValue(value: unknown, entityType: string): string {
  const str = typeof value === 'string' ? value : String(value);

  switch (entityType.toLowerCase()) {
    case 'email': {
      const atIdx = str.indexOf('@');
      if (atIdx > 0) return str[0] + '***' + str.slice(atIdx);
      return '***';
    }
    case 'phone': {
      const digits = str.replace(/\D/g, '');
      if (digits.length >= 4)
        return str.slice(0, str.length - 4).replace(/\d/g, '*') + str.slice(-4);
      return '****';
    }
    default:
      return '****';
  }
}
