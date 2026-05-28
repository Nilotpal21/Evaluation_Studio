/**
 * Migration: add projectId + profileId to end_user_oauth_tokens
 *
 * Backfill strategy (three cases per HLD §9.4 #10):
 *   (a) Token's provider matches a profile with connector + projectId → adopt profile's projectId + _id
 *   (b) Token's source profile is tenant-scoped (no projectId) → leave projectId null
 *   (c) Unresolvable (no matching profile) → leave both null
 *
 * Index changes:
 *   - Drop old unique index: { tenantId, userId, provider }
 *   - Create partial unique: { tenantId, projectId, userId, provider } where projectId is string
 *   - Create partial secondary: { tenantId, profileId, userId } where profileId is string
 *
 * Idempotent: fields checked before update, index ops are safe to re-run.
 * Reversible: down() drops new indexes, restores old unique, unsets new fields.
 *
 * Date: 2026-05-08
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex } from '../validation.js';

type Db = mongoose.mongo.Db;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

const TOKEN_COLLECTION = 'end_user_oauth_tokens';
const PROFILE_COLLECTION = 'auth_profiles';

const OLD_UNIQUE_KEY = { tenantId: 1, userId: 1, provider: 1 };
const NEW_PARTIAL_UNIQUE_KEY = { tenantId: 1, projectId: 1, userId: 1, provider: 1 };
const NEW_PARTIAL_SECONDARY_KEY = { tenantId: 1, profileId: 1, userId: 1 };
const NEW_PARTIAL_UNIQUE_NAME = 'tenantId_1_projectId_1_userId_1_provider_1';
const NEW_PARTIAL_SECONDARY_NAME = 'tenantId_1_profileId_1_userId_1';

export const migration: Migration = {
  version: '20260508_020',
  description:
    'Add projectId + profileId to end_user_oauth_tokens; swap unique index for partial unique',
  transactionMode: 'none',

  async up(db: Db) {
    const tokenCol = db.collection(TOKEN_COLLECTION);
    const profileCol = db.collection(PROFILE_COLLECTION);

    // ── Phase 1: Backfill projectId + profileId ─────────────────────────
    // Find tokens that don't yet have projectId/profileId set
    const tokensToBackfill = await tokenCol
      .find({
        $or: [{ projectId: { $exists: false } }, { profileId: { $exists: false } }],
      })
      .toArray();

    let resolvedCount = 0;
    let tenantScopedCount = 0;
    let unresolvableCount = 0;

    for (const token of tokensToBackfill) {
      // Try to find a matching auth profile via provider name
      const matchingProfile = await profileCol.findOne({
        tenantId: token.tenantId,
        connector: token.provider,
        status: 'active',
      });

      if (matchingProfile && matchingProfile.projectId) {
        // Case (a): Profile has a projectId — adopt it
        await tokenCol.updateOne(
          { _id: token._id },
          {
            $set: {
              projectId: matchingProfile.projectId,
              profileId: matchingProfile._id,
            },
          },
        );
        resolvedCount++;
      } else if (matchingProfile && !matchingProfile.projectId) {
        // Case (b): Profile is tenant-scoped — set profileId but leave projectId null
        await tokenCol.updateOne(
          { _id: token._id },
          {
            $set: {
              profileId: matchingProfile._id,
              projectId: null,
            },
          },
        );
        tenantScopedCount++;
      } else {
        // Case (c): No matching profile — set both to null
        await tokenCol.updateOne(
          { _id: token._id },
          {
            $set: {
              projectId: null,
              profileId: null,
            },
          },
        );
        unresolvableCount++;
      }
    }

    log.info(
      `Backfilled end_user_oauth_tokens: ${resolvedCount} resolved, ${tenantScopedCount} tenant-scoped, ${unresolvableCount} unresolvable`,
    );

    // ── Phase 2: Drop old unique index ──────────────────────────────────
    const hasOldIndex = await hasIndex(db, TOKEN_COLLECTION, OLD_UNIQUE_KEY, {
      unique: true,
    });
    if (hasOldIndex) {
      try {
        await tokenCol.dropIndex('tenantId_1_userId_1_provider_1');
        log.info('Dropped old unique index: tenantId_1_userId_1_provider_1');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.info(`Could not drop old unique index by name (${message}), skipping`);
      }
    } else {
      log.info('Old unique index not present, skipping drop');
    }

    // ── Phase 3: Create new partial unique index ────────────────────────
    const hasNewUnique = await hasIndex(db, TOKEN_COLLECTION, NEW_PARTIAL_UNIQUE_KEY, {
      unique: true,
    });
    if (!hasNewUnique) {
      await tokenCol.createIndex(NEW_PARTIAL_UNIQUE_KEY, {
        name: NEW_PARTIAL_UNIQUE_NAME,
        unique: true,
        partialFilterExpression: { projectId: { $type: 'string' } },
      });
      log.info(`Created partial unique index: ${NEW_PARTIAL_UNIQUE_NAME}`);
    } else {
      log.info(`Partial unique index already exists: ${NEW_PARTIAL_UNIQUE_NAME}`);
    }

    // ── Phase 4: Create new partial secondary index ─────────────────────
    const hasNewSecondary = await hasIndex(db, TOKEN_COLLECTION, NEW_PARTIAL_SECONDARY_KEY);
    if (!hasNewSecondary) {
      await tokenCol.createIndex(NEW_PARTIAL_SECONDARY_KEY, {
        name: NEW_PARTIAL_SECONDARY_NAME,
        partialFilterExpression: { profileId: { $type: 'string' } },
      });
      log.info(`Created partial secondary index: ${NEW_PARTIAL_SECONDARY_NAME}`);
    } else {
      log.info(`Partial secondary index already exists: ${NEW_PARTIAL_SECONDARY_NAME}`);
    }
  },

  async down(db: Db) {
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Drop new indexes
    try {
      await tokenCol.dropIndex(NEW_PARTIAL_UNIQUE_NAME);
      log.info(`Dropped partial unique index: ${NEW_PARTIAL_UNIQUE_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.info(`Index ${NEW_PARTIAL_UNIQUE_NAME} not found (${message}), continuing`);
    }

    try {
      await tokenCol.dropIndex(NEW_PARTIAL_SECONDARY_NAME);
      log.info(`Dropped partial secondary index: ${NEW_PARTIAL_SECONDARY_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.info(`Index ${NEW_PARTIAL_SECONDARY_NAME} not found (${message}), continuing`);
    }

    // Restore old unique index
    const hasOld = await hasIndex(db, TOKEN_COLLECTION, OLD_UNIQUE_KEY, { unique: true });
    if (!hasOld) {
      await tokenCol.createIndex(OLD_UNIQUE_KEY, {
        name: 'tenantId_1_userId_1_provider_1',
        unique: true,
      });
      log.info('Restored old unique index: tenantId_1_userId_1_provider_1');
    }

    // Unset new fields
    const result = await tokenCol.updateMany({}, { $unset: { projectId: '', profileId: '' } });
    log.info(`Unset projectId + profileId on ${result.modifiedCount} end_user_oauth_tokens`);
  },

  async validate(db: Db) {
    const hasOld = await hasIndex(db, TOKEN_COLLECTION, OLD_UNIQUE_KEY, {
      unique: true,
    });
    const hasNewUnique = await hasIndex(db, TOKEN_COLLECTION, NEW_PARTIAL_UNIQUE_KEY, {
      unique: true,
    });
    const hasNewSecondary = await hasIndex(db, TOKEN_COLLECTION, NEW_PARTIAL_SECONDARY_KEY);

    if (hasOld || !hasNewUnique || !hasNewSecondary) {
      return {
        ok: false,
        summary: 'end_user_oauth_tokens indexes do not match expected state',
        details: {
          oldUniquePresent: hasOld,
          newPartialUniquePresent: hasNewUnique,
          newPartialSecondaryPresent: hasNewSecondary,
        },
      };
    }

    return {
      ok: true,
      summary: 'end_user_oauth_tokens has correct partial unique and secondary indexes',
      details: {
        oldUniquePresent: hasOld,
        newPartialUniquePresent: hasNewUnique,
        newPartialSecondaryPresent: hasNewSecondary,
      },
    };
  },
};

export default migration;
