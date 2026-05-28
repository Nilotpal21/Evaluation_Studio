/**
 * Migration: backfill legacy zero voice filler delay values.
 *
 * Earlier ProjectRuntimeConfig documents could persist `filler.voiceDelayMs: 0`
 * because the Mongoose schema used zero as the default. The runtime now treats
 * absence as the fallback signal and uses a 500ms voice default, so stored zero
 * values must be rewritten before the new resolver interprets them literally.
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;
type ClientSession = mongoose.mongo.ClientSession;

const COLLECTION = 'project_runtime_configs';
const DEFAULT_VOICE_DELAY_MS = 500;
const LEGACY_ZERO_FILTER = { 'filler.voiceDelayMs': 0 } as const;

function sessionOptions(session?: ClientSession): { session?: ClientSession } | undefined {
  return session ? { session } : undefined;
}

async function countLegacyZeros(db: Db, session?: ClientSession): Promise<number> {
  return db.collection(COLLECTION).countDocuments(LEGACY_ZERO_FILTER, sessionOptions(session));
}

export const migration: Migration = {
  version: '20260513_034',
  description: 'Backfill legacy zero voice filler delay values to 500ms',

  async up(db: Db, session?: ClientSession) {
    const result = await db.collection(COLLECTION).updateMany(
      LEGACY_ZERO_FILTER,
      {
        $set: {
          'filler.voiceDelayMs': DEFAULT_VOICE_DELAY_MS,
        },
      },
      sessionOptions(session),
    );

    process.stdout.write(
      `[migration] project_runtime_configs: backfilled ${result.modifiedCount} voiceDelayMs values from 0 to ${DEFAULT_VOICE_DELAY_MS}\n`,
    );
  },

  async down() {
    process.stdout.write(
      '[migration] Rollback is a no-op because restoring voiceDelayMs:0 would reintroduce ambiguous immediate voice filler behavior\n',
    );
  },

  async validate(db: Db, session?: ClientSession) {
    const remainingLegacyZeros = await countLegacyZeros(db, session);

    if (remainingLegacyZeros > 0) {
      return validationFailed('Legacy zero voice filler delays remain', {
        remainingLegacyZeros,
      });
    }

    return validationPassed('Voice filler delay values no longer use zero as a default', {
      remainingLegacyZeros,
      defaultVoiceDelayMs: DEFAULT_VOICE_DELAY_MS,
    });
  },
};

export default migration;
