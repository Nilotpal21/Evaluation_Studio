/**
 * Migration: Drop Legacy Tool Collections (SUPERSEDED)
 *
 * Originally dropped `mcp_discovered_tools` and `agent_tool_links` collections
 * after migration 001 created `tools` + `tool_versions`. All three legacy
 * collection families are now deprecated — `project_tools` is the sole model.
 *
 * Retained as a no-op so the migration runner does not error on databases
 * where it was already applied.
 */

import type { Migration } from '../types.js';

export const migration: Migration = {
  version: '20260216_002',
  description: '[SUPERSEDED] Drop legacy mcp_discovered_tools and agent_tool_links collections',

  async up() {
    console.log('  No-op: legacy collections already handled. project_tools is the sole model.');
  },

  async down() {
    console.log('  No-op: original migration superseded.');
  },
};
