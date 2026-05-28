/**
 * Migration: Unified Tool Schema (SUPERSEDED)
 *
 * Originally created the `tools` and `tool_versions` collections and migrated
 * `mcp_discovered_tools` records. Both `tools` and `tool_versions` are now
 * deprecated — `project_tools` is the sole tool storage model.
 *
 * This migration is retained as a no-op so the migration runner does not
 * error on databases where it was already applied.
 */

import type { Migration } from '../types.js';

export const migration: Migration = {
  version: '20260216_001',
  description: '[SUPERSEDED] Create unified tools + tool_versions collections',

  async up() {
    console.log('  No-op: tools + tool_versions are deprecated. project_tools is the sole model.');
  },

  async down() {
    console.log('  No-op: original migration superseded.');
  },
};
