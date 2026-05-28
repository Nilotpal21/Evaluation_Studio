#!/usr/bin/env tsx
/**
 * Migration Script: Pipeline Multi-Trigger Format
 *
 * Converts old single-trigger pipeline definitions to the new multi-trigger format.
 * Also sets activeTriggers on pipeline configs that don't have them.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-pipeline-triggers.ts
 *   pnpm tsx scripts/migrate-pipeline-triggers.ts --dry-run
 *
 * Environment:
 *   MONGODB_URL - MongoDB connection string
 */

import mongoose from 'mongoose';

// Import the new-format definitions
import {
  sentimentPipelineDefinition,
  SENTIMENT_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/sentiment-pipeline.js';
import {
  intentPipelineDefinition,
  INTENT_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/intent-pipeline.js';
import {
  qualityPipelineDefinition,
  QUALITY_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/quality-pipeline.js';
import {
  hallucinationPipelineDefinition,
  HALLUCINATION_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/hallucination-pipeline.js';
import {
  knowledgeGapPipelineDefinition,
  KNOWLEDGE_GAP_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/knowledge-gap-pipeline.js';
import {
  guardrailPipelineDefinition,
  GUARDRAIL_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/guardrail-pipeline.js';
import {
  frictionPipelineDefinition,
  FRICTION_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/friction-pipeline.js';
import {
  anomalyPipelineDefinition,
  ANOMALY_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/anomaly-pipeline.js';
import {
  driftPipelineDefinition,
  DRIFT_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/drift-pipeline.js';
import {
  evalPipelineDefinition,
  EVAL_PIPELINE_ID,
} from '../packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.js';
import { PipelineDefinitionModel } from '../packages/pipeline-engine/src/schemas/pipeline-definition.schema.js';
import { PipelineConfigModel } from '../packages/pipeline-engine/src/schemas/pipeline-config.schema.js';

const DEFINITIONS = [
  { id: SENTIMENT_PIPELINE_ID, def: sentimentPipelineDefinition },
  { id: INTENT_PIPELINE_ID, def: intentPipelineDefinition },
  { id: QUALITY_PIPELINE_ID, def: qualityPipelineDefinition },
  { id: HALLUCINATION_PIPELINE_ID, def: hallucinationPipelineDefinition },
  { id: KNOWLEDGE_GAP_PIPELINE_ID, def: knowledgeGapPipelineDefinition },
  { id: GUARDRAIL_PIPELINE_ID, def: guardrailPipelineDefinition },
  { id: FRICTION_PIPELINE_ID, def: frictionPipelineDefinition },
  { id: ANOMALY_PIPELINE_ID, def: anomalyPipelineDefinition },
  { id: DRIFT_PIPELINE_ID, def: driftPipelineDefinition },
  { id: EVAL_PIPELINE_ID, def: evalPipelineDefinition },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('=== DRY RUN MODE (no writes) ===\n');
  }

  const mongoUrl =
    process.env.MONGODB_URL ||
    process.env.MONGO_URL ||
    'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';

  console.log(`Connecting to MongoDB: ${mongoUrl.replace(/\/\/[^@]+@/, '//<credentials>@')}`);
  await mongoose.connect(mongoUrl);
  console.log('Connected.\n');

  let defUpdated = 0;
  let defSkipped = 0;
  let configUpdated = 0;
  let configSkipped = 0;

  // ── Step 1: Update pipeline definitions ─────────────────────────────────
  console.log('--- Step 1: Updating pipeline definitions ---');

  for (const { id, def } of DEFINITIONS) {
    const existing = await PipelineDefinitionModel.findById(id);

    if (!existing) {
      console.log(`  [SKIP] ${id} — not found in DB (will be created by seed script)`);
      defSkipped++;
      continue;
    }

    // Check if already migrated
    if (
      existing.supportedTriggers &&
      existing.supportedTriggers.length > 0 &&
      existing.strategies &&
      (existing.strategies instanceof Map
        ? existing.strategies.size > 0
        : Object.keys(existing.strategies).length > 0)
    ) {
      console.log(`  [SKIP] ${id} — already has supportedTriggers + strategies`);
      defSkipped++;
      continue;
    }

    console.log(`  [UPDATE] ${id} — adding multi-trigger fields`);

    if (!dryRun) {
      await PipelineDefinitionModel.findByIdAndUpdate(id, {
        $set: {
          configSchema: def.configSchema,
          supportedTriggers: def.supportedTriggers,
          defaultTriggerIds: def.defaultTriggerIds,
          strategies: def.strategies,
          updatedAt: new Date(),
        },
      });
    }
    defUpdated++;
  }

  console.log(`  Definitions: ${defUpdated} updated, ${defSkipped} skipped\n`);

  // ── Step 2: Set activeTriggers on configs ─────────────────────────────────
  console.log('--- Step 2: Setting activeTriggers on configs ---');

  const configs = await PipelineConfigModel.find({
    $or: [
      { activeTriggers: { $exists: false } },
      { activeTriggers: { $size: 0 } },
      { activeTriggers: null },
    ],
  });

  for (const config of configs) {
    // Find the matching definition to get defaultTriggerIds
    const defEntry = DEFINITIONS.find((d) => d.def.pipelineType === config.pipelineType);
    if (!defEntry) {
      console.log(`  [SKIP] ${config.pipelineType} (${config.tenantId}) — no matching definition`);
      configSkipped++;
      continue;
    }

    const defaultIds = defEntry.def.defaultTriggerIds ?? ['batch'];
    console.log(
      `  [UPDATE] ${config.pipelineType} (${config.tenantId}) — activeTriggers = [${defaultIds.join(', ')}]`,
    );

    if (!dryRun) {
      await PipelineConfigModel.findByIdAndUpdate(config._id, {
        $set: { activeTriggers: defaultIds },
      });
    }
    configUpdated++;
  }

  console.log(`  Configs: ${configUpdated} updated, ${configSkipped} skipped\n`);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('=== Migration Summary ===');
  console.log(`  Definitions: ${defUpdated} updated, ${defSkipped} skipped`);
  console.log(`  Configs: ${configUpdated} updated, ${configSkipped} skipped`);
  if (dryRun) {
    console.log('\n  (DRY RUN — no changes were written)');
  }
}

main()
  .catch((e) => {
    console.error('Migration error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
