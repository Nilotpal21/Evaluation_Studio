/**
 * PageContext — structured representation of the user's current Studio page.
 * Attached to MessageRequest so the specialist knows what the user is looking at.
 * B02: Page Context Awareness
 */

import { z } from 'zod';

// =============================================================================
// ZOD SCHEMA
// =============================================================================

export const PageContextEntitySchema = z.object({
  type: z.enum([
    'agent',
    'trace',
    'session',
    'tool',
    'workflow',
    'pipeline',
    'connection',
    'mcp_server',
    'topology_node',
    'topology_edge',
    'knowledge_base',
    'integration_draft',
  ]),
  id: z.string().min(1),
  name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const PageContextUserSchema = z.object({
  /** User role within the current project/tenant context. */
  role: z.enum(['owner', 'admin', 'editor', 'developer', 'viewer', 'analyst', 'member']).optional(),
  /** Capability scopes granted to the user (free-form strings). */
  scopes: z.array(z.string().min(1)).optional(),
});

export const PageContextSchema = z.object({
  /** Studio surface that produced this context. Defaults to project-level Arch when omitted. */
  surface: z.enum(['project', 'agent-editor']).optional(),
  /** Current navigation area */
  area: z.string().min(1),
  /** Current page within the area */
  page: z.string().min(1),
  /** Current nested tab within the page, if any */
  tab: z.string().min(1).optional(),
  /** Current nested section within the tab, if any */
  subSection: z.string().min(1).optional(),
  /** User's browser timezone in IANA format (for relative date interpretation) */
  timeZone: z.string().min(1).optional(),
  /** Project context (if in a project) */
  project: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      agentCount: z.number(),
    })
    .optional(),
  /** Entity-specific context (agent, trace, session, topology node/edge) */
  entity: PageContextEntitySchema.optional(),
  /** High-level capabilities relevant to the current surface */
  capabilities: z.array(z.string().min(1)).max(12).optional(),
  /** Page-level summary data (dashboard KPIs, settings tab info, etc.) */
  summary: z.record(z.unknown()).optional(),
  /** Acting user context (role/scopes) for permission-aware specialist behavior. */
  user: PageContextUserSchema.optional(),
});

// =============================================================================
// TYPES
// =============================================================================

export type PageContextEntity = z.infer<typeof PageContextEntitySchema>;
export type PageContextUser = z.infer<typeof PageContextUserSchema>;
export type PageContext = z.infer<typeof PageContextSchema>;
