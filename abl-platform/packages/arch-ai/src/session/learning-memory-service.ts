/**
 * Learning Memory Service — Arch AI's cross-project knowledge (Layer 3).
 *
 * Records patterns that Arch discovers across all projects:
 * - Error->fix patterns (compile errors and their resolutions)
 * - Topology->domain mappings (which patterns work for which domains)
 * - Construct usage (which ABL constructs are used for which agent roles)
 * - Model preferences (which LLM configs work best)
 *
 * Unlike project memory (Layer 2, scoped per project), learning memory
 * is Arch's OWN knowledge that improves its recommendations over time.
 *
 * Bounded to MAX_LEARNINGS. Confidence increases with observations,
 * capped at 0.95. All entries are anonymized.
 *
 * Note: This service queries by type+pattern (not userId) because
 * learnings are global cross-project knowledge, not user-owned resources.
 * The model has no userId field — it is intentionally tenant-optional
 * and anonymized for cross-project pattern aggregation.
 */

import type { Model } from 'mongoose';
import type { IArchLearningMemoryRecord, LearningMemoryType } from '../models/index.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('arch-ai:learning-memory');

/** Max learning entries — evict lowest confidence when exceeded */
const MAX_LEARNINGS = 1000;

/** Max pattern/resolution text length */
const MAX_TEXT_LENGTH = 300;

/** Initial confidence for new observations */
const INITIAL_CONFIDENCE = 0.3;

/** Confidence increment per observation */
const CONFIDENCE_INCREMENT = 0.1;

/** Maximum confidence value */
const MAX_CONFIDENCE = 0.95;

/** Minimum confidence threshold for prompt injection */
const PROMPT_INJECTION_THRESHOLD = 0.5;

/** Max learnings returned per query */
const MAX_QUERY_RESULTS = 10;

/** Max chars budget for prompt injection (~500 tokens) */
const MAX_PROMPT_CHARS = 2000;

// ─── Types ──────────────────────────────────────────────────────────────

export interface LearningEntry {
  id: string;
  type: LearningMemoryType;
  pattern: string;
  resolution: string;
  confidence: number;
  observationCount: number;
  domain?: string;
  agentRole?: string;
  construct?: string;
  firstSeen: Date;
  lastSeen: Date;
}

export interface LearningContext {
  domain?: string;
  constructs?: string[];
  phase?: string;
  agentRole?: string;
}

export interface RecordErrorFixParams {
  errorCode?: string;
  errorMessage: string;
  fixDescription: string;
  context?: {
    domain?: string;
    agentRole?: string;
    construct?: string;
  };
}

export interface RecordTopologyChoiceParams {
  domain: string;
  pattern: string;
  agentCount: number;
}

export interface RecordConstructUsageParams {
  construct: string;
  agentRole: string;
  domain?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

function computeConfidence(observationCount: number): number {
  return Math.min(MAX_CONFIDENCE, INITIAL_CONFIDENCE + observationCount * CONFIDENCE_INCREMENT);
}

function toLearningEntry(doc: IArchLearningMemoryRecord): LearningEntry {
  return {
    id: doc._id,
    type: doc.type,
    pattern: doc.pattern,
    resolution: doc.resolution,
    confidence: doc.confidence,
    observationCount: doc.observationCount,
    domain: doc.domain,
    agentRole: doc.agentRole,
    construct: doc.construct,
    firstSeen: doc.firstSeen,
    lastSeen: doc.lastSeen,
  };
}

// ─── Service ────────────────────────────────────────────────────────────

export class LearningMemoryService {
  constructor(private readonly model: Model<IArchLearningMemoryRecord>) {}

  /**
   * Record an error->fix pattern.
   * If a similar pattern exists, increment its observation count and update
   * confidence. If new, create with initial confidence.
   */
  async recordErrorFix(params: RecordErrorFixParams): Promise<LearningEntry> {
    const pattern = truncateText(
      params.errorCode ? `[${params.errorCode}] ${params.errorMessage}` : params.errorMessage,
      MAX_TEXT_LENGTH,
    );
    const resolution = truncateText(params.fixDescription, MAX_TEXT_LENGTH);

    return this.upsertLearning({
      type: 'error_fix',
      pattern,
      resolution,
      domain: params.context?.domain,
      agentRole: params.context?.agentRole,
      construct: params.context?.construct,
    });
  }

