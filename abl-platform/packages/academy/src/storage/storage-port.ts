/**
 * Learning Academy — Storage Port
 *
 * DB-agnostic storage interface. The default MongooseAcademyStorage
 * implementation ships with the package. Other backends (PostgreSQL,
 * DynamoDB, REST) only need to implement these ~9 methods.
 */

import type { AcademyProgress, ModuleProgress, LeaderboardEntry } from '../types.js';

export interface AcademyStoragePort {
  getProgress(userId: string): Promise<AcademyProgress | null>;

  upsertProgress(userId: string, updates: Partial<AcademyProgress>): Promise<AcademyProgress>;

  updateModuleProgress(
    userId: string,
    moduleId: string,
    progress: Partial<ModuleProgress>,
  ): Promise<AcademyProgress>;

  addBadges(userId: string, badges: string[]): Promise<AcademyProgress>;

  addStreakDay(userId: string, day: string): Promise<AcademyProgress>;

  pruneStreakDays(userId: string, maxDays: number): Promise<void>;

  getLeaderboard(limit: number, offset: number): Promise<LeaderboardEntry[]>;

  getUserPosition(userId: string): Promise<number>;

  resetProgress(userId: string): Promise<void>;
}
