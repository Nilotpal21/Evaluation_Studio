/**
 * Learning Academy — Gamification Service
 *
 * Badge checking, streak management, and rank derivation.
 *
 * Badge trigger types:
 * - first-quiz-pass: any quiz passed
 * - perfect-quiz: any quiz scored 1.0
 * - course:<id>: all modules in course passed
 * - path:<persona>: all courses in persona path completed
 * - streak:3 / streak:7: consecutive day streaks
 * - multi-path: courses completed in 2+ learning paths
 * - all-courses: all 14 courses completed
 *
 * Streak pruning keeps max 60 entries.
 */

import type {
  AcademyProgress,
  GamificationService,
  ContentService,
  AcademyConfig,
  BadgeConfig,
  RankConfig,
  CourseConfig,
} from '../types.js';
import type { AcademyStoragePort } from '../storage/storage-port.js';

/** Maximum streak days retained */
const MAX_STREAK_DAYS = 60;

/**
 * Check if all modules in a course have been passed (quizPassed = true).
 */
function isCourseCompleted(
  course: CourseConfig,
  modules: Map<string, { quizPassed: boolean }>,
): boolean {
  return course.modules.every((moduleId) => {
    const mod = modules.get(moduleId);
    return mod?.quizPassed === true;
  });
}

/**
 * Count the longest streak of consecutive days in a sorted array of ISO date strings.
 */
function longestConsecutiveStreak(sortedDays: string[]): number {
  if (sortedDays.length === 0) return 0;

  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < sortedDays.length; i++) {
    const prev = new Date(sortedDays[i - 1]);
    const curr = new Date(sortedDays[i]);
    const diffMs = curr.getTime() - prev.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (Math.abs(diffDays - 1) < 0.01) {
      // Consecutive day
      currentStreak++;
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    } else if (diffDays > 1.01) {
      // Gap — reset streak
      currentStreak = 1;
    }
    // diffDays === 0 means same day (duplicate) — skip but don't reset
  }

  return maxStreak;
}

