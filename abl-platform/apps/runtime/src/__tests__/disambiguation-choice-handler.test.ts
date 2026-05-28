import { describe, test, expect } from 'vitest';
import { parseDisambiguationChoice } from '../services/execution/flow-step-executor.js';

describe('Disambiguation choice handler', () => {
  const intents = ['book_flight', 'book_hotel', 'check_status'];

  test('parse numeric choice "1"', () => {
    expect(parseDisambiguationChoice('1', intents)).toEqual({
      index: 0,
      intent: 'book_flight',
    });
  });

  test('parse numeric choice "3"', () => {
    expect(parseDisambiguationChoice('3', intents)).toEqual({
      index: 2,
      intent: 'check_status',
    });
  });

  test('parse exact intent name', () => {
    expect(parseDisambiguationChoice('book_hotel', intents)).toEqual({
      index: 1,
      intent: 'book_hotel',
    });
  });

  test('parse case-insensitive intent name', () => {
    expect(parseDisambiguationChoice('Book_Flight', intents)).toEqual({
      index: 0,
      intent: 'book_flight',
    });
  });

  test('parse prefix match', () => {
    expect(parseDisambiguationChoice('check', intents)).toEqual({
      index: 2,
      intent: 'check_status',
    });
  });

  test('return null for invalid choice', () => {
    expect(parseDisambiguationChoice('unknown', intents)).toBeNull();
  });

  test('return null for out of range number', () => {
    expect(parseDisambiguationChoice('5', intents)).toBeNull();
  });

  test('return null for zero', () => {
    expect(parseDisambiguationChoice('0', intents)).toBeNull();
  });
});
