/**
 * Project Memory Service — cross-session memory for Arch AI.
 *
 * Persists decisions, patterns, preferences, constraints, and learnings
 * across sessions. Memories are injected into the LLM system prompt during
 * IN_PROJECT mode so the AI retains context about previous work.
 *
 * Memory lifecycle:
 * - Auto-extracted from completed sessions (decisions from journal, patterns from topology)
 * - Manually added by users via manage_memory tool
 * - Eviction: when max limit (50) is reached, lowest relevance entry is removed
 *
 * Scoping: all queries include tenantId (never findById).
 */

import type { Model } from 'mongoose';
import type {
  IArchProjectMemoryRecord,
  IProjectMemoryEntry,
  ProjectMemoryType,
  ProjectMemorySource,
} from '../models/index.js';
import { createLogger } from '@agent-platform/shared-observability';
import type { ArchSession } from '../types/session.js';
import type { JournalEntry, DecisionContent, MutationContent } from '../journal/types.js';

const log = createLogger('arch-ai:project-memory');

/** Max memories per project — sliding window evicts lowest relevance */
const MAX_MEMORIES = 50;

/** Max content length per memory entry — keeps prompt injection budget manageable */
const MAX_CONTENT_LENGTH = 500;

interface MemoryContext {
  tenantId: string;
  userId: string;
}

export interface ProjectMemoryEntry {
  id: string;
  type: ProjectMemoryType;
  content: string;
  source: ProjectMemorySource;
  phase: string;
  sessionId: string;
  createdAt: Date;
  relevance: number;
}

export interface AddMemoryParams {
  type: ProjectMemoryType;
  content: string;
  source: ProjectMemorySource;
  phase: string;
  sessionId: string;
  relevance?: number;
}

function toProjectMemoryEntry(doc: IProjectMemoryEntry): ProjectMemoryEntry {
  return {
    id: doc.id,
    type: doc.type,
    content: doc.content,
    source: doc.source,
    phase: doc.phase,
    sessionId: doc.sessionId,
    createdAt: doc.createdAt,
    relevance: doc.relevance,
  };
}

export class ProjectMemoryService {
  constructor(private readonly model: Model<IArchProjectMemoryRecord>) {}

  /**
   * Get all memories for a project, sorted by relevance (highest first).
   */
  async getProjectMemories(ctx: MemoryContext, projectId: string): Promise<ProjectMemoryEntry[]> {
    const doc = await this.model.findOne({
      tenantId: ctx.tenantId,
      projectId,
    });

    if (!doc) return [];

    return doc.memories.map(toProjectMemoryEntry).sort((a, b) => b.relevance - a.relevance);
  }

  /**
   * Add a memory entry for a project.
   * Uses atomic $push with $sort/$slice to enforce the MAX_MEMORIES cap
   * without a window where the array transiently exceeds the limit.
   */
  async addMemory(
    ctx: MemoryContext,
    projectId: string,
    entry: AddMemoryParams,
  ): Promise<ProjectMemoryEntry> {
    const truncatedContent =
      entry.content.length > MAX_CONTENT_LENGTH
        ? entry.content.slice(0, MAX_CONTENT_LENGTH - 1) + '\u2026'
        : entry.content;

    const memoryEntry: IProjectMemoryEntry = {
      id: crypto.randomUUID(),
      type: entry.type,
      content: truncatedContent,
      source: entry.source,
      phase: entry.phase,
      sessionId: entry.sessionId,
      createdAt: new Date(),
      relevance: entry.relevance ?? 0.5,
    };

    // Atomic push + eviction: $push with $each/$sort/$slice ensures the array
    // never transiently exceeds MAX_MEMORIES, eliminating the race window
    // from the previous push + separate eviction pattern.
    await this.model.findOneAndUpdate(
      { tenantId: ctx.tenantId, projectId },
      {
        $setOnInsert: {
          tenantId: ctx.tenantId,
          projectId,
          _v: 1,
        },
        $push: {
          memories: {
            $each: [memoryEntry],
            $sort: { relevance: -1 },
            $slice: MAX_MEMORIES,
          },
        },
      },
      { upsert: true, new: true },
    );

    return toProjectMemoryEntry(memoryEntry);
  }

