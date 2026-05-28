import { describe, it, expect } from 'vitest';
import {
  quizSubmissionSchema,
  personaSelectionSchema,
  leaderboardQuerySchema,
  moduleIdSchema,
  courseIdSchema,
} from '../../validation/schemas.js';

describe('quizSubmissionSchema', () => {
  it('accepts valid submission with answers', () => {
    const result = quizSubmissionSchema.safeParse({
      answers: [
        { questionId: 'q1', answer: 'b' },
        { questionId: 'q2', answer: 'some answer' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty answers array', () => {
    const result = quizSubmissionSchema.safeParse({ answers: [] });
    expect(result.success).toBe(false);
  });

  it('rejects answers without questionId', () => {
    const result = quizSubmissionSchema.safeParse({
      answers: [{ answer: 'b' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects answers without answer field', () => {
    const result = quizSubmissionSchema.safeParse({
      answers: [{ questionId: 'q1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty questionId', () => {
    const result = quizSubmissionSchema.safeParse({
      answers: [{ questionId: '', answer: 'b' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty answer string', () => {
    const result = quizSubmissionSchema.safeParse({
      answers: [{ questionId: 'q1', answer: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 answers', () => {
    const answers = Array.from({ length: 21 }, (_, i) => ({
      questionId: `q${i}`,
      answer: 'x',
    }));
    const result = quizSubmissionSchema.safeParse({ answers });
    expect(result.success).toBe(false);
  });

  it('accepts up to 20 answers', () => {
    const answers = Array.from({ length: 20 }, (_, i) => ({
      questionId: `q${i}`,
      answer: 'x',
    }));
    const result = quizSubmissionSchema.safeParse({ answers });
    expect(result.success).toBe(true);
  });
});

describe('personaSelectionSchema', () => {
  it('accepts valid personas', () => {
    expect(personaSelectionSchema.safeParse({ persona: 'agent-builder' }).success).toBe(true);
    expect(personaSelectionSchema.safeParse({ persona: 'agent-architect' }).success).toBe(true);
    expect(personaSelectionSchema.safeParse({ persona: 'business-analyst' }).success).toBe(true);
  });

  it('rejects invalid persona', () => {
    expect(personaSelectionSchema.safeParse({ persona: 'hacker' }).success).toBe(false);
    expect(personaSelectionSchema.safeParse({ persona: '' }).success).toBe(false);
    expect(personaSelectionSchema.safeParse({}).success).toBe(false);
  });
});

describe('leaderboardQuerySchema', () => {
  it('accepts valid limit and offset', () => {
    const result = leaderboardQuerySchema.safeParse({ limit: 10, offset: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(0);
    }
  });

  it('provides defaults for missing values', () => {
    const result = leaderboardQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it('coerces string values', () => {
    const result = leaderboardQuerySchema.safeParse({ limit: '50', offset: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it('rejects limit > 100', () => {
    const result = leaderboardQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit < 1', () => {
    const result = leaderboardQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative offset', () => {
    const result = leaderboardQuerySchema.safeParse({ offset: -1 });
    expect(result.success).toBe(false);
  });
});

describe('moduleIdSchema', () => {
  it('accepts valid module IDs', () => {
    expect(moduleIdSchema.safeParse('getting-started').success).toBe(true);
    expect(moduleIdSchema.safeParse('abl-basics').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(moduleIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects strings over 100 characters', () => {
    expect(moduleIdSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

describe('courseIdSchema', () => {
  it('accepts valid course IDs', () => {
    expect(courseIdSchema.safeParse('platform-foundations').success).toBe(true);
    expect(courseIdSchema.safeParse('abl-language').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(courseIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects strings over 100 characters', () => {
    expect(courseIdSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});
