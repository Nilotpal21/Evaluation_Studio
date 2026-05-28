/**
 * Integration: Studio Serializer Round-Trip (INT-6)
 *
 * Tests the full round-trip: GatherFieldData → DSL → Parser → Compiler → IR
 * Verifies that gather field configuration survives serialization and hydration.
 */

import { describe, test, expect } from 'vitest';
import {
  serializeConversationBehaviorToABL,
  serializeGatherToABL,
} from '../../lib/abl-serializers.js';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';

function buildDsl(edits: any[]): string {
  let dsl = 'AGENT: RoundTripTest\nGOAL: "Test round trip"\n';
  for (const edit of edits) {
    if (edit?.content) {
      dsl += edit.content + '\n';
    }
  }
  return dsl;
}

describe('INT-6: Serializer round-trip', () => {
  test('basic string and enum fields survive round-trip', () => {
    const fields = [
      {
        name: 'full_name',
        prompt: 'What is your name?',
        type: 'string' as const,
        required: true,
      },
      {
        name: 'pizza_size',
        prompt: 'What size?',
        type: 'enum' as const,
        required: true,
        options: ['small', 'medium', 'large'],
      },
      {
        name: 'notes',
        prompt: 'Any notes?',
        type: 'string' as const,
        required: false,
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    const dsl = buildDsl(edits);
    const parseResult = parseAgentBasedABL(dsl);

    const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    const agent = output.agents['RoundTripTest'];
    const gatherFields = agent.gather?.fields ?? [];

    // All 3 fields must survive
    expect(gatherFields).toHaveLength(3);

    const nameField = gatherFields.find((f: any) => f.name === 'full_name');
    expect(nameField).toBeDefined();
    expect(nameField!.prompt).toBe('What is your name?');
    expect(nameField!.required).toBe(true);

    const sizeField = gatherFields.find((f: any) => f.name === 'pizza_size');
    expect(sizeField).toBeDefined();
    expect(sizeField!.type).toBe('enum');
    expect(sizeField!.enum_values).toEqual(['small', 'medium', 'large']);

    const notesField = gatherFields.find((f: any) => f.name === 'notes');
    expect(notesField).toBeDefined();
    expect(notesField!.required).toBe(false);
  });

  test('conversation behavior survives round-trip', () => {
    const edits = serializeConversationBehaviorToABL({
      speaking: {
        style: 'warm and concise',
        language_policy: 'interaction_context',
        max_sentences: 2,
        tool_lead_in: 'brief',
      },
      listening: {
        barge_in: 'allow',
        on_pause: 'wait_briefly',
      },
      interaction: {
        answer_shape: 'answer_first',
        clarification: {
          mode: 'ask_only_when_blocked',
          max_questions: 1,
        },
        uncertainty: {
          mode: 'say_when_unsure',
          offer_next_step: true,
        },
      },
    });

    const dsl = buildDsl(edits);
    const parseResult = parseAgentBasedABL(dsl);
    const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    expect(output.agents['RoundTripTest'].conversation_behavior).toEqual({
      speaking: {
        style: 'warm and concise',
        language_policy: 'interaction_context',
        max_sentences: 2,
        tool_lead_in: 'brief',
      },
      listening: {
        barge_in: 'allow',
        on_pause: 'wait_briefly',
      },
      interaction: {
        answer_shape: 'answer_first',
        clarification: {
          mode: 'ask_only_when_blocked',
          max_questions: 1,
        },
        uncertainty: {
          mode: 'say_when_unsure',
          offer_next_step: true,
        },
      },
    });
  });

  test('all field types and properties survive round-trip', () => {
    const fields = [
      {
        name: 'user_name',
        prompt: 'Your name?',
        type: 'string' as const,
        required: true,
      },
      {
        name: 'age',
        prompt: 'How old are you?',
        type: 'number' as const,
        required: true,
      },
      {
        name: 'confirmed',
        prompt: 'Do you confirm?',
        type: 'boolean' as const,
        required: false,
      },
      {
        name: 'email',
        prompt: 'Your email?',
        type: 'string' as const,
        required: true,
        validation: {
          type: 'regex',
          rule: 'matches_email(email)',
          errorMessage: 'Invalid email',
        },
      },
      {
        name: 'ssn',
        prompt: 'SSN?',
        type: 'string' as const,
        required: true,
        sensitive: true,
        sensitiveDisplay: 'mask',
        maskConfig: { showFirst: 0, showLast: 4, char: '*' },
      },
      {
        name: 'preference',
        prompt: 'Preferred color?',
        type: 'enum' as const,
        required: true,
        options: ['red', 'blue', 'green'],
      },
      {
        name: 'intent',
        prompt: 'What do you need?',
        type: 'string' as const,
        required: false,
        infer: true,
        extractionHints: ['look for keywords'],
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    const dsl = buildDsl(edits);
    const parseResult = parseAgentBasedABL(dsl);

    const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    const gatherFields = output.agents['RoundTripTest'].gather?.fields ?? [];

    // All 7 fields must survive
    expect(gatherFields).toHaveLength(7);

    // String field
    const nameF = gatherFields.find((f: any) => f.name === 'user_name');
    expect(nameF).toBeDefined();
    expect(nameF!.prompt).toBe('Your name?');

    // Number field
    const ageF = gatherFields.find((f: any) => f.name === 'age');
    expect(ageF).toBeDefined();
    expect(ageF!.type).toBe('number');

    // Boolean field
    const confirmF = gatherFields.find((f: any) => f.name === 'confirmed');
    expect(confirmF).toBeDefined();
    expect(confirmF!.type).toBe('boolean');
    expect(confirmF!.required).toBe(false);

    // Validation
    const emailF = gatherFields.find((f: any) => f.name === 'email');
    expect(emailF).toBeDefined();
    expect(emailF!.validation).toBeDefined();

    // Sensitive
    const ssnF = gatherFields.find((f: any) => f.name === 'ssn');
    expect(ssnF).toBeDefined();
    expect(ssnF!.sensitive).toBe(true);

    // Enum
    const prefF = gatherFields.find((f: any) => f.name === 'preference');
    expect(prefF).toBeDefined();
    expect(prefF!.type).toBe('enum');
    expect(prefF!.enum_values).toEqual(['red', 'blue', 'green']);

    // Infer + hints
    const intentF = gatherFields.find((f: any) => f.name === 'intent');
    expect(intentF).toBeDefined();
    expect(intentF!.infer).toBe(true);
  });

  test('non-lookup field does not emit LOOKUP_TABLES section', () => {
    const fields = [
      {
        name: 'email',
        prompt: 'Your email?',
        type: 'string' as const,
        required: true,
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    const lookupEdit = edits.find((e: any) => e.section === 'LOOKUP_TABLES');
    expect(lookupEdit).toBeUndefined();
  });

  test('lookupTable reference emits semantics.lookup in DSL', () => {
    const fields = [
      {
        name: 'city',
        prompt: 'Which city?',
        type: 'string' as const,
        required: true,
        lookupTable: 'cities',
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    expect(edits).toHaveLength(1);
    expect(edits[0].section).toBe('GATHER');
    expect(edits[0].content).toContain('lookup: cities');

    // No LOOKUP_TABLES section
    const lookupEdit = edits.find((e: any) => e.section === 'LOOKUP_TABLES');
    expect(lookupEdit).toBeUndefined();

    // Round-trip: parse + compile → field has semantics.lookup
    const dsl = buildDsl(edits);
    const parseResult = parseAgentBasedABL(dsl);
    const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    const gatherField = output.agents['RoundTripTest'].gather?.fields?.find(
      (f: any) => f.name === 'city',
    );
    expect(gatherField).toBeDefined();
    expect(gatherField!.semantics?.lookup).toBe('cities');
  });

  test('serializer never emits LOOKUP_TABLES section', () => {
    const fields = [
      { name: 'name', prompt: 'Name?', type: 'string' as const, required: true },
      {
        name: 'city',
        prompt: 'City?',
        type: 'string' as const,
        required: false,
        lookupTable: 'cities',
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    expect(edits).toHaveLength(1);
    expect(edits[0].section).toBe('GATHER');
    const lookupEdit = edits.find((e: any) => e.section === 'LOOKUP_TABLES');
    expect(lookupEdit).toBeUndefined();
  });

  test('pii_type and advanced semantics survive round-trip', () => {
    const fields = [
      {
        name: 'contact_info',
        prompt: 'How should we reach you?',
        type: 'string' as const,
        required: true,
        piiType: 'email' as const,
        lookupTable: 'contact_methods',
        semantics: {
          format: 'email',
          locale: 'en-US',
          kore_entity_type: 'EMAIL',
        },
      },
      {
        name: 'priority',
        prompt: 'Priority?',
        type: 'enum' as const,
        required: true,
        options: ['low', 'medium', 'high'],
        semantics: {
          enum_set: ['low', 'medium', 'high'],
          format: 'severity',
        },
      },
    ];

    const edits = serializeGatherToABL(fields as any);
    const dsl = buildDsl(edits);
    const parseResult = parseAgentBasedABL(dsl);

    const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);

    const output = compileABLtoIR([parseResult.document!]);
    const gatherFields = output.agents['RoundTripTest'].gather?.fields ?? [];

    const contactField = gatherFields.find((f: any) => f.name === 'contact_info');
    expect(contactField).toBeDefined();
    expect(contactField!.pii_type).toBe('email');
    expect(contactField!.semantics?.lookup).toBe('contact_methods');
    expect(contactField!.semantics?.format).toBe('email');
    expect(contactField!.semantics?.locale).toBe('en-US');
    expect(contactField!.semantics?.kore_entity_type).toBe('EMAIL');

    const priorityField = gatherFields.find((f: any) => f.name === 'priority');
    expect(priorityField).toBeDefined();
    expect(priorityField!.enum_values).toEqual(['low', 'medium', 'high']);
    expect(priorityField!.semantics?.enum_set).toEqual(['low', 'medium', 'high']);
    expect(priorityField!.semantics?.format).toBe('severity');
  });
});
