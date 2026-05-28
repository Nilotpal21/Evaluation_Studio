/**
 * Learning Academy — Progress Service
 *
 * Manages user progress: content completion, quiz submission, persona selection.
 *
 * Key behaviors:
 * - upsert-on-read: getProgress() creates a new doc for unknown users
 * - Rate limiting: max 3 quiz attempts per module per 5-minute window
 * - Diminishing points: 100 / 50 / 25 for 1st / 2nd / 3rd+ attempts
 * - Badge checking after quiz pass
 * - Streak update on every quiz submission
 *
 * Rate-limit state is stored in-memory (bounded Map with TTL + max size).
 */

import type {
  AcademyProgress,
  ProgressService,
  ContentService,
  GamificationService,
  QuizSubmission,
  QuizResult,
} from '../types.js';
import type { AcademyStoragePort } from '../storage/storage-port.js';
import { gradeQuiz } from '../quiz/quiz-grader.js';
import { deriveRankFromPoints } from './gamification-service.js';

/** Max quiz attempts allowed per module within the rate window */
const RATE_LIMIT_MAX_ATTEMPTS = 3;

/** Rate window in milliseconds (5 minutes) */
const RATE_WINDOW_MS = 5 * 60 * 1000;

/** Max entries in the rate-limit map (bounded) */
const RATE_MAP_MAX_SIZE = 10_000;

/** TTL for rate-limit entries (10 minutes — 2x the window for cleanup) */
const RATE_MAP_TTL_MS = 10 * 60 * 1000;

interface RateLimitEntry {
  attempts: number[];
  createdAt: number;
}

/**
 * In-memory rate limiter with bounded size and TTL.
 * Key format: `${userId}:${moduleId}`
 */
const rateLimitMap = new Map<string, RateLimitEntry>();

