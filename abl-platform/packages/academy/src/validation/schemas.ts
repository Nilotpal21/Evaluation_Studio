/**
 * Learning Academy — Zod Validation Schemas
 *
 * Input validation for API endpoints.
 * All ID fields use z.string().min(1) per project convention.
 */

import { z } from 'zod';

/** Validates a quiz submission from the client */
export const quizSubmissionSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        answer: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});

/** Validates persona selection */
export const personaSelectionSchema = z.object({
  persona: z.enum(['agent-builder', 'agent-architect', 'business-analyst']),
});

/** Validates leaderboard query parameters */
export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Validates a module ID path parameter */
export const moduleIdSchema = z.string().min(1).max(100);

/** Validates a course ID path parameter */
export const courseIdSchema = z.string().min(1).max(100);

export type QuizSubmissionInput = z.infer<typeof quizSubmissionSchema>;
export type PersonaSelectionInput = z.infer<typeof personaSelectionSchema>;
export type LeaderboardQueryInput = z.infer<typeof leaderboardQuerySchema>;
