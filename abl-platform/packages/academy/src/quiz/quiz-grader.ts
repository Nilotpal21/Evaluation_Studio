/**
 * Learning Academy — Quiz Grader
 *
 * Pure function: grades a quiz submission against the answer key.
 * Supports MCQ (option ID match) and fill-blank (case-insensitive trim + alternatives).
 *
 * Returns score (0-1), passed flag, and per-question results with explanations.
 */

import type { QuizSubmission, QuizFile, QuizQuestion } from '../types.js';

export interface GradeResult {
  /** Score as a fraction 0..1 */
  score: number;
  /** Whether the score meets or exceeds the passThreshold */
  passed: boolean;
  /** Per-question results */
  results: Array<{
    questionId: string;
    correct: boolean;
    explanation: string;
  }>;
}

/**
 * Grade a single MCQ question by comparing the submitted answer
 * to the option marked `correct: true`.
 */
function gradeMcq(question: QuizQuestion, answer: string): boolean {
  if (!question.options) return false;
  const correctOption = question.options.find((opt) => opt.correct === true);
  if (!correctOption) return false;
  return answer.trim().toLowerCase() === correctOption.id.trim().toLowerCase();
}

/**
 * Grade a single fill-blank question by comparing the submitted answer
 * to the canonical answer and any accepted alternatives.
 * Comparison is case-insensitive with whitespace trimmed.
 */
function gradeFillBlank(question: QuizQuestion, answer: string): boolean {
  const submitted = answer.trim().toLowerCase();
  if (!submitted) return false;

  // Check canonical answer
  if (question.answer && question.answer.trim().toLowerCase() === submitted) {
    return true;
  }

  // Check accepted alternatives
  if (question.acceptAlternatives) {
    return question.acceptAlternatives.some((alt) => alt.trim().toLowerCase() === submitted);
  }

  return false;
}

/**
 * Grade a complete quiz submission against its answer key.
 *
 * @param submission - The user's answers
 * @param quiz - The full quiz file with correct answers
 * @returns GradeResult with score, passed flag, and per-question details
 */
export function gradeQuiz(submission: QuizSubmission, quiz: QuizFile): GradeResult {
  const questionMap = new Map<string, QuizQuestion>();
  for (const q of quiz.questions) {
    questionMap.set(q.id, q);
  }

  const results: GradeResult['results'] = [];
  let correctCount = 0;

  for (const { questionId, answer } of submission.answers) {
    const question = questionMap.get(questionId);

    if (!question) {
      results.push({
        questionId,
        correct: false,
        explanation: 'Question not found in quiz.',
      });
      continue;
    }

    let correct = false;
    if (question.type === 'mcq') {
      correct = gradeMcq(question, answer);
    } else if (question.type === 'fill-blank') {
      correct = gradeFillBlank(question, answer);
    }

    if (correct) {
      correctCount++;
    }

    results.push({
      questionId,
      correct,
      explanation: question.explanation,
    });
  }

  const totalQuestions = quiz.questions.length;
  const score = totalQuestions > 0 ? correctCount / totalQuestions : 0;
  const passed = score >= quiz.passThreshold;

  return { score, passed, results };
}
