/**
 * A2A Agent Card Builder
 *
 * Builds AgentCard objects from ChannelConnection records, with an
 * LRU cache (TTL 5 min, max 100 entries) to avoid repeated DB lookups.
 */

import type { AgentCard } from '@agent-platform/a2a';
import type { IChannelConnection } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';
import { findProjectByIdAndTenant } from '../../repos/project-repo.js';

const log = createLogger('a2a-agent-card-builder');

// ─── A2A connection config overlay ──────────────────────────────────────

/** A2A-specific config stored in ChannelConnection.config */
export interface A2AConnectionConfig {
  card?: {
    name?: string;
    description?: string;
    version?: string;
    skills?: Array<{
      name: string;
      description: string;
      tags?: string[];
    }>;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
  };
}

// ─── Card cache (LRU with TTL) ─────────────────────────────────────────

const CARD_CACHE_TTL_MS = 5 * 60 * 1000;
const CARD_CACHE_MAX_SIZE = 100;

interface CardCacheEntry {
  card: AgentCard;
  expiresAt: number;
}

const cardCache = new Map<string, CardCacheEntry>();

export function getCachedCard(connectionId: string): AgentCard | null {
  const entry = cardCache.get(connectionId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cardCache.delete(connectionId);
    return null;
  }

  // LRU: re-insert to move to end (most-recently-used)
  cardCache.delete(connectionId);
  cardCache.set(connectionId, entry);

  return entry.card;
}

export function cacheCard(connectionId: string, card: AgentCard): void {
  // Evict expired entries first
  if (cardCache.size >= CARD_CACHE_MAX_SIZE && !cardCache.has(connectionId)) {
    const now = Date.now();
    for (const [key, entry] of cardCache) {
      if (now > entry.expiresAt) {
        cardCache.delete(key);
      }
    }
  }

  // If still at capacity, evict LRU (first entry in Map iteration order)
  if (cardCache.size >= CARD_CACHE_MAX_SIZE && !cardCache.has(connectionId)) {
    const lru = cardCache.keys().next().value;
    if (lru !== undefined) {
      cardCache.delete(lru);
    }
  }

  cardCache.set(connectionId, {
    card,
    expiresAt: Date.now() + CARD_CACHE_TTL_MS,
  });
}

export function invalidateCard(connectionId: string): void {
  cardCache.delete(connectionId);
}

export function invalidateAllCards(): void {
  cardCache.clear();
}

// ─── Project shape for card builder ─────────────────────────────────────

/** Minimal interface for project fields used in agent card construction */
interface ProjectInfo {
  name?: string;
  description?: string;
}

// ─── Card builder ───────────────────────────────────────────────────────

export async function buildAgentCard(connection: IChannelConnection): Promise<AgentCard> {
  const cached = getCachedCard(connection._id);
  if (cached) return cached;

  let projectName = '';
  let projectDescription = '';

  const project: ProjectInfo | null = await findProjectByIdAndTenant(
    connection.projectId,
    connection.tenantId,
  );
  if (!project) {
    throw new Error(`Project ${connection.projectId} not found`);
  }
  projectName = project.name ?? '';
  projectDescription = project.description ?? '';

  const overrides = (connection.config as A2AConnectionConfig)?.card || {};
  const displayName = overrides.name || connection.displayName || projectName || connection._id;

  const card: AgentCard = {
    name: displayName,
    description: overrides.description || projectDescription || displayName,
    url: `/a2a/${connection._id}`,
    version: overrides.version || '1.0.0',
    protocolVersion: '0.2.1',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    defaultInputModes: overrides.defaultInputModes || ['text'],
    defaultOutputModes: overrides.defaultOutputModes || ['text'],
    skills: overrides.skills?.map((s, i) => ({
      id: `${connection._id}-skill-${i}`,
      name: s.name,
      description: s.description,
      tags: s.tags || ['a2a'],
    })) || [
      {
        id: connection._id,
        name: displayName,
        description: projectDescription || displayName,
        tags: ['a2a'],
      },
    ],
  };

  cacheCard(connection._id, card);
  return card;
}
