/**
 * Entity Lifecycle Trace Event Builders — Unit Tests
 *
 * Tests that each builder function:
 * 1. Returns the correct `type` string
 * 2. Includes all parameters in `data`
 * 3. Excludes optional params when undefined
 * 4. Includes optional params when provided
 */
import { describe, it, expect } from 'vitest';
import {
  traceEntityObservation,
  traceIntrinsicValidation,
  traceSlotAssignment,
  traceSlotClarification,
  traceSlotDisambiguation,
  traceBusinessValidation,
  traceEntityCommitment,
  EntityTraceEvent,
} from '../services/execution/entity-trace-events.js';

describe('Entity Lifecycle Trace Event Builders', () => {
  describe('traceEntityObservation', () => {
    it('returns type entity_observation with all required params in data', () => {
      const event = traceEntityObservation('BookingAgent', 'email', 'email', 'a@b.com', 0.95);
      expect(event.type).toBe('entity_observation');
      expect(event.data).toEqual({
        agentName: 'BookingAgent',
        entityName: 'email',
        entityType: 'email',
        value: 'a@b.com',
        confidence: 0.95,
      });
    });

    it('excludes span when undefined', () => {
      const event = traceEntityObservation('Agent', 'name', 'string', 'Alice', 0.9);
      expect(event.data).not.toHaveProperty('span');
    });

    it('includes span when provided', () => {
      const span = { start: 0, end: 5 };
      const event = traceEntityObservation('Agent', 'name', 'string', 'Alice', 0.9, span);
      expect(event.data.span).toEqual(span);
    });
  });

  describe('traceIntrinsicValidation', () => {
    it('returns type entity_validation_intrinsic with all required params', () => {
      const event = traceIntrinsicValidation('Agent', 'email', 'email', 'bad', false);
      expect(event.type).toBe('entity_validation_intrinsic');
      expect(event.data).toEqual({
        agentName: 'Agent',
        entityName: 'email',
        entityType: 'email',
        value: 'bad',
        valid: false,
      });
    });

    it('excludes error when undefined', () => {
      const event = traceIntrinsicValidation('Agent', 'email', 'email', 'a@b.com', true);
      expect(event.data).not.toHaveProperty('error');
    });

    it('includes error when provided', () => {
      const event = traceIntrinsicValidation(
        'Agent',
        'email',
        'email',
        'bad',
        false,
        'Invalid email format',
      );
      expect(event.data.error).toBe('Invalid email format');
    });
  });

  describe('traceSlotAssignment', () => {
    it('returns type entity_slot_assignment with all params', () => {
      const event = traceSlotAssignment('Agent', 'userEmail', 'email', 'a@b.com', 'direct');
      expect(event.type).toBe('entity_slot_assignment');
      expect(event.data).toEqual({
        agentName: 'Agent',
        fieldName: 'userEmail',
        entityRef: 'email',
        value: 'a@b.com',
        method: 'direct',
      });
    });

    it('supports disambiguation method', () => {
      const event = traceSlotAssignment('Agent', 'city', 'city', 'NYC', 'disambiguation');
      expect(event.data.method).toBe('disambiguation');
    });

    it('supports clarification method', () => {
      const event = traceSlotAssignment('Agent', 'city', 'city', 'NYC', 'clarification');
      expect(event.data.method).toBe('clarification');
    });
  });

  describe('traceSlotClarification', () => {
    it('returns type entity_slot_clarification with all params', () => {
      const candidates = ['New York', 'New Delhi'];
      const event = traceSlotClarification('Agent', 'city', 'city', candidates);
      expect(event.type).toBe('entity_slot_clarification');
      expect(event.data).toEqual({
        agentName: 'Agent',
        fieldName: 'city',
        entityRef: 'city',
        candidates,
      });
    });

    it('handles empty candidates array', () => {
      const event = traceSlotClarification('Agent', 'city', 'city', []);
      expect(event.data.candidates).toEqual([]);
    });
  });

  describe('traceSlotDisambiguation', () => {
    it('returns type entity_slot_disambiguation with all params', () => {
      const values = ['NYC', 'LA'];
      const targetFields = ['departure_city', 'arrival_city'];
      const event = traceSlotDisambiguation('Agent', 'city', values, targetFields);
      expect(event.type).toBe('entity_slot_disambiguation');
      expect(event.data).toEqual({
        agentName: 'Agent',
        entityName: 'city',
        values,
        targetFields,
      });
    });
  });

  describe('traceBusinessValidation', () => {
    it('returns type entity_validation_business with all required params', () => {
      const event = traceBusinessValidation('Agent', 'age', 25, true);
      expect(event.type).toBe('entity_validation_business');
      expect(event.data).toEqual({
        agentName: 'Agent',
        fieldName: 'age',
        value: 25,
        valid: true,
      });
    });

    it('excludes error when undefined', () => {
      const event = traceBusinessValidation('Agent', 'age', 25, true);
      expect(event.data).not.toHaveProperty('error');
    });

    it('includes error when provided', () => {
      const event = traceBusinessValidation('Agent', 'age', -5, false, 'Age must be positive');
      expect(event.data.error).toBe('Age must be positive');
    });
  });

  describe('traceEntityCommitment', () => {
    it('returns type entity_commitment with all params', () => {
      const event = traceEntityCommitment('Agent', 'email', 'user@example.com');
      expect(event.type).toBe('entity_commitment');
      expect(event.data).toEqual({
        agentName: 'Agent',
        fieldName: 'email',
        value: 'user@example.com',
      });
    });

    it('handles non-string values', () => {
      const event = traceEntityCommitment('Agent', 'count', 42);
      expect(event.data.value).toBe(42);
    });
  });

  describe('EntityTraceEvent interface compliance', () => {
    it('all builders return objects matching EntityTraceEvent shape', () => {
      const events: EntityTraceEvent[] = [
        traceEntityObservation('A', 'e', 't', 'v', 0.9),
        traceIntrinsicValidation('A', 'e', 't', 'v', true),
        traceSlotAssignment('A', 'f', 'e', 'v', 'direct'),
        traceSlotClarification('A', 'f', 'e', []),
        traceSlotDisambiguation('A', 'e', [], []),
        traceBusinessValidation('A', 'f', 'v', true),
        traceEntityCommitment('A', 'f', 'v'),
      ];
      for (const event of events) {
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('data');
        expect(typeof event.type).toBe('string');
        expect(typeof event.data).toBe('object');
      }
    });
  });
});
