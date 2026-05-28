/**
 * Migration: Update Slack externalIdentifier to team_id:app_id Format
 *
 * Slack connections previously used team_id alone as externalIdentifier.
 * The new format is "{team_id}:{api_app_id}" to support multiple apps per workspace.
 *
 * Because api_app_id is not stored in the connection document, this migration
 * cannot automatically reformat existing records. Instead it marks stale connections
 * inactive and logs a warning so they can be re-created with the correct identifier.
 *
 * Date: 2026-03-01
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'channel_connections';

export const migration: Migration = {
  version: '20260301_006',
  description:
    'Mark stale Slack connections inactive (externalIdentifier now requires team_id:app_id)',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    // Find Slack connections still using the old team_id-only format (no colon)
    const stale = await collection
      .find({ channelType: 'slack', externalIdentifier: { $not: /:/ } })
      .project({ _id: 1, externalIdentifier: 1, projectId: 1 })
      .toArray();

    if (stale.length === 0) {
      console.log('[migration] No stale Slack connections found — nothing to do');
      return;
    }

    console.log(
      `[migration] Found ${stale.length} Slack connection(s) with old team_id-only externalIdentifier:`,
    );
    for (const doc of stale) {
      console.log(
        `[migration]   id=${doc._id} externalIdentifier=${doc.externalIdentifier} projectId=${doc.projectId}`,
      );
      console.log(
        `[migration]   ACTION REQUIRED: Delete and re-create this connection with ` +
          `externalIdentifier in "team_id:app_id" format (e.g. ${doc.externalIdentifier}:A<YOUR_APP_ID>).`,
      );
    }

    // Mark stale connections inactive so they do not silently route incoming events
    const result = await collection.updateMany(
      { channelType: 'slack', externalIdentifier: { $not: /:/ } },
      { $set: { status: 'inactive' } },
    );
    console.log(`[migration] Marked ${result.modifiedCount} stale Slack connection(s) inactive`);
  },

  async down(db: Db) {
    // Reactivating old connections would re-introduce the broken identifier format.
    // Leave them inactive — the operator must manually re-create connections.
    console.log(
      '[migration] down: no-op. Stale Slack connections were deactivated in up(). ' +
        'To restore, manually set status=active on the desired connections.',
    );
  },

  async validate(db: Db) {
    const collection = db.collection(COLLECTION);
    const activeLegacyConnections = await collection.countDocuments({
      channelType: 'slack',
      externalIdentifier: { $not: /:/ },
      status: { $ne: 'inactive' },
    });

    if (activeLegacyConnections > 0) {
      return validationFailed('Legacy Slack external identifiers are still active', {
        activeLegacyConnections,
      });
    }

    return validationPassed('Legacy Slack external identifiers are no longer active', {
      activeLegacyConnections,
    });
  },
};
