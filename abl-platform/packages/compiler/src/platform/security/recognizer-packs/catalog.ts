/**
 * PII Entity Catalog — aggregates entity metadata from all recognizer packs.
 *
 * Each pack exports a top-level `ENTITIES` constant with typed
 * `EntityCatalogEntry[]` entries. This module collects them into a
 * lookup table keyed by pack name and exposes `listEnabledPIIEntities`
 * for callers that need the full entity list for a given set of packs.
 */

import { ENTITIES as CORE_ENTITIES } from './core.js';
import { ENTITIES as US_ENTITIES } from './us.js';
import { ENTITIES as EU_ENTITIES } from './eu.js';
import { ENTITIES as APAC_ENTITIES } from './apac.js';
import { ENTITIES as FINANCIAL_ENTITIES } from './financial.js';
import { ENTITIES as MEDICAL_ENTITIES } from './medical.js';
import { ENTITIES as NETWORK_ENTITIES } from './network.js';
import { ENTITIES as INTL_PHONE_ENTITIES } from './international-phone.js';

export interface EntityCatalogEntry {
  id: string;
  label: string;
  pack: string;
  category: string;
}

const PACK_TO_ENTITIES: Record<string, ReadonlyArray<EntityCatalogEntry>> = {
  core: CORE_ENTITIES,
  us: US_ENTITIES,
  eu: EU_ENTITIES,
  apac: APAC_ENTITIES,
  financial: FINANCIAL_ENTITIES,
  medical: MEDICAL_ENTITIES,
  network: NETWORK_ENTITIES,
  'international-phone': INTL_PHONE_ENTITIES,
};

/**
 * Returns entity catalog entries for the given enabled pack names.
 * Unknown pack names are silently skipped (the pack dispatcher
 * already handles unknown-pack warnings separately).
 */
export function listEnabledPIIEntities(enabledPacks: ReadonlyArray<string>): EntityCatalogEntry[] {
  const result: EntityCatalogEntry[] = [];
  for (const pack of enabledPacks) {
    const entities = PACK_TO_ENTITIES[pack];
    if (entities) result.push(...entities);
  }
  return result;
}
