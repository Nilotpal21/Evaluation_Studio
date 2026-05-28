import mongoose from 'mongoose';
import type { Query } from 'mongoose';
import type { TenantSettingsWithEvalRetention } from './eval-retention.js';
import { resolveEvalRetentionContract } from './eval-retention.js';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;

/**
 * v0 eval-definition scrubber.
 *
 * The database package cannot depend on @abl/compiler without introducing a
 * circular platform dependency, so model hooks use this deliberately small
 * regex scrubber until ABLP-999 follow-up extracts the compiler PII detector
 * into a dependency-safe shared package.
 */
export function scrubEvalDefinitionPii(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(SSN_PATTERN, '[REDACTED_SSN]')
    .replace(CREDIT_CARD_PATTERN, '[REDACTED_CARD]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]');
}

export async function shouldScrubEvalDefinitionsForTenant(tenantId: string): Promise<boolean> {
  const tenant = await mongoose.connection
    .collection<{ _id: string; settings?: TenantSettingsWithEvalRetention | null }>('tenants')
    .findOne({ _id: tenantId }, { projection: { settings: 1 } });

  if (!tenant?.settings) {
    return false;
  }

  return resolveEvalRetentionContract(tenant.settings).scrubPiiOnStore;
}

type UpdateDocument = Record<string, unknown> & {
  $set?: Record<string, unknown>;
};

function scrubUpdateField(update: UpdateDocument, field: string): boolean {
  let changed = false;
  if (typeof update[field] === 'string') {
    update[field] = scrubEvalDefinitionPii(update[field]);
    changed = true;
  }
  if (update.$set && typeof update.$set[field] === 'string') {
    update.$set[field] = scrubEvalDefinitionPii(update.$set[field]);
    changed = true;
  }
  return changed;
}

export async function scrubEvalDefinitionUpdateIfEnabled(
  query: Query<unknown, unknown>,
  field: string,
): Promise<void> {
  const tenantId = query.getQuery().tenantId;
  if (typeof tenantId !== 'string' || !(await shouldScrubEvalDefinitionsForTenant(tenantId))) {
    return;
  }

  const update = query.getUpdate();
  if (!update || Array.isArray(update) || typeof update !== 'object') {
    return;
  }

  const mutableUpdate = update as UpdateDocument;
  if (scrubUpdateField(mutableUpdate, field)) {
    query.setUpdate(mutableUpdate);
  }
}
