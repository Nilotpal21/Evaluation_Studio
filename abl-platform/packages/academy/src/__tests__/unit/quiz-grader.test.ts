import { describe, it, expect } from 'vitest';
import { gradeQuiz } from '../../quiz/quiz-grader.js';
import type { QuizFile, QuizSubmission } from '../../types.js';

const MCQ_QUIZ: QuizFile = {
  moduleId: 'test-module',
  passThreshold: 0.8,
  questions: [
    {
      id: 'q1',
      type: 'mcq',
      stem: 'Which is correct?',
      options: [
        { id: 'a', text: 'Wrong' },
        { id: 'b', text: 'Correct', correct: true },
        { id: 'c', text: 'Wrong' },
      ],
      explanation: 'B is the correct answer.',
    },
    {
      id: 'q2',
      type: 'mcq',
      stem: 'Pick one.',
      options: [
        { id: 'a', text: 'Right', correct: true },
        { id: 'b', text: 'Wrong' },
      ],
      explanation: 'A is correct.',
    },
  ],
};

const FILL_BLANK_QUIZ: QuizFile = {
  moduleId: 'test-fill',
  passThreshold: 0.5,
  questions: [
    {
      id: 'fb1',
      type: 'fill-blank',
      stem: 'Agent Platform uses a ________ DSL.',
      answer: 'declarative',
      acceptAlternatives: ['Declarative'],
      explanation: 'ABL is a declarative DSL.',
    },
    {
      id: 'fb2',
      type: 'fill-blank',
      stem: 'The compiler outputs an ________.',
      answer: 'Intermediate Representation',
      acceptAlternatives: ['intermediate representation', 'IR'],
      explanation: 'The compiler outputs an IR.',
    },
  ],
};

const MIXED_QUIZ: QuizFile = {
  moduleId: 'test-mixed',
  passThreshold: 0.6,
  questions: [
    {
      id: 'q1',
      type: 'mcq',
      stem: 'MCQ question',
      options: [
        { id: 'a', text: 'Wrong' },
        { id: 'b', text: 'Correct', correct: true },
      ],
      explanation: 'B is correct.',
    },
    {
      id: 'q2',
      type: 'fill-blank',
      stem: 'Fill blank question',
      answer: 'answer',
      explanation: 'The answer is "answer".',
    },
    {
      id: 'q3',
      type: 'mcq',
      stem: 'Another MCQ',
      options: [
        { id: 'x', text: 'Correct', correct: true },
        { id: 'y', text: 'Wrong' },
      ],
      explanation: 'X is correct.',
    },
  ],
};

describe('gradeQuiz — MCQ', () => {
  it('grades all correct MCQ answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'b' },
        { questionId: 'q2', answer: 'a' },
      ],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.correct)).toBe(true);
  });

  it('grades all wrong MCQ answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'a' },
        { questionId: 'q2', answer: 'b' },
      ],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.results.every((r) => !r.correct)).toBe(true);
  });

  it('grades partial MCQ answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'b' },
        { questionId: 'q2', answer: 'b' },
      ],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(false); // threshold is 0.8
  });

  it('is case-insensitive for option IDs', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'B' },
        { questionId: 'q2', answer: 'A' },
      ],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('handles unknown question IDs gracefully', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'nonexistent', answer: 'a' },
        { questionId: 'q1', answer: 'b' },
      ],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    // 1 correct out of 2 total questions in quiz
    expect(result.score).toBe(0.5);
    expect(result.results[0].correct).toBe(false);
    expect(result.results[0].explanation).toBe('Question not found in quiz.');
  });
});

describe('gradeQuiz — fill-blank', () => {
  it('grades correct fill-blank answers (exact match)', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: 'declarative' },
        { questionId: 'fb2', answer: 'Intermediate Representation' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('is case-insensitive for fill-blank', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: 'DECLARATIVE' },
        { questionId: 'fb2', answer: 'intermediate representation' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('accepts alternatives', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: 'Declarative' },
        { questionId: 'fb2', answer: 'IR' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('trims whitespace in answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: '  declarative  ' },
        { questionId: 'fb2', answer: '  IR  ' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('rejects wrong fill-blank answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: 'imperative' },
        { questionId: 'fb2', answer: 'JSON' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('rejects empty answers', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'fb1', answer: '' },
        { questionId: 'fb2', answer: '   ' },
      ],
    };

    const result = gradeQuiz(submission, FILL_BLANK_QUIZ);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe('gradeQuiz — mixed questions', () => {
  it('handles a mix of MCQ and fill-blank', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'b' },
        { questionId: 'q2', answer: 'answer' },
        { questionId: 'q3', answer: 'x' },
      ],
    };

    const result = gradeQuiz(submission, MIXED_QUIZ);
    expect(result.score).toBeCloseTo(1);
    expect(result.passed).toBe(true);
  });

  it('returns explanation for each question', () => {
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'a' },
        { questionId: 'q2', answer: 'wrong' },
        { questionId: 'q3', answer: 'y' },
      ],
    };

    const result = gradeQuiz(submission, MIXED_QUIZ);
    expect(result.results[0].explanation).toBe('B is correct.');
    expect(result.results[1].explanation).toBe('The answer is "answer".');
    expect(result.results[2].explanation).toBe('X is correct.');
  });

  it('respects passThreshold of 0.6', () => {
    // 2/3 correct = 0.666 >= 0.6
    const submission: QuizSubmission = {
      answers: [
        { questionId: 'q1', answer: 'b' },
        { questionId: 'q2', answer: 'wrong' },
        { questionId: 'q3', answer: 'x' },
      ],
    };

    const result = gradeQuiz(submission, MIXED_QUIZ);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(true);
  });
});

describe('gradeQuiz — edge cases', () => {
  it('handles empty submission', () => {
    const submission: QuizSubmission = { answers: [] };
    const result = gradeQuiz(submission, MCQ_QUIZ);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it('handles quiz with no questions', () => {
    const emptyQuiz: QuizFile = {
      moduleId: 'empty',
      passThreshold: 0.8,
      questions: [],
    };
    const submission: QuizSubmission = { answers: [] };
    const result = gradeQuiz(submission, emptyQuiz);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('score is based on total quiz questions, not submitted answers', () => {
    // Submit only 1 answer for a 2-question quiz
    const submission: QuizSubmission = {
      answers: [{ questionId: 'q1', answer: 'b' }],
    };

    const result = gradeQuiz(submission, MCQ_QUIZ);
    // 1 correct out of 2 total questions
    expect(result.score).toBe(0.5);
  });
});