  /**
   * Record a topology choice for a domain.
   * Tracks which topology patterns are used for which domains.
   */
  async recordTopologyChoice(params: RecordTopologyChoiceParams): Promise<LearningEntry> {
    const pattern = truncateText(
      `${params.domain}: ${params.pattern} (${params.agentCount} agents)`,
      MAX_TEXT_LENGTH,
    );
    const resolution = truncateText(
      `Use ${params.pattern} pattern with ${params.agentCount} agents for ${params.domain} projects`,
      MAX_TEXT_LENGTH,
    );

    return this.upsertLearning({
      type: 'topology_pattern',
      pattern,
      resolution,
      domain: params.domain,
    });
  }

  /**
   * Record a construct usage for an agent role.
   * Tracks which ABL constructs are commonly used for which agent roles.
   */
  async recordConstructUsage(params: RecordConstructUsageParams): Promise<LearningEntry> {
    const pattern = truncateText(
      `${params.construct} in ${params.agentRole} agents`,
      MAX_TEXT_LENGTH,
    );
    const resolution = truncateText(
      `${params.construct} is commonly used in ${params.agentRole} agents`,
      MAX_TEXT_LENGTH,
    );

    return this.upsertLearning({
      type: 'construct_usage',
      pattern,
      resolution,
      domain: params.domain,
      agentRole: params.agentRole,
      construct: params.construct,
    });
  }

  /**
   * Get relevant learnings for the current context.
   * Filters by confidence threshold, sorts by confidence DESC.
   * Returns max MAX_QUERY_RESULTS entries.
   *
   * Note: Learnings are global cross-project knowledge (not user-owned).
   * No userId filter is needed — the model is intentionally anonymized.
   */
  async getRelevantLearnings(context: LearningContext): Promise<LearningEntry[]> {
    const filter: Record<string, unknown> = {
      confidence: { $gt: PROMPT_INJECTION_THRESHOLD },
    };

    // Build OR conditions for contextual matching
    const orConditions: Record<string, unknown>[] = [];

    if (context.domain) {
      orConditions.push({ domain: context.domain });
      // Also include domain-agnostic (global) learnings
      orConditions.push({ domain: { $exists: false } });
      orConditions.push({ domain: null });
    }

    if (context.constructs && context.constructs.length > 0) {
      orConditions.push({ construct: { $in: context.constructs } });
    }

    if (context.agentRole) {
      orConditions.push({ agentRole: context.agentRole });
    }

    // If we have context filters, use $or; otherwise return top learnings
    if (orConditions.length > 0) {
      filter.$or = orConditions;
    }

    const docs = await this.model
      .find(filter)
      .sort({ confidence: -1 })
      .limit(MAX_QUERY_RESULTS)
      .lean();

    return docs.map(toLearningEntry);
  }

