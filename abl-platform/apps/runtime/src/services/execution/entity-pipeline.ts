/**
 * Entity Extraction Pipeline Orchestrator.
 *
 * Orchestrates phases 1-3 of the entity lifecycle:
 *   Phase 1: Extract — Run JS extraction (Tier 1) for JS-extractable entity types
 *   Phase 2: Normalize — Apply synonym resolution for enum entities
 *   Phase 3: Validate (intrinsic) — Run intrinsic validation for each extracted value
 *
 * Returns an ObservationSet containing all successfully extracted observations.
 */

import { createLogger } from '@abl/compiler/platform';
import type { EntityDefinitionIR } from '@abl/compiler/platform';

import {
  createObservationSet,
  addObservation,
  type ObservationSet,
  type EntityObservation,
} from './entity-observations.js';
import { extractWithJSLibs, isJSExtractableType, type JSExtractionField } from './js-extraction.js';
import { normalizeEnumValue } from './extraction-validation.js';
import { validateIntrinsic } from './intrinsic-validation.js';

export interface EntityExtractionContext {
  referenceInstant?: Date;
  timezone?: string;
}

const log = createLogger('entity-pipeline');

/**
 * Maximum input length for entity extraction.
 * Inputs longer than this skip JS extraction to avoid excessive regex/parsing cost.
 * Most real user messages are well under 1 KB; 10 KB accommodates paste-heavy inputs.
 */
const MAX_EXTRACTION_INPUT_LENGTH = 10_000;

/**
 * Run phases 1-3 of the entity extraction pipeline on a user message.
 *
 * 1. Extract values from the message using Tier 1 JS libraries
 * 2. Normalize enum values via synonym resolution
 * 3. Validate each extracted value against intrinsic entity-type rules
 *
 * @param userMessage - The raw user utterance
 * @param entities    - Entity definitions from the agent IR
 * @param locale      - BCP-47 locale (e.g. 'en', 'en-US')
 * @param turn        - Current conversation turn number
 * @returns ObservationSet with extracted and validated observations
 */
export function extractEntityObservations(
  userMessage: string,
  entities: EntityDefinitionIR[],
  locale: string,
  turn: number,
  context: EntityExtractionContext = {},
): ObservationSet {
  let observationSet = createObservationSet(turn);

  // Early return for empty input
  if (!userMessage || !userMessage.trim() || entities.length === 0) {
    return observationSet;
  }

  // Guard: skip JS extraction for unreasonably long inputs
  if (userMessage.length > MAX_EXTRACTION_INPUT_LENGTH) {
    log.warn('User message exceeds max extraction length, skipping JS extraction', {
      length: userMessage.length,
      maxLength: MAX_EXTRACTION_INPUT_LENGTH,
    });
    return observationSet;
  }

  // Phase 1: Filter to JS-extractable entity types and extract
  const jsExtractableEntities = entities.filter((e) => isJSExtractableType(e.type));

  if (jsExtractableEntities.length === 0) {
    log.debug('No JS-extractable entities in definitions', {
      entityCount: entities.length,
      types: entities.map((e) => e.type),
    });
    return observationSet;
  }

  const jsFields: JSExtractionField[] = jsExtractableEntities.map((e) => ({
    name: e.name,
    type: e.type,
    values: e.values,
    synonyms: e.synonyms,
  }));

  const extracted = extractWithJSLibs(userMessage, jsFields, locale, context);

  log.debug('JS extraction results', {
    fieldsRequested: jsFields.length,
    fieldsExtracted: Object.keys(extracted).length,
    extractedKeys: Object.keys(extracted),
  });

  // Phases 2 & 3: Normalize + validate each extracted value
  for (const entity of entities) {
    const rawValue = extracted[entity.name];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    // Handle multi-value extraction (e.g., multiple dates or emails)
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const singleValue of values) {
      let normalizedValue: unknown = singleValue;

      // Phase 2: Synonym resolution for enum entities
      if (entity.type === 'enum' && entity.values && entity.values.length > 0) {
        const enumResolved = normalizeEnumValue(
          String(singleValue),
          entity.values,
          entity.synonyms,
        );
        if (enumResolved !== null) {
          normalizedValue = enumResolved;
        }
      }

      // Phase 3: Intrinsic validation
      const validationResult = validateIntrinsic(
        entity.type,
        normalizedValue,
        {
          values: entity.values,
          synonyms: entity.synonyms,
          pattern: entity.pattern,
        },
        {
          locale,
          referenceInstant: context.referenceInstant,
          timezone: context.timezone,
        },
      );

      const observation: EntityObservation = {
        entityName: entity.name,
        entityType: entity.type,
        value: validationResult.normalized ?? normalizedValue,
        confidence: 1.0,
        intrinsicValid: validationResult.valid,
        intrinsicError: validationResult.error,
        sensitive: entity.sensitive,
      };

      observationSet = addObservation(observationSet, observation);
    }
  }

  log.debug('Entity pipeline complete', {
    turn,
    observationsCreated: Object.values(observationSet.entities).reduce(
      (sum, obs) => sum + obs.length,
      0,
    ),
  });

  return observationSet;
}
