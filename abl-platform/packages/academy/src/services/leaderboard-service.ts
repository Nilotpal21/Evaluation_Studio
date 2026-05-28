/**
 * Learning Academy — Leaderboard Service
 *
 * Provides sorted, paginated leaderboard access and user position lookups.
 * Delegates all storage to the AcademyStoragePort — no direct DB access.
 *
 * Privacy: LeaderboardEntry never includes email. The storage layer's
 * getLeaderboard() projection already excludes it (see mongoose-storage.ts).
 */

import type { AcademyStoragePort } from '../storage/storage-port.js';
import type { LeaderboardService, LeaderboardEntry } from '../types.js';

export function createLeaderboardService(storage: AcademyStoragePort): LeaderboardService {
  return {
    async getLeaderboard(limit: number, offset: number): Promise<LeaderboardEntry[]> {
      return storage.getLeaderboard(limit, offset);
    },

    async getUserPosition(userId: string): Promise<number> {
      return storage.getUserPosition(userId);
    },
  };
}
