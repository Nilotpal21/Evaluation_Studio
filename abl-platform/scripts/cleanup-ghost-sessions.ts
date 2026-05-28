#!/usr/bin/env npx tsx
/**
 * One-off script to clean up ghost sessions from MongoDB.
 *
 * Ghost sessions are DB records created by WebSocket handlers that never
 * received any actual user messages or trace events. They appear in the
 * sessions list with 0 messages, 0 traces, and inflated durations.
 *
 * Usage:
 *   npx tsx scripts/cleanup-ghost-sessions.ts              # dry run (default)
 *   npx tsx scripts/cleanup-ghost-sessions.ts --delete      # actually delete
 *
 * Requires MONGODB_URI in env or .env file.
 */

import mongoose from 'mongoose';
import { config } from 'dotenv';

config(); // load .env

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;
if (!MONGODB_URI) {
  console.error('ERROR: Set MONGODB_URI or DATABASE_URL in your environment');
  process.exit(1);
}

const dryRun = !process.argv.includes('--delete');

async function main() {
  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(MONGODB_URI!);
  console.log('Connected.\n');

  const db = mongoose.connection.db!;
  const sessions = db.collection('sessions');

  // Ghost session criteria:
  //   messageCount === 0 (or missing)
  //   traceEventCount === 0 (or missing/null — field didn't exist before this fix)
  //   status still 'active' or 'idle' (never properly closed)
  const ghostFilter = {
    $or: [{ messageCount: 0 }, { messageCount: { $exists: false } }],
    $and: [
      {
        $or: [
          { traceEventCount: 0 },
          { traceEventCount: { $exists: false } },
          { traceEventCount: null },
        ],
      },
    ],
    status: { $in: ['active', 'idle'] },
  };

  // Count ghosts
  const ghostCount = await sessions.countDocuments(ghostFilter);
  const totalCount = await sessions.countDocuments({});

  console.log(`Total sessions in DB:  ${totalCount}`);
  console.log(`Ghost sessions found:  ${ghostCount}`);
  console.log(`Real sessions:         ${totalCount - ghostCount}\n`);

  if (ghostCount === 0) {
    console.log('No ghost sessions to clean up.');
    await mongoose.disconnect();
    return;
  }

  // Show a sample
  const sample = await sessions
    .find(ghostFilter)
    .project({
      _id: 1,
      currentAgent: 1,
      channel: 1,
      status: 1,
      messageCount: 1,
      startedAt: 1,
    })
    .limit(10)
    .toArray();

  console.log('Sample ghost sessions:');
  for (const s of sample) {
    const age = s.startedAt
      ? `${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000)}min ago`
      : 'unknown';
    console.log(
      `  ${s._id}  agent=${s.currentAgent}  ch=${s.channel}  status=${s.status}  msgs=${s.messageCount ?? 0}  created=${age}`,
    );
  }
  if (ghostCount > 10) {
    console.log(`  ... and ${ghostCount - 10} more`);
  }
  console.log();

  if (dryRun) {
    console.log('DRY RUN — no changes made. Run with --delete to remove ghost sessions.');
  } else {
    console.log(`Deleting ${ghostCount} ghost sessions...`);
    const result = await sessions.deleteMany(ghostFilter);
    console.log(`Deleted ${result.deletedCount} ghost sessions.`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
