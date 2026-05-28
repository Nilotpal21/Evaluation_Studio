/**
 * Tests for ablTypeToJsonSchema — maps ABL/IR type strings to JSON Schema
 * property descriptors for LLM tool definitions.
 */

import { describe, test, expect } from 'vitest';
import { ablTypeToJsonSchema } from '../services/runtime-executor.js';

describe('ablTypeToJsonSchema', () => {
  // -------------------------------------------------------------------------
  // Primitive types
  // -------------------------------------------------------------------------

  test('maps "string" to JSON Schema string', () => {
    expect(ablTypeToJsonSchema('string')).toEqual({ type: 'string' });
  });

  test('maps "text" to JSON Schema string', () => {
    expect(ablTypeToJsonSchema('text')).toEqual({ type: 'string' });
  });

  test('maps "integer" to JSON Schema integer', () => {
    expect(ablTypeToJsonSchema('integer')).toEqual({ type: 'integer' });
  });

  test('maps "int" to JSON Schema integer', () => {
    expect(ablTypeToJsonSchema('int')).toEqual({ type: 'integer' });
  });

  test('maps "number" to JSON Schema number', () => {
    expect(ablTypeToJsonSchema('number')).toEqual({ type: 'number' });
  });

  test('maps "float" to JSON Schema number', () => {
    expect(ablTypeToJsonSchema('float')).toEqual({ type: 'number' });
  });

  test('maps "double" to JSON Schema number', () => {
    expect(ablTypeToJsonSchema('double')).toEqual({ type: 'number' });
  });

  test('maps "boolean" to JSON Schema boolean', () => {
    expect(ablTypeToJsonSchema('boolean')).toEqual({ type: 'boolean' });
  });

  test('maps "bool" to JSON Schema boolean', () => {
    expect(ablTypeToJsonSchema('bool')).toEqual({ type: 'boolean' });
  });

  test('maps "object" to JSON Schema object', () => {
    expect(ablTypeToJsonSchema('object')).toEqual({ type: 'object' });
  });

  test('maps "json" to JSON Schema object', () => {
    expect(ablTypeToJsonSchema('json')).toEqual({ type: 'object' });
  });

  test('maps "map" to JSON Schema object', () => {
    expect(ablTypeToJsonSchema('map')).toEqual({ type: 'object' });
  });

  // -------------------------------------------------------------------------
  // Semantic string subtypes (date, email, phone, url)
  // -------------------------------------------------------------------------

  test('maps "date" to string with ISO 8601 date hint', () => {
    expect(ablTypeToJsonSchema('date')).toEqual({
      type: 'string',
      description: 'ISO 8601 date',
    });
  });

  test('maps "datetime" to string with ISO 8601 datetime hint', () => {
    expect(ablTypeToJsonSchema('datetime')).toEqual({
      type: 'string',
      description: 'ISO 8601 datetime',
    });
  });

  test('maps "email" to string with email hint', () => {
    expect(ablTypeToJsonSchema('email')).toEqual({
      type: 'string',
      description: 'Email address',
    });
  });

  test('maps "phone" to string with phone hint', () => {
    expect(ablTypeToJsonSchema('phone')).toEqual({
      type: 'string',
      description: 'Phone number',
    });
  });

  test('maps "url" to string with URL hint', () => {
    expect(ablTypeToJsonSchema('url')).toEqual({
      type: 'string',
      description: 'URL',
    });
  });

  // -------------------------------------------------------------------------
  // Array types
  // -------------------------------------------------------------------------

  test('maps "string[]" to array of strings', () => {
    expect(ablTypeToJsonSchema('string[]')).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  test('maps "integer[]" to array of integers', () => {
    expect(ablTypeToJsonSchema('integer[]')).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  test('maps "boolean[]" to array of booleans', () => {
    expect(ablTypeToJsonSchema('boolean[]')).toEqual({
      type: 'array',
      items: { type: 'boolean' },
    });
  });

  // -------------------------------------------------------------------------
  // Description propagation
  // -------------------------------------------------------------------------

  test('includes description for primitive types', () => {
    expect(ablTypeToJsonSchema('integer', 'Number of guests')).toEqual({
      type: 'integer',
      description: 'Number of guests',
    });
  });

  test('includes description for array types', () => {
    expect(ablTypeToJsonSchema('string[]', 'List of tags')).toEqual({
      type: 'array',
      description: 'List of tags',
      items: { type: 'string' },
    });
  });

  test('appends format hint to description for date type', () => {
    expect(ablTypeToJsonSchema('date', 'Check-in date')).toEqual({
      type: 'string',
      description: 'Check-in date (ISO 8601 date)',
    });
  });

  test('appends format hint to description for email type', () => {
    expect(ablTypeToJsonSchema('email', 'Contact email')).toEqual({
      type: 'string',
      description: 'Contact email (email address)',
    });
  });

  // -------------------------------------------------------------------------
  // Case insensitivity and whitespace
  // -------------------------------------------------------------------------

  test('is case-insensitive', () => {
    expect(ablTypeToJsonSchema('Integer')).toEqual({ type: 'integer' });
    expect(ablTypeToJsonSchema('BOOLEAN')).toEqual({ type: 'boolean' });
    expect(ablTypeToJsonSchema('Number')).toEqual({ type: 'number' });
  });

  test('trims whitespace', () => {
    expect(ablTypeToJsonSchema('  string  ')).toEqual({ type: 'string' });
    expect(ablTypeToJsonSchema(' integer[] ')).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  // -------------------------------------------------------------------------
  // Unknown types fall back to string
  // -------------------------------------------------------------------------

  test('falls back to string for unknown types', () => {
    expect(ablTypeToJsonSchema('uuid')).toEqual({ type: 'string' });
    expect(ablTypeToJsonSchema('customType')).toEqual({ type: 'string' });
  });

  test('falls back to string with description for unknown types', () => {
    expect(ablTypeToJsonSchema('uuid', 'Session identifier')).toEqual({
      type: 'string',
      description: 'Session identifier',
    });
  });
});