  /**
   * Delete a specific memory by its ID.
   */
  async deleteMemory(ctx: MemoryContext, projectId: string, memoryId: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { tenantId: ctx.tenantId, projectId },
      { $pull: { memories: { id: memoryId } } },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Delete all memories matching a content substring (for "forget" commands).
   * Returns number of memories deleted.
   */
  async deleteMemoriesByContent(
    ctx: MemoryContext,
    projectId: string,
    contentSubstring: string,
  ): Promise<number> {
    const doc = await this.model.findOne({
      tenantId: ctx.tenantId,
      projectId,
    });

    if (!doc) return 0;

    const lowerSearch = contentSubstring.toLowerCase();
    const toRemove = doc.memories.filter((m) => m.content.toLowerCase().includes(lowerSearch));

    if (toRemove.length === 0) return 0;

    const idsToRemove = toRemove.map((m) => m.id);
    await this.model.updateOne(
      { tenantId: ctx.tenantId, projectId },
      { $pull: { memories: { id: { $in: idsToRemove } } } },
    );

    return toRemove.length;
  }

  /**
   * Extract memories from journal entries for a completed session.
   * Called when a session transitions to COMPLETE/ARCHIVED.
   *
   * Extracts:
   * - Decisions: from journal entries of type 'decision'
   * - Patterns: from topology pattern selection
   * - Constraints: from specification constraints
   * - Learnings: from validation errors that required fixes
   */
  async extractMemoriesFromSession(
    ctx: MemoryContext,
    projectId: string,
    session: ArchSession,
    journalEntries: JournalEntry[],
  ): Promise<ProjectMemoryEntry[]> {
    const extracted: AddMemoryParams[] = [];

    // 1. Extract decisions from journal
    const decisions = journalEntries.filter((e) => e.type === 'decision' && e.status === 'active');
    for (const decision of decisions) {
      const content = decision.content as { type: 'decision' } & DecisionContent;
      if (content.summary) {
        extracted.push({
          type: 'decision',
          content: content.summary + (content.rationale ? ` (${content.rationale})` : ''),
          source: 'auto',
          phase: decision.phase,
          sessionId: session.id,
          relevance: content.source === 'user_input' ? 0.9 : 0.7,
        });
      }
    }

    // 2. Extract patterns from topology
    const topology = session.metadata.topology as
      | { pattern?: string; agents?: Array<{ name: string }> }
      | undefined;
    if (topology?.pattern) {
      const agentCount = Array.isArray(topology.agents) ? topology.agents.length : 0;
      extracted.push({
        type: 'pattern',
        content: `Selected ${topology.pattern} topology pattern with ${agentCount} agents`,
        source: 'auto',
        phase: 'BLUEPRINT',
        sessionId: session.id,
        relevance: 0.8,
      });
    }

    // 3. Extract constraints/preferences from conversation notes
    // The session specification has conversationNotes that capture compliance,
    // integration, SLA, and constraint details gathered during interview.
    const spec = session.metadata.specification;
    if (spec?.conversationNotes && Array.isArray(spec.conversationNotes)) {
      for (const note of spec.conversationNotes) {
        if (note.detail && note.category === 'compliance') {
          extracted.push({
            type: 'constraint',
            content: `Compliance: ${note.label} \u2014 ${note.detail}`,
            source: 'auto',
            phase: 'INTERVIEW',
            sessionId: session.id,
            relevance: 0.9,
          });
        } else if (note.detail && note.category === 'sla') {
          extracted.push({
            type: 'constraint',
            content: `SLA: ${note.label} \u2014 ${note.detail}`,
            source: 'auto',
            phase: 'INTERVIEW',
            sessionId: session.id,
            relevance: 0.85,
          });
        } else if (
          note.detail &&
          (note.category === 'escalation' || note.category === 'integration')
        ) {
          extracted.push({
            type: 'preference',
            content: `${note.label}: ${note.detail}`,
            source: 'auto',
            phase: 'INTERVIEW',
            sessionId: session.id,
            relevance: 0.75,
          });
        }
      }
    }

    // 4. Extract learnings from mutations (fixes applied after validation)
    const mutations = journalEntries.filter((e) => e.type === 'mutation' && e.status === 'active');
    for (const mutation of mutations) {
      const content = mutation.content as { type: 'mutation' } & MutationContent;
      if (content.reason && content.what) {
        extracted.push({
          type: 'learning',
          content: `${content.what}: ${content.reason}`,
          source: 'auto',
          phase: mutation.phase,
          sessionId: session.id,
          relevance: 0.6,
        });
      }
    }

    // Deduplicate by content similarity — skip entries whose content
    // already exists in the project memories
    const existing = await this.getProjectMemories(ctx, projectId);
    const existingContents = new Set(existing.map((m) => m.content.toLowerCase().trim()));

    const deduped = extracted.filter((e) => !existingContents.has(e.content.toLowerCase().trim()));

    // Persist — limit to 10 new memories per extraction to avoid flooding
    const toAdd = deduped.slice(0, 10);
    const added: ProjectMemoryEntry[] = [];

    for (const entry of toAdd) {
      try {
        const mem = await this.addMemory(ctx, projectId, entry);
        added.push(mem);
      } catch (err: unknown) {
        log.warn('Failed to add extracted memory', {
          projectId,
          type: entry.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (added.length > 0) {
      log.info('Extracted memories from session', {
        projectId,
        sessionId: session.id,
        totalExtracted: extracted.length,
        dedupedCount: deduped.length,
        addedCount: added.length,
      });
    }

    return added;
  }

  /**
   * Format memories for injection into the LLM system prompt.
   * Returns null if there are no memories.
   *
   * Budget: aims for ~1000 tokens max (~4000 chars).
   * Memories are sorted by relevance, highest first.
   */
  formatMemoriesForPrompt(memories: ProjectMemoryEntry[]): string | null {
    if (memories.length === 0) return null;

    const sorted = [...memories].sort((a, b) => b.relevance - a.relevance);
    const lines: string[] = [
      '## Project Memory (from previous sessions)',
      'These are decisions, patterns, and learnings from previous work on this project:',
      '',
    ];

    let charBudget = 3500; // ~875 tokens at 4 chars/token

    for (const mem of sorted) {
      const line = `- [${mem.type}] ${mem.content}`;
      if (charBudget - line.length < 0) break;
      charBudget -= line.length;
      lines.push(line);
    }

    lines.push('');
    lines.push(
      'Use this memory silently to inform your responses. Do not recite it unless the user asks "what do you remember?"',
    );

    return lines.join('\n');
  }
}
