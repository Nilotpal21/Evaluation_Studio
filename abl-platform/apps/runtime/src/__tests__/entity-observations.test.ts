import { describe, it, expect } from 'vitest';
import {
  createObservationSet,
  addObservation,
  getObservationsForEntity,
  getObservationsForType,
  clearObservations,
  type EntityObservation,
  type ObservationSet,
} from '../services/execution/entity-observations.js';

describe('entity-observations', () => {
  const phoneObs: EntityObservation = {
    entityName: 'phone_number',
    entityType: 'phone',
    value: '+1-555-1234',
    confidence: 0.95,
    span: '+1-555-1234',
    intrinsicValid: true,
  };

  const emailObs: EntityObservation = {
    entityName: 'email_address',
    entityType: 'email',
    value: 'user@example.com',
    confidence: 0.9,
    span: 'user@example.com',
    intrinsicValid: true,
  };

  const secondPhoneObs: EntityObservation = {
    entityName: 'phone_number',
    entityType: 'phone',
    value: '+1-555-5678',
    confidence: 0.88,
    span: '+1-555-5678',
    intrinsicValid: true,
  };

  const dateObs: EntityObservation = {
    entityName: 'travel_date',
    entityType: 'date',
    value: '2026-05-15',
    confidence: 0.85,
    span: 'May 15th',
  };

  const invalidPhoneObs: EntityObservation = {
    entityName: 'phone_number',
    entityType: 'phone',
    value: '123',
    confidence: 0.6,
    intrinsicValid: false,
    intrinsicError: 'Phone number too short',
  };

  describe('createObservationSet', () => {
    it('creates empty observation set with turn=0 by default', () => {
      const set = createObservationSet();
      expect(set.entities).toEqual({});
      expect(set.turn).toBe(0);
    });

    it('creates empty observation set with specified turn', () => {
      const set = createObservationSet(5);
      expect(set.entities).toEqual({});
      expect(set.turn).toBe(5);
    });
  });

  describe('addObservation', () => {
    it('adds single observation to empty set', () => {
      const set = createObservationSet(1);
      const updated = addObservation(set, phoneObs);

      expect(updated.entities['phone_number']).toHaveLength(1);
      expect(updated.entities['phone_number'][0]).toEqual(phoneObs);
      expect(updated.turn).toBe(1);
    });

    it('does not mutate the original set', () => {
      const set = createObservationSet(1);
      const updated = addObservation(set, phoneObs);

      expect(set.entities).toEqual({});
      expect(updated.entities['phone_number']).toHaveLength(1);
    });

    it('adds multiple observations for same entity (multi-value)', () => {
      const set = createObservationSet(1);
      const step1 = addObservation(set, phoneObs);
      const step2 = addObservation(step1, secondPhoneObs);

      expect(step2.entities['phone_number']).toHaveLength(2);
      expect(step2.entities['phone_number'][0]).toEqual(phoneObs);
      expect(step2.entities['phone_number'][1]).toEqual(secondPhoneObs);
    });

    it('adds observations for different entities', () => {
      const set = createObservationSet(1);
      const step1 = addObservation(set, phoneObs);
      const step2 = addObservation(step1, emailObs);

      expect(Object.keys(step2.entities)).toHaveLength(2);
      expect(step2.entities['phone_number']).toHaveLength(1);
      expect(step2.entities['email_address']).toHaveLength(1);
    });
  });

  describe('getObservationsForEntity', () => {
    it('retrieves observations by entity name', () => {
      let set = createObservationSet(1);
      set = addObservation(set, phoneObs);
      set = addObservation(set, emailObs);
      set = addObservation(set, secondPhoneObs);

      const phoneObs_ = getObservationsForEntity(set, 'phone_number');
      expect(phoneObs_).toHaveLength(2);
      expect(phoneObs_[0].value).toBe('+1-555-1234');
      expect(phoneObs_[1].value).toBe('+1-555-5678');
    });

    it('returns empty array for unknown entity name', () => {
      const set = createObservationSet(1);
      const result = getObservationsForEntity(set, 'nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('getObservationsForType', () => {
    it('retrieves all observations matching entity type across different entity names', () => {
      let set = createObservationSet(1);
      set = addObservation(set, phoneObs);
      set = addObservation(set, emailObs);
      set = addObservation(set, invalidPhoneObs);

      const phoneTypeObs = getObservationsForType(set, 'phone');
      expect(phoneTypeObs).toHaveLength(2);
      expect(phoneTypeObs[0].value).toBe('+1-555-1234');
      expect(phoneTypeObs[1].value).toBe('123');
    });

    it('returns empty array for unknown entity type', () => {
      const set = createObservationSet(1);
      const result = getObservationsForType(set, 'nonexistent');
      expect(result).toEqual([]);
    });

    it('returns observations from multiple entity names with same type', () => {
      const altPhoneEntity: EntityObservation = {
        entityName: 'backup_phone',
        entityType: 'phone',
        value: '+1-555-9999',
        confidence: 0.7,
      };

      let set = createObservationSet(1);
      set = addObservation(set, phoneObs);
      set = addObservation(set, altPhoneEntity);

      const phoneTypeObs = getObservationsForType(set, 'phone');
      expect(phoneTypeObs).toHaveLength(2);
      expect(phoneTypeObs.map((o) => o.entityName)).toEqual(['phone_number', 'backup_phone']);
    });
  });

  describe('clearObservations', () => {
    it('clears all observations and sets new turn number', () => {
      let set = createObservationSet(1);
      set = addObservation(set, phoneObs);
      set = addObservation(set, emailObs);

      const cleared = clearObservations(set, 2);
      expect(cleared.entities).toEqual({});
      expect(cleared.turn).toBe(2);
    });

    it('does not mutate the original set', () => {
      let set = createObservationSet(1);
      set = addObservation(set, phoneObs);

      const cleared = clearObservations(set, 2);
      expect(set.entities['phone_number']).toHaveLength(1);
      expect(cleared.entities).toEqual({});
    });
  });

  describe('SerializedObservationSet', () => {
    it('ObservationSet is JSON-serializable (no Set/Map types)', () => {
      let set: ObservationSet = createObservationSet(3);
      set = addObservation(set, phoneObs);
      set = addObservation(set, dateObs);

      const json = JSON.stringify(set);
      const parsed = JSON.parse(json) as ObservationSet;

      expect(parsed.turn).toBe(3);
      expect(parsed.entities['phone_number']).toHaveLength(1);
      expect(parsed.entities['travel_date']).toHaveLength(1);
      expect(parsed.entities['phone_number'][0].value).toBe('+1-555-1234');
    });
  });
});
