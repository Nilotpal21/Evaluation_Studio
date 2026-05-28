/**
 * Recognizer-pack dispatcher.
 *
 * Maps each PackName to the pack module's `register(registry)` factory.
 * Unknown names log a warning and fire `pii.detect.degraded` via the
 * supplied onDegraded callback (the runtime owns the trace-event emit;
 * see LLD wiring checklist for the no-runtime-edge-from-compiler note).
 *
 * PACK_NAMES + PackName are imported from @agent-platform/shared/validation
 * (canonical home — declared once, consumed by the Zod schema in shared
 * and by this dispatcher).
 */

import { type PackName } from '@agent-platform/shared/validation';
import { createLogger } from '../../logger.js';
import type { PIIRecognizerRegistry } from '../pii-recognizer-registry.js';
import { register as registerCore } from './core.js';
import { register as registerUs } from './us.js';
import { register as registerEu } from './eu.js';
import { register as registerApac } from './apac.js';
import { register as registerFinancial } from './financial.js';
import { register as registerMedical } from './medical.js';
import { register as registerNetwork } from './network.js';
import { register as registerInternationalPhone } from './international-phone.js';

const log = createLogger('pii-recognizer-packs');

type PackRegister = (registry: PIIRecognizerRegistry) => void;

const PACK_REGISTRY: Record<PackName, PackRegister | null> = {
  core: registerCore,
  us: registerUs,
  eu: registerEu,
  apac: registerApac,
  financial: registerFinancial,
  medical: registerMedical,
  network: registerNetwork,
  'international-phone': registerInternationalPhone,
};

export interface RegisterPacksOptions {
  /**
   * Optional callback invoked with `reason: 'unknown_pack'` when an
   * incoming name does not exist in the dispatcher table. Lets the
   * runtime caller emit a `pii.detect.degraded` trace event without
   * the compiler package taking a runtime → compiler edge.
   */
  onDegraded?: (reason: 'unknown_pack', name: string) => void;
}

export function registerPacks(
  packNames: readonly string[] | undefined,
  registry: PIIRecognizerRegistry,
  options?: RegisterPacksOptions,
): void {
  if (!packNames || packNames.length === 0) return;
  for (const name of packNames) {
    const factory = (PACK_REGISTRY as Record<string, PackRegister | null | undefined>)[name];
    if (factory) {
      factory(registry);
      continue;
    }
    if (factory === null) {
      // Pack name is valid but the implementation has not landed in this
      // phase yet (e.g., 'us' before P2). No-op silently — the LLD ships
      // packs phase-by-phase and this branch keeps the dispatcher safe.
      continue;
    }
    log.warn('pii-recognizer-pack-unknown', { name });
    options?.onDegraded?.('unknown_pack', name);
  }
}
