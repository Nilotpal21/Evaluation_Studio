/**
 * Migration: re-run GuardrailPolicy scope index reconciliation after rollout.
 *
 * 20260510_031 introduced the scoped unique index and dropped the legacy
 * tenant-wide index. This follow-up is intentionally idempotent so environments
 * where an old application pod recreated the legacy index during deploy get a
 * second cleanup after the new image is active.
 */

import type mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed } from '../validation.js';
import { migration as guardrailPolicyScopeUniqueIndexMigration } from './20260510_031_fix_guardrail_policy_scope_unique_index.js';

type Db = mongoose.mongo.Db;
type ClientSession = mongoose.mongo.ClientSession;

export const migration: Migration = {
  version: '20260511_032',
  description: 'Reconcile GuardrailPolicy scoped uniqueness after rollout',
  transactionMode: 'none',

  async up(db: Db, session?: ClientSession) {
    await guardrailPolicyScopeUniqueIndexMigration.up(db, session);
  },

  async down(db: Db, session?: ClientSession) {
    await guardrailPolicyScopeUniqueIndexMigration.down(db, session);
  },

  async validate(db: Db, session?: ClientSession) {
    if (!guardrailPolicyScopeUniqueIndexMigration.validate) {
      return validationFailed('guardrail policy scope index validation is not available');
    }

    return guardrailPolicyScopeUniqueIndexMigration.validate(db, session);
  },
};

export default migration;