  /**
   * Format learnings as a concise prompt section for LLM injection.
   * Groups by type, keeps under token budget.
   */
  formatLearningsForPrompt(learnings: LearningEntry[]): string | null {
    if (learnings.length === 0) return null;

    const groups: Record<string, LearningEntry[]> = {
      error_fix: [],
      topology_pattern: [],
      construct_usage: [],
      model_preference: [],
    };

    for (const entry of learnings) {
      groups[entry.type].push(entry);
    }

    const sections: string[] = ['## Arch Experience'];
    let charCount = sections[0].length;

    // Topology guidance
    if (groups.topology_pattern.length > 0) {
      const header = '\n### Topology Guidance';
      charCount += header.length;
      if (charCount < MAX_PROMPT_CHARS) {
        sections.push(header);
        for (const entry of groups.topology_pattern) {
          const pct = Math.round(entry.confidence * 100);
          const line = `- ${entry.pattern} (${pct}% confidence, ${entry.observationCount} observations)`;
          charCount += line.length + 1;
          if (charCount > MAX_PROMPT_CHARS) break;
          sections.push(line);
        }
      }
    }

    // Error avoidance
    if (groups.error_fix.length > 0) {
      const header = '\n### Common Mistakes to Avoid';
      charCount += header.length;
      if (charCount < MAX_PROMPT_CHARS) {
        sections.push(header);
        for (const entry of groups.error_fix) {
          const line = `- ${entry.pattern}: ${entry.resolution}`;
          charCount += line.length + 1;
          if (charCount > MAX_PROMPT_CHARS) break;
          sections.push(line);
        }
      }
    }

    // Construct recommendations
    if (groups.construct_usage.length > 0) {
      const header = '\n### Recommended Constructs';
      charCount += header.length;
      if (charCount < MAX_PROMPT_CHARS) {
        sections.push(header);
        for (const entry of groups.construct_usage) {
          const pct = Math.round(entry.confidence * 100);
          const line = `- ${entry.pattern} (${pct}% usage rate)`;
          charCount += line.length + 1;
          if (charCount > MAX_PROMPT_CHARS) break;
          sections.push(line);
        }
      }
    }

    // Only the header? No actual content to inject.
    if (sections.length <= 1) return null;

    return sections.join('\n');
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /**
   * Upsert a learning: atomically increment observation count if pattern exists,
   * create with initial confidence if new.
   * Enforces the MAX_LEARNINGS bound by evicting lowest confidence.
   *
   * Note: Queries are by type+pattern (global knowledge), not by userId.
   * This is intentional — learnings are anonymized cross-project data.
   */
  private async upsertLearning(params: {
    type: LearningMemoryType;
    pattern: string;
    resolution: string;
    domain?: string;
    agentRole?: string;
    construct?: string;
  }): Promise<LearningEntry> {
    const now = new Date();
    const truncatedPattern = truncateText(params.pattern, MAX_TEXT_LENGTH);

    // Atomic upsert: increment observation count if existing, create if new.
    // Eliminates the TOCTOU race from the previous findOne + findOneAndUpdate pattern.
    const result = await this.model.findOneAndUpdate(
      { type: params.type, pattern: truncatedPattern },
      {
        $inc: { observationCount: 1 },
        $set: {
          lastSeen: now,
          resolution: truncateText(params.resolution, MAX_TEXT_LENGTH),
          ...(params.domain && { domain: params.domain }),
          ...(params.agentRole && { agentRole: params.agentRole }),
          ...(params.construct && { construct: params.construct }),
        },
        $setOnInsert: {
          confidence: INITIAL_CONFIDENCE,
          firstSeen: now,
        },
      },
      { upsert: true, new: true },
    );

    if (result) {
      // Recompute confidence from the returned observationCount
      const newConfidence = computeConfidence(result.observationCount);
      if (Math.abs(newConfidence - result.confidence) > 0.01) {
        await this.model.updateOne({ _id: result._id }, { $set: { confidence: newConfidence } });
      }

      log.info(
        result.observationCount > 1
          ? 'Learning pattern reinforced'
          : 'New learning pattern recorded',
        {
          type: params.type,
          pattern: truncatedPattern,
          observationCount: result.observationCount,
          confidence: newConfidence,
        },
      );
    }

    // Enforce max limit — evict lowest confidence if over cap
    const totalCount = await this.model.countDocuments();
    if (totalCount > MAX_LEARNINGS) {
      const lowestConfidence = await this.model.findOne().sort({ confidence: 1 }).lean();

      if (lowestConfidence) {
        await this.model.deleteOne({ _id: lowestConfidence._id });
        log.info('Evicted lowest-confidence learning', {
          evictedId: lowestConfidence._id,
          evictedConfidence: lowestConfidence.confidence,
          evictedType: lowestConfidence.type,
        });
      }
    }

    return toLearningEntry(result!);
  }
}
