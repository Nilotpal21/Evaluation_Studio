/**
 * Learning Academy — Mongoose Storage Implementation
 *
 * Default implementation of AcademyStoragePort using Mongoose.
 * Ships with the package. Other backends implement the same interface.
 *
 * Bounded collections:
 * - modules Map: MAX_MODULES = 40 (one per module in content/)
 * - streakDays: max 60, pruned via pruneStreakDays()
 * - badges: max 11 (one per badge type)
 */

import type { Connection, Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import type { AcademyStoragePort } from './storage-port.js';
import type { AcademyProgress, ModuleProgress, LeaderboardEntry } from '../types.js';
import {
  getAcademyProgressModel,
  type AcademyProgressDocument,
} from '../schemas/academy-progress.schema.js';

/** Maximum modules per user — bounded by content/modules/ directory count */
const MAX_MODULES = 40;

/** Maximum streak days retained — pruned via pruneStreakDays() */
const MAX_STREAK_DAYS = 60;

/**
 * Lean documents return `Record<string, ...>` for Mongoose Map fields.
 * This type represents what `.lean()` actually gives us.
 */
interface LeanProgressDoc {
  _id: string;
  userId: string;
  email: string;
  displayName: string | null;
  selectedPersona: string | null;
  modules?: Record<string, ModuleProgress> | Map<string, ModuleProgress>;
  points: number;
  badges: string[];
  streakDays: string[];
  lastActiveDate: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

function toModulesMap(
  raw: Record<string, ModuleProgress> | Map<string, ModuleProgress> | undefined,
): Map<string, ModuleProgress> {
  if (!raw) return new Map<string, ModuleProgress>();
  if (raw instanceof Map) return raw;
  return new Map(Object.entries(raw));
}

function docToProgress(doc: LeanProgressDoc): AcademyProgress {
  return {
    _id: doc._id,
    userId: doc.userId,
    email: doc.email,
    displayName: doc.displayName,
    selectedPersona: doc.selectedPersona,
    modules: toModulesMap(doc.modules),
    points: doc.points,
    badges: doc.badges,
    streakDays: doc.streakDays,
    lastActiveDate: doc.lastActiveDate,
    _v: doc._v,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongooseAcademyStorage implements AcademyStoragePort {
  private model: Model<AcademyProgressDocument>;

  constructor(connection: Connection) {
    this.model = getAcademyProgressModel(connection);
  }

  async getProgress(userId: string): Promise<AcademyProgress | null> {
    const doc = await this.model.findOne({ userId }).lean();
    if (!doc) return null;
    return docToProgress(doc as LeanProgressDoc);
  }

  async upsertProgress(
    userId: string,
    updates: Partial<AcademyProgress>,
  ): Promise<AcademyProgress> {
    const doc = await this.model.findOneAndUpdate(
      { userId },
      {
        $set: updates,
        $setOnInsert: { _id: uuidv7(), userId },
      },
      { upsert: true, new: true, lean: true },
    );
    return docToProgress(doc as LeanProgressDoc);
  }

  async updateModuleProgress(
    userId: string,
    moduleId: string,
    progress: Partial<ModuleProgress>,
  ): Promise<AcademyProgress> {
    const setFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(progress)) {
      setFields[`modules.${moduleId}.${key}`] = value;
    }

    const doc = await this.model.findOneAndUpdate(
      { userId },
      { $set: setFields },
      { new: true, lean: true },
    );

    if (!doc) {
      throw new Error(`Progress not found for user: ${userId}`);
    }
    return docToProgress(doc as LeanProgressDoc);
  }

  async addBadges(userId: string, badges: string[]): Promise<AcademyProgress> {
    const doc = await this.model.findOneAndUpdate(
      { userId },
      { $addToSet: { badges: { $each: badges } } },
      { new: true, lean: true },
    );

    if (!doc) {
      throw new Error(`Progress not found for user: ${userId}`);
    }
    return docToProgress(doc as LeanProgressDoc);
  }

  async addStreakDay(userId: string, day: string): Promise<AcademyProgress> {
    const doc = await this.model.findOneAndUpdate(
      { userId },
      {
        $addToSet: { streakDays: day },
        $set: { lastActiveDate: day },
      },
      { new: true, lean: true },
    );

    if (!doc) {
      throw new Error(`Progress not found for user: ${userId}`);
    }
    return docToProgress(doc as LeanProgressDoc);
  }

  async pruneStreakDays(userId: string, maxDays: number): Promise<void> {
    const doc = await this.model.findOne({ userId });
    if (!doc) return;

    const limit = Math.min(maxDays, MAX_STREAK_DAYS);
    if (doc.streakDays.length > limit) {
      // Keep the most recent entries
      const sorted = [...doc.streakDays].sort();
      doc.streakDays = sorted.slice(-limit);
      await doc.save();
    }
  }

  async getLeaderboard(limit: number, offset: number): Promise<LeaderboardEntry[]> {
    const docs = await this.model
      .find({})
      .select('userId displayName points badges selectedPersona')
      .sort({ points: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    return docs.map((doc) => ({
      userId: doc.userId,
      displayName: doc.displayName,
      points: doc.points,
      badges: doc.badges,
      selectedPersona: doc.selectedPersona,
    }));
  }

  async getUserPosition(userId: string): Promise<number> {
    const user = await this.model.findOne({ userId }).select('points').lean();
    if (!user) return 0;

    const count = await this.model.countDocuments({
      points: { $gt: user.points },
    });
    return count + 1; // 1-indexed
  }

  async resetProgress(userId: string): Promise<void> {
    await this.model.findOneAndUpdate(
      { userId },
      {
        $set: {
          selectedPersona: null,
          modules: {},
          points: 0,
          badges: [],
          streakDays: [],
          lastActiveDate: null,
        },
      },
    );
  }
}

// Exported constants for consumers
export { MAX_MODULES, MAX_STREAK_DAYS };

export function createMongooseAcademyStorage(connection: Connection): AcademyStoragePort {
  return new MongooseAcademyStorage(connection);
}