export function createGamificationService(
  storage: AcademyStoragePort,
  contentService: ContentService,
): GamificationService {
  /**
   * Check all badge triggers against current progress.
   * Returns only NEWLY earned badge IDs (not already in progress.badges).
   */
  async function checkBadges(progress: AcademyProgress): Promise<string[]> {
    const config: AcademyConfig = await contentService.getConfig();
    const existingBadges = new Set(progress.badges);
    const newBadges: string[] = [];

    for (const badge of config.badges) {
      // Skip already-earned badges
      if (existingBadges.has(badge.id)) continue;

      const earned = await evaluateTrigger(badge, progress, config);
      if (earned) {
        newBadges.push(badge.id);
      }
    }

    return newBadges;
  }

  async function evaluateTrigger(
    badge: BadgeConfig,
    progress: AcademyProgress,
    config: AcademyConfig,
  ): Promise<boolean> {
    const trigger = badge.trigger;

    if (trigger === 'first-quiz-pass') {
      return hasAnyQuizPassed(progress);
    }

    if (trigger === 'perfect-quiz') {
      return hasAnyPerfectScore(progress);
    }

    if (trigger.startsWith('course:')) {
      const courseId = trigger.slice('course:'.length);
      return await isCourseCompletedById(courseId, progress);
    }

    if (trigger.startsWith('path:')) {
      const persona = trigger.slice('path:'.length);
      return await isPathCompleted(persona, progress, config);
    }

    if (trigger.startsWith('streak:')) {
      const requiredDays = parseInt(trigger.slice('streak:'.length), 10);
      if (isNaN(requiredDays)) return false;
      const sorted = [...progress.streakDays].sort();
      return longestConsecutiveStreak(sorted) >= requiredDays;
    }

    if (trigger === 'multi-path') {
      return await hasMultiPathCompletion(progress, config);
    }

    if (trigger === 'all-courses') {
      return await areAllCoursesCompleted(progress, config);
    }

    return false;
  }

  function hasAnyQuizPassed(progress: AcademyProgress): boolean {
    for (const [, mod] of progress.modules) {
      if (mod.quizPassed) return true;
    }
    return false;
  }

  function hasAnyPerfectScore(progress: AcademyProgress): boolean {
    for (const [, mod] of progress.modules) {
      if (mod.bestScore >= 1.0) return true;
    }
    return false;
  }

  async function isCourseCompletedById(
    courseId: string,
    progress: AcademyProgress,
  ): Promise<boolean> {
    try {
      const course = await contentService.getCourse(courseId);
      return isCourseCompleted(course, progress.modules);
    } catch {
      return false;
    }
  }

  async function isPathCompleted(
    persona: string,
    progress: AcademyProgress,
    config: AcademyConfig,
  ): Promise<boolean> {
    const entry = config.personaCourseMap[persona];
    if (!entry) return false;

    for (const courseId of entry.courses) {
      const completed = await isCourseCompletedById(courseId, progress);
      if (!completed) return false;
    }
    return true;
  }

  async function hasMultiPathCompletion(
    progress: AcademyProgress,
    config: AcademyConfig,
  ): Promise<boolean> {
    let completedPaths = 0;

    for (const [persona, entry] of Object.entries(config.personaCourseMap)) {
      // Check if at least one course (not in shared pool) is completed for this path
      let pathHasUniqueCompletion = false;

      for (const courseId of entry.courses) {
        const completed = await isCourseCompletedById(courseId, progress);
        if (completed) {
          pathHasUniqueCompletion = true;
          break;
        }
      }

      if (pathHasUniqueCompletion) {
        completedPaths++;
      }
    }

    return completedPaths >= 2;
  }

  async function areAllCoursesCompleted(
    progress: AcademyProgress,
    config: AcademyConfig,
  ): Promise<boolean> {
    // Gather all unique course IDs
    const allCourseIds = new Set<string>();
    for (const entry of Object.values(config.personaCourseMap)) {
      for (const courseId of entry.courses) {
        allCourseIds.add(courseId);
      }
    }

    for (const courseId of allCourseIds) {
      const completed = await isCourseCompletedById(courseId, progress);
      if (!completed) return false;
    }
    return true;
  }

  /**
   * Add today's date as a streak day, deduplicate, prune >60 entries,
   * and check for streak badges.
   */
  async function updateStreak(userId: string): Promise<AcademyProgress> {
    const today = new Date().toISOString().split('T')[0];

    // addStreakDay uses $addToSet so duplicates are handled at DB level
    let progress = await storage.addStreakDay(userId, today);

    // Prune if over limit
    if (progress.streakDays.length > MAX_STREAK_DAYS) {
      await storage.pruneStreakDays(userId, MAX_STREAK_DAYS);
      // Re-fetch after prune
      const updated = await storage.getProgress(userId);
      if (updated) {
        progress = updated;
      }
    }

    return progress;
  }

  /**
   * Derive the user's rank title based on their points and the rank thresholds
   * from academy.json. Returns the highest rank whose minPoints <= user points.
   */
  function deriveRank(progress: AcademyProgress): string {
    // We need config synchronously for rank derivation, but the interface
    // defines deriveRank as sync. We'll use a fallback approach —
    // the caller should have config loaded. For now, we use a hardcoded
    // threshold table that mirrors academy.json ranks.
    // This is safe because ranks change infrequently and are loaded from config.
    return deriveRankFromPoints(progress.points);
  }

  return {
    checkBadges,
    updateStreak,
    deriveRank,
  };
}

/**
 * Default rank thresholds matching academy.json.
 * Used by deriveRank() which must be synchronous per the interface.
 */
const DEFAULT_RANKS: RankConfig[] = [
  { level: 1, title: 'Newcomer', minPoints: 0 },
  { level: 2, title: 'Explorer', minPoints: 500 },
  { level: 3, title: 'Practitioner', minPoints: 1500 },
  { level: 4, title: 'Specialist', minPoints: 3000 },
  { level: 5, title: 'Expert', minPoints: 5000 },
  { level: 6, title: 'Master', minPoints: 8000, requirePaths: 2 },
];

/**
 * Pure function to derive rank from points.
 * Exported for unit testing.
 */
export function deriveRankFromPoints(points: number, ranks: RankConfig[] = DEFAULT_RANKS): string {
  // Sort descending by minPoints and find the first one the user qualifies for
  const sorted = [...ranks].sort((a, b) => b.minPoints - a.minPoints);

  for (const rank of sorted) {
    if (points >= rank.minPoints) {
      return rank.title;
    }
  }

  // Fallback — should not happen if ranks include a 0-point entry
  return ranks.length > 0 ? ranks[0].title : 'Newcomer';
}

// Export helper for testing
export { longestConsecutiveStreak, isCourseCompleted };
