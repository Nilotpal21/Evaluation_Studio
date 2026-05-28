/**
 * Migration: Enable Default LLM Features
 *
 * Updates existing SearchIndex documents to enable core LLM features by default.
 * Sets llmConfig.enabled = true and enables core features (progressive summarization,
 * question synthesis, knowledge graph extraction) with smart defaults.
 *
 * Date: 2026-02-25
 * Author: SearchAI Team
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

export const migration: Migration = {
  version: '20260225_003',
  description: 'Enable default LLM features for existing search indexes',

  async up(db: Db) {
    const collection = db.collection('search_indexes');

    console.log('[migration] Updating search indexes with default LLM configuration...');

    // Find all indexes without llmConfig or with llmConfig.enabled = false
    const indexes = await collection
      .find({
        $or: [
          { llmConfig: { $exists: false } },
          { llmConfig: null },
          { 'llmConfig.enabled': false },
          { 'llmConfig.enabled': { $exists: false } },
        ],
      })
      .toArray();

    console.log(`[migration] Found ${indexes.length} indexes to update`);

    if (indexes.length === 0) {
      console.log('[migration] No indexes need updating');
      return;
    }

    // Update each index with default LLM configuration
    let updated = 0;
    for (const index of indexes) {
      const indexId = index._id;
      const existingConfig = index.llmConfig || {};

      // Build new llmConfig with defaults
      const newLLMConfig = {
        enabled: true, // Enable LLM features globally
        useCases: {
          // Core features - enabled by default
          progressiveSummarization: {
            enabled: true,
            modelTier: 'fast',
            maxTokens: 300,
            enableDocumentSummary: true,
            documentSummaryMaxTokens: 500,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.progressiveSummarization || {}),
          },

          questionSynthesis: {
            enabled: true,
            modelTier: 'fast',
            questionsPerChunk: 3,
            maxTokens: 150,
            enableEmbedding: true,
            enableDocumentQuestions: true,
            documentQuestionsCount: 5,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.questionSynthesis || {}),
          },

          knowledgeGraph: {
            enabled: true, // NOW ENABLED BY DEFAULT
            modelTier: 'fast',
            enableCoOccurrence: true,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.knowledgeGraph || {}),
          },

          // Specialized features - remain disabled by default
          noiseDetection: {
            enabled: false,
            modelTier: 'fast',
            enableConceptExtraction: true,
            conceptConfidenceThreshold: 0.6,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.noiseDetection || {}),
          },

          scopeClassification: {
            enabled: false,
            modelTier: 'fast',
            maxTokens: 50,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.scopeClassification || {}),
          },

          // Advanced/expensive features - remain disabled by default
          vision: {
            enabled: false,
            modelTier: 'balanced',
            maxTokens: 500,
            analyzeScreenshots: true,
            analyzeImages: true,
            enhanceTableContinuations: true,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.vision || {}),
          },

          multimodal: {
            enabled: false,
            modelTier: 'balanced',
            enableImageDescription: true,
            enableTableSummarization: true,
            enableChartAnalysis: true,
            // Preserve any existing overrides
            ...(existingConfig.useCases?.multimodal || {}),
          },

          // Preserve any other use cases that may exist
          ...(existingConfig.useCases || {}),
        },
      };

      // Update the index
      await collection.updateOne({ _id: indexId }, { $set: { llmConfig: newLLMConfig } });

      updated++;

      if (updated % 10 === 0) {
        console.log(`[migration] Updated ${updated}/${indexes.length} indexes`);
      }
    }

    console.log(`[migration] Successfully updated ${updated} search indexes`);
  },

  async down(db: Db) {
    const collection = db.collection('search_indexes');

    console.log('[migration] Reverting LLM configuration changes...');

    // Find all indexes with llmConfig.enabled = true
    const indexes = await collection.find({ 'llmConfig.enabled': true }).toArray();

    console.log(`[migration] Found ${indexes.length} indexes to revert`);

    if (indexes.length === 0) {
      console.log('[migration] No indexes need reverting');
      return;
    }

    let reverted = 0;
    for (const index of indexes) {
      const indexId = index._id;

      // Disable knowledge graph (newly enabled feature)
      await collection.updateOne(
        { _id: indexId },
        {
          $set: {
            'llmConfig.enabled': false,
            'llmConfig.useCases.knowledgeGraph.enabled': false,
          },
        },
      );

      reverted++;

      if (reverted % 10 === 0) {
        console.log(`[migration] Reverted ${reverted}/${indexes.length} indexes`);
      }
    }

    console.log(`[migration] Successfully reverted ${reverted} search indexes`);
  },
};

export default migration;
