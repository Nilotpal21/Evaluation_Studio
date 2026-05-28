/**
 * Learning Academy — Mongoose Schema
 *
 * Collection: academy_progress
 * - NO tenantIsolationPlugin (progress is per-userId globally)
 * - userId unique index (one doc per user)
 * - points descending index (leaderboard sorting)
 *
 * Bounded arrays:
 * - streakDays: max 60 entries, pruned in gamification-service.updateStreak()
 * - badges: max 11 entries (one per badge type in academy.json)
 * - modules: max 40 entries (one per module in content/)
 */

import { Schema, type Connection, type Model } from 'mongoose';
import { getOrCreateModel } from './model-registry.js';

const MODULE_PROGRESS_SCHEMA = new Schema(
  {
    contentRead: { type: Boolean, default: false },
    quizAttempts: { type: Number, default: 0 },
    quizPassed: { type: Boolean, default: false },
    bestScore: { type: Number, default: 0 },
    lastAttemptDate: { type: Date, default: null },
    contentVersion: { type: String, default: null },
  },
  { _id: false },
);

const ACADEMY_PROGRESS_SCHEMA = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    displayName: { type: String, default: null },
    selectedPersona: { type: String, default: null },
    modules: {
      type: Map,
      of: MODULE_PROGRESS_SCHEMA,
      default: undefined,
    },
    points: { type: Number, default: 0, index: true },
    badges: { type: [String], default: [] },
    streakDays: { type: [String], default: [] },
    lastActiveDate: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'academy_progress',
  },
);

// Compound index for leaderboard sorting
ACADEMY_PROGRESS_SCHEMA.index({ points: -1 });

export interface AcademyProgressDocument {
  _id: string;
  userId: string;
  email: string;
  displayName: string | null;
  selectedPersona: string | null;
  modules: Map<
    string,
    {
      contentRead: boolean;
      quizAttempts: number;
      quizPassed: boolean;
      bestScore: number;
      lastAttemptDate: Date | null;
      contentVersion: string | null;
    }
  >;
  points: number;
  badges: string[];
  streakDays: string[];
  lastActiveDate: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

export function getAcademyProgressModel(connection: Connection): Model<AcademyProgressDocument> {
  return getOrCreateModel<AcademyProgressDocument>(
    connection,
    'AcademyProgress',
    ACADEMY_PROGRESS_SCHEMA,
  );
}

export { ACADEMY_PROGRESS_SCHEMA };