function evictExpiredRateLimits(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.createdAt > RATE_MAP_TTL_MS) {
      rateLimitMap.delete(key);
    }
  }

  // If still over limit, evict oldest entries
  if (rateLimitMap.size > RATE_MAP_MAX_SIZE) {
    const entries = [...rateLimitMap.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = entries.slice(0, rateLimitMap.size - RATE_MAP_MAX_SIZE);
    for (const [key] of toRemove) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(userId: string, moduleId: string): boolean {
  const key = `${userId}:${moduleId}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry) return true; // No prior attempts

  // Filter out attempts outside the window
  const recentAttempts = entry.attempts.filter((t) => now - t < RATE_WINDOW_MS);
  entry.attempts = recentAttempts;

  return recentAttempts.length < RATE_LIMIT_MAX_ATTEMPTS;
}

function recordAttempt(userId: string, moduleId: string): void {
  const key = `${userId}:${moduleId}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (entry) {
    entry.attempts.push(now);
  } else {
    evictExpiredRateLimits();
    rateLimitMap.set(key, { attempts: [now], createdAt: now });
  }
}

/**
 * Exported for testing — clears the rate limit map.
 */
export function clearRateLimits(): void {
  rateLimitMap.clear();
}

export function createProgressService(
  storage: AcademyStoragePort,
  contentService: ContentService,
  gamificationService: GamificationService,
): ProgressService {
  /**
   * Get user progress, creating a new record if none exists (upsert-on-read).
   */
  async function getProgress(userId: string): Promise<AcademyProgress> {
    const existing = await storage.getProgress(userId);
    if (existing) return existing;

    // Create new progress document via upsert
    return storage.upsertProgress(userId, {
      email: `${userId}@placeholder`,
      displayName: null,
      selectedPersona: null,
      points: 0,
      badges: [],
      streakDays: [],
      lastActiveDate: null,
    });
  }

  /**
   * Mark content as read for a module and award lesson-complete points.
   */
  async function markContentRead(userId: string, moduleId: string): Promise<AcademyProgress> {
    // Ensure progress exists
    await getProgress(userId);

    const config = await contentService.getConfig();
    const pointsForLesson = config.settings.pointsLessonComplete;

    // Get content version for tracking
    let contentVersion: string | null = null;
    try {
      contentVersion = await contentService.getContentVersion(moduleId);
    } catch {
      // Content version unavailable — proceed without it
    }

    // Update module progress
    let progress = await storage.updateModuleProgress(userId, moduleId, {
      contentRead: true,
      contentVersion,
    });

    // Award points
    progress = await storage.upsertProgress(userId, {
      points: progress.points + pointsForLesson,
    });

    return progress;
  }

  /**
   * Submit a quiz for grading. Enforces rate limiting, grades the quiz,
   * awards diminishing points, checks badges, and derives rank.
   */
  async function submitQuiz(
    userId: string,
    moduleId: string,
    answers: QuizSubmission['answers'],
  ): Promise<QuizResult> {
    // Rate limit check
    if (!checkRateLimit(userId, moduleId)) {
      throw new Error(
        `Rate limit exceeded: maximum ${RATE_LIMIT_MAX_ATTEMPTS} quiz attempts per ${RATE_WINDOW_MS / 60000} minutes`,
      );
    }

    // Record the attempt for rate limiting
    recordAttempt(userId, moduleId);

    // Ensure progress exists
    let progress = await getProgress(userId);

    // Load the quiz with answers
    const quiz = await contentService.getQuizInternal(moduleId);

    // Grade the submission
    const gradeResult = gradeQuiz({ answers }, quiz);

    // Determine attempt number for this module
    const moduleProgress = progress.modules.get(moduleId);
    const attemptNumber = (moduleProgress?.quizAttempts ?? 0) + 1;

    // Calculate points to award
    const config = await contentService.getConfig();
    let pointsAwarded = 0;

    if (gradeResult.passed) {
      // Only award points if they haven't already passed this quiz
      const alreadyPassed = moduleProgress?.quizPassed === true;

      if (!alreadyPassed) {
        if (attemptNumber === 1) {
          pointsAwarded = config.settings.pointsFirstAttempt;
        } else if (attemptNumber === 2) {
          pointsAwarded = config.settings.pointsSecondAttempt;
        } else {
          pointsAwarded = config.settings.pointsThirdPlusAttempt;
        }
      }
    }

    // Update module progress
    const newBestScore = Math.max(moduleProgress?.bestScore ?? 0, gradeResult.score);
    progress = await storage.updateModuleProgress(userId, moduleId, {
      quizAttempts: attemptNumber,
      quizPassed: gradeResult.passed || moduleProgress?.quizPassed === true,
      bestScore: newBestScore,
      lastAttemptDate: new Date(),
    });

    // Award points if applicable
    if (pointsAwarded > 0) {
      progress = await storage.upsertProgress(userId, {
        points: progress.points + pointsAwarded,
      });
    }

    // Update streak
    progress = await gamificationService.updateStreak(userId);

    // Check for new badges
    const newBadges = await gamificationService.checkBadges(progress);
    if (newBadges.length > 0) {
      progress = await storage.addBadges(userId, newBadges);
    }

    // Derive current rank
    const rank = gamificationService.deriveRank(progress);

    return {
      score: gradeResult.score,
      passed: gradeResult.passed,
      pointsAwarded,
      results: gradeResult.results,
      newBadges,
      rank,
    };
  }

  /**
   * Set the user's selected learning persona.
   */
  async function setPersona(userId: string, persona: string): Promise<AcademyProgress> {
    await getProgress(userId);
    return storage.upsertProgress(userId, { selectedPersona: persona });
  }

  /**
   * Reset all progress for a user.
   */
  async function resetProgress(userId: string): Promise<void> {
    await storage.resetProgress(userId);
  }

  return {
    getProgress,
    markContentRead,
    submitQuiz,
    setPersona,
    resetProgress,
  };
}
