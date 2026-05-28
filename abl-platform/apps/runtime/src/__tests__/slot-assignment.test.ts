import { describe, it, expect } from 'vitest';
import {
  createObservationSet,
  addObservation,
  type EntityObservation,
} from '../services/execution/entity-observations.js';
import {
  assignObservationsToSlots,
  buildDisambiguationPrompt,
  buildClarificationMessage,
  type SlotTarget,
  type ClarificationNeeded,
  type DisambiguationNeeded,
  type SlotAssignmentResult,
} from '../services/execution/slot-assignment.js';

describe('slot-assignment', () => {
  // ---- Shared fixtures ----

  const jfkObs: EntityObservation = {
    entityName: 'airport_code',
    entityType: 'airport',
    value: 'JFK',
    confidence: 0.95,
    span: 'JFK',
    intrinsicValid: true,
  };

  const laxObs: EntityObservation = {
    entityName: 'airport_code',
    entityType: 'airport',
    value: 'LAX',
    confidence: 0.92,
    span: 'LAX',
    intrinsicValid: true,
  };

  const phoneObs: EntityObservation = {
    entityName: 'phone_number',
    entityType: 'phone',
    value: '+1-555-1234',
    confidence: 0.9,
    span: '+1-555-1234',
    intrinsicValid: true,
  };

  const invalidObs: EntityObservation = {
    entityName: 'airport_code',
    entityType: 'airport',
    value: 'XX',
    confidence: 0.3,
    intrinsicValid: false,
    intrinsicError: 'Unknown airport code',
  };

  // ---- assignObservationsToSlots ----

  describe('assignObservationsToSlots', () => {
    it('Case C: single value + single slot → direct assignment', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({ origin: 'JFK' });
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('Case C: single value + multiple slots (same entityRef) → assign to first slot', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
        {
          fieldName: 'destination',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying to?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({ origin: 'JFK' });
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('Case B: 2 values + 1 slot → needsClarification', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);
      set = addObservation(set, laxObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'preferred_airport',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Which airport do you prefer?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({});
      expect(result.needsClarification).toHaveLength(1);
      expect(result.needsClarification[0]).toEqual({
        fieldName: 'preferred_airport',
        entityRef: 'airport_code',
        candidates: ['JFK', 'LAX'],
        prompt: 'Which airport do you prefer?',
      });
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('Case A: 2 values + 2 slots → needsDisambiguation', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);
      set = addObservation(set, laxObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
        {
          fieldName: 'destination',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying to?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({});
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(1);
      expect(result.needsDisambiguation[0]).toEqual({
        entityName: 'airport_code',
        entityType: 'airport',
        values: ['JFK', 'LAX'],
        targetFields: [
          { fieldName: 'origin', prompt: 'Where are you flying from?' },
          { fieldName: 'destination', prompt: 'Where are you flying to?' },
        ],
      });
    });

    it('Case D: no slots → empty result', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);

      const slots: SlotTarget[] = [];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({});
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('mixed entity types: different entities assigned independently', () => {
      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);
      set = addObservation(set, phoneObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
        {
          fieldName: 'contact_phone',
          entityRef: 'phone_number',
          entityType: 'phone',
          prompt: 'What is your phone number?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({
        origin: 'JFK',
        contact_phone: '+1-555-1234',
      });
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('intrinsicValid=false observations are excluded from assignment', () => {
      let set = createObservationSet(1);
      set = addObservation(set, invalidObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({});
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });

    it('deduplicates identical values', () => {
      const dupObs: EntityObservation = {
        entityName: 'airport_code',
        entityType: 'airport',
        value: 'JFK',
        confidence: 0.88,
        span: 'JFK',
        intrinsicValid: true,
      };

      let set = createObservationSet(1);
      set = addObservation(set, jfkObs);
      set = addObservation(set, dupObs);

      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'airport',
          prompt: 'Where are you flying from?',
        },
      ];

      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({ origin: 'JFK' });
      expect(result.needsClarification).toHaveLength(0);
      expect(result.needsDisambiguation).toHaveLength(0);
    });
  });

  // ---- buildDisambiguationPrompt ----

  describe('buildDisambiguationPrompt', () => {
    it('builds a structured disambiguation prompt', () => {
      const disambiguation: DisambiguationNeeded = {
        entityName: 'airport_code',
        entityType: 'airport',
        values: ['JFK', 'LAX'],
        targetFields: [
          { fieldName: 'origin', prompt: 'Where are you flying from?' },
          { fieldName: 'destination', prompt: 'Where are you flying to?' },
        ],
      };

      const prompt = buildDisambiguationPrompt('I want to fly from JFK to LAX', disambiguation);

      expect(prompt).toContain('I want to fly from JFK to LAX');
      expect(prompt).toContain('JFK');
      expect(prompt).toContain('LAX');
      expect(prompt).toContain('origin');
      expect(prompt).toContain('destination');
      expect(prompt).toContain('Where are you flying from?');
      expect(prompt).toContain('Where are you flying to?');
      expect(prompt).toContain('JSON');
    });
  });

  // ---- buildClarificationMessage ----

  describe('buildClarificationMessage', () => {
    it('builds a clarification message listing candidates and using the prompt', () => {
      const clarification: ClarificationNeeded = {
        fieldName: 'preferred_airport',
        entityRef: 'airport_code',
        candidates: ['JFK', 'LAX'],
        prompt: 'Which airport do you prefer?',
      };

      const message = buildClarificationMessage(clarification);

      expect(message).toContain('JFK');
      expect(message).toContain('LAX');
      expect(message).toContain('Which airport do you prefer?');
    });
  });
});
