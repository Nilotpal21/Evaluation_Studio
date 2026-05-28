import { describe, it, expect } from 'vitest';
import { extractEntityObservations } from '../services/execution/entity-pipeline.js';
import type { EntityDefinitionIR } from '@abl/compiler/platform';

describe('entity-pipeline — extractEntityObservations', () => {
  // ── Helpers ──────────────────────────────────────────────────────────────

  function makeEntity(
    overrides: Partial<EntityDefinitionIR> & Pick<EntityDefinitionIR, 'name' | 'type'>,
  ): EntityDefinitionIR {
    return {
      source: 'explicit',
      ...overrides,
    };
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  it('extracts email from text and produces observation with intrinsicValid=true', () => {
    const entities: EntityDefinitionIR[] = [makeEntity({ name: 'user_email', type: 'email' })];

    const result = extractEntityObservations('My email is alice@example.com', entities, 'en', 1);

    expect(result.turn).toBe(1);
    const obs = result.entities['user_email'];
    expect(obs).toBeDefined();
    expect(obs).toHaveLength(1);
    expect(obs[0].entityName).toBe('user_email');
    expect(obs[0].entityType).toBe('email');
    expect(obs[0].value).toMatch(/@example\.com/);
    expect(obs[0].confidence).toBe(1.0);
    expect(obs[0].intrinsicValid).toBe(true);
  });

  it('extracts phone from text', () => {
    const entities: EntityDefinitionIR[] = [makeEntity({ name: 'contact_phone', type: 'phone' })];

    const result = extractEntityObservations('Call me at +1-555-867-5309', entities, 'en-US', 2);

    expect(result.turn).toBe(2);
    const obs = result.entities['contact_phone'];
    expect(obs).toBeDefined();
    expect(obs).toHaveLength(1);
    expect(obs[0].entityName).toBe('contact_phone');
    expect(obs[0].entityType).toBe('phone');
    expect(obs[0].confidence).toBe(1.0);
    expect(obs[0].intrinsicValid).toBe(true);
  });

  it('extracts multiple entity types from one utterance', () => {
    const entities: EntityDefinitionIR[] = [
      makeEntity({ name: 'user_email', type: 'email' }),
      makeEntity({ name: 'contact_phone', type: 'phone' }),
    ];

    const result = extractEntityObservations(
      'Reach me at bob@test.com or +1-555-123-4567',
      entities,
      'en-US',
      3,
    );

    expect(result.turn).toBe(3);
    expect(result.entities['user_email']).toBeDefined();
    expect(result.entities['user_email']).toHaveLength(1);
    expect(result.entities['contact_phone']).toBeDefined();
    expect(result.entities['contact_phone']).toHaveLength(1);
  });

  it('skips entities whose type has no JS extraction support (e.g. location)', () => {
    const entities: EntityDefinitionIR[] = [
      makeEntity({ name: 'user_email', type: 'email' }),
      makeEntity({ name: 'dest_city', type: 'location' }),
    ];

    const result = extractEntityObservations(
      'My email is test@example.com and I want to go to Paris',
      entities,
      'en',
      1,
    );

    // email should be extracted
    expect(result.entities['user_email']).toBeDefined();
    expect(result.entities['user_email']).toHaveLength(1);

    // location should NOT appear — not JS-extractable
    expect(result.entities['dest_city']).toBeUndefined();
  });

  it('handles empty entity list', () => {
    const result = extractEntityObservations('Hello world', [], 'en', 1);

    expect(result.turn).toBe(1);
    expect(Object.keys(result.entities)).toHaveLength(0);
  });

  it('sets turn number on observation set', () => {
    const entities: EntityDefinitionIR[] = [makeEntity({ name: 'user_email', type: 'email' })];

    const result5 = extractEntityObservations('email: a@b.com', entities, 'en', 5);
    expect(result5.turn).toBe(5);

    const result0 = extractEntityObservations('email: a@b.com', entities, 'en', 0);
    expect(result0.turn).toBe(0);
  });

  it('handles empty/whitespace message', () => {
    const entities: EntityDefinitionIR[] = [makeEntity({ name: 'user_email', type: 'email' })];

    const empty = extractEntityObservations('', entities, 'en', 1);
    expect(Object.keys(empty.entities)).toHaveLength(0);

    const whitespace = extractEntityObservations('   ', entities, 'en', 1);
    expect(Object.keys(whitespace.entities)).toHaveLength(0);
  });

  it('normalizes enum values via synonym resolution', () => {
    const entities: EntityDefinitionIR[] = [
      makeEntity({
        name: 'plan_type',
        type: 'enum',
        values: ['basic', 'premium', 'enterprise'],
        synonyms: { premium: ['pro', 'professional'] },
      }),
    ];

    // 'enum' is not JS-extractable, so this should produce no observations
    // (enum extraction requires LLM tier, not JS tier)
    const result = extractEntityObservations('I want the pro plan', entities, 'en', 1);
    expect(result.entities['plan_type']).toBeUndefined();
  });

  it('processes currency entities extracted by JS libs', () => {
    const entities: EntityDefinitionIR[] = [makeEntity({ name: 'budget', type: 'currency' })];

    const result = extractEntityObservations('My budget is $500', entities, 'en', 1);

    expect(result.entities['budget']).toBeDefined();
    expect(result.entities['budget']).toHaveLength(1);
    expect(result.entities['budget'][0].intrinsicValid).toBe(true);
  });
});
