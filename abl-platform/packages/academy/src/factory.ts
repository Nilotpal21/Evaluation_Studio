/**
 * Learning Academy — Service Factory
 *
 * Creates all academy services wired together.
 * Host passes a storage port (DB-agnostic) and optional config.
 *
 * Phase 1: scaffold stubs
 * Phase 2: content service wired
 * Phase 3: progress + gamification wired
 * Phase 4: leaderboard wired
 */

import type { AcademyStoragePort } from './storage/storage-port.js';
import type { AcademyServices, AcademyServicesOptions } from './types.js';
import { createContentService } from './services/content-service.js';
import { createGamificationService } from './services/gamification-service.js';
import { createProgressService } from './services/progress-service.js';
import { createLeaderboardService } from './services/leaderboard-service.js';
import { resolveContentRoot } from './content/content-loader.js';

export function createAcademyServices(
  storage: AcademyStoragePort,
  options?: AcademyServicesOptions,
): AcademyServices {
  const contentRoot = resolveContentRoot(options?.contentRoot);
  const content = createContentService(contentRoot);
  const gamification = createGamificationService(storage, content);
  const progress = createProgressService(storage, content, gamification);
  const leaderboard = createLeaderboardService(storage);

  return {
    content,
    progress,
    gamification,
    leaderboard,
  };
}
